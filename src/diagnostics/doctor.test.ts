// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DoctorCheck, formatDoctor, runDoctor } from "./doctor.js";

describe("runDoctor", () => {
    beforeEach(() => {
        process.env.ATLAS_NO_DOCTOR_NETWORK = "true"; // keep it offline + fast
    });
    afterEach(() => {
        delete process.env.ATLAS_NO_DOCTOR_NETWORK;
    });

    it("returns a check per probe and never throws (fail-open)", async () => {
        const checks = await runDoctor();
        expect(checks.length).toBeGreaterThanOrEqual(7);
        for (const c of checks) {
            expect(["ok", "warn", "fail"]).toContain(c.status);
            expect(typeof c.check).toBe("string");
        }
    });

    it("skips network probes when ATLAS_NO_DOCTOR_NETWORK=true", async () => {
        const checks = await runDoctor();
        const convex = checks.find((c) => c.check === "Convex reachability");
        expect(convex?.detail).toContain("skipped");
    });

    it("authed probe is skipped by default", async () => {
        const checks = await runDoctor();
        const authed = checks.find((c) => c.check.startsWith("Authed"));
        expect(authed?.detail).toContain("skipped");
    });
});

describe("formatDoctor", () => {
    it("renders status emoji, fixes, and a summary footer", () => {
        const checks: DoctorCheck[] = [
            { check: "A", status: "ok" },
            { check: "B", status: "warn", detail: "hmm", fix: "do X" },
            { check: "C", status: "fail", detail: "broke" },
        ];
        const out = formatDoctor(checks);
        expect(out).toContain("🩺");
        expect(out).toContain("✅ A");
        expect(out).toContain("⚠️ B — hmm");
        expect(out).toContain("↳ fix: do X");
        expect(out).toContain("❌ C — broke");
        expect(out).toContain("3 checks · 1 failed · 1 warnings");
    });
});
