// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { spawn } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { CropFrame } from "../effects/auto-crop.js";
import { parseEffect } from "../plan/effects.js";
import type { EditPlan, Transition } from "../plan/schema.js";
import { checkDurations, checkSourcesExist, checkTransitionBetweenExists } from "../plan/validator.js";
import { ffmpegPath } from "../util/ffmpeg-bin.js";
import { FilterComplexBuilder } from "./ffmpeg-builder.js";

export enum RenderErrorCategory {
    CodecMissing = "CodecMissing",
    InvalidFilterGraph = "InvalidFilterGraph",
    SourceUnreadable = "SourceUnreadable",
    Unknown = "Unknown",
}

export class RenderError extends Error {
    readonly category: RenderErrorCategory;
    readonly stderrExcerpt: string;
    readonly ffmpegArgs: string[];

    constructor(message: string, category: RenderErrorCategory, stderrExcerpt: string, ffmpegArgs: string[]) {
        super(message);
        this.name = "RenderError";
        this.category = category;
        this.stderrExcerpt = stderrExcerpt;
        this.ffmpegArgs = ffmpegArgs;
    }
}

export interface RenderOpts {
    onProgress?: (percent: number) => void;
    confirm?: (info: { name: string; sizeBytes: number }) => Promise<boolean>;
}

export interface RenderResult {
    outputPath: string;
    logPath: string;
}

const CODEC_MISSING = [/Decoder.*not found/i, /Encoder.*not found/i, /Unknown encoder/i, /codec.*not found/i];
const INVALID_GRAPH = [/No such filter/i, /Invalid option/i, /Error initializing.*filter/i, /filter chain/i];
const SOURCE_UNREADABLE = [/No such file or directory/i, /moov atom not found/i, /Invalid data found/i, /ENOENT/];

export function classifyRenderError(stderr: string): RenderErrorCategory {
    if (CODEC_MISSING.some((p) => p.test(stderr))) return RenderErrorCategory.CodecMissing;
    if (INVALID_GRAPH.some((p) => p.test(stderr))) return RenderErrorCategory.InvalidFilterGraph;
    if (SOURCE_UNREADABLE.some((p) => p.test(stderr))) return RenderErrorCategory.SourceUnreadable;
    return RenderErrorCategory.Unknown;
}

/**
 * Converts CropFrame[] into FFmpeg sendcmd script content.
 * Format: "<t> crop w <w>, crop h <h>, crop x <x>, crop y <y>;"
 */
export function buildSendcmdScript(cropFrames: CropFrame[]): string {
    if (cropFrames.length === 0) return "";
    return cropFrames.map((f) => `${f.t} crop w ${f.w}, crop h ${f.h}, crop x ${f.x}, crop y ${f.y};`).join("\n");
}

function absPath(p: string, root: string): string {
    return isAbsolute(p) ? p : resolve(root, p);
}

interface Compiled {
    inputs: string[];
    filterGraph: string;
    outputVideoLabel: string;
    outputAudioLabel: string;
    outputPath: string;
}

function compilePlan(plan: EditPlan, projectRoot: string): Compiled {
    const builder = new FilterComplexBuilder();
    const sourceInfo = new Map(plan.sources.map((s, i) => [s.id, { idx: i, path: absPath(s.path, projectRoot) }]));
    const inputs = plan.sources.map((s) => absPath(s.path, projectRoot));

    const videoLabels = new Map<string, string>();
    for (const clip of plan.tracks.video) {
        const info = sourceInfo.get(clip.source);
        if (!info) continue;
        const label = builder.addTrim(info.idx, clip.in, clip.out);
        videoLabels.set(clip.id, label);
    }

    const transitionMap = new Map((plan.transitions ?? []).map((tx) => [`${tx.between[0]}_${tx.between[1]}`, tx]));

    const clipIds = plan.tracks.video.map((v) => v.id);
    const firstLabel = videoLabels.get(clipIds[0]);
    if (!firstLabel) {
        throw new RenderError(
            "compilePlan: no video labels produced from plan",
            RenderErrorCategory.InvalidFilterGraph,
            "",
            [],
        );
    }
    let finalVideoLabel: string = firstLabel;

    for (let i = 1; i < clipIds.length; i++) {
        const prevId = clipIds[i - 1];
        const currId = clipIds[i];
        const tx: Transition | undefined = transitionMap.get(`${prevId}_${currId}`);
        const currLabel = videoLabels.get(currId);
        if (!currLabel) continue;

        if (tx?.type === "xfade" && tx.duration !== undefined) {
            const prevClip = plan.tracks.video.find((v) => v.id === prevId);
            const prevLen = prevClip ? prevClip.out - prevClip.in : 0;
            const offset = Math.max(0, prevLen - tx.duration);
            finalVideoLabel = builder.addXfade(finalVideoLabel, currLabel, tx.kind ?? "fade", tx.duration, offset);
        } else {
            finalVideoLabel = builder.addConcat([finalVideoLabel, currLabel]);
        }
    }

    for (const overlay of plan.tracks.overlays ?? []) {
        if (overlay.type === "text") {
            finalVideoLabel = builder.addDrawtext(finalVideoLabel, overlay.content, {
                fontsize: overlay.font_size,
                fontcolor: overlay.font_color ?? "white",
                x: overlay.x,
                y: overlay.y,
                enable: `between(t,${overlay.from},${overlay.to})`,
            });
        }
    }

    builder.setOutputVideoLabel(finalVideoLabel);

    let finalAudioLabel = "";
    const audioTracks = plan.tracks.audio ?? [];
    if (audioTracks.length > 0) {
        for (const at of audioTracks) inputs.push(absPath(at.source, projectRoot));
        const audioLabels = audioTracks.map((_, i) => `[${plan.sources.length + i}:a]`);
        finalAudioLabel = builder.addAudioMix(audioLabels, { normalize: false });
        builder.setOutputAudioLabel(finalAudioLabel);
    }

    const { filterGraph, outputLabels } = builder.build();

    return {
        inputs,
        filterGraph,
        outputVideoLabel: outputLabels.video,
        outputAudioLabel: outputLabels.audio,
        outputPath: absPath(plan.output.path, projectRoot),
    };
}

/**
 * Async variant of compilePlan.
 * Handles clip.crop === "auto_face" by running face detection + EMA smoothing
 * + writing a sendcmd script. Other clips pass through unchanged.
 *
 * Also dispatches per-clip `effects` strings via parseEffect:
 *   - "bg_replace:<path>" → generateAlphaMatte + addAlphaMerge
 *   - "color_grade:<preset>" → addColorGrade
 *   - "stabilize" / "stylize:..." → warn + skip (Phase 2 not implemented)
 */
export async function compilePlanAsync(
    plan: EditPlan,
    projectRoot: string,
    opts: { confirm?: (info: { name: string; sizeBytes: number }) => Promise<boolean> } = {},
): Promise<Compiled> {
    const builder = new FilterComplexBuilder();
    const sourceInfo = new Map(plan.sources.map((s, i) => [s.id, { idx: i, path: absPath(s.path, projectRoot) }]));
    const inputs = plan.sources.map((s) => absPath(s.path, projectRoot));
    const ts = Date.now();

    const rendersDir = resolve(projectRoot, "renders");
    await fs.mkdir(rendersDir, { recursive: true });

    const videoLabels = new Map<string, string>();

    for (const clip of plan.tracks.video) {
        const info = sourceInfo.get(clip.source);
        if (!info) continue;

        const trimmedLabel = builder.addTrim(info.idx, clip.in, clip.out);

        let currentLabel: string;

        if (clip.crop === "auto_face") {
            const { detectFaces } = await import("../analyze/face-track.js");
            const { computeAutoCrop } = await import("../effects/auto-crop.js");
            const { probeVideoMetadata } = await import("../analyze/timeline-builder.js");

            const meta = await probeVideoMetadata(info.path);
            const faceTrack = await detectFaces(info.path, projectRoot);
            const cropFrames = computeAutoCrop(faceTrack, {
                targetAspect: plan.output.aspect as "1:1" | "4:5" | "9:16",
                inputWidth: meta.width,
                inputHeight: meta.height,
            });

            const sendcmdContent = buildSendcmdScript(cropFrames);
            const sendcmdPath = join(rendersDir, `sendcmd-${ts}-${clip.id}.txt`);
            await fs.writeFile(sendcmdPath, sendcmdContent, "utf-8");

            const first = cropFrames[0];
            const initialCrop = first
                ? `${first.w}:${first.h}:${first.x}:${first.y}`
                : `${meta.width}:${meta.height}:0:0`;

            currentLabel = builder.addAutoCrop(trimmedLabel, sendcmdPath, initialCrop);
        } else {
            currentLabel = trimmedLabel;
        }

        for (const raw of clip.effects ?? []) {
            const directive = parseEffect(raw);
            if (!directive) {
                console.warn(`[video-studio] Unrecognized effect '${raw}', skipping`);
                continue;
            }

            if (directive.kind === "bg_replace") {
                const { generateAlphaMatte } = await import("../effects/bg-remove.js");
                const mattePath = await generateAlphaMatte(info.path, projectRoot, { confirm: opts.confirm });
                const bgPath = absPath(directive.asset, projectRoot);

                const matteInputIdx = inputs.length;
                inputs.push(mattePath);
                const bgInputIdx = inputs.length;
                inputs.push(bgPath);

                currentLabel = builder.addAlphaMerge(currentLabel, `[${matteInputIdx}:v]`, `[${bgInputIdx}:v]`);
            } else if (directive.kind === "color_grade") {
                const preset = directive.preset as "cool" | "mono" | "vintage" | "warm";
                if (preset !== "cool" && preset !== "mono" && preset !== "vintage" && preset !== "warm") {
                    console.warn(`[video-studio] Unknown color_grade preset '${directive.preset}', skipping`);
                    continue;
                }
                currentLabel = builder.addColorGrade(currentLabel, preset);
            } else if (directive.kind === "stabilize") {
                console.warn("[video-studio] stabilize effect is not yet implemented in Phase 2, skipping");
            } else if (directive.kind === "stylize") {
                console.warn("[video-studio] stylize effect is not yet implemented in Phase 2, skipping");
            }
        }

        videoLabels.set(clip.id, currentLabel);
    }

    const transitionMap = new Map((plan.transitions ?? []).map((tx) => [`${tx.between[0]}_${tx.between[1]}`, tx]));
    const clipIds = plan.tracks.video.map((v) => v.id);
    const firstLabel = videoLabels.get(clipIds[0]);
    if (!firstLabel) {
        throw new RenderError(
            "compilePlanAsync: no video labels produced from plan",
            RenderErrorCategory.InvalidFilterGraph,
            "",
            [],
        );
    }
    let finalVideoLabel: string = firstLabel;

    for (let i = 1; i < clipIds.length; i++) {
        const prevId = clipIds[i - 1];
        const currId = clipIds[i];
        const tx: Transition | undefined = transitionMap.get(`${prevId}_${currId}`);
        const currLabel = videoLabels.get(currId);
        if (!currLabel) continue;
        if (tx?.type === "xfade" && tx.duration !== undefined) {
            const prevClip = plan.tracks.video.find((v) => v.id === prevId);
            const prevLen = prevClip ? prevClip.out - prevClip.in : 0;
            const offset = Math.max(0, prevLen - tx.duration);
            finalVideoLabel = builder.addXfade(finalVideoLabel, currLabel, tx.kind ?? "fade", tx.duration, offset);
        } else {
            finalVideoLabel = builder.addConcat([finalVideoLabel, currLabel]);
        }
    }

    for (const overlay of plan.tracks.overlays ?? []) {
        if (overlay.type === "text") {
            finalVideoLabel = builder.addDrawtext(finalVideoLabel, overlay.content, {
                fontsize: overlay.font_size,
                fontcolor: overlay.font_color ?? "white",
                x: overlay.x,
                y: overlay.y,
                enable: `between(t,${overlay.from},${overlay.to})`,
            });
        }
    }

    builder.setOutputVideoLabel(finalVideoLabel);

    let finalAudioLabel = "";
    const audioTracks = plan.tracks.audio ?? [];
    if (audioTracks.length > 0) {
        for (const at of audioTracks) inputs.push(absPath(at.source, projectRoot));
        const audioLabels = audioTracks.map((_, idx) => `[${plan.sources.length + idx}:a]`);
        finalAudioLabel = builder.addAudioMix(audioLabels, { normalize: false });
        builder.setOutputAudioLabel(finalAudioLabel);
    }

    const { filterGraph, outputLabels } = builder.build();

    return {
        inputs,
        filterGraph,
        outputVideoLabel: outputLabels.video,
        outputAudioLabel: outputLabels.audio,
        outputPath: absPath(plan.output.path, projectRoot),
    };
}

function buildArgs(compiled: Compiled, plan: EditPlan, progressPath: string): string[] {
    const args: string[] = [];
    const [w, h] = plan.output.resolution.split("x").map(Number);

    for (const inp of compiled.inputs) args.push("-i", inp);

    // If the plan has no audio tracks, add a silent audio source as an extra input
    // so the output has an audio stream. Input options MUST come before any output
    // options (like -map), so we declare this BEFORE -filter_complex / -map.
    const silentAudioInputIdx = compiled.outputAudioLabel ? -1 : compiled.inputs.length;
    if (!compiled.outputAudioLabel) {
        args.push("-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo");
    }

    // When using filter_complex, -vf cannot apply to the same mapped stream. Append
    // a scale filter to the filter_complex graph if we have a graph+label to extend;
    // otherwise scale via -vf on the raw 0:v input.
    let mappedVideoLabel = compiled.outputVideoLabel;
    let filterGraph = compiled.filterGraph;
    if (filterGraph && mappedVideoLabel) {
        const scaledLabel = "[vout]";
        filterGraph = `${filterGraph};${mappedVideoLabel}scale=${w}:${h}${scaledLabel}`;
        mappedVideoLabel = scaledLabel;
    }

    if (filterGraph) {
        args.push("-filter_complex", filterGraph);
    }

    args.push("-map", mappedVideoLabel || "0:v");

    if (compiled.outputAudioLabel) {
        args.push("-map", compiled.outputAudioLabel);
    } else {
        args.push("-map", `${silentAudioInputIdx}:a`);
    }

    const outputArgs: string[] = ["-c:v", "libx264", "-preset", "fast", "-crf", "23"];
    if (!filterGraph) {
        outputArgs.push("-vf", `scale=${w}:${h}`);
    }
    outputArgs.push(
        "-r",
        String(plan.output.fps),
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-shortest",
        "-movflags",
        "+faststart",
        "-progress",
        progressPath,
        "-y",
        compiled.outputPath,
    );
    args.push(...outputArgs);

    return args;
}

function simplifyPlan(plan: EditPlan): EditPlan {
    return {
        ...plan,
        transitions: (plan.transitions ?? []).map((tx) => ({ ...tx, type: "cut" as const })),
        tracks: {
            ...plan.tracks,
            video: plan.tracks.video.map((v) => ({ ...v, effects: undefined })),
        },
    };
}

async function runFFmpeg(
    binPath: string,
    args: string[],
    logPath: string,
    totalDuration: number,
    onProgress?: (pct: number) => void,
): Promise<void> {
    await fs.mkdir(dirname(logPath), { recursive: true });
    const log = createWriteStream(logPath, { flags: "w" });
    let stderr = "";

    return new Promise<void>((res, rej) => {
        const proc = spawn(binPath, args, { stdio: ["ignore", "pipe", "pipe"] });

        proc.stderr?.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf-8");
            log.write(text);
            stderr = (stderr + text).slice(-8192);
        });

        // Progress is routed to stdout via `-progress pipe:1`. Parse out_time_ms=
        // to derive a percentage. Log stdout too for completeness.
        proc.stdout?.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf-8");
            log.write(text);
            if (onProgress && totalDuration > 0) {
                const matches = text.matchAll(/out_time_ms=(\d+)/g);
                for (const m of matches) {
                    const secs = Number.parseInt(m[1], 10) / 1_000_000;
                    onProgress(Math.min(100, Math.round((secs / totalDuration) * 100)));
                }
            }
        });

        proc.on("close", (code) => {
            log.end();
            if (code === 0) {
                res();
            } else {
                rej(
                    new RenderError(
                        `ffmpeg exited with code ${code}`,
                        classifyRenderError(stderr),
                        stderr.slice(-2000),
                        args,
                    ),
                );
            }
        });

        proc.on("error", (err) => {
            log.end();
            rej(new RenderError(`ffmpeg spawn error: ${err.message}`, RenderErrorCategory.Unknown, err.message, args));
        });
    });
}

export async function renderPlan(plan: EditPlan, projectRoot: string, opts: RenderOpts = {}): Promise<RenderResult> {
    const sc = await checkSourcesExist(plan, projectRoot);
    if (!sc.ok) {
        throw new RenderError(
            `Pre-render: ${sc.errors.join("; ")}`,
            RenderErrorCategory.SourceUnreadable,
            sc.errors.join("\n"),
            [],
        );
    }

    const dc = checkDurations(plan);
    if (!dc.ok) {
        throw new RenderError(
            `Pre-render: ${dc.errors.join("; ")}`,
            RenderErrorCategory.InvalidFilterGraph,
            dc.errors.join("\n"),
            [],
        );
    }

    const tc = checkTransitionBetweenExists(plan);
    if (!tc.ok) {
        throw new RenderError(
            `Pre-render: ${tc.errors.join("; ")}`,
            RenderErrorCategory.InvalidFilterGraph,
            tc.errors.join("\n"),
            [],
        );
    }

    const binPath = ffmpegPath();

    const ts = Date.now();
    const rendersDir = resolve(projectRoot, "renders");
    await fs.mkdir(rendersDir, { recursive: true });

    const logPath = join(rendersDir, `render-${ts}.log`);
    const progressPath = "pipe:1";

    const totalDuration = plan.tracks.video.reduce((s, clip) => s + (clip.out - clip.in), 0);

    const hasAutoCrop = plan.tracks.video.some((v) => v.crop === "auto_face");
    const hasEffects = plan.tracks.video.some((v) => (v.effects ?? []).length > 0);
    const compiled =
        hasAutoCrop || hasEffects
            ? await compilePlanAsync(plan, projectRoot, { confirm: opts.confirm })
            : compilePlan(plan, projectRoot);
    await fs.mkdir(dirname(compiled.outputPath), { recursive: true });
    const args = buildArgs(compiled, plan, progressPath);

    try {
        await runFFmpeg(binPath, args, logPath, totalDuration, opts.onProgress);
        return { outputPath: compiled.outputPath, logPath };
    } catch (err) {
        if (err instanceof RenderError && err.category === RenderErrorCategory.InvalidFilterGraph) {
            const simple = simplifyPlan(plan);
            const sc2 = compilePlan(simple, projectRoot);
            const retryLog = join(rendersDir, `render-${ts}-retry.log`);
            await fs.mkdir(dirname(sc2.outputPath), { recursive: true });
            const retryArgs = buildArgs(sc2, simple, progressPath);
            await runFFmpeg(binPath, retryArgs, retryLog, totalDuration, opts.onProgress);
            return { outputPath: sc2.outputPath, logPath: retryLog };
        }
        throw err;
    }
}
