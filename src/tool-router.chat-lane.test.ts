// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Routing budget + banter chat lane. From a real turn (2026-10-28): "it's 1am,
// i have 40 chrome tabs open and my code still doesn't build. roast me" took
// 14.9s to route (5s budget) and got 37 tools across 9 categories.

import { beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
    process.env.ATLAS_TOOL_ROUTER_TIMEOUT_MS = "200";
    process.env.ATLAS_NO_PERSONA_BIAS = "true";
    return { embedDelayMs: 0 };
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
        await sleep(h.embedDelayMs);
        return fakeEmbed(t);
    },
    cosineSimilarity: (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i], 0),
}));
vi.mock("./llm.js", () => ({ MODELS: { GPT41_NANO: "nano" } }));
vi.mock("./mcp/client.js", () => ({ getMCPToolSchemas: () => [] }));
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
        ["get_current_time", "shell_exec", "read", "edit", "write", "grep", "browser_navigate", "browser_click_at"].map(
            (name) => ({ type: "function", function: { name, description: name, parameters: { type: "object" } } }),
        ),
}));

const { initToolRouter, isConversationalBanter, selectTools, setToolRouterLLM } = await import("./tool-router.js");

// The classifier LLM stalls (the log's "LLM Classifier: fallback (timeout)").
const stalledLLM = { chat: () => new Promise(() => {}) } as never;

const ROAST = "it's 1am, i have 40 chrome tabs open and my code still doesn't build. roast me";
const BANTER = [
    ROAST,
    "tell me a joke about my love life",
    "lol what do you think of people who never close their tabs",
    "my code is so bad, be honest, rate my life choices",
];
const ACTIONS = [
    "close my chrome tabs",
    "fix the build error in ./src",
    "roast my code in src/agent.ts",
    "lol can you open spotify",
    "close my chrome tabs and roast me",
];

describe("isConversationalBanter", () => {
    it.each(BANTER)("banter: %s", (m) => expect(isConversationalBanter(m)).toBe(true));
    it.each(ACTIONS)("request to act: %s", (m) => expect(isConversationalBanter(m)).toBe(false));
});

describe("selectTools with the classifier timing out", () => {
    beforeAll(async () => {
        await initToolRouter();
        setToolRouterLLM(stalledLLM);
    });

    it("routes the real roast turn to the chat lane", async () => {
        const sel = await selectTools({ message: ROAST, iteration: 1 });
        expect(sel.categories).toEqual(["chat_only"]);
        expect(sel.tools.map((t) => t.function.name)).toEqual(["request_tools"]);
        expect(sel.classification?.tier).toBe("chat");
    });

    it.each(["close my chrome tabs", "fix the build error in ./src"])("still gives tools to: %s", async (m) => {
        const sel = await selectTools({ message: m, iteration: 1 });
        expect(sel.categories).not.toContain("chat_only");
        expect(sel.tools.length).toBeGreaterThan(1);
    });

    it("bounds the whole step, fallback embedding included", async () => {
        h.embedDelayMs = 2000; // a cold/slow embedder after the classifier already used the budget
        const t0 = Date.now();
        const sel = await selectTools({ message: "open the downloads folder in finder", iteration: 1 });
        const elapsed = Date.now() - t0;
        h.embedDelayMs = 0;
        expect(sel.tools.length).toBeGreaterThan(1); // structural fallback still routes
        expect(elapsed).toBeLessThan(500); // budget is 200ms; before the fix this was ~2200ms
    });
});
