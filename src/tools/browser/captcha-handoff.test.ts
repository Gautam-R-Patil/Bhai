// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
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

const { waitForCaptchaCleared } = await import("./captcha.js");

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
