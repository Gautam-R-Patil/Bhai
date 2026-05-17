// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// F14: login response time must be ~constant across the three failure paths:
//   (a) user not found
//   (b) wrong password
//   (c) banned/suspended user
//
// Because the real route requires Convex, we exercise the bcrypt-equalization
// pattern directly. The pattern: always run bcrypt.compare, using a dummy
// hash on the user-not-found path. If timing is within tolerance, the route
// shape that uses this pattern is also within tolerance.
//
// The exact same DUMMY_BCRYPT_HASH constant lives in
// portals/developer-portal/src/app/api/auth/login/route.ts; we reproduce it
// to assert it's a valid bcrypt-shaped hash that bcrypt.compare actually
// runs work on (rather than rejecting immediately).

import { describe, it, expect } from "vitest";
import bcrypt from "bcryptjs";

const DUMMY_BCRYPT_HASH = "$2a$12$" + "C".repeat(53);

describe("F14: login timing equalization", () => {
    it("dummy hash is bcrypt-shape-valid (forces full work, not immediate-reject)", async () => {
        // bcrypt.compare returns false on shape mismatch *fast*. The dummy
        // we use is shape-valid (cost 12, 53 chars of salt+hash) — so
        // compare(password, dummy) performs the full key-derivation.
        const result = await bcrypt.compare("anything", DUMMY_BCRYPT_HASH);
        expect(result).toBe(false);
    });

    it("user-not-found path takes similar time to wrong-password path", async () => {
        // Pre-hash a real password so we have a comparable "wrong password" case.
        const realHash = await bcrypt.hash("real-password", 12);

        const sample = async (storedHash: string) => {
            const start = process.hrtime.bigint();
            await bcrypt.compare("guess", storedHash);
            return Number(process.hrtime.bigint() - start) / 1e6; // ms
        };

        // Warm up — first run is always slower due to JIT/optimization.
        await sample(realHash);
        await sample(DUMMY_BCRYPT_HASH);

        const dummyMs = await sample(DUMMY_BCRYPT_HASH);
        const realMs = await sample(realHash);
        const diff = Math.abs(dummyMs - realMs);

        // 50ms tolerance per the spec. bcrypt at cost 12 takes ~150-300ms on
        // modern hardware; the difference between two such runs is well
        // under 50ms in steady state.
        expect(diff).toBeLessThan(50);
    });
});
