// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditPlan } from "../../plan/schema.js";
import { snapCutsToBeats } from "../beat-sync.js";

function makePlan(clips: Array<{ id: string; in: number; out: number }>): EditPlan {
    return {
        projectId: "test",
        output: { path: "renders/out.mp4", aspect: "16:9", fps: 30, resolution: "1920x1080" },
        sources: clips.map((c) => ({ id: c.id, path: `inputs/${c.id}.mp4`, duration: c.out + 5 })),
        tracks: {
            video: clips.map((c) => ({ id: `v_${c.id}`, source: c.id, in: c.in, out: c.out })),
            audio: [],
            overlays: [],
        },
        transitions: [],
        export_targets: ["mp4"],
    } as EditPlan;
}

describe("snapCutsToBeats", () => {
    const BEATS = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0];

    it("snaps cuts to nearest beat within default 0.15s tolerance", () => {
        const plan = makePlan([{ id: "s1", in: 0.08, out: 0.98 }]);
        const result = snapCutsToBeats(plan, BEATS);
        expect(result.tracks.video[0].in).toBe(0.0);
        expect(result.tracks.video[0].out).toBe(1.0);
    });

    it("leaves cuts outside tolerance unchanged", () => {
        const plan = makePlan([{ id: "s1", in: 0.3, out: 1.8 }]);
        const result = snapCutsToBeats(plan, BEATS, 0.15);
        expect(result.tracks.video[0].in).toBeCloseTo(0.3);
        expect(result.tracks.video[0].out).toBeCloseTo(1.8);
    });

    it("respects custom tolerance", () => {
        const plan = makePlan([{ id: "s1", in: 0.3, out: 0.9 }]);
        const result = snapCutsToBeats(plan, BEATS, 0.25);
        expect(result.tracks.video[0].in).toBe(0.5);
    });

    it("returns a new object (does not mutate)", () => {
        const plan = makePlan([{ id: "s1", in: 0.08, out: 0.98 }]);
        const result = snapCutsToBeats(plan, BEATS);
        expect(result).not.toBe(plan);
        expect(plan.tracks.video[0].in).toBeCloseTo(0.08);
    });

    it("returns plan unchanged with empty beats", () => {
        const plan = makePlan([{ id: "s1", in: 0.5, out: 1.5 }]);
        const result = snapCutsToBeats(plan, []);
        expect(result.tracks.video[0].in).toBeCloseTo(0.5);
    });
});

describe("detectBeats", () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it("parses librosa JSON output from runPython", async () => {
        vi.doMock("../../util/python-sidecar.js", () => ({
            ensurePythonEnv: vi.fn().mockResolvedValue(undefined),
            runPython: vi.fn().mockResolvedValue(JSON.stringify([0.5, 1.0, 1.5])),
        }));
        const { detectBeats } = await import("../beat-sync.js");
        const beats = await detectBeats("/tmp/fake.mp3");
        expect(beats).toEqual([0.5, 1.0, 1.5]);
    });

    it("throws when runPython rejects", async () => {
        vi.doMock("../../util/python-sidecar.js", () => ({
            ensurePythonEnv: vi.fn().mockResolvedValue(undefined),
            runPython: vi.fn().mockRejectedValue(new Error("python not found")),
        }));
        const { detectBeats } = await import("../beat-sync.js");
        await expect(detectBeats("/tmp/fake.mp3")).rejects.toThrow(/beat detection failed/i);
    });
});
