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
            "os_type",
            "system_info",
            "clipboard",
            "browser_navigate",
            "app_manager",
            "window_manage",
            "web_search",
            "list_directory",
            "compress_files",
            "trash_manager",
            "file_manage",
            "apple_notes",
            "image_edit",
            "pdf_edit",
            "calculator",
            "generate_image",
            "send_file",
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
    // From the model-ladder eval: light mode got 6 tools and no dark_mode; a typing task got no app_manager.
    ["switch my mac to light mode", "dark_mode"],
    ["open textedit, make a new document and type hello", "app_manager"],
    // From the complex-task eval: no screen tools were offered, only app_manager and file tools.
    ["use the calculator app to work out 123 times 45, then open a new textedit document and write the result in it", "os_type"],
    ["use the calculator app to work out 123 times 45", "os_smart_click"],
    // From the widened eval: no tools were offered for these.
    ["how much free disk space do i have", "system_info"],
    ["open example.com in the browser and tell me the page's main heading", "browser_navigate"],
    ["open the wikipedia page for alan turing and tell me the year he was born", "browser_navigate"],
    ["find the newest pdf in my downloads folder and copy its file name to my clipboard", "clipboard"],
    // From the all-nano run: zipping was filed under os_control and compress_files wasn't offered.
    ["zip the bhaieval folder on my desktop and save the zip inside that folder", "compress_files"],
    ["empty my trash", "trash_manager"],
    // No tool moved or renamed files at all.
    ["move invoice.pdf into the Invoices folder", "file_manage"],
    ["rename the report file to final report", "file_manage"],
    ["make a new folder called Reports on my desktop", "file_manage"],
    ["Create a note in Apple Notes titled 'Bhai eval note' with the text 'it works'", "apple_notes"],
    ["convert this heic photo to a jpg", "image_edit"],
    ["make photo.png 100 pixels wide and resize the image", "image_edit"],
    // Creating or AI-editing a picture is generate_image, not a format conversion.
    ["draw a cat in a spacesuit", "generate_image"],
    ["remove the man from this photo", "generate_image"],
    ["make a picture of a sunset", "generate_image"],
    ["make me a logo for my bakery", "generate_image"],
    ["make the sky bluer in this photo", "generate_image"],
    ["change the background to a beach", "generate_image"],
    ["make another version of that image", "generate_image"],
    ["Make that image again in high quality", "generate_image"],
    ["undo that last image edit", "generate_image"],
    // The overlay's follow-up chips.
    ["Make another version", "generate_image"],
    ["Make it higher quality", "generate_image"],
    ["Undo that edit", "generate_image"],
    ["here is my pic\nchange the background to a beach", "generate_image"],
    // Phrases the fallback missed: Hinglish, bare follow-ups, combining and adding.
    ["isko Ghibli style mein bana do", "generate_image"],
    ["peeche wale bande ko hata do", "generate_image"],
    ["mere chai stall ke liye logo bana do", "generate_image"],
    ["undo", "generate_image"],
    ["give me a few options", "generate_image"],
    ["put me and my dog in one picture", "generate_image"],
    ["add a hat to him", "generate_image"],
    ["is pic ka background badal do", "generate_image"],
    ["peeche wale log ko hata do", "generate_image"],
    ["make this a png", "image_edit"],
    ["combine these two pdfs into one", "pdf_edit"],
    ["how many pages does the report pdf have", "pdf_edit"],
    // Every model got Calculator wrong some way; one call does it.
    ["use the calculator app to work out 17 times 23, then add 100", "calculator"],
    // Long-task eval: nano went digging in System Settings for this.
    ["find out which version of macos i'm running and write it into version.txt", "system_info"],
    ["Find the capital of Australia on Wikipedia and create an Apple Note titled Capital with the answer", "apple_notes"],
    ["Read task.txt in the BhaiEval folder on my Desktop and create a reminder for tomorrow at 10am with its text", "read"],
];

// A desktop wallpaper is a setting, not a photo edit.
const NOT_CASES: [string, string][] = [
    ["change my desktop background", "generate_image"],
    ["open photoshop and click save", "generate_image"],
    ["install a different version of node", "generate_image"],
    ["what are my options", "generate_image"],
    ["show me three options for flights to Goa tomorrow", "generate_image"],
    ["undo my last git commit", "generate_image"],
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

    it.each(NOT_CASES)("%s → no %s", async (message, tool) => {
        const sel = await selectTools({ message, iteration: 1 });
        expect(sel.tools.map((t) => t.function.name)).not.toContain(tool);
    });
});
