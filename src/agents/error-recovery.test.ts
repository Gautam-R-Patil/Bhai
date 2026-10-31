// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { afterEach, describe, expect, it, vi } from "vitest";
import { jitteredBackoff } from "./error-recovery.js";

const BACKOFF_MS = 2000;

afterEach(() => {
    delete process.env.BHAI_NO_RECOVERY_JITTER;
    vi.restoreAllMocks();
});

describe("jitteredBackoff — bounds", () => {
    it.each([0, 1, 2, 3, 4])("attempt=%i: every sample lies in [base, base*1.5)", (attempt) => {
        const base = BACKOFF_MS * 2 ** attempt;
        for (let i = 0; i < 1000; i++) {
            const d = jitteredBackoff(BACKOFF_MS, attempt);
            expect(d).toBeGreaterThanOrEqual(base);
            expect(d).toBeLessThan(base * 1.5);
        }
    });

    it("base doubles each attempt (lower bound = base*2^attempt)", () => {
        for (let attempt = 0; attempt <= 4; attempt++) {
            const base = BACKOFF_MS * 2 ** attempt;
            for (let i = 0; i < 100; i++) {
                expect(jitteredBackoff(BACKOFF_MS, attempt)).toBeGreaterThanOrEqual(base);
            }
        }
    });
});

describe("jitteredBackoff — decorrelation", () => {
    it("produces a spread of distinct values (lockstep broken)", () => {
        const base = BACKOFF_MS;
        const samples = Array.from({ length: 1000 }, () => jitteredBackoff(BACKOFF_MS, 0));

        expect(new Set(samples).size).toBeGreaterThan(1);

        const min = Math.min(...samples);
        const max = Math.max(...samples);
        expect(max - min).toBeGreaterThan(base * 0.25);

        for (const d of samples) {
            expect(d).toBeGreaterThanOrEqual(base);
            expect(d).toBeLessThan(base * 1.5);
        }
    });
});

describe("jitteredBackoff — Math.random extremes", () => {
    it("random=0 yields exactly base", () => {
        vi.spyOn(Math, "random").mockReturnValue(0);
        expect(jitteredBackoff(BACKOFF_MS, 2)).toBe(8000);
    });

    it("random→1 approaches base*1.5 but stays below it", () => {
        vi.spyOn(Math, "random").mockReturnValue(0.9999999);
        const base = BACKOFF_MS * 2 ** 2;
        const d = jitteredBackoff(BACKOFF_MS, 2);
        expect(d).toBeLessThan(base * 1.5);
        expect(d).toBeGreaterThan(base * 1.49);
    });
});

describe("jitteredBackoff — kill-switch", () => {
    it("BHAI_NO_RECOVERY_JITTER=true returns bare base (no randomness)", () => {
        process.env.BHAI_NO_RECOVERY_JITTER = "true";
        expect(jitteredBackoff(BACKOFF_MS, 0)).toBe(2000);
        expect(jitteredBackoff(BACKOFF_MS, 1)).toBe(4000);
        expect(jitteredBackoff(BACKOFF_MS, 2)).toBe(8000);
    });
});
