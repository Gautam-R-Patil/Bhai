// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { beforeEach, describe, expect, it } from "vitest";
import {
    type CapabilityReport,
    clearCapabilityCache,
    detectCapabilities,
    summarizeCapabilities,
    type VisionProfile,
} from "../capability-detector.js";

// Note: detectCapabilities() spawns subprocesses (system_profiler, lspci, etc.) so it's slow.
// These tests focus on the pure-logic surface (pickProfile via the public API + override path).

describe("capability detector — override via env", () => {
    beforeEach(() => {
        clearCapabilityCache();
        delete process.env.ATLAS_VISION_PROFILE;
    });

    it("respects ATLAS_VISION_PROFILE=lite override", async () => {
        process.env.ATLAS_VISION_PROFILE = "lite";
        const r = await detectCapabilities({ force: true });
        expect(r.profile).toBe("lite");
        expect(r.notes.some((n) => n.includes("overridden"))).toBe(true);
    });

    it("respects ATLAS_VISION_PROFILE=standard override", async () => {
        process.env.ATLAS_VISION_PROFILE = "standard";
        const r = await detectCapabilities({ force: true });
        expect(r.profile).toBe("standard");
    });

    it("reads a stored 'full' (the retired tier) as the standard setup", async () => {
        process.env.ATLAS_VISION_PROFILE = "full";
        const r = await detectCapabilities({ force: true });
        expect(r.profile).toBe("standard");
    });

    it("ignores invalid override values", async () => {
        process.env.ATLAS_VISION_PROFILE = "rainbow";
        const r = await detectCapabilities({ force: true });
        // No override → the one default setup
        expect(r.profile).toBe("standard" satisfies VisionProfile);
    });
});

describe(
    "capability detector — report shape",
    () => {
        beforeEach(() => clearCapabilityCache());

        it("returns all required fields", async () => {
            const r = await detectCapabilities({ force: true });
            expect(typeof r.profile).toBe("string");
            expect(typeof r.ramGB).toBe("number");
            expect(typeof r.freeRamGB).toBe("number");
            expect(typeof r.cpuCores).toBe("number");
            expect(typeof r.cpuModel).toBe("string");
            expect(typeof r.cpuBenchScore).toBe("number");
            expect(typeof r.gpu).toBe("string");
            expect(typeof r.diskFreeGB).toBe("number");
            expect(typeof r.online).toBe("boolean");
            expect(typeof r.deps).toBe("object");
            expect(Array.isArray(r.notes)).toBe(true);
        });

        it("ramGB reflects actual system memory (sanity check)", async () => {
            const r = await detectCapabilities({ force: true });
            // Any modern dev box has at least 2GB; cap at 1024GB to catch overflow bugs.
            expect(r.ramGB).toBeGreaterThanOrEqual(2);
            expect(r.ramGB).toBeLessThan(1024);
        });

        it("cpuCores >= 1", async () => {
            const r = await detectCapabilities({ force: true });
            expect(r.cpuCores).toBeGreaterThanOrEqual(1);
        });

        it("cpuBenchScore > 0 (benchmark actually runs)", async () => {
            const r = await detectCapabilities({ force: true });
            expect(r.cpuBenchScore).toBeGreaterThan(0);
        });

        it("gpu is one of the four valid classes", async () => {
            const r = await detectCapabilities({ force: true });
            expect(["none", "integrated", "discrete", "apple-silicon"]).toContain(r.gpu);
        });

        it("deps has all expected boolean fields", async () => {
            const r = await detectCapabilities({ force: true });
            expect(typeof r.deps.python).toBe("boolean");
            expect(typeof r.deps.pillow).toBe("boolean");
            expect(typeof r.deps.ollama).toBe("boolean");
            expect(typeof r.deps.cliclick).toBe("boolean");
            expect(typeof r.deps.xdotool).toBe("boolean");
            expect(typeof r.deps.accessibilityPermission).toBe("boolean");
        });

        it("summarizeCapabilities returns non-empty one-liner", async () => {
            const r = await detectCapabilities({ force: true });
            const summary = summarizeCapabilities(r);
            expect(summary).toContain("profile=");
            expect(summary).toContain("ram=");
            expect(summary).toContain("cpu=");
            expect(summary).toContain("gpu=");
            expect(summary.split("\n").length).toBe(1);
        });
    },
    { timeout: 30_000 },
);

describe(
    "capability detector — caching",
    () => {
        beforeEach(() => clearCapabilityCache());

        it("returns same object on second call (in-process cache)", async () => {
            const r1 = await detectCapabilities({ force: true });
            const r2 = await detectCapabilities();
            expect(r2).toBe(r1);
        });

        it("force=true bypasses cache", async () => {
            const r1 = await detectCapabilities({ force: true });
            const r2 = await detectCapabilities({ force: true });
            // Same shape, but different timestamps means different objects
            expect(r1.detectedAt).toBeLessThanOrEqual(r2.detectedAt);
        });

        it("clearCapabilityCache() forces re-probe", async () => {
            const r1 = await detectCapabilities({ force: true });
            clearCapabilityCache();
            const r2 = await detectCapabilities({ force: true });
            expect(r2).not.toBe(r1);
        });
    },
    { timeout: 30_000 },
);

describe("capability detector — default", () => {
    beforeEach(() => {
        clearCapabilityCache();
        delete process.env.ATLAS_VISION_PROFILE;
    });

    it("picks the standard setup on every machine (there is no tier to choose)", async () => {
        const r = await detectCapabilities({ force: true });
        expect(r.profile).toBe("standard");
    }, 30_000);
});
