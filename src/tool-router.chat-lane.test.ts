// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Routing budget + banter chat lane. From a real turn (2026-10-28): "it's 1am,
// i have 40 chrome tabs open and my code still doesn't build. roast me" took
// 14.9s to route (5s budget) and got 37 tools across 9 categories.

import { beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
    process.env.ATLAS_TOOL_ROUTER_TIMEOUT_MS = "200";
    process.env.ATLAS_NO_PERSONA_BIAS = "true";
    return { embedDelayMs: 0, embedded: [] as string[], mcp: [] as unknown[], noSignal: false };
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Deterministic 4-dim "embedding" from the text, so cosine scores are stable.
const fakeEmbed = (s: string) => {
    const v = new Float32Array(4);
    for (let i = 0; i < s.length; i++) v[i % 4] += s.charCodeAt(i) - 105;
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
};

vi.mock("./memory/embeddings.js", () => ({
    isReady: () => true,
    warmup: async () => {},
    embedBatch: async (texts: string[]) => texts.map(fakeEmbed),
    embedText: async (t: string) => {
        h.embedded.push(t);
        await sleep(h.embedDelayMs);
        return fakeEmbed(t);
    },
    cosineSimilarity: (a: Float32Array, b: Float32Array) => (h.noSignal ? 0 : a.reduce((s, x, i) => s + x * b[i], 0)),
}));
vi.mock("./llm.js", () => ({ MODELS: { GPT41_NANO: "nano" } }));
vi.mock("./mcp/client.js", () => ({ getMCPToolSchemas: () => h.mcp }));
vi.mock("./skills/loader.js", () => ({ getRelevantSkillSlugs: () => [] }));
vi.mock("./harness/registry.js", () => ({ getDimensionValue: () => undefined }));
vi.mock("./tool-router-analytics.js", () => ({
    detectTaskChain: () => null,
    getCategoriesForChain: () => [],
    getFollowUpTools: () => [],
    getLikelyCategories: () => [],
    getPreferredTools: (_i: string, t: string[]) => t,
    initAnalytics: () => {},
    recordToolUsage: () => {},
    updateCategoryAffinity: () => {},
}));
vi.mock("./tools/index.js", () => ({
    getToolSchemas: () =>
        [
            "get_current_time",
            "shell_exec",
            "read",
            "edit",
            "write",
            "grep",
            "browser_navigate",
            "browser_click_at",
            "browser_close",
            "browser_switch_tab",
            "app_manager",
            "spotify",
            "music_control",
            "whatsapp_send",
            "send_message_on_channel",
        ].map((name) => ({ type: "function", function: { name, description: name, parameters: { type: "object" } } })),
}));

const { initToolRouter, isConversationalBanter, selectTools, setToolRouterLLM } = await import("./tool-router.js");

// The classifier LLM stalls (the log's "LLM Classifier: fallback (timeout)").
const stalledLLM = { chat: () => new Promise(() => {}) } as never;

const ROAST = "it's 1am, i have 40 chrome tabs open and my code still doesn't build. roast me";
const BANTER = [ROAST, "tell me a joke about my love life", "lmao i'm so done with today", "haha cheer me up"];
// Requests (or might be): never the chat lane without the classifier saying so.
// The list after the first five comes from the review of f2fdee8.
const NOT_BANTER = [
    "close my chrome tabs",
    "fix the build error in ./src",
    "roast my code in src/agent.ts",
    "lol can you open spotify",
    "close my chrome tabs and roast me",
    "haha what's the weather in delhi right now",
    "lol what's on my calendar today",
    "jokes aside, my mac is crawling, what's eating my cpu",
    "roast my github profile github.com/dheeraj-codingdesk",
    "be honest, how is bitcoin doing today",
    "rate my resume, it's resume.pdf on my desktop",
    "lol I need you to close all my chrome tabs",
    "haha my wifi keeps dropping, help me fix it",
    "what do you think of the email my boss just sent",
    "lol remind me to call mom at 6",
    "lol play despacito",
    "haha send hi to mom on whatsapp",
    "lol what do you think of people who never close their tabs",
];
const ACTIONS: [string, string[]][] = [
    ["close my chrome tabs", ["browser_close", "app_manager"]],
    ["fix the build error in ./src", ["read", "edit", "shell_exec"]],
    ["play a song on youtube", ["browser_navigate", "spotify", "music_control"]],
    ["send hi to mom on whatsapp", ["whatsapp_send", "send_message_on_channel"]],
];

describe("isConversationalBanter", () => {
    it.each(BANTER)("banter: %s", (m) => expect(isConversationalBanter(m)).toBe(true));
    it.each(NOT_BANTER)("not certain it's banter: %s", (m) => expect(isConversationalBanter(m)).toBe(false));
});

describe("selectTools with the classifier timing out", () => {
    beforeAll(async () => {
        await initToolRouter();
        setToolRouterLLM(stalledLLM);
    });

    it("never guesses the chat lane with no classifier answer, even for banter", async () => {
        for (const m of BANTER) {
            const sel = await selectTools({ message: m, iteration: 1 });
            expect(sel.categories).not.toContain("chat_only");
        }
    });

    // Every action, plain and wrapped in banter, keeps its tools on a timeout,
    // from structural routing alone (embeddings only add on top).
    it.each(
        ACTIONS.flatMap(([m, t]): [string, string[]][] => [
            [m, t],
            [`lol ${m}`, t],
        ]),
    )("still gives tools to: %s", async (m, want) => {
        h.noSignal = true; // the fake embedder picks everything; make it pick nothing
        const sel = await selectTools({ message: m, iteration: 1 }).finally(() => {
            h.noSignal = false;
        });
        const names = sel.tools.map((t) => t.function.name);
        expect(sel.categories).not.toContain("chat_only");
        expect(names.some((n) => want.includes(n))).toBe(true);
    });

    it.each(NOT_BANTER)("no chat lane for: %s", async (m) => {
        const sel = await selectTools({ message: m, iteration: 1 });
        expect(sel.categories).not.toContain("chat_only");
    });

    it("still scores with the message embedding after the classifier used the budget", async () => {
        h.embedded.length = 0;
        h.embedDelayMs = 50;
        await selectTools({ message: "don't let me forget priya's birthday dinner on friday", iteration: 1 });
        h.embedDelayMs = 0;
        expect(h.embedded.some((t) => t.includes("priya"))).toBe(true);
    });

    it("bounds the fallback embedding, and adds no blind MCP tools when it times out", async () => {
        h.mcp = Array.from({ length: 6 }, (_, i) => ({
            type: "function",
            function: { name: `mcp_tool_${i}`, description: `mcp ${i}`, parameters: { type: "object" } },
        }));
        h.embedDelayMs = 3000; // a cold/slow embedder
        const t0 = Date.now();
        const sel = await selectTools({ message: "open the downloads folder in finder", iteration: 1 });
        const elapsed = Date.now() - t0;
        h.embedDelayMs = 0;
        h.mcp = [];
        const names = sel.tools.map((t) => t.function.name);
        expect(names.length).toBeGreaterThan(1); // structural fallback still routes
        expect(names.filter((n) => n.startsWith("mcp_"))).toEqual([]);
        expect(elapsed).toBeLessThan(1600); // 200ms budget + one 1s embed floor; unbounded was 3s+
    }, 10_000);
});

describe("selectTools with the classifier saying chat", () => {
    beforeAll(() => {
        const reply =
            '{"intent":"banter","categories":[],"specific_tools":[],"confidence":0.9,"tier":"chat","multi_step":false}';
        setToolRouterLLM({ chat: async () => ({ choices: [{ message: { content: reply } }] }) } as never);
    });

    it.each([
        "lol what do you think of people with 300 tabs open",
        "my code is so bad, be honest, rate my life choices",
        "haha you're the worst assistant ever, roast yourself",
    ])("takes the chat lane: %s", async (m) => {
        const sel = await selectTools({ message: m, iteration: 1 });
        expect(sel.categories).toEqual(["chat_only"]);
        expect(sel.tools.map((t) => t.function.name)).toEqual(["request_tools"]);
    });
});

describe("selectTools when the classifier answers with no categories", () => {
    // Answered, but unsure of the tier: banter still takes the chat lane.
    const noCatsLLM = {
        chat: async () => ({
            choices: [{ message: { content: JSON.stringify({ intent: "banter", categories: [], tools: [], confidence: 0.5, tier: "simple" }) } }],
        }),
    } as never;
    beforeAll(async () => {
        await initToolRouter();
        setToolRouterLLM(noCatsLLM);
    });

    it("routes a roast turn to the chat lane", async () => {
        // A message the timeout tests above didn't route (the selection cache would answer).
        const sel = await selectTools({ message: "lmao roast me, 40 tabs open and the code still won't build", iteration: 1 });
        expect(sel.categories).toEqual(["chat_only"]);
        expect(sel.tools.map((t) => t.function.name)).toEqual(["request_tools"]);
    });
});
