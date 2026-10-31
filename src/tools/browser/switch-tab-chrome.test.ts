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
    if (cmd === "get_active_tab") return { id: 12 }; // Bhai's tab
    return { success: true };
});
vi.mock("./chrome-bridge.js", () => ({ getExtensionTabs: async () => tabs, sendBridgeCommand }));
vi.mock("./browser-backend.js", () => ({ getCurrentMode: () => "chrome", getActiveBackend: vi.fn() }));

const { browserClose, browserSwitchTab } = await import("./navigation.js");

describe("browser_switch_tab in Chrome mode", () => {
    it("lists, closes by index and switches Chrome's own tabs", async () => {
        const listed = JSON.parse(await browserSwitchTab.handler({}));
        expect(listed.tabs.map((t: { title: string }) => t.title)).toEqual(["Inbox", "Example Domain"]);
        // An index alone, or one whose tab has changed since the list, closes nothing.
        expect(JSON.parse(await browserSwitchTab.handler({ close_tab_index: 1 })).error).toMatch(/close_tab_url/);
        const moved = JSON.parse(
            await browserSwitchTab.handler({ close_tab_index: 0, close_tab_url: "https://example.com/" }),
        );
        expect(moved.error).toMatch(/tabs changed/);
        expect(sendBridgeCommand).not.toHaveBeenCalledWith("close_tab", expect.anything());
        const closed = JSON.parse(
            await browserSwitchTab.handler({ close_tab_index: 1, close_tab_url: "https://example.com" }),
        );
        expect(closed.closed.url).toBe("https://example.com/");
        expect(sendBridgeCommand).toHaveBeenCalledWith("close_tab", { tabId: 12 });
        expect(closed.tabs).toHaveLength(1);
        await browserSwitchTab.handler({ tab_index: 0 });
        expect(sendBridgeCommand).toHaveBeenCalledWith("switch_tab", { tabId: 11, focus: true });
    });

    it("browser_close closes only the tab Bhai is on, never the owner's Chrome", async () => {
        tabs = [
            { id: 11, title: "Inbox", url: "https://mail.example/", active: false },
            { id: 12, title: "Example Domains", url: "https://www.iana.org/help/example-domains", active: true },
        ];
        sendBridgeCommand.mockClear();
        const out = JSON.parse(await browserClose.handler({}));
        expect(out.closed.url).toBe("https://www.iana.org/help/example-domains");
        expect(sendBridgeCommand).toHaveBeenCalledWith("close_tab", { tabId: 12 });
        expect(tabs.map((t) => t.id)).toEqual([11]);
    });
});
