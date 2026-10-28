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
 * Model: Haiku by default (a quarter of Sonnet's price, and faster). The
 * caller re-grounds with Sonnet once when a Haiku click verifies as a miss
 * (os-smart-click.ts self-correction). The screenshot is
 * downscaled to ≤1568px longest side BEFORE sending so Claude does not resize
 * it again server-side; returned coords are in the SENT image's pixel space and
 * we report those dims as imageWidth/Height for toScreenCoords. Only invoked
 * when the local cascade (AX/OmniParser/UI-TARS) has already missed.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/index.js";
import type { LLMClient } from "../llm.js";
import { MODELS } from "../llm.js";
import { downscaleForVision, parseGroundingResponse } from "./ui-tars.js";

/** Raw-file read cap (memory safety); a 5K Retina PNG can exceed 10MB before downscale. */
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
/** Claude's per-image limit (~5MB base64). */
const MAX_SENT_BASE64_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const GROUNDING_MODEL = MODELS.HAIKU;
const GROUNDING_SYSTEM_PROMPT =
    "You are a GUI grounding model. Given a screenshot and a target UI element, output ONLY a JSON object with the pixel coordinate to click. No prose.";

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
    opts: { llm: LLMClient; timeoutMs?: number; model?: string },
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
    let mime: string;
    let imageWidth: number;
    let imageHeight: number;
    try {
        const stat = await fs.stat(screenshotPath);
        if (stat.size > MAX_IMAGE_BYTES) {
            return errorResult("none", start, `image_too_large:${stat.size}`);
        }
        // Downscale + JPEG so Claude sees exactly the pixels we scale by (no server-side resize).
        const scaled = await downscaleForVision(await fs.readFile(screenshotPath), { jpeg: true });
        ({ mime, width: imageWidth, height: imageHeight } = scaled);
        base64 = scaled.buf.toString("base64");
        if (base64.length > MAX_SENT_BASE64_BYTES) {
            return errorResult("none", start, `image_too_large_after_downscale:${base64.length}`);
        }
    } catch (err) {
        return errorResult("none", start, `image_read_failed:${(err as Error).message}`);
    }

    const sizeLine = imageWidth > 0 ? `The screenshot is ${imageWidth}x${imageHeight} pixels. ` : "";
    const prompt = `Target: ${instruction}

${sizeLine}Respond with ONLY a JSON object: {"x": <pixel_x>, "y": <pixel_y>, "confidence": <0.0-1.0>, "reasoning": "<one sentence>"}
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

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const model = opts.model ?? GROUNDING_MODEL;
    let timer: NodeJS.Timeout | undefined;
    try {
        const resp = await Promise.race([
            opts.llm.chat({
                messages,
                systemPrompt: GROUNDING_SYSTEM_PROMPT,
                modelOverride: model,
                thinkingLevel: "low",
                responseFormat: "json_object",
            }),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`timeout_${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
        const text = resp.choices?.[0]?.message?.content ?? "";
        const parsed = parseGroundingResponse(typeof text === "string" ? text : "");
        if (parsed) {
            return { ...parsed, elapsedMs: Date.now() - start, model: model, imageWidth, imageHeight };
        }
        return errorResult(model, start, "unparseable");
    } catch (err) {
        return errorResult(model, start, (err as Error).message);
    } finally {
        clearTimeout(timer);
    }
}
