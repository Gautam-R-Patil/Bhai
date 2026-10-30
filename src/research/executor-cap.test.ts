// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The extra-discovery (Phase 1 fallback) page loop must honor maxSources like the
// three sibling page loops, or it overshoots the source budget. Also: pages are
// analyzed concurrently, one page under two URL spellings is fetched once, and a
// run resumes from its checkpoint.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveResearch, ResearchProfile, ResearchState } from "./types.js";

const ctl = vi.hoisted(() => ({
    search: null as null | ((q: string) => Array<{ url: string; title: string; snippet: string }>),
    fetched: [] as string[],
    inFlight: 0,
    maxInFlight: 0,
    seedCalls: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actual: any = await importOriginal();
    return { ...actual, promises: { ...actual.promises, mkdir: async () => {}, writeFile: async () => {} } };
});

vi.mock("./engines.js", () => {
    let uid = 0;
    const EXTRA = /comprehensive guide|detailed review|recommendations tips|^best |reddit/i;
    return {
        resetEngineHealth: () => {},
        multiEngineSearch: async (q: string) => ({
            results:
                ctl.search?.(q) ??
                Array.from({ length: EXTRA.test(q) ? 8 : 2 }, () => ({
                    url: `https://u${uid++}.example/p`,
                    title: "T",
                    snippet: "s",
                })),
            engines: ["mock"],
        }),
    };
});

vi.mock("./fetcher.js", () => ({
    fetchPages: async (urls: Array<{ url: string; title: string }>) => {
        ctl.fetched.push(...urls.map((u) => u.url));
        return urls.map((u) => ({ url: u.url, title: u.title, content: "x".repeat(200), links: [] }));
    },
    rankOutboundLinks: () => [],
    scoreDomainQuality: () => 0.5,
    getDomain: () => "u.example",
}));

vi.mock("./analysis.js", () => ({
    generateSeedQueries: async () => {
        ctl.seedCalls++;
        return ["s1", "s2", "s3", "s4"];
    },
    generateMoreQueries: async () => [],
    analyzeAndExtract: async () => {
        ctl.maxInFlight = Math.max(ctl.maxInFlight, ++ctl.inFlight);
        await new Promise((r) => setTimeout(r, 5));
        ctl.inFlight--;
        return { findings: ["f"], followUpQueries: [], categories: ["c"] };
    },
    detectContradictions: async () => [],
    identifyGaps: async () => [],
    synthesizeResearch: async () => "# Report",
    shouldExtractContacts: () => false,
    extractContactsSection: async () => "",
}));

vi.mock("./scoring.js", async (importOriginal) => ({
    UrlSet: (await importOriginal<typeof import("./scoring.js")>()).UrlSet,
    rankSource: (url: string, title: string, content: string) => ({
        url,
        title,
        content,
        domain: "u.example",
        domainScore: 0.5,
        contentDepth: 0.5,
        findingDensity: 0.5,
        recencyScore: 0.5,
        citationCount: 0,
        finalScore: 0.5,
        findings: [],
        outboundLinks: [],
    }),
    dedupeByText: (items: unknown[]) => items,
    crossReferenceFindings: () => [],
}));

vi.mock("./persistence.js", () => ({
    saveResearchState: async () => {},
    deleteResearchState: async () => {},
    storeResearchInMemory: async () => {},
}));
vi.mock("./hypothesis-engine.js", () => ({
    generateHypotheses: async () => ({ hypotheses: [], queryOrder: [] }),
    updateHypothesis: (h: unknown) => h,
}));
vi.mock("./credibility-model.js", () => ({ getCredibility: () => 0.5, recordClaimVerification: () => {} }));
vi.mock("../harness/registry.js", () => ({ getDimensionValue: () => undefined }));

const { executeDeepResearch } = await import("./executor.js");

const profile: ResearchProfile = {
    depth: 5,
    maxSources: 20,
    concurrentQueries: 2,
    citationDepth: 0,
    useAcademicEngines: false,
    multiPass: false,
    synthesisModel: "m",
};

beforeEach(() => {
    Object.assign(ctl, { search: null, fetched: [], inFlight: 0, maxInFlight: 0, seedCalls: 0 });
});

describe("executeDeepResearch source cap", () => {
    it("never exceeds maxSources even when extra discovery runs", async () => {
        const research: ActiveResearch = {
            id: "t1",
            topic: "widgets",
            profile: "quick",
            status: "running",
            depth: 5,
            maxSources: 20,
            sourcesProcessed: 0,
            roundsCompleted: 0,
            findingsCount: 0,
            currentPhase: 0,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            report: "",
            reportFile: "",
            abortController: new AbortController(),
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await executeDeepResearch(research, profile, {} as any, async () => {});

        expect(research.status).toBe("completed");
        expect(research.sourcesProcessed).toBeLessThanOrEqual(research.maxSources);
        expect(ctl.maxInFlight).toBeGreaterThan(1); // pages analyzed concurrently
    }, 30_000);

    it("fetches one page once even when a batch has it under two spellings", async () => {
        ctl.search = () => [
            { url: "https://a.example/p", title: "A", snippet: "s" },
            { url: "http://www.a.example/p/", title: "A", snippet: "s" },
        ];
        const research = newResearch();
        await executeDeepResearch(research, profile, {} as never, async () => {});
        expect(research.status).toBe("completed");
        expect(ctl.fetched).toEqual(["https://a.example/p"]);
    }, 30_000);

    it("resumes a Phase 2 checkpoint without re-seeding", async () => {
        const source = (url: string) => ({
            url,
            title: "T",
            content: "",
            domain: "u.example",
            domainScore: 0.5,
            contentDepth: 0.5,
            findingDensity: 0.5,
            recencyScore: 0.5,
            citationCount: 0,
            finalScore: 0.5,
            findings: ["f"],
            outboundLinks: [],
        });
        const { abortController: _, ...saved } = {
            ...newResearch(),
            currentPhase: 2,
            sourcesProcessed: 3,
            engineBreakdown: { earlier: 4 },
        };
        const state: ResearchState = {
            research: saved,
            allFindings: ["r1", "r2", "r3"].map((u) => ({
                text: u,
                sourceUrl: `https://${u}.example/`,
                sourceTitle: "T",
                categories: [],
            })),
            allSources: ["r1", "r2", "r3"].map((u) => source(`https://${u}.example/`)),
            visitedUrls: ["r1.example", "r2.example", "r3.example"],
            usedQueries: ["s1"],
            pendingQueries: ["p1"],
            rounds: [],
            currentRound: 4,
        };
        const research: ActiveResearch = { ...state.research, abortController: new AbortController() };
        await executeDeepResearch(research, profile, {} as never, async () => {}, state);
        expect(ctl.seedCalls).toBe(0);
        expect(research.status).toBe("completed");
        expect(research.sourcesProcessed).toBeGreaterThanOrEqual(3);
        expect(research.roundsCompleted).toBeGreaterThan(4);
        // Engine counts from before the interruption carry over into the report's "Engines used".
        expect(research.engineBreakdown?.earlier).toBe(4);
        expect(research.engineBreakdown?.mock).toBeGreaterThan(0);
    }, 30_000);
});

function newResearch(): ActiveResearch {
    return {
        id: "t2",
        topic: "widgets",
        profile: "quick",
        status: "running",
        depth: 5,
        maxSources: 20,
        sourcesProcessed: 0,
        roundsCompleted: 0,
        findingsCount: 0,
        currentPhase: 0,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        report: "",
        reportFile: "",
        abortController: new AbortController(),
    };
}
