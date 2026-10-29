// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// In the user's real Chrome, browser_switch_tab works on Chrome's tabs (it used
// to list the headless browser's — zero — and could close nothing).
import { describe, expect, it, vi } from "vitest";

let tabs = [
    { id: 11, title: "Inbox", url: "https://mail.example/", active: false },
    { id: 12, title: "Example Domain", url: "https://example.com/", active: true },
];
const sendBridgeCommand = vi.fn(async (cmd: string, p: { tabId?: number }) => {
    if (cmd === "close_tab") tabs = tabs.filter((t) => t.id !== p.tabId);
    return { success: true };
});
vi.mock("./chrome-bridge.js", () => ({ getExtensionTabs: async () => tabs, sendBridgeCommand }));
vi.mock("./browser-backend.js", () => ({ getCurrentMode: () => "chrome", getActiveBackend: vi.fn() }));

const { browserSwitchTab } = await import("./navigation.js");

describe("browser_switch_tab in Chrome mode", () => {
    it("lists, closes by index and switches Chrome's own tabs", async () => {
        const listed = JSON.parse(await browserSwitchTab.handler({}));
        expect(listed.tabs.map((t: { title: string }) => t.title)).toEqual(["Inbox", "Example Domain"]);
        const closed = JSON.parse(await browserSwitchTab.handler({ close_tab_index: 1 }));
        expect(closed.closed.url).toBe("https://example.com/");
        expect(sendBridgeCommand).toHaveBeenCalledWith("close_tab", { tabId: 12 });
        expect(closed.tabs).toHaveLength(1);
        await browserSwitchTab.handler({ tab_index: 0 });
        expect(sendBridgeCommand).toHaveBeenCalledWith("switch_tab", { tabId: 11 });
    });
});
