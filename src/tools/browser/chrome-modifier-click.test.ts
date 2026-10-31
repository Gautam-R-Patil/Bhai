// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// browser_click_at with ctrl/meta in the owner's Chrome: the held keys reach the click.
import { expect, it, vi } from "vitest";

const clicks: Array<Record<string, unknown>> = [];
vi.mock("./chrome-bridge.js", () => ({
    getActiveExtensionTab: async () => null,
    getExtensionTabs: async () => [],
    sendBridgeCommand: async (type: string, p: Record<string, unknown>) => {
        if (type === "click_at") clicks.push(p);
        return null;
    },
}));
const { ChromePageProxy } = await import("./chrome-backend.js");

it("a click while Control is held carries it; after release it doesn't", async () => {
    const page = new ChromePageProxy();
    await page.keyboard.down("Control");
    await page.mouse.click(10, 20);
    await page.keyboard.up("Control");
    await page.mouse.click(10, 20);
    expect(clicks.map((c) => c.modifiers)).toEqual([["Control"], []]);
});
