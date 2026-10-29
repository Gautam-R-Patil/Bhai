// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The decay MATH (DB round-trip is CI-only). LAMBDA=0.02/day, cap 14 days,
// prune < 0.1. Incremental from the anchor must converge to one full-gap decay.
import { describe, expect, it } from "vitest";
import { computeTraitDecay } from "./traits.js";

const DAY = 86_400_000;

describe("computeTraitDecay", () => {
    it("a just-reinforced trait (anchor == now) does not decay", () => {
        const now = 1_000 * DAY;
        expect(computeTraitDecay(0.9, now, now, now).action).toBe("none");
    });

    it("decays a mid-confidence trait that the old min() cap never touched (0.65, 10 days)", () => {
        const now = 1_000 * DAY;
        const d = computeTraitDecay(0.65, now - 10 * DAY, null, now);
        expect(d.action).toBe("update");
        expect(d.newConfidence).toBeCloseTo(0.65 * Math.exp(-0.02 * 10), 6); // ~0.532
    });

    it("prunes once it falls below 0.1", () => {
        const now = 1_000 * DAY;
        // start low and idle the full 14-day cap repeatedly
        let conf = 0.13;
        let anchor = now - 14 * DAY;
        let t = now;
        for (let i = 0; i < 20; i++) {
            const d = computeTraitDecay(conf, anchor, null, t);
            if (d.action === "prune") { conf = d.newConfidence; break; }
            if (d.action === "update") conf = d.newConfidence;
            t += 14 * DAY; anchor = t - 14 * DAY;
        }
        expect(conf).toBeLessThan(0.1);
    });

    it("incremental decay converges to one full-gap decay (does not compound)", () => {
        const start = 1_000 * DAY;
        const totalGap = 12; // days, under the 14 cap
        // One shot over the full gap:
        const oneShot = computeTraitDecay(0.8, start, null, start + totalGap * DAY).newConfidence;
        // Many runs (3x/day), advancing last_decay each time:
        let conf = 0.8;
        let lastDecay: number | null = null;
        const lastSeen = start;
        for (let step = 1; step <= totalGap * 3; step++) {
            const now = start + (step * DAY) / 3;
            const d = computeTraitDecay(conf, lastSeen, lastDecay, now);
            if (d.action === "update") { conf = d.newConfidence; lastDecay = now; }
        }
        expect(conf).toBeCloseTo(oneShot, 4); // telescopes, no quadratic compounding
    });
});
