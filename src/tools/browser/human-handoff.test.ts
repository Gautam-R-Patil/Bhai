// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// browser_wait_for_human: detect → bring the tab up → ask the owner → poll
// until the check is gone. It must never reach a solver (2captcha, NopeCHA,
// the audio path): the browser core, bridge and channel are fakes here.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mode = { value: "playwright" as "playwright" | "chrome" };
const getActivePage = vi.fn();
const sendBridgeCommand = vi.fn(async () => ({ success: true }));
const transcribeBuffer = vi.fn();
const showNotification = vi.fn(async () => {});
const solverEntry = vi.fn(() => {
    throw new Error("solver must not be called");
});

vi.mock("./core.js", () => ({ ATLAS_HUD_JS: "() => {}", getActivePage, touchBrowserActivity: vi.fn() }));
vi.mock("./chrome-bridge.js", () => ({
    getActiveExtensionTab: vi.fn(async () => ({ id: 7, url: "https://shop.test/login" })),
    isExtensionConnected: () => true,
    sendBridgeCommand,
}));
vi.mock("./browser-backend.js", () => ({ getCurrentMode: () => mode.value }));
vi.mock("../../voice/transcribe.js", () => ({ transcribeBuffer }));
vi.mock("../platform-bridge.js", () => ({ showNotification }));
// The real detector runs against the fake page; the solver entry points are spies.
vi.mock("./captcha.js", async (orig) => ({
    ...(await orig<object>()),
    detectCaptcha: vi.fn(),
    handleCaptchaIfPresent: solverEntry,
    browserHandleCaptcha: { schema: {}, handler: solverEntry },
}));

const captcha = await import("./captcha.js");
const detect = vi.mocked(captcha.detectCaptcha);
const { browserWaitForHuman, waitForHuman } = await import("./human-handoff.js");
const { registerChannelSender, setActiveChannel } = await import("../channel-send.js");

/** A page whose check is still there for `polls` detector calls after the first. */
function fakePage(polls: number) {
    let left = polls;
    detect.mockReset();
    detect.mockImplementation(async () =>
        left-- >= 0 ? { type: "recaptcha-v2", siteKey: "k" } : { type: "none", siteKey: null },
    );
    return {
        url: () => "https://shop.test/login",
        evaluate: vi.fn(async (code: unknown) =>
            String(code).includes("location.href") ? { href: "https://shop.test/login", solved: false } : undefined,
        ),
        bringToFront: vi.fn(async () => {}),
        // Anything a solver would touch:
        click: solverEntry,
        frameLocator: solverEntry,
        mouse: { click: solverEntry },
        keyboard: { type: solverEntry },
    };
}

const fetchSpy = vi.spyOn(globalThis, "fetch");
const sent: string[] = [];
registerChannelSender("test", async (m) => {
    sent.push(m);
});

beforeEach(() => {
    sent.length = 0;
    vi.clearAllMocks();
    mode.value = "playwright";
    setActiveChannel("test");
    // If anything reached the solver tiers, these keys would make it call out.
    process.env.NOPECHA_API_KEY = "x";
    process.env.CAPTCHA_API_KEY = "x";
});

function expectNoSolver() {
    expect(solverEntry).not.toHaveBeenCalled();
    expect(transcribeBuffer).not.toHaveBeenCalled();
    const solverCalls = fetchSpy.mock.calls.filter(([u]) => /2captcha|nopecha|recaptcha/i.test(String(u)));
    expect(solverCalls).toEqual([]);
}

describe("waitForHuman", () => {
    it("polls until the check disappears", async () => {
        const page = fakePage(3);
        expect(await waitForHuman(page, { timeoutMs: 2000, intervalMs: 1 })).toBe("cleared");
        expect(detect).toHaveBeenCalledTimes(5);
        expectNoSolver();
    });

    it("counts a filled response token as done (a ticked box stays on the page)", async () => {
        const page = fakePage(1000);
        page.evaluate.mockResolvedValue({ href: "https://shop.test/login", solved: true });
        expect(await waitForHuman(page, { timeoutMs: 2000, intervalMs: 1, startUrl: "https://shop.test/login" })).toBe(
            "cleared",
        );
    });

    it("counts the page moving on as done", async () => {
        const page = fakePage(1000);
        page.evaluate.mockResolvedValue({ href: "https://shop.test/account", solved: false });
        expect(await waitForHuman(page, { timeoutMs: 2000, intervalMs: 1, startUrl: "https://shop.test/login" })).toBe(
            "cleared",
        );
    });

    it("times out when the owner never does it", async () => {
        const page = fakePage(1_000_000);
        expect(await waitForHuman(page, { timeoutMs: 30, intervalMs: 5 })).toBe("timeout");
        expectNoSolver();
    });

    it("stops as soon as the turn is cancelled", async () => {
        const page = fakePage(1_000_000);
        const ctl = new AbortController();
        setTimeout(() => ctl.abort(), 20);
        const t0 = Date.now();
        expect(await waitForHuman(page, { timeoutMs: 60_000, intervalMs: 2000, signal: ctl.signal })).toBe("cancelled");
        expect(Date.now() - t0).toBeLessThan(1000); // woke from the 2s nap, didn't sleep it out
    });
});

describe("browser_wait_for_human", () => {
    it("asks the owner, waits, and returns cleared", async () => {
        const page = fakePage(0);
        getActivePage.mockResolvedValue(page);
        const out = JSON.parse(await browserWaitForHuman.handler({ timeout_s: 30 }));
        expect(out).toMatchObject({ success: true, status: "cleared", site: "shop.test", asked_on: "test" });
        expect(sent).toHaveLength(1);
        expect(sent[0]).toContain(`Tap the "I'm not a robot" box on shop.test`);
        expect(sent[0]).toContain("I'll carry on after");
        expect(showNotification).toHaveBeenCalled();
        expect(page.bringToFront).toHaveBeenCalled();
        expectNoSolver();
    }, 15_000);

    it("brings the exact tab and its window to the front in Chrome-bridge mode", async () => {
        mode.value = "chrome";
        const page = fakePage(0);
        getActivePage.mockResolvedValue(page);
        const out = JSON.parse(await browserWaitForHuman.handler({ timeout_s: 30 }));
        expect(out.status).toBe("cleared");
        expect(sendBridgeCommand).toHaveBeenCalledWith("switch_tab", { tabId: 7, focus: true });
        expect(page.bringToFront).not.toHaveBeenCalled();
        expect(sent[0]).toContain("open in your Chrome");
        expectNoSolver();
    }, 15_000);

    it("returns at once when there is no check, without messaging the owner", async () => {
        const page = fakePage(-1);
        getActivePage.mockResolvedValue(page);
        const out = JSON.parse(await browserWaitForHuman.handler({}));
        expect(out).toMatchObject({ success: true, captcha_present: false });
        expect(sent).toEqual([]);
    });

    it("ends with an error when the turn is stopped", async () => {
        const page = fakePage(1_000_000);
        getActivePage.mockResolvedValue(page);
        const ctl = new AbortController();
        setTimeout(() => ctl.abort(), 20);
        const out = JSON.parse(await browserWaitForHuman.handler({ timeout_s: 60, _signal: ctl.signal }));
        expect(out.status).toBe("cancelled");
        expect(out.error).toMatch(/Stopped/);
        expectNoSolver();
    });
});
