// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The extra-discovery (Phase 1 fallback) page loop must honor maxSources like the
// three sibling page loops, or it overshoots the source budget.
import { describe, expect, it, vi } from "vitest";
import type { ActiveResearch, ResearchProfile } from "./types.js";

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
            results: Array.from({ length: EXTRA.test(q) ? 8 : 2 }, () => ({
                url: `https://u${uid++}.example/p`,
                title: "T",
                snippet: "s",
            })),
            engines: ["mock"],
        }),
    };
});

vi.mock("./fetcher.js", () => ({
    fetchPages: async (urls: Array<{ url: string; title: string }>) =>
        urls.map((u) => ({ url: u.url, title: u.title, content: "x".repeat(200), links: [] })),
    rankOutboundLinks: () => [],
    scoreDomainQuality: () => 0.5,
    getDomain: () => "u.example",
}));

vi.mock("./analysis.js", () => ({
    generateSeedQueries: async () => ["s1", "s2", "s3", "s4"],
    generateMoreQueries: async () => [],
    analyzeAndExtract: async () => ({ findings: ["f"], followUpQueries: [], categories: ["c"] }),
    detectContradictions: async () => [],
    identifyGaps: async () => [],
    synthesizeResearch: async () => "# Report",
    shouldExtractContacts: () => false,
    extractContactsSection: async () => "",
}));

vi.mock("./scoring.js", () => ({
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
        const profile: ResearchProfile = {
            depth: 5,
            maxSources: 20,
            concurrentQueries: 2,
            citationDepth: 0,
            useAcademicEngines: false,
            multiPass: false,
            synthesisModel: "m",
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await executeDeepResearch(research, profile, {} as any, async () => {});

        expect(research.status).toBe("completed");
        expect(research.sourcesProcessed).toBeLessThanOrEqual(research.maxSources);
    }, 30_000);
});
