// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// The tab list reports the tab the next action will use: after a followed popup
// closes itself, that's its opener, not the stale index of the gone popup.
import { describe, expect, it, vi } from "vitest";

const tab = (name: string) => ({
    name,
    closed: false,
    isClosed() {
        return this.closed;
    },
    title: async () => name,
    url: () => `https://${name}.test/`,
});
const [a, b, c, popup] = [tab("A"), tab("B"), tab("C"), tab("popup")];
let pages = [a, b, c, popup];

vi.mock("./chrome-bridge.js", () => ({}));
vi.mock("./browser-backend.js", () => ({ getCurrentMode: () => "playwright", getActiveBackend: vi.fn() }));
vi.mock("./core.js", async (orig) => ({
    ...(await orig<typeof import("./core.js")>()),
    getBrowser: async () => ({ pages: () => pages }),
}));
const core = await import("./core.js");
const { browserSwitchTab } = await import("./navigation.js");

describe("browser_switch_tab list", () => {
    it("marks the opener active once the followed popup has closed", async () => {
        core.setActivePageIndex(3, { page: popup as never, opener: a as never });
        popup.closed = true; // window.close() from the popup
        pages = [a, b, c];
        const listed = JSON.parse(await browserSwitchTab.handler({}));
        expect(listed.active_tab).toBe(0);
        expect(listed.tabs.filter((t: { active: boolean }) => t.active).map((t: { title: string }) => t.title)).toEqual(["A"]);
    });
});
