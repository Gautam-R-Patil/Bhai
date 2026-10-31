// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn(async () => ({
    status: 200,
    ok: true,
    json: async () => ({ status: "active", plan: "pro", ai_credits: 50 }),
}));
vi.mock("./session.js", () => ({ getSessionToken: async () => "tok" }));
vi.mock("./config/keys.js", () => ({ getConvexSiteUrl: () => "https://example.test" }));
vi.mock("./crypto-transport.js", () => ({ encryptedFetch: fetchMock }));

describe("checkAccountStatus", () => {
    it("reuses a fresh allowed status instead of fetching every turn", async () => {
        process.env.BHAI_OTPLESS_USER_ID = "u1";
        const { checkAccountStatus } = await import("./account-guard.js");
        expect(await checkAccountStatus()).toEqual({ allowed: true });
        expect(await checkAccountStatus()).toEqual({ allowed: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        vi.useFakeTimers();
        vi.setSystemTime(Date.now() + 31_000);
        await checkAccountStatus();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
    });
});
