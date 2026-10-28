// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Human-handoff polling: waitForCaptchaCleared() must keep polling through
// detector errors, return true once the CAPTCHA is gone, and give up at the
// timeout. The browser core is mocked so no Playwright/Chrome is launched.

import { describe, expect, it, vi } from "vitest";

const touch = vi.fn();
vi.mock("./core.js", () => ({ ATLAS_HUD_JS: "", getActivePage: vi.fn(), touchBrowserActivity: touch }));
vi.mock("./chrome-bridge.js", () => ({ getActiveExtensionTab: vi.fn(), sendBridgeCommand: vi.fn() }));
vi.mock("./browser-backend.js", () => ({ getCurrentMode: () => "playwright" }));
vi.mock("../../voice/transcribe.js", () => ({ transcribeBuffer: vi.fn() }));

const { waitForCaptchaCleared, solveViaNoCaptchaAI } = await import("./captcha.js");

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

describe("waitForCaptchaCleared", () => {
    it("polls through errors until the CAPTCHA clears", async () => {
        const detect = vi
            .fn()
            .mockResolvedValueOnce({ type: "hcaptcha", siteKey: null })
            .mockRejectedValueOnce(new Error("page navigating"))
            .mockResolvedValueOnce({ type: "none", siteKey: null });
        expect(await waitForCaptchaCleared({}, 1000, 1, detect)).toBe(true);
        expect(detect).toHaveBeenCalledTimes(3);
        expect(touch).toHaveBeenCalled();
    });

    it("returns false when the CAPTCHA never clears", async () => {
        const detect = vi.fn().mockResolvedValue({ type: "turnstile", siteKey: null });
        expect(await waitForCaptchaCleared({}, 30, 5, detect)).toBe(false);
    });
});
