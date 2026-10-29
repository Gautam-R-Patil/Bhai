// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

import { describe, expect, it } from "vitest";
import { isSensitivePath } from "./sensitive-paths.js";

describe("isSensitivePath — /proc and /sys (Linux env/memory exfiltration)", () => {
    // /proc/self/environ dumps the process env (every .env token); /proc/self/mem
    // is its raw memory (decrypted vault values, session keys). The deny is
    // path-based, so it fires on every platform regardless of whether /proc exists.
    it("denies /proc/self/environ", () => {
        expect(isSensitivePath("/proc/self/environ").denied).toBe(true);
    });
    it("denies /proc/<pid>/mem and /proc/<pid>/environ", () => {
        expect(isSensitivePath("/proc/1/mem").denied).toBe(true);
        expect(isSensitivePath("/proc/12345/environ").denied).toBe(true);
    });
    it("denies anything under /sys", () => {
        expect(isSensitivePath("/sys/kernel/debug").denied).toBe(true);
    });
    it("does not over-match a sibling like /procfoo", () => {
        // Boundary guard: /proc must not deny an unrelated path that merely shares
        // the prefix string.
        expect(isSensitivePath("/procfoo/bar").denied).toBe(false);
    });
    it("still allows an ordinary path", () => {
        expect(isSensitivePath("/tmp/ok.txt").denied).toBe(false);
    });
});
