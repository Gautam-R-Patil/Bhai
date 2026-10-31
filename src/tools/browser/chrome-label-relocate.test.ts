// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// browser_click_at by label in the owner's Chrome: a light-DOM element is clicked where it is now,
// a shadow-DOM control still at its scanned point, a removed or hidden element is reported gone, and
// where page scripts can't run the label clicks its scanned point as before.
import { beforeEach, expect, it, vi } from "vitest";

// The page as the bridge sees it: stamped id → where that element is now. Shadow controls are
// stamped too, but document.querySelectorAll can't reach them, so they are never in here.
// hidden "display" = display:none (closed dropdown item, inactive tab panel): an all-zero rect, checkVisibility()
// false. "visibility" = visibility:hidden until :hover (a mail row's Delete): a real box, checkVisibility() false.
// h = a box taller than the 800px viewport (a long editor).
const live = new Map<string, { x: number; y: number; h?: number; hidden?: "display" | "visibility" }>();
const clicks: Array<[number, number]> = [];
const typed: string[] = [];
let scrolls = 0;
// "js-blocked": the debugger can't attach and the ISOLATED-world fallback hits the extension's CSP;
// "down": the extension disconnected. Both reject like the real bridge does.
// "click-timeout": click_at reached the page but its CDP click is held (an alert() it opened).
let bridge: "ok" | "js-blocked" | "down" | "click-timeout" = "ok";
const CSP_ERROR =
    "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: \"script-src 'self' 'wasm-unsafe-eval' 'inline-speculation-rules'\".";

vi.mock("./chrome-bridge.js", () => ({
    getActiveExtensionTab: async () => ({ url: "https://shop.test/", title: "Shop", status: "complete" }),
    getExtensionTabs: async () => [],
    sendBridgeCommand: async (type: string, p: { code?: string; x?: number; y?: number }) => {
        if (bridge === "down") throw new Error("Chrome extension not connected");
        if (type === "scan_elements")
            return {
                elements: [
                    { label: 1, x: 100, y: 200, tag: "button", text: "Pay", bhaiId: "bhai-el-1-0", frameId: 0 },
                    { label: 2, x: 300, y: 400, tag: "button", text: "Close", bhaiId: "bhai-shadow-1-5", frameId: 0 },
                ],
            };
        if (type === "click_at") clicks.push([p.x as number, p.y as number]);
        if (type === "click_at" && bridge === "click-timeout")
            throw new Error('Chrome bridge command "click_at" timed out after 3000ms');
        if (type === "type_text") typed.push(type);
        if (type !== "execute_js") return { success: true };
        if (bridge === "js-blocked") throw new Error(CSP_ERROR);
        const document = {
            readyState: "complete",
            querySelectorAll: (sel: string) =>
                [...live]
                    .filter(([id]) => sel === `[data-bhai-id="${id}"]`)
                    .map(([, at]) => ({
                        focus() {},
                        checkVisibility: () => !at.hidden,
                        get h() {
                            return (at.h ?? 20) / 2;
                        },
                        scrollIntoView() {
                            scrolls++;
                            at.y = 400; // block: "center" in an 800px viewport
                        },
                        getBoundingClientRect() {
                            if (at.hidden === "display")
                                return { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
                            const h = this.h;
                            return { x: at.x - 10, y: at.y - h, left: at.x - 10, top: at.y - h, width: 20, height: 2 * h, right: at.x + 10, bottom: at.y + h };
                        },
                    })),
        };
        try {
            return new Function("document", "innerWidth", "innerHeight", `return ${p.code}`)(document, 1280, 800);
        } catch {
            return null; // page scripts (HUD, cursor, readiness) this fake page doesn't run
        }
    },
}));
vi.mock("./browser-backend.js", async (orig) => {
    const { ChromeExtensionBackend } = await import("./chrome-backend.js");
    const backend = new ChromeExtensionBackend();
    return {
        ...(await orig<typeof import("./browser-backend.js")>()),
        getCurrentMode: () => "chrome",
        getActiveBackend: async () => backend,
    };
});

const core = await import("./core.js");
const { browserClickAt, browserType } = await import("./interaction.js");
const { ChromePageProxy } = await import("./chrome-backend.js");

beforeEach(async () => {
    bridge = "ok";
    live.clear();
    live.set("bhai-el-1-0", { x: 100, y: 200 });
    core.setLastElementMap(await core.getInteractiveElements(await core.getActivePage(), true));
    clicks.length = 0;
    typed.length = 0;
    scrolls = 0;
});

it("clicks a light-DOM element at its new place after a layout shift, and syncs the tab", async () => {
    live.set("bhai-el-1-0", { x: 100, y: 50 });
    const sync = vi.spyOn(ChromePageProxy.prototype, "syncTab");
    const r = JSON.parse(await browserClickAt.handler({ label: 1 }));
    expect(r.success).toBe(true);
    expect(r.method).toBe("element_handle");
    expect(clicks[0]).toEqual([100, 50]);
    expect(sync).toHaveBeenCalled(); // the same navigation grace a coordinate click gets
    expect(scrolls).toBe(0); // in view: the page is not scrolled (a popover could close)
}, 20_000);

it("scrolls an element below the fold into view, then clicks it there", async () => {
    live.set("bhai-el-1-0", { x: 100, y: 1200 });
    const r = JSON.parse(await browserClickAt.handler({ label: 1 }));
    expect(r.success).toBe(true);
    expect(scrolls).toBe(1);
    expect(clicks[0]).toEqual([100, 400]);
}, 20_000);

it("reports a hidden element (display:none) gone, and never clicks the viewport's corner", async () => {
    live.set("bhai-el-1-0", { x: 100, y: 200, hidden: "display" });
    const r = JSON.parse(await browserClickAt.handler({ label: 1 }));
    expect(r.error).toMatch(/vanished/i);
    expect(clicks).toEqual([]);
}, 20_000);

it("browser_type into a hidden element types nothing", async () => {
    live.set("bhai-el-1-0", { x: 100, y: 200, hidden: "display" });
    const r = JSON.parse(await browserType.handler({ label: 1, text: "4242" }));
    expect(r.error).toMatch(/vanished/i);
    expect(clicks).toEqual([]);
    expect(typed).toEqual([]);
}, 20_000);

it("where page scripts can't run, clicks the scanned point as before (not VANISHED)", async () => {
    bridge = "js-blocked";
    const r = JSON.parse(await browserClickAt.handler({ label: 1 }));
    expect(r.success).toBe(true);
    expect(clicks).toEqual([[100, 200]]);
}, 20_000);

it("where page scripts can't run, browser_type clicks the scanned point and types", async () => {
    bridge = "js-blocked";
    const r = JSON.parse(await browserType.handler({ label: 1, text: "4242" }));
    expect(r.success).toBe(true);
    expect(clicks).toEqual([[100, 200]]);
    expect(typed).toHaveLength(1);
}, 20_000);

it("a disconnected extension is reported as such, not as a vanished element", async () => {
    bridge = "down";
    const r = JSON.parse(await browserClickAt.handler({ label: 1 }));
    expect(r.error).toMatch(/Chrome extension not connected/);
    expect(r.error).not.toMatch(/vanished/i);
}, 20_000);

it("clicks a shadow-DOM control at its scanned point, not VANISHED", async () => {
    const r = JSON.parse(await browserClickAt.handler({ label: 2 }));
    expect(r.success).toBe(true);
    expect(r.method).toBe("coordinates");
    expect(clicks[0]).toEqual([300, 400]);
}, 20_000);

it("reports an element that is gone, and clicks nothing", async () => {
    live.clear();
    const r = JSON.parse(await browserClickAt.handler({ label: 1 }));
    expect(r.error).toMatch(/vanished/i);
    expect(clicks).toEqual([]);
}, 20_000);

it("browser_type into a gone element types nothing (not into whatever has focus)", async () => {
    live.clear();
    const r = JSON.parse(await browserType.handler({ label: 1, text: "4242" }));
    expect(r.error).toMatch(/vanished/i);
    expect(typed).toEqual([]);
}, 20_000);

it("clicks a button shown only on :hover (visibility:hidden, with a box) at its live centre, as before", async () => {
    // The extension's scan labels it (native button), at the box Chromium reports: x 101, y 39.
    live.set("bhai-el-1-0", { x: 101, y: 39, hidden: "visibility" });
    const r = JSON.parse(await browserClickAt.handler({ label: 1 }));
    expect(r.success).toBe(true);
    expect(clicks).toEqual([[101, 39]]); // the click's mouse move shows it, and the press lands
}, 20_000);

it("browser_type into a visibility:hidden field clicks its live box, then types", async () => {
    live.set("bhai-el-1-0", { x: 101, y: 39, hidden: "visibility" });
    const r = JSON.parse(await browserType.handler({ label: 1, text: "4242" }));
    expect(r.success).toBe(true);
    expect(clicks).toEqual([[101, 39]]);
    expect(typed).toHaveLength(1);
}, 20_000);

it("a click_at that times out (an alert() holds it) is reported, never clicked a second time", async () => {
    bridge = "click-timeout";
    const r = JSON.parse(await browserClickAt.handler({ label: 1 }));
    expect(r.error).toMatch(/Click failed: Chrome bridge command "click_at" timed out/);
    expect(clicks).toEqual([[100, 200]]);
}, 20_000);

it("does not scroll an element taller than the viewport whose centre is on screen", async () => {
    live.set("bhai-el-1-0", { x: 100, y: 300, h: 3000 }); // top -1200, bottom 1800
    const r = JSON.parse(await browserClickAt.handler({ label: 1 }));
    expect(r.success).toBe(true);
    expect(scrolls).toBe(0);
    expect(clicks[0]).toEqual([100, 300]);
}, 20_000);

it("any other locator keeps the old scroll: always to centre on click, fully-in-view on scrollIntoViewIfNeeded", async () => {
    const { ChromeLocatorProxy } = await import("./chrome-backend.js");
    const loc = new ChromeLocatorProxy('[data-bhai-id="bhai-el-1-0"]');
    live.set("bhai-el-1-0", { x: 100, y: 300, h: 3000 }); // centre on screen: a label would not scroll
    await loc.click();
    expect(scrolls).toBe(1);
    expect(clicks[0]).toEqual([100, 400]);
    live.set("bhai-el-1-0", { x: 100, y: 795 }); // centre on screen, bottom 805 past the 800px fold
    await loc.scrollIntoViewIfNeeded();
    expect(scrolls).toBe(2);
    live.set("bhai-el-1-0", { x: 100, y: 200, hidden: "display" });
    await expect(loc.focus()).resolves.toBeUndefined(); // no visibility check, as before
}, 20_000);
