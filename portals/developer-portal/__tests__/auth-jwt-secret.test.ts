// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//
// F14: lib/auth.ts must refuse the placeholder JWT secret on import. The
// validation runs at module load time so we use vi.resetModules() + dynamic
// import per test to re-trigger the side effect.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("F14: developer-portal auth JWT secret validation", () => {
    const original = process.env.JWT_SECRET;

    beforeEach(() => {
        vi.resetModules();
        delete process.env.JWT_SECRET;
    });

    afterEach(() => {
        process.env.JWT_SECRET = original;
    });

    it("throws when JWT_SECRET is unset", async () => {
        await expect(import("../src/lib/auth")).rejects.toThrow(/JWT_SECRET/);
    });

    it("throws when JWT_SECRET contains 'change-this'", async () => {
        process.env.JWT_SECRET = "your-super-secret-jwt-key-change-this-in-production-64-chars";
        await expect(import("../src/lib/auth")).rejects.toThrow(/unsafe/i);
    });

    it("throws when JWT_SECRET is too short", async () => {
        process.env.JWT_SECRET = "shortsecret";
        await expect(import("../src/lib/auth")).rejects.toThrow(/unsafe/i);
    });

    it("loads when JWT_SECRET is a real 48-byte random value", async () => {
        process.env.JWT_SECRET = "this-is-a-deterministic-pseudo-random-test-secret-of-sufficient-length-okay";
        const mod = await import("../src/lib/auth");
        expect(typeof mod.createSession).toBe("function");
        expect(typeof mod.verifySession).toBe("function");
    });
});
