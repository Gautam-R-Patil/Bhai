// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, afterEach, vi } from "vitest";
import os from "node:os";
import { getResourceLimits } from "./system-resources.js";

// Helpers to mock os.freemem() and os.cpus() cleanly.
function mockSystem(freeMemoryBytes: number, cpuCount: number) {
    vi.spyOn(os, "freemem").mockReturnValue(freeMemoryBytes);
    // os.cpus() returns an array of objects; we only care about .length
    vi.spyOn(os, "cpus").mockReturnValue(
        Array.from({ length: cpuCount }, () => ({
            model: "mock",
            speed: 2400,
            times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
        })),
    );
}

const MB = 1024 * 1024;

describe("getResourceLimits", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("returns sane defaults on a mid-range machine (4 cores, 8 GB free)", () => {
        mockSystem(8 * 1024 * MB, 4);
        const r = getResourceLimits();
        // memoryBasedLimit: (8192-1024)/120 = 58
        // cpuBasedLimit: max(2, 4-1) = 3
        // min(8, 58, 3) = 3; max(2, 3) = 3
        expect(r.maxParallelTabs).toEqual(3);
        expect(r.cpuCount).toEqual(4);
        expect(r.freeMemoryMB).toEqual(8192);
    });

    it("caps at ABSOLUTE_MAX_TABS (8) on a massive machine", () => {
        mockSystem(128 * 1024 * MB, 64);
        const r = getResourceLimits();
        expect(r.maxParallelTabs).toEqual(8);
    });

    it("respects ABSOLUTE_MIN_TABS (2) on a tiny machine", () => {
        // Very low memory: free is 1.5GB, after reservation only 512 MB for tabs → 4 tabs memory-wise
        // but 1 CPU → cpu limit max(2, 1-1)=2
        mockSystem(Math.round(1.5 * 1024) * MB, 1);
        const r = getResourceLimits();
        expect(r.maxParallelTabs).toEqual(2);
    });

    it("floors to 2 even when memory is so tight memoryBasedLimit is 0", () => {
        // Free memory below reserved threshold → availableForTabs = 0 → memoryBasedLimit = 0
        mockSystem(500 * MB, 8);
        const r = getResourceLimits();
        expect(r.maxParallelTabs).toEqual(2);
    });

    it("floors to 2 when memory is exactly at the reserved threshold", () => {
        mockSystem(1024 * MB, 8);
        const r = getResourceLimits();
        // availableForTabs = 1024 - 1024 = 0 → memoryBasedLimit = 0 → floored to min 2
        expect(r.maxParallelTabs).toEqual(2);
    });

    it("prefers CPU limit when CPU is the bottleneck", () => {
        // Abundant memory, but only 3 CPUs → cpu-based: max(2, 3-1) = 2
        mockSystem(32 * 1024 * MB, 3);
        const r = getResourceLimits();
        expect(r.maxParallelTabs).toEqual(2); // cpu-based cap
    });

    it("prefers memory limit when memory is the bottleneck", () => {
        // Lots of CPUs, just 1.3 GB free → only 300 MB for tabs → 2 tabs (120 MB each)
        mockSystem(Math.round(1.3 * 1024) * MB, 32);
        const r = getResourceLimits();
        expect(r.maxParallelTabs).toEqual(2); // memory-based or floored to 2
    });

    it("returns a reason string that includes all three metrics", () => {
        mockSystem(4 * 1024 * MB, 4);
        const r = getResourceLimits();
        expect(r.reason).toContain(`${r.freeMemoryMB}MB`);
        expect(r.reason).toContain(`CPUs: ${r.cpuCount}`);
        expect(r.reason).toContain(`tab limit: ${r.maxParallelTabs}`);
    });

    it("freeMemoryMB is rounded to nearest MB", () => {
        mockSystem(1_555_555_555, 2); // ~1483.47 MB
        const r = getResourceLimits();
        // Math.round(1555555555 / (1024*1024)) = 1483
        expect(r.freeMemoryMB).toEqual(1483);
    });

    it("cpuBasedLimit uses cpuCount-1 (reserves one for main process)", () => {
        // 5 CPUs, abundant memory → cpu-based limit is max(2, 5-1)=4
        mockSystem(32 * 1024 * MB, 5);
        const r = getResourceLimits();
        expect(r.maxParallelTabs).toEqual(4);
    });
});
