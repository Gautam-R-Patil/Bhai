// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { LLMClient } from "../../llm.js";
import { MODELS } from "../../llm.js";
import { extractJSON } from "../../utils/json-extract.js";
import type { Timeline } from "../analyze/timeline-builder.js";
import { type EditPlan, validateEditPlan } from "./schema.js";

export class PlanValidationError extends Error {
    readonly lastAttempt: unknown;
    readonly validationErrors: string[];

    constructor(message: string, lastAttempt: unknown, validationErrors: string[]) {
        super(message);
        this.name = "PlanValidationError";
        this.lastAttempt = lastAttempt;
        this.validationErrors = validationErrors;
    }
}

export interface PlanEditOpts {
    llm: LLMClient;
    timeline: Timeline;
    userIntent: string;
    projectId: string;
}

const SCHEMA_DESCRIPTION = `Required JSON shape (strict — output ONLY this JSON, no prose):
{
  "projectId": "<string>",
  "output": { "path": "<string>", "aspect": "16:9"|"9:16"|"1:1"|"4:5", "fps": <int>, "resolution": "<WxH>" },
  "sources": [{ "id": "<string>", "path": "<string>", "duration": <number> }],
  "tracks": {
    "video": [{ "id": "<string>", "source": "<sources[].id>", "in": <number>, "out": <number>,
                "speed": <opt number>, "crop": <opt string>, "effects": <opt string[]> }],
    "audio": [{ "id": "<string>", "source": "<path>", "volume": <opt dB>, "duck_on_speech": <opt bool>,
                "sync_to_beats": <opt bool>, "fade_in": <opt s>, "fade_out": <opt s> }],
    "overlays": [
      { "type": "captions", "style": "<string>", "from": <s>, "to": <s>, "highlight_color": "<#hex>" } |
      { "type": "text", "content": "<string>", "from": <s>, "to": <s>, "x": <px>, "y": <px> } |
      { "type": "sticker", "asset": "<filename>", "from": <s>, "to": <s>, "x": <px>, "y": <px> }
    ]
  },
  "transitions": [{ "between": ["<videoId>", "<videoId>"], "type": "xfade"|"cut",
                    "kind": <opt string>, "duration": <opt s> }],
  "export_targets": ["mp4"] (required) | ["mp4","fcpxml"]
}
Constraints: video[].out <= source duration; video[].in < video[].out;
             transition between[] IDs must exist in tracks.video[].id.`;

function buildSystemPrompt(): string {
    return `You are a video editing planner. Given a timeline and a user intent, you output a single valid JSON edit plan conforming exactly to the schema below. Output ONLY the JSON object — no markdown fences, no prose, no comments.

${SCHEMA_DESCRIPTION}`;
}

function buildTimelineSummary(timeline: Timeline): string {
    const sceneSummary = timeline.scenes
        .map((s, i) => `  Scene ${i + 1}: ${s.start.toFixed(2)}s-${s.end.toFixed(2)}s (${s.duration.toFixed(1)}s)`)
        .join("\n");

    const captionSummary = (timeline.keyframes ?? [])
        .map((kf) => `    scene ${kf.sceneIndex}: "${kf.caption}"`)
        .join("\n");

    const allWords = (timeline.transcript?.segments ?? []).flatMap((s) => s.words ?? []);
    const excerpt = allWords
        .slice(0, 30)
        .map((w) => w.word)
        .join(" ");

    return `TIMELINE:
- videoPath: ${timeline.videoPath}
- duration: ${timeline.duration.toFixed(2)}s
- resolution: ${timeline.resolution}  fps: ${timeline.fps}
- scenes (${timeline.scenes.length}):
${sceneSummary}
- keyframe captions:
${captionSummary}
- transcript excerpt: "${excerpt}${allWords.length > 30 ? "..." : ""}"`;
}

function tryExtractAndValidate(
    content: string,
): { ok: true; plan: EditPlan } | { ok: false; raw: unknown; errors: string[] } {
    const json = extractJSON(content);
    if (json === null) {
        return { ok: false, raw: null, errors: ["No JSON found in LLM response"] };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return { ok: false, raw: null, errors: ["JSON.parse failed on extracted string"] };
    }
    const v = validateEditPlan(parsed);
    if (v.ok) return { ok: true, plan: v.plan };
    return { ok: false, raw: parsed, errors: v.errors };
}

export async function planEdit(opts: PlanEditOpts): Promise<EditPlan> {
    const { llm, timeline, userIntent, projectId } = opts;

    const systemPrompt = buildSystemPrompt();
    const userContent = `${buildTimelineSummary(timeline)}\n\nUSER INTENT: ${userIntent}\n\nOutput the edit_plan JSON:`;

    const r1 = await llm.chat({
        messages: [{ role: "user", content: userContent }],
        systemPrompt,
        modelOverride: MODELS.SONNET,
    });
    const c1 = r1.choices[0]?.message?.content ?? "";
    const v1 = tryExtractAndValidate(c1);
    if (v1.ok) return v1.plan;

    const errorList = v1.errors.join("\n");
    const r2 = await llm.chat({
        messages: [
            { role: "user", content: userContent },
            { role: "assistant", content: c1 },
            {
                role: "user",
                content: `Your response failed validation with these errors:\n${errorList}\n\nFix every error. Output ONLY the corrected JSON:`,
            },
        ],
        systemPrompt,
        modelOverride: MODELS.SONNET,
    });
    const c2 = r2.choices[0]?.message?.content ?? "";
    const v2 = tryExtractAndValidate(c2);
    if (v2.ok) return v2.plan;

    throw new PlanValidationError(
        `Edit plan failed validation after 2 attempts for project ${projectId}`,
        v2.raw ?? v1.raw,
        v2.errors,
    );
}
