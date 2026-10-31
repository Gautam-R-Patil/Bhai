// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// browser_parallel_tabs on the owner's Chrome: one shared page proxy, so tabs must not race on it.
import { expect, it, vi } from "vitest";

// One real tab: goto commits at once and finishes loading later, innerText reads whatever is loaded now.
let current = "about:blank";
const page = {
    goto: async (url: string) => {
        current = url;
        await new Promise((r) => setTimeout(r, url.endsWith("a") ? 60 : 10));
    },
    evaluate: async () => `text of ${current}`,
    url: () => current,
    title: async () => current,
};
vi.mock("./core.js", () => ({
    getBrowser: async () => ({ pages: () => [], newPage: async () => page }),
    waitForPageReady: async () => {},
    setActivePageIndex: () => {},
    invalidateCache: () => {},
}));
vi.mock("./browser-backend.js", () => ({ getCurrentMode: () => "chrome" }));
vi.mock("../../utils/system-resources.js", () => ({ getResourceLimits: () => ({ maxParallelTabs: 4, reason: "test" }) }));

const { browserParallelTabs } = await import("./advanced.js");

it("each tab's result is its own page", async () => {
    const out = JSON.parse(
        await browserParallelTabs.handler({
            tab_actions: [
                { url: "https://shop.example/a", extract_text: true },
                { url: "https://shop.example/b", extract_text: true },
            ],
        }),
    );
    expect(out.results.map((r: { extracted: string }) => r.extracted)).toEqual([
        "text of https://shop.example/a",
        "text of https://shop.example/b",
    ]);
});
