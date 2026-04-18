// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { z } from "zod";

const OutputSchema = z.object({
    path: z.string().min(1),
    aspect: z.enum(["16:9", "9:16", "1:1", "4:5"]),
    fps: z.number().int().positive(),
    resolution: z.string().regex(/^\d+x\d+$/, "resolution must be WxH e.g. 1920x1080"),
});

const SourceSchema = z.object({
    id: z.string().min(1),
    path: z.string().min(1),
    duration: z.number().positive(),
});

const VideoTrackSchema = z.object({
    id: z.string().min(1),
    source: z.string().min(1),
    in: z.number().nonnegative(),
    out: z.number().positive(),
    speed: z.number().positive().optional(),
    crop: z.string().optional(),
    effects: z.array(z.string()).optional(),
});

const AudioTrackSchema = z.object({
    id: z.string().min(1),
    source: z.string().min(1),
    volume: z.number().optional(),
    duck_on_speech: z.boolean().optional(),
    sync_to_beats: z.boolean().optional(),
    fade_in: z.number().nonnegative().optional(),
    fade_out: z.number().nonnegative().optional(),
});

const CaptionsOverlaySchema = z.object({
    type: z.literal("captions"),
    style: z.string().min(1),
    from: z.number().nonnegative(),
    to: z.number().positive(),
    highlight_color: z.string().min(1),
    font_size: z.number().positive().optional(),
    font_family: z.string().optional(),
    position: z.enum(["top", "center", "bottom"]).optional(),
});

const TextOverlaySchema = z.object({
    type: z.literal("text"),
    content: z.string().min(1),
    from: z.number().nonnegative(),
    to: z.number().positive(),
    x: z.number(),
    y: z.number(),
    font_size: z.number().positive().optional(),
    font_color: z.string().optional(),
    font_family: z.string().optional(),
    box_color: z.string().optional(),
});

const StickerOverlaySchema = z.object({
    type: z.literal("sticker"),
    asset: z.string().min(1),
    from: z.number().nonnegative(),
    to: z.number().positive(),
    x: z.number(),
    y: z.number(),
    scale: z.number().positive().optional(),
});

const OverlaySchema = z.discriminatedUnion("type", [CaptionsOverlaySchema, TextOverlaySchema, StickerOverlaySchema]);

const TracksSchema = z.object({
    video: z.array(VideoTrackSchema).min(1),
    audio: z.array(AudioTrackSchema).optional().default([]),
    overlays: z.array(OverlaySchema).optional().default([]),
});

const TransitionSchema = z.object({
    between: z.tuple([z.string(), z.string()]),
    type: z.enum(["xfade", "cut"]),
    kind: z.string().optional(),
    duration: z.number().positive().optional(),
});

export const EditPlanSchema = z.object({
    projectId: z.string().min(1),
    output: OutputSchema,
    sources: z.array(SourceSchema).min(1),
    tracks: TracksSchema,
    transitions: z.array(TransitionSchema).optional().default([]),
    export_targets: z.array(z.enum(["mp4", "fcpxml"])).min(1),
});

export type EditPlan = z.infer<typeof EditPlanSchema>;
export type VideoTrack = z.infer<typeof VideoTrackSchema>;
export type AudioTrack = z.infer<typeof AudioTrackSchema>;
export type OverlayTrack = z.infer<typeof OverlaySchema>;
export type CaptionsOverlay = z.infer<typeof CaptionsOverlaySchema>;
export type TextOverlay = z.infer<typeof TextOverlaySchema>;
export type StickerOverlay = z.infer<typeof StickerOverlaySchema>;
export type Transition = z.infer<typeof TransitionSchema>;
export type Source = z.infer<typeof SourceSchema>;

export type ValidateResult = { ok: true; plan: EditPlan } | { ok: false; errors: string[] };

export function validateEditPlan(raw: unknown): ValidateResult {
    const result = EditPlanSchema.safeParse(raw);
    if (result.success) {
        return { ok: true, plan: result.data };
    }
    const errors = result.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `${path}: ${issue.message}`;
    });
    return { ok: false, errors };
}
