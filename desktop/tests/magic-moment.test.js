// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";

const mod = await import("../components/magic-moment.js");
const { pickObservations } = mod.default || mod;

describe("pickObservations", () => {
    it("returns at least one observation even with empty state", () => {
        const obs = pickObservations({});
        expect(obs.length).toBeGreaterThan(0);
        expect(obs[0]).toHaveProperty("observation");
        expect(obs[0]).toHaveProperty("followup");
    });

    it("includes a late-night observation when state.hourOfDay = late-night", () => {
        const obs = pickObservations({ hourOfDay: "late-night" });
        const found = obs.find(function (o) { return /late-night|minimal/i.test(o.observation); });
        expect(found).toBeTruthy();
    });

    it("includes a dev-cluster observation when persona = developer", () => {
        const obs = pickObservations({ profile: { persona: "developer" } });
        const found = obs.find(function (o) { return /building|codebase|terminal/i.test(o.observation); });
        expect(found).toBeTruthy();
    });

    it("caps observations at 4", () => {
        const obs = pickObservations({
            hourOfDay: "late-night",
            profile: { persona: "developer" },
            theme: "dark",
            defaultBrowser: "Chrome",
            monitorCount: 3,
        });
        expect(obs.length).toBeLessThanOrEqual(4);
    });
});
