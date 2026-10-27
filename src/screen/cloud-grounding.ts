// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * Cloud GUI-grounding fallback for vision-nav.
 *
 * Mirrors src/screen/ui-tars.ts::groundClick(), but instead of a local Ollama
 * model it sends (screenshot + instruction) to a cheap cloud VLM via the
 * LLMClient proxy and parses back click coordinates. This is the grounding
 * path for Lite/Standard tiers (no local UI-TARS) and the self-heal path for a
 * degraded Full tier (Full hardware but UI-TARS model not pulled).
 *
 * Model: qwen/qwen3.7-plus (primary, strong GUI grounding) → falls back to
 * qwen/qwen3-vl-235b-a22b-instruct on error/404. Only invoked when the local
 * cascade (AX/OmniParser/UI-TARS) has already missed, so cost stays minimal.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/index.js";
import type { LLMClient } from "../llm.js";
import { MODELS } from "../llm.js";
import { parseGroundingResponse } from "./ui-tars.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Cloud grounding models, in fallback order: primary first. */
const GROUNDING_MODELS = [MODELS.QWEN37_PLUS, MODELS.QWEN3_VL_235B];

export interface CloudGroundingResult {
    x: number;
    y: number;
    confidence: number;
    reasoning?: string;
    elapsedMs: number;
    model: string;
    imageWidth?: number;
    imageHeight?: number;
    error?: string;
}

/** Reject screenshot paths outside known-safe dirs (mirrors ui-tars.ts). */
function isSafeScreenshotPath(p: string): boolean {
    const abs = resolve(p);
    const cwd = resolve("");
    const isMeaningfulDir = (d: string): boolean => {
        if (!d || d === cwd) return false;
        if (d === "/" || d === "\\" || /^[A-Za-z]:\\?$/.test(d)) return false;
        if (d.length < 4) return false;
        return true;
    };
    const allowedDirs = [
        resolve(tmpdir()),
        "/tmp",
        "/private/tmp",
        resolve(process.env.HOME || "", "Desktop", "Bhai Files"),
        resolve(process.env.HOME || "", "Documents", "Bhai Files"),
        resolve(process.env.HOME || "", "Bhai Files"),
        resolve(process.env.HOME || "", "Library", "Caches", "atlas"),
        process.env.ATLAS_WORKSPACE ? resolve(process.env.ATLAS_WORKSPACE) : "",
    ].filter(isMeaningfulDir);
    return allowedDirs.some((d) => abs === d || abs.startsWith(`${d}/`) || abs.startsWith(`${d}\\`));
}

function errorResult(model: string, start: number, message: string): CloudGroundingResult {
    return { x: 0, y: 0, confidence: 0, elapsedMs: Date.now() - start, model, error: message };
}

/**
 * Ground a click instruction against a screenshot using a cloud VLM.
 * Returns `error` when the LLM is unavailable or returns an unparseable response.
 */
export async function cloudGroundClick(
    screenshotPath: string,
    instruction: string,
    opts: { llm: LLMClient; timeoutMs?: number },
): Promise<CloudGroundingResult> {
    const start = Date.now();
    if (process.env.ATLAS_NO_CLOUD_GROUNDING === "true") {
        return errorResult("disabled", start, "cloud_grounding_disabled");
    }
    if (!opts.llm) return errorResult("none", start, "no_llm_client");
    if (!isSafeScreenshotPath(screenshotPath)) {
        return errorResult("none", start, "screenshot_path_rejected");
    }

    let base64: string;
    let mime = "image/png";
    let imageWidth = 0;
    let imageHeight = 0;
    try {
        const stat = await fs.stat(screenshotPath);
        if (stat.size > MAX_IMAGE_BYTES) {
            return errorResult("none", start, `image_too_large:${stat.size}`);
        }
        const buf = await fs.readFile(screenshotPath);
        // PNG IHDR: width@16, height@20 (BE uint32). JPEG → leave dims 0 (caller scales by screenDims).
        if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
            imageWidth = buf.readUInt32BE(16);
            imageHeight = buf.readUInt32BE(20);
        } else if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
            mime = "image/jpeg";
        }
        base64 = buf.toString("base64");
    } catch (err) {
        return errorResult("none", start, `image_read_failed:${(err as Error).message}`);
    }

    const prompt = `You are a GUI grounding model. Given a screenshot and a target UI element description, return the pixel coordinate to click.

Target: ${instruction}

Respond with ONLY a JSON object: {"x": <pixel_x>, "y": <pixel_y>, "confidence": <0.0-1.0>, "reasoning": "<one sentence>"}
Coordinates are in the screenshot's own pixel space (top-left origin).`;

    const messages: ChatCompletionMessageParam[] = [
        {
            role: "user",
            content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
            ],
        },
    ];

    // Try primary model, fall through to the GA fallback on any error.
    let lastErr = "no_models";
    for (const model of GROUNDING_MODELS) {
        try {
            const resp = await opts.llm.chat({
                messages,
                modelOverride: model,
                thinkingLevel: "off",
                responseFormat: "json_object",
            });
            const text = resp.choices?.[0]?.message?.content ?? "";
            const parsed = parseGroundingResponse(typeof text === "string" ? text : "");
            if (parsed) {
                return { ...parsed, elapsedMs: Date.now() - start, model, imageWidth, imageHeight };
            }
            lastErr = `unparseable:${model}`;
        } catch (err) {
            lastErr = `${model}:${(err as Error).message}`;
        }
    }
    return errorResult(GROUNDING_MODELS[0], start, lastErr);
}
