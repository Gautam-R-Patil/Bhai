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
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Reject screenshot paths outside known-safe directories (defence against arbitrary file read). */
function isSafeScreenshotPath(p: string): boolean {
    const abs = resolve(p);
    const cwd = resolve("");
    // Reject filesystem-root and unreasonably short paths from the allowlist —
    // ATLAS_WORKSPACE="/" would otherwise let every absolute path pass startsWith.
    const isMeaningfulDir = (d: string): boolean => {
        if (!d || d === cwd) return false;
        if (d === "/" || d === "\\" || /^[A-Za-z]:\\?$/.test(d)) return false;
        if (d.length < 4) return false;
        return true;
    };
    const allowedDirs = [
        resolve(tmpdir()),
        "/tmp", // common shorthand for the per-user system tmp
        "/private/tmp", // macOS canonical (os.tmpdir() returns /var/folders/...)
        resolve(process.env.HOME || "", "Desktop", "A.T.L.A.S Files"),
        resolve(process.env.HOME || "", "Documents", "A.T.L.A.S Files"),
        resolve(process.env.HOME || "", "A.T.L.A.S Files"),
        resolve(process.env.HOME || "", "Library", "Caches", "atlas"),
        process.env.ATLAS_WORKSPACE ? resolve(process.env.ATLAS_WORKSPACE) : "",
    ].filter(isMeaningfulDir);
    return allowedDirs.some((d) => abs === d || abs.startsWith(`${d}/`) || abs.startsWith(`${d}\\`));
}

export interface UITarsGroundingResult {
    x: number;
    y: number;
    confidence: number;
    reasoning?: string;
    elapsedMs: number;
    model: string;
    /** Pixel width of the screenshot the model saw — callers need this to scale to screen coords. */
    imageWidth?: number;
    /** Pixel height of the screenshot the model saw. */
    imageHeight?: number;
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
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB cap on screenshot before base64 encoding

/**
 * Validate Ollama host is a loopback address and canonicalize it to bypass
 * DNS-rewrite SSRF (some hosts remap `localhost` to a non-loopback address).
 * Returns the canonicalized host string (`127.0.0.1`-rooted) when valid.
 */
export function validateOllamaHost(host: string): { ok: boolean; reason?: string; canonical?: string } {
    try {
        const u = new URL(host);
        if (!["127.0.0.1", "::1", "localhost"].includes(u.hostname)) {
            return { ok: false, reason: `non_loopback_host:${u.hostname}` };
        }
        if (u.hostname === "0.0.0.0") {
            return { ok: false, reason: "wildcard_host" };
        }
        // Force the URL's hostname to the literal loopback IPv4 — defends against
        // /etc/hosts rewrites that map `localhost` to a non-loopback address.
        u.hostname = "127.0.0.1";
        return { ok: true, canonical: u.toString().replace(/\/$/, "") };
    } catch {
        return { ok: false, reason: "invalid_host_url" };
    }
}

export async function groundClick(
    screenshotPath: string,
    instruction: string,
    opts: UITarsOptions = {},
): Promise<UITarsGroundingResult> {
    // Honour the wizard's persisted choice — install can pull either
    // ui-tars:1.5-7b (canonical Ollama 1.5 release) or ui-tars:7b depending
    // on which tag the registry serves. ATLAS_UI_TARS_TAG is written by
    // installer/phases.js after a successful pull.
    const model = opts.model || process.env.ATLAS_UI_TARS_TAG || "ui-tars:1.5-7b";
    const host = opts.host || process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const start = Date.now();

    const hostCheck = validateOllamaHost(host);
    if (!hostCheck.ok) return errorResult(model, start, hostCheck.reason || "host_rejected");
    const canonHost = hostCheck.canonical || host;
    if (!isSafeScreenshotPath(screenshotPath)) {
        return errorResult(model, start, "screenshot_path_rejected:must be under tmpdir or ATLAS Files directory");
    }

    let base64: string;
    let imageWidth = 0;
    let imageHeight = 0;
    try {
        // Size cap BEFORE readFile — a 100MB file would crash a 4GB box during base64 encoding.
        const stat = await fs.stat(screenshotPath);
        if (stat.size > MAX_IMAGE_BYTES) {
            return errorResult(model, start, `image_too_large:${stat.size}_bytes_max_${MAX_IMAGE_BYTES}`);
        }
        const buf = await fs.readFile(screenshotPath);
        // PNG IHDR chunk starts at byte 8; width is uint32 BE at offset 16, height at 20.
        if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
            imageWidth = buf.readUInt32BE(16);
            imageHeight = buf.readUInt32BE(20);
        }
        base64 = buf.toString("base64");
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
        const resp = await fetch(`${canonHost}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: requestBody,
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (!resp.ok) {
            invalidateAvailCacheFor(host, model);
            return errorResult(model, start, `ollama_${resp.status}:${await resp.text().catch(() => "")}`);
        }
        const data = (await resp.json()) as { response?: string };
        const parsed = parseGroundingResponse(data.response || "");
        if (!parsed) {
            return errorResult(model, start, "model_returned_unparseable_response");
        }
        return { ...parsed, elapsedMs: Date.now() - start, model, imageWidth, imageHeight };
    } catch (err) {
        const msg = (err as Error).message;
        // Any transport-level failure invalidates the availability cache so the next
        // call re-probes instead of pretending Ollama is still alive for up to 60s.
        invalidateAvailCacheFor(host, model);
        if (msg.includes("ECONNREFUSED")) return errorResult(model, start, "ollama_not_running");
        if (msg.includes("aborted")) return errorResult(model, start, "timeout");
        return errorResult(model, start, msg);
    }
}

function invalidateAvailCacheFor(host: string, model: string): void {
    _availCache.delete(`${host}|${model}`);
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
    // Use indexOf/lastIndexOf to capture the outermost JSON object — handles
    // nested braces inside reasoning strings like "the {Save} button".
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
        const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
        // Clamp coords to a sane screen-space range to defend against hallucinated huge ints.
        const x = typeof obj.x === "number" ? Math.max(-32767, Math.min(32767, Math.round(obj.x))) : null;
        const y = typeof obj.y === "number" ? Math.max(-32767, Math.min(32767, Math.round(obj.y))) : null;
        if (x === null || y === null) return null;
        const confidence = typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : 0.5;
        const reasoning = typeof obj.reasoning === "string" ? obj.reasoning : undefined;
        return { x, y, confidence, reasoning };
    } catch {
        return null;
    }
}

// 60s availability cache prevents wasting 3s per call when Ollama is never installed.
interface AvailCacheEntry {
    result: { available: boolean; reason?: string; modelTag?: string };
    expiresAt: number;
}
const _availCache = new Map<string, AvailCacheEntry>();
const AVAIL_CACHE_TTL_MS = 60_000;

export function clearUITarsAvailCache(): void {
    _availCache.clear();
}

/**
 * Check whether Ollama is reachable AND has the specified model pulled.
 * Cached for 60s per (host, model) pair so Lite-tier boxes don't waste 3s per call.
 */
export async function isUITarsAvailable(
    opts: { model?: string; host?: string } = {},
): Promise<{ available: boolean; reason?: string; modelTag?: string }> {
    const model = opts.model || process.env.ATLAS_UI_TARS_TAG || "ui-tars:1.5-7b";
    const host = opts.host || process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
    const cacheKey = `${host}|${model}`;
    const cached = _availCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    const hostCheck = validateOllamaHost(host);
    if (!hostCheck.ok) {
        const result = { available: false, reason: hostCheck.reason };
        _availCache.set(cacheKey, { result, expiresAt: Date.now() + AVAIL_CACHE_TTL_MS });
        return result;
    }

    let result: { available: boolean; reason?: string; modelTag?: string };
    try {
        const resp = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (!resp.ok) {
            result = { available: false, reason: `ollama_${resp.status}` };
        } else {
            const data = (await resp.json()) as { models?: Array<{ name?: string }> };
            // Normalize: "ui-tars" matches "ui-tars:latest" AND "ui-tars:7b" (best-effort prefix).
            const found = (data.models || []).find((m) => {
                if (!m.name) return false;
                if (m.name === model) return true;
                // Allow `ui-tars` (without tag) to match any `ui-tars:*`
                if (!model.includes(":") && m.name.startsWith(`${model}:`)) return true;
                // Allow `ui-tars:7b` to match `ui-tars` (model without tag stored as :latest)
                if (model.endsWith(":latest") && m.name === model.replace(":latest", "")) return true;
                return false;
            });
            result = found
                ? { available: true, modelTag: found.name }
                : { available: false, reason: "model_not_pulled" };
        }
    } catch (err) {
        result = { available: false, reason: `ollama_not_running:${(err as Error).message}` };
    }
    _availCache.set(cacheKey, { result, expiresAt: Date.now() + AVAIL_CACHE_TTL_MS });
    return result;
}
