// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";
import {
    parseOtplessVerifyResponse,
    isLegacyUserId,
} from "../auth-helpers.js";

describe("parseOtplessVerifyResponse", () => {
    it("returns the verified identity + session on success", () => {
        const raw = {
            session: { token: "t_abc", expiresAt: 99 },
            userId: "u_1",
            email: "a@b.com",
            phone: "+911111111111",
            name: "A",
        };
        expect(parseOtplessVerifyResponse(raw)).toEqual({
            ok: true,
            session: { token: "t_abc", expiresAt: 99 },
            userId: "u_1",
            email: "a@b.com",
            phone: "+911111111111",
            name: "A",
        });
    });

    it("returns ok:false and error on error payload", () => {
        const raw = { error: "Incorrect OTP" };
        expect(parseOtplessVerifyResponse(raw)).toEqual({ ok: false, error: "Incorrect OTP" });
    });

    it("returns ok:false when session is missing", () => {
        expect(parseOtplessVerifyResponse({ userId: "u" })).toEqual({
            ok: false,
            error: "Missing session in response",
        });
    });

    it("returns ok:false when userId is missing", () => {
        expect(parseOtplessVerifyResponse({ session: { token: "t" } })).toEqual({
            ok: false,
            error: "Missing userId in response",
        });
    });
});

describe("isLegacyUserId", () => {
    it("matches phone_*", () => { expect(isLegacyUserId("phone_9876543210")).toBe(true); });
    it("matches google_*", () => { expect(isLegacyUserId("google_a_at_b")).toBe(true); });
    it("does not match real OTPless IDs", () => {
        expect(isLegacyUserId("u_abc123")).toBe(false);
        expect(isLegacyUserId("0193aef")).toBe(false);
    });
    it("handles null/undefined", () => {
        expect(isLegacyUserId(null)).toBe(false);
        expect(isLegacyUserId(undefined)).toBe(false);
    });
});
