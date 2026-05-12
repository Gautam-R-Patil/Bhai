// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * UI-TARS-1.5-7B grounding wrapper via Ollama.
 *
 * Sends a screenshot + instruction to a locally-running Ollama instance with
 * ui-tars (ByteDance-Seed/UI-TARS-1.5-7B). Returns predicted click coordinates
 * in image pixel space, with confidence.
 *
 * 61.6% ScreenSpot-Pro (Apache 2.0). ~400ms per call on M-series.
 *
 * Install:
 *   ollama pull ui-tars:7b   (one-time, ~4.5GB)
 *
 * On the Full tier this is the local grounding fallback before falling back to
 * the cloud VLM. On Lite/Standard tiers this is unavailable and skipped.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface UITarsGroundingResult {
    x: number;
    y: number;
    confidence: number;
    reasoning?: string;
    elapsedMs: number;
    model: string;
    error?: string;
}

export interface UITarsOptions {
    /** Ollama model name (default: "ui-tars:7b"). */
    model?: string;
    /** Ollama host URL (default: http://127.0.0.1:11434). */
    host?: string;
    /** Max generation tokens (default: 256). */
    maxTokens?: number;
    /** Override timeout (default 30s). */
    timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Ground a click instruction against a screenshot using UI-TARS.
 * Returns `error` field when Ollama or the model isn't available.
 */
export async function groundClick(
    screenshotPath: string,
    instruction: string,
    opts: UITarsOptions = {},
): Promise<UITarsGroundingResult> {
    const model = opts.model || "ui-tars:7b";
    const host = opts.host || process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const start = Date.now();

    let base64: string;
    try {
        base64 = (await fs.readFile(screenshotPath)).toString("base64");
    } catch (err) {
        return errorResult(model, start, `image_read_failed:${(err as Error).message}`);
    }

    // UI-TARS prompt format (per the model card): describe target → emit coordinate.
    const prompt = `You are a GUI grounding model. Given a screenshot and a target description, return the click coordinate.

Target: ${instruction}

Respond with ONLY a JSON object of the form: {"x": <pixel_x>, "y": <pixel_y>, "confidence": <0.0-1.0>, "reasoning": "<one sentence>"}`;

    const requestBody = JSON.stringify({
        model,
        prompt,
        images: [base64],
        stream: false,
        options: { num_predict: opts.maxTokens ?? 256, temperature: 0.0 },
    });

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const resp = await fetch(`${host}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: requestBody,
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (!resp.ok) {
            return errorResult(model, start, `ollama_${resp.status}:${await resp.text().catch(() => "")}`);
        }
        const data = (await resp.json()) as { response?: string };
        const parsed = parseGroundingResponse(data.response || "");
        if (!parsed) {
            return errorResult(model, start, "model_returned_unparseable_response");
        }
        return { ...parsed, elapsedMs: Date.now() - start, model };
    } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("ECONNREFUSED")) return errorResult(model, start, "ollama_not_running");
        if (msg.includes("aborted")) return errorResult(model, start, "timeout");
        return errorResult(model, start, msg);
    }
}

function errorResult(model: string, start: number, message: string): UITarsGroundingResult {
    return { x: 0, y: 0, confidence: 0, elapsedMs: Date.now() - start, model, error: message };
}

/**
 * Parse UI-TARS' JSON response. Tolerant of code-fences and surrounding prose.
 */
export function parseGroundingResponse(
    text: string,
): { x: number; y: number; confidence: number; reasoning?: string } | null {
    if (!text) return null;
    // Try to extract a JSON object from the response.
    const match = text.match(/\{[^{}]*"x"\s*:\s*-?\d+[^{}]*\}/);
    if (!match) return null;
    try {
        const obj = JSON.parse(match[0]) as Record<string, unknown>;
        const x = typeof obj.x === "number" ? Math.round(obj.x) : null;
        const y = typeof obj.y === "number" ? Math.round(obj.y) : null;
        if (x === null || y === null) return null;
        const confidence = typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : 0.5;
        const reasoning = typeof obj.reasoning === "string" ? obj.reasoning : undefined;
        return { x, y, confidence, reasoning };
    } catch {
        return null;
    }
}

/**
 * Check whether Ollama is reachable AND has the specified model pulled.
 */
export async function isUITarsAvailable(
    opts: { model?: string; host?: string } = {},
): Promise<{ available: boolean; reason?: string; modelTag?: string }> {
    const model = opts.model || "ui-tars:7b";
    const host = opts.host || process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
    try {
        const resp = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (!resp.ok) return { available: false, reason: `ollama_${resp.status}` };
        const data = (await resp.json()) as { models?: Array<{ name?: string }> };
        const found = (data.models || []).some((m) => m.name === model);
        return found ? { available: true, modelTag: model } : { available: false, reason: "model_not_pulled" };
    } catch (err) {
        return { available: false, reason: `ollama_not_running:${(err as Error).message}` };
    }
}
