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
