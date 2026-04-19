// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { EditPlanSchema, VideoTrackSchema, validateEditPlan } from "../schema.js";

const VALID_PLAN = {
    projectId: "vid_2026_04_18_01",
    output: { path: "renders/final.mp4", aspect: "9:16", fps: 30, resolution: "1080x1920" },
    sources: [{ id: "s1", path: "inputs/clip1.mp4", duration: 42.1 }],
    tracks: {
        video: [{ id: "v1", source: "s1", in: 3.2, out: 8.4 }],
        audio: [{ id: "a1", source: "music/upbeat.mp3", volume: -12, duck_on_speech: true }],
        overlays: [{ type: "captions", style: "reel_karaoke", from: 0, to: 12.9, highlight_color: "#FFD700" }],
    },
    transitions: [{ between: ["v1", "v2"], type: "xfade", kind: "fade", duration: 0.5 }],
    export_targets: ["mp4"],
};

describe("EditPlanSchema", () => {
    it("accepts a fully valid plan", () => {
        expect(EditPlanSchema.safeParse(VALID_PLAN).success).toBe(true);
    });

    it("accepts optional video fields speed, crop, effects", () => {
        const plan = structuredClone(VALID_PLAN);
        Object.assign(plan.tracks.video[0], { speed: 1.5, crop: "auto_face", effects: ["bg_replace:beach.jpg"] });
        expect(EditPlanSchema.safeParse(plan).success).toBe(true);
    });

    it("rejects a plan missing projectId", () => {
        const bad = { ...VALID_PLAN, projectId: undefined };
        const result = EditPlanSchema.safeParse(bad);
        expect(result.success).toBe(false);
        if (!result.success) {
            const paths = result.error.issues.map((i) => i.path.join("."));
            expect(paths.some((p) => p.includes("projectId"))).toBe(true);
        }
    });

    it("rejects an invalid aspect ratio", () => {
        const bad = structuredClone(VALID_PLAN);
        bad.output.aspect = "3:2" as never;
        expect(EditPlanSchema.safeParse(bad).success).toBe(false);
    });

    it("rejects an unknown export_target value", () => {
        const bad = structuredClone(VALID_PLAN);
        (bad as { export_targets: string[] }).export_targets = ["avi"];
        expect(EditPlanSchema.safeParse(bad).success).toBe(false);
    });

    it("rejects resolution that does not match WxH pattern", () => {
        const bad = structuredClone(VALID_PLAN);
        bad.output.resolution = "fullhd";
        expect(EditPlanSchema.safeParse(bad).success).toBe(false);
    });

    it("accepts crop: auto_face", () => {
        const plan = structuredClone(VALID_PLAN);
        Object.assign(plan.tracks.video[0], { crop: "auto_face" });
        expect(EditPlanSchema.safeParse(plan).success).toBe(true);
    });

    it("accepts crop: coordinate string matching N:N:N:N", () => {
        const plan = structuredClone(VALID_PLAN);
        Object.assign(plan.tracks.video[0], { crop: "0:0:1920:1080" });
        expect(EditPlanSchema.safeParse(plan).success).toBe(true);
    });

    it("rejects crop: arbitrary string that is not auto_face or N:N:N:N", () => {
        const plan = structuredClone(VALID_PLAN);
        Object.assign(plan.tracks.video[0], { crop: "garbage_value" });
        expect(EditPlanSchema.safeParse(plan).success).toBe(false);
    });
});

describe("VideoTrackSchema export", () => {
    it("VideoTrackSchema is exported and parses a valid track", () => {
        const result = VideoTrackSchema.safeParse({ id: "v1", source: "s1", in: 0, out: 5 });
        expect(result.success).toBe(true);
    });
});

describe("EditPlanSchema overlay discriminated union", () => {
    it("accepts a captions overlay with required fields", () => {
        const plan = structuredClone(VALID_PLAN);
        plan.tracks.overlays = [
            { type: "captions", style: "reel_karaoke", from: 0, to: 10, highlight_color: "#fff" },
        ] as never;
        expect(EditPlanSchema.safeParse(plan).success).toBe(true);
    });

    it("accepts a text overlay with required fields", () => {
        const plan = structuredClone(VALID_PLAN);
        plan.tracks.overlays = [{ type: "text", content: "Hello", from: 0, to: 5, x: 100, y: 200 }] as never;
        expect(EditPlanSchema.safeParse(plan).success).toBe(true);
    });

    it("accepts a sticker overlay with required fields", () => {
        const plan = structuredClone(VALID_PLAN);
        plan.tracks.overlays = [{ type: "sticker", asset: "fire.gif", from: 1, to: 3, x: 50, y: 50 }] as never;
        expect(EditPlanSchema.safeParse(plan).success).toBe(true);
    });

    it("rejects a captions overlay missing highlight_color", () => {
        const plan = structuredClone(VALID_PLAN);
        plan.tracks.overlays = [{ type: "captions", style: "reel_karaoke", from: 0, to: 10 }] as never;
        expect(EditPlanSchema.safeParse(plan).success).toBe(false);
    });

    it("rejects a text overlay missing content", () => {
        const plan = structuredClone(VALID_PLAN);
        plan.tracks.overlays = [{ type: "text", from: 0, to: 5, x: 0, y: 0 }] as never;
        expect(EditPlanSchema.safeParse(plan).success).toBe(false);
    });
});

describe("validateEditPlan", () => {
    it("returns ok:true with typed plan on valid input", () => {
        const r = validateEditPlan(VALID_PLAN);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.plan.projectId).toBe("vid_2026_04_18_01");
    });

    it("returns ok:false with human-readable errors on invalid input", () => {
        const r = validateEditPlan({ projectId: 42 });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.errors.length).toBeGreaterThan(0);
            expect(typeof r.errors[0]).toBe("string");
        }
    });
});
