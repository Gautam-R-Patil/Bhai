// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Microsoft-Decision-1 as the classifier: its answers become the classification, and two
// failures in a row pause it so an outage can't slow every turn.
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
    process.env.ATLAS_TOOL_ROUTER_TIMEOUT_MS = "300";
    process.env.ATLAS_NO_PERSONA_BIAS = "true";
});
vi.mock("./memory/embeddings.js", () => ({
    isReady: () => true,
    warmup: async () => {},
    embedBatch: async (texts: string[]) => texts.map(() => new Float32Array(4)),
    embedText: async () => new Float32Array(4),
    cosineSimilarity: () => 0,
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
}));
vi.mock("./tools/index.js", () => ({
    getToolSchemas: () =>
        ["get_current_time", "spotify", "music_control", "app_manager", "os_smart_click", "find_files"].map((name) => ({
            type: "function",
            function: { name, description: name, parameters: { type: "object" } },
        })),
}));

const { initToolRouter, selectTools, setDecisionTransport, setToolRouterLLM } = await import("./tool-router.js");

describe("Decision-1 classifier", () => {
    beforeAll(async () => {
        await initToolRouter();
        setToolRouterLLM({ chat: () => new Promise(() => {}) } as never); // the LLM classifier stalls
    });

    it("its main category, sure extras, tier and multi-step become the classification", async () => {
        setDecisionTransport(async () => ({
            primary: { choice: "media", confidence: 0.9 },
            app_management: { noul: 0.97 },
            shell: { noul: 0.8 }, // below the 0.95 bar
            tier: { choice: "simple" },
            multi_step: { noul: 0.9 }, // ignored on a simple turn
        }));
        const sel = await selectTools({ message: "play blinding lights on spotify", iteration: 1 });
        expect(sel.classification).toMatchObject({ categories: ["media", "app_management"], tier: "simple", multi_step: false });
    });

    it("two failures in a row pause it", async () => {
        let calls = 0;
        setDecisionTransport(async () => {
            calls++;
            throw new Error("down");
        });
        for (const m of ["open notes app please", "open the calendar app now", "open the music app now"])
            await selectTools({ message: m, iteration: 1 });
        expect(calls).toBe(2);
    });
});
