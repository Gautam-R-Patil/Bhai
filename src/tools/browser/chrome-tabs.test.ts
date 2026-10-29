// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// browser_switch_tab on the owner's real Chrome (extension bridge), two windows open.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: Array<[string, Record<string, unknown>]> = [];
// Window 1: the owner's tabs (Gmail active). Window 2 (focused): Bhai's tab (shop active).
const tabs = [
    { id: 11, title: "Gmail", url: "https://mail.google.com", active: true },
    { id: 12, title: "Docs", url: "https://docs.google.com", active: false },
    { id: 21, title: "Shop", url: "https://shop.example", active: true },
];
vi.mock("./chrome-bridge.js", () => ({
    getExtensionTabs: async () => tabs,
    sendBridgeCommand: async (type: string, payload: Record<string, unknown>) => {
        sent.push([type, payload]);
        return type === "get_active_tab" ? tabs[2] : { success: true };
    },
}));
vi.mock("./browser-backend.js", async (orig) => ({
    ...(await orig<object>()),
    getActiveBackend: async () => ({}),
    getCurrentMode: () => "chrome",
}));

const { browserSwitchTab } = await import("./navigation.js");

describe("browser_switch_tab in the owner's Chrome", () => {
    beforeEach(() => {
        sent.length = 0;
    });

    it("close_active closes the focused window's tab, not the owner's tab in another window", async () => {
        const out = JSON.parse(await browserSwitchTab.handler({ close_active: true }));
        expect(out.closed.title).toBe("Shop");
        expect(sent).toContainEqual(["close_tab", { tabId: 21 }]);
        expect(sent.some(([t, p]) => t === "close_tab" && p.tabId === 11)).toBe(false);
    });

    it("switching to a tab in another window brings that window forward", async () => {
        await browserSwitchTab.handler({ tab_index: 1 });
        expect(sent).toContainEqual(["switch_tab", { tabId: 12, focus: true }]);
    });
});
