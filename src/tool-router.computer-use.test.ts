// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Everyday computer requests must get their one-call tool offered even when the
// classifier LLM is unavailable and embeddings carry no signal: keyword routing
// alone. A tool that isn't offered can't be picked, by any model.

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
    process.env.ATLAS_TOOL_ROUTER_TIMEOUT_MS = "200";
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
    recordToolUsage: () => {},
    updateCategoryAffinity: () => {},
}));
vi.mock("./tools/index.js", () => ({
    getToolSchemas: () =>
        [
            "get_current_time",
            "read",
            "edit",
            "write",
            "spotify",
            "music_control",
            "set_volume",
            "open_settings",
            "clipboard",
            "dark_mode",
            "wifi_control",
            "bluetooth_control",
            "find_files",
            "open_in_app",
            "os_smart_click",
            "os_inspect",
            "os_screenshot",
            "app_manager",
            "window_manage",
            "web_search",
        ].map((name) => ({ type: "function", function: { name, description: name, parameters: { type: "object" } } })),
}));

const { initToolRouter, selectTools, setToolRouterLLM } = await import("./tool-router.js");

const CASES: [string, string][] = [
    ["play blinding lights on apple music", "music_control"],
    ["skip this song", "spotify"],
    ["open bluetooth settings", "open_settings"],
    ["give zoom access to my camera", "open_settings"],
    ["let chrome use my microphone", "open_settings"],
    ["change my wallpaper", "open_settings"],
    ["turn on night shift", "open_settings"],
    ["connect my airpods", "bluetooth_control"],
    ["find my resume pdf", "find_files"],
    ["where did i save the tax documents", "find_files"],
    ["show me the pdf i downloaded yesterday", "find_files"],
    ["click the save button", "os_smart_click"],
    ["open calculator and compute 45*12", "os_smart_click"],
    ["make the window full screen", "window_manage"],
    ["put chrome and vscode side by side", "window_manage"],
    ["take a screenshot", "os_screenshot"],
];

describe("computer-use routing without the classifier", () => {
    beforeAll(async () => {
        await initToolRouter();
        setToolRouterLLM({ chat: () => new Promise(() => {}) } as never); // classifier stalls
    });

    it.each(CASES)("%s → %s", async (message, tool) => {
        const sel = await selectTools({ message, iteration: 1 });
        expect(sel.tools.map((t) => t.function.name)).toContain(tool);
    });
});
