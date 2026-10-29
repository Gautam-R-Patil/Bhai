// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { z } from "zod";

const OutputSchema = z.object({
    aspect: z.enum(["16:9", "9:16", "1:1", "4:5"]),
    fps: z.number().int().positive(),
    path: z.string().min(1),
    resolution: z.string().regex(/^\d+x\d+$/, "resolution must be WxH e.g. 1920x1080"),
});

const SourceSchema = z.object({
    duration: z.number().positive(),
    id: z.string().min(1),
    path: z.string().min(1),
});

export const VideoTrackSchema = z.object({
    crop: z.union([z.literal("auto_face"), z.string().regex(/^\d+:\d+:\d+:\d+$/)]).optional(),
    effects: z.array(z.string()).optional(),
    id: z.string().min(1),
    in: z.number().nonnegative(),
    out: z.number().positive(),
    source: z.string().min(1),
    speed: z.number().positive().optional(),
});

const AudioTrackSchema = z.object({
    duck_on_speech: z.boolean().optional(),
    fade_in: z.number().nonnegative().optional(),
    fade_out: z.number().nonnegative().optional(),
    id: z.string().min(1),
    source: z.string().min(1),
    sync_to_beats: z.boolean().optional(),
    volume: z.number().optional(),
});

const CaptionsOverlaySchema = z.object({
    font_family: z.string().optional(),
    font_size: z.number().positive().optional(),
    from: z.number().nonnegative(),
    highlight_color: z.string().min(1),
    position: z.enum(["top", "center", "bottom"]).optional(),
    style: z.string().min(1),
    to: z.number().positive(),
    type: z.literal("captions"),
});

const TextOverlaySchema = z.object({
    box_color: z.string().optional(),
    content: z.string().min(1),
    font_color: z.string().optional(),
    font_family: z.string().optional(),
    font_size: z.number().positive().optional(),
    from: z.number().nonnegative(),
    to: z.number().positive(),
    type: z.literal("text"),
    x: z.number(),
    y: z.number(),
});

const StickerOverlaySchema = z.object({
    asset: z.string().min(1),
    from: z.number().nonnegative(),
    scale: z.number().positive().optional(),
    to: z.number().positive(),
    type: z.literal("sticker"),
    x: z.number(),
    y: z.number(),
});

const OverlaySchema = z.discriminatedUnion("type", [CaptionsOverlaySchema, TextOverlaySchema, StickerOverlaySchema]);

const TracksSchema = z.object({
    audio: z.array(AudioTrackSchema).optional().default([]),
    overlays: z.array(OverlaySchema).optional().default([]),
    video: z.array(VideoTrackSchema).min(1),
});

const TransitionSchema = z.object({
    between: z.tuple([z.string(), z.string()]),
    duration: z.number().positive().optional(),
    kind: z.string().optional(),
    type: z.enum(["xfade", "cut"]),
});

export const EditPlanSchema = z.object({
    export_targets: z.array(z.enum(["mp4", "fcpxml"])).min(1),
    output: OutputSchema,
    projectId: z.string().min(1),
    sources: z.array(SourceSchema).min(1),
    tracks: TracksSchema,
    transitions: z.array(TransitionSchema).optional().default([]),
});

export type AudioTrack = z.infer<typeof AudioTrackSchema>;
export type CaptionsOverlay = z.infer<typeof CaptionsOverlaySchema>;
export type EditPlan = z.infer<typeof EditPlanSchema>;
export type OverlayTrack = z.infer<typeof OverlaySchema>;
export type Source = z.infer<typeof SourceSchema>;
export type StickerOverlay = z.infer<typeof StickerOverlaySchema>;
export type TextOverlay = z.infer<typeof TextOverlaySchema>;
export type Transition = z.infer<typeof TransitionSchema>;
export type VideoTrack = z.infer<typeof VideoTrackSchema>;

export type ValidateResult = { ok: true; plan: EditPlan } | { ok: false; errors: string[] };

export function validateEditPlan(raw: unknown): ValidateResult {
    const result = EditPlanSchema.safeParse(raw);
    if (result.success) {
        return { ok: true, plan: result.data };
    }
    const errors = result.error.issues.map((issue) => {
        const issuePath = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `${issuePath}: ${issue.message}`;
    });
    return { ok: false, errors };
}
