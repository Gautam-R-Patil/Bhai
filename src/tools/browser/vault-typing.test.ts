// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//
// A saved secret is typed only where the vault allows it at the moment the
// keys land: not after a click that navigated, not into a cross-origin frame,
// not into a tab the Chrome proxy only remembers. Typing tools don't echo it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const getActivePage = vi.fn();
const getLastElementMap = vi.fn(() => [] as Array<{ label: number; x: number; y: number }>);
vi.mock("./core.js", () => ({
    ATLAS_HUD_JS: "() => {}",
    CLICK_INDICATOR_JS: "() => {}",
    SCROLL_INDICATOR_JS: "() => {}",
    getActivePageIndex: () => 0,
    setActivePageIndex: () => {},
    getBrowser: vi.fn(),
    invalidateCache: () => {},
    getAccessibilityTree: vi.fn(),
    touchBrowserActivity: vi.fn(),
    getActivePage,
    getLastElementMap,
    getInteractiveElements: async () => [],
    setLastElementMap: () => {},
    buildElementsText: () => "",
    waitForPageReady: async () => {},
}));
const liveTab = { url: "https://github.com/login", title: "GitHub" };
const sendBridgeCommand = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ success: true }));
vi.mock("./chrome-bridge.js", () => ({
    isExtensionConnected: () => true,
    getExtensionTabs: async () => [],
    getActiveExtensionTab: vi.fn(async () => ({ id: 1, ...liveTab })),
    sendBridgeCommand,
}));

const { browserType, browserKeyboard } = await import("./interaction.js");
const { browserRunJs } = await import("./extraction.js");
const { ChromePageProxy } = await import("./chrome-backend.js");
const { runVaultCall } = await import("../../security/vault.js");
const { typeVaultText } = await import("./vault-typing.js");

const SECRET = "Gh-Secret-77!";
const RULES = [{ token: "{{vault:gh.password}}", domains: ["github.com"], payment: false }];
const asVault = <T>(fn: () => Promise<T>) => runVaultCall({ tool: "browser_type", rules: RULES }, fn);

/** A Playwright-like page. `frameUrl` set: focus sits in an iframe on that URL. */
function fakePage(o: { url: string; frameUrl?: string; clickNavigatesTo?: string; doc?: string }) {
    let url = o.url;
    const typed: string[] = [];
    const handles = new Map<object, { evaluate: (fn: (e: unknown) => unknown) => Promise<unknown> }>();
    const h = (el: object) => {
        if (!handles.has(el)) handles.set(el, { evaluate: async (fn) => fn(el) });
        return handles.get(el);
    };
    const iframeEl = { tagName: "IFRAME" };
    const inputEl = { tagName: "INPUT" };
    const run = async (fn: unknown, arg?: unknown) => (typeof fn === "function" ? fn(arg) : undefined);
    const child = {
        url: () => o.frameUrl,
        evaluateHandle: async () => h(inputEl),
        childFrames: () => [],
        frameElement: async () => h(iframeEl),
        evaluate: run,
    };
    const main = {
        url: () => url,
        evaluateHandle: async () => h(o.frameUrl ? iframeEl : inputEl),
        childFrames: () => (o.frameUrl ? [child] : []),
        evaluate: run,
    };
    return {
        typed,
        url: () => url,
        mainFrame: () => main,
        frames: () => (o.frameUrl ? [main, child] : [main]),
        evaluate: async (code: unknown) =>
            String(code).includes("location.origin") ? new URL(url).origin : undefined,
        mouse: {
            click: async () => {
                if (o.clickNavigatesTo) url = o.clickNavigatesTo;
            },
        },
        keyboard: {
            type: async (t: string) => {
                typed.push(t);
            },
            press: async () => {},
        },
        waitForTimeout: async () => {},
    };
}

beforeEach(() => {
    getLastElementMap.mockReturnValue([]);
    sendBridgeCommand.mockClear();
    liveTab.url = "https://github.com/login";
});

describe("browser_type with a saved secret", () => {
    it("re-checks the origin after its own click: a click that navigates off-site types nothing", async () => {
        const page = fakePage({ url: "https://github.com/login", clickNavigatesTo: "https://evil.example/" });
        getActivePage.mockResolvedValue(page);
        getLastElementMap.mockReturnValue([{ label: 1, x: 5, y: 5 }]);
        const out = await asVault(() => browserType.handler({ label: 1, text: SECRET }));
        expect(JSON.parse(out)).toHaveProperty("error");
        expect(page.typed.join("")).not.toContain(SECRET);
    });

    it("refuses when focus is in a cross-origin frame on the right top page", async () => {
        const page = fakePage({ url: "https://github.com/login", frameUrl: "https://evil.example/frame" });
        getActivePage.mockResolvedValue(page);
        const out = await asVault(() => browserType.handler({ text: SECRET }));
        expect(JSON.parse(out)).toHaveProperty("error");
        expect(page.typed).toEqual([]);
    });

    it("types on the right site and doesn't echo what it typed", async () => {
        const page = fakePage({ url: "https://github.com/login" });
        getActivePage.mockResolvedValue(page);
        const out = await asVault(() => browserType.handler({ text: SECRET }));
        expect(page.typed.join("")).toBe(SECRET);
        expect(out).not.toContain(SECRET);
        expect(JSON.parse(out)).toMatchObject({ success: true, typed_chars: SECRET.length });
        // ...and page JavaScript is off on that ORIGIN for the rest of the task — even
        // after navigating within github.com (Back/forward could refill the field).
        expect(JSON.parse(await browserRunJs.handler({ code: "return 1" }))).toHaveProperty("error");
        getActivePage.mockResolvedValue(fakePage({ url: "https://github.com/dashboard" }));
        expect(JSON.parse(await browserRunJs.handler({ code: "return 1" }))).toHaveProperty("error");
        // a different origin was never typed into, so page JavaScript is fine there
        getActivePage.mockResolvedValue(fakePage({ url: "https://elsewhere.example/" }));
        expect(JSON.parse(await browserRunJs.handler({ code: "return 1" })).error ?? "").not.toMatch(/saved secret/);
    });
});

describe("browser_keyboard", () => {
    it("never echoes typed text", async () => {
        const page = fakePage({ url: "https://example.com/" });
        getActivePage.mockResolvedValue(page);
        const long = "k".repeat(64);
        expect(await browserKeyboard.handler({ text: long })).not.toContain("kkkkkkkk");
    });
    it("with a saved secret, checks the origin first", async () => {
        const page = fakePage({ url: "https://evil.example/" });
        getActivePage.mockResolvedValue(page);
        const out = await asVault(() => browserKeyboard.handler({ text: SECRET }));
        expect(JSON.parse(out)).toHaveProperty("error");
        expect(page.typed).toEqual([]);
    });
});

describe("Chrome extension mode", () => {
    it("checks the live tab, not the proxy's cached URL", async () => {
        const proxy = new ChromePageProxy("https://github.com/login", "GitHub"); // cached
        liveTab.url = "https://evil.example/"; // the tab really shows this now
        const err = await asVault(() => typeVaultText(proxy, SECRET));
        expect(err).toMatch(/Refused/);
        expect(sendBridgeCommand.mock.calls.some((c) => c[0] === "type_text")).toBe(false);
    });
    it("sends the rules with the text so the extension re-checks in the page", async () => {
        const proxy = new ChromePageProxy("https://github.com/login", "GitHub");
        sendBridgeCommand.mockImplementation(async (cmd: unknown) =>
            cmd === "execute_js" ? "https://github.com|1" : { success: true, guarded: true },
        );
        expect(await asVault(() => typeVaultText(proxy, SECRET))).toBeNull();
        const call = sendBridgeCommand.mock.calls.find((c) => c[0] === "type_text");
        expect(call?.[1]).toMatchObject({ text: SECRET, vaultRules: RULES });
    });
    it("an in-page refusal from the extension is an error, not a success", async () => {
        const proxy = new ChromePageProxy("https://github.com/login", "GitHub");
        sendBridgeCommand.mockImplementation(async (cmd: unknown) =>
            cmd === "type_text" ? { success: false, error: "vault_origin_mismatch" } : "https://github.com|1",
        );
        await expect(asVault(() => typeVaultText(proxy, SECRET))).rejects.toThrow(/vault_origin_mismatch/);
    });
});
