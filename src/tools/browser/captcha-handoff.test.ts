// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// browser_handle_captcha: the NoCaptchaAI tier's wire format, and the hand-off
// to the owner once every solver tier failed. The browser core is mocked so no
// Playwright/Chrome is launched.

import { describe, expect, it, vi } from "vitest";

const getActivePage = vi.fn();
const waitHandler = vi.fn(async (_input: Record<string, unknown>) => JSON.stringify({ success: true, status: "cleared" }));
vi.mock("./core.js", () => ({ ATLAS_HUD_JS: "", getActivePage, touchBrowserActivity: vi.fn() }));
vi.mock("./chrome-bridge.js", () => ({ getActiveExtensionTab: vi.fn(), sendBridgeCommand: vi.fn() }));
vi.mock("./browser-backend.js", () => ({ getCurrentMode: () => "playwright" }));
vi.mock("../../voice/transcribe.js", () => ({ transcribeBuffer: vi.fn() }));
vi.mock("./human-handoff.js", () => ({ browserWaitForHuman: { handler: waitHandler } }));

const { browserHandleCaptcha, solveViaNoCaptchaAI } = await import("./captcha.js");

describe("solveViaNoCaptchaAI", () => {
    const json = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

    it("creates a Turnstile task, polls, and returns the token", async () => {
        vi.useFakeTimers();
        process.env.NOCAPTCHAAI_API_KEY = "k";
        const fetchMock = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(json({ errorId: 0, taskId: "t1" }))
            .mockResolvedValueOnce(json({ status: "processing" }))
            .mockResolvedValueOnce(json({ status: "ready", solution: { token: "tok" } }));
        const p = solveViaNoCaptchaAI("turnstile", "sk", "https://x.test");
        await vi.advanceTimersByTimeAsync(7000);
        expect(await p).toBe("tok");
        const sent = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
        expect(sent).toEqual({
            clientKey: "k",
            task: { type: "AntiTurnstileTaskProxyLess", websiteURL: "https://x.test", websiteKey: "sk" },
        });
        fetchMock.mockRestore();
        vi.useRealTimers();
    });

    it("returns null on a rejected key and skips unsupported types", async () => {
        process.env.NOCAPTCHAAI_API_KEY = "k";
        const fetchMock = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(json({ errorId: 1, error: "Invalid apikey. errorid 1" }));
        expect(await solveViaNoCaptchaAI("turnstile", "sk", "https://x.test")).toBeNull();
        expect(await solveViaNoCaptchaAI("hcaptcha", "sk", "https://x.test")).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        fetchMock.mockRestore();
    });
});

describe("browserHandleCaptcha", () => {
    it("hands an unsolved check to the owner with the time left and the Stop signal", async () => {
        process.env.NOCAPTCHAAI_API_KEY = "k"; // a local key skips the Convex key fetch
        // An hCaptcha with no readable sitekey: the API tiers skip, and no vision LLM is set.
        getActivePage.mockResolvedValue({
            url: () => "https://shop.test",
            evaluate: vi.fn(async (fn: unknown) =>
                typeof fn !== "function"
                    ? false
                    : String(fn).includes("innerHTML")
                      ? '<div class="h-captcha"></div>'
                      : { type: "hcaptcha", siteKey: null },
            ),
        });
        const ctl = new AbortController();
        const out = JSON.parse(await browserHandleCaptcha.handler({ _signal: ctl.signal }));
        expect(out).toMatchObject({ success: true, status: "cleared", method: "human", captcha_type: "hcaptcha" });
        const sent = waitHandler.mock.calls[0][0];
        expect(sent._signal).toBe(ctl.signal);
        expect(sent.timeout_s).toBeGreaterThan(500);
    });
});

describe("Turnstile", () => {
    it("ticks the box when it doesn't pass by itself, and counts the token as the pass", async () => {
        vi.useFakeTimers();
        let clicked = false;
        const page = {
            url: () => "https://shop.test",
            evaluate: vi.fn(async (code: unknown) => {
                const s = String(code);
                if (s.includes("cf-turnstile-response") && s.includes("tok"))
                    return { tok: clicked, present: true, box: { x: 10, y: 20, w: 300, h: 65 } };
                if (typeof code !== "function") return false;
                return s.includes("innerHTML") ? '<div class="cf-turnstile"></div>' : { type: "turnstile", siteKey: null };
            }),
            screenshot: vi.fn(),
            mouse: {
                move: vi.fn(async () => {}),
                click: vi.fn(async () => {
                    clicked = true;
                }),
            },
        };
        const { handleCaptchaIfPresent } = await import("./captcha.js");
        let result: { method: string } | undefined;
        handleCaptchaIfPresent(page).then((r) => (result = r));
        while (!result) await vi.advanceTimersByTimeAsync(500);
        expect(result).toMatchObject({ handled: true, method: "turnstile_click" });
        expect(page.mouse.click).toHaveBeenCalledWith(40, 52.5); // 30px in, centred in the 65px strip
        vi.useRealTimers();
    });
});

describe("autoHandleCaptcha", () => {
    const captchaPage = () => ({
        url: () => "https://shop.test",
        screenshot: vi.fn(),
        mouse: { move: vi.fn(), click: vi.fn() },
        evaluate: vi.fn(async (code: unknown) => {
            if (typeof code !== "function") return false; // no token yet
            return String(code).includes("innerHTML") ? '<div class="h-captcha"></div>' : { type: "hcaptcha", siteKey: null };
        }),
    });

    it("reports a CAPTCHA it couldn't solve so the agent can hand it to the owner", async () => {
        const { autoHandleCaptcha } = await import("./captcha.js");
        expect(await autoHandleCaptcha(captchaPage())).toMatchObject({ captcha_detected: true, captcha_type: "hcaptcha" });
    });

    it("leaves CAPTCHAs to the agent when the owner turned it off", async () => {
        process.env.ATLAS_NO_CAPTCHA_AUTO = "true";
        const { autoHandleCaptcha, CAPTCHA_HINT } = await import("./captcha.js");
        const page = captchaPage();
        expect(await autoHandleCaptcha(page)).toEqual({ captcha_detected: true, captcha_type: "hcaptcha", hint: CAPTCHA_HINT });
        expect(page.mouse.click).not.toHaveBeenCalled();
        delete process.env.ATLAS_NO_CAPTCHA_AUTO;
    });

    it("returns nothing on a page without a CAPTCHA", async () => {
        const { autoHandleCaptcha } = await import("./captcha.js");
        const page = { evaluate: vi.fn(async (code: unknown) => (String(code).includes("innerHTML") ? "<p>hi</p>" : { type: "none", siteKey: null })) };
        expect(await autoHandleCaptcha(page)).toEqual({});
    });
});
