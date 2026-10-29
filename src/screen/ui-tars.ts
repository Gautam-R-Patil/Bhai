// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
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
        resolve(process.env.HOME || "", "Desktop", "Bhai Files"),
        resolve(process.env.HOME || "", "Documents", "Bhai Files"),
        resolve(process.env.HOME || "", "Bhai Files"),
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
    /** Max generation tokens (default: 64 — the {x,y,confidence} JSON is tiny). */
    maxTokens?: number;
    /** Override timeout (default 30s). */
    timeoutMs?: number;
    /**
     * Ollama keep_alive — how long to keep the model resident after this call.
     * Defaults to "30m" so the first click warms the model and subsequent clicks
     * reuse it (cold ~5GB reload is the bulk of the per-call latency).
     */
    keepAlive?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

// Default UI-TARS GGUF when no ATLAS_UI_TARS_TAG is set. The Lucy-in-the-Sky
// quant is verified-working for VISION inference (grounds a real screenshot in
// ~3s, conf ~0.96). The previously-default mradermacher quant pulls + runs text
// fine but CRASHES on image inference (broken mmproj → GGML_ASSERT/500), so it
// must NOT be the default. isUITarsHealthy() guards against a broken tag anyway.
export const DEFAULT_UI_TARS_TAG = "hf.co/Lucy-in-the-Sky/UI-TARS-1.5-7B-Q4_K_M-GGUF:latest";

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

/** Longest-side cap for vision-model input (UI-TARS-1.5 max; ≤ Claude's own resize threshold). */
export const VISION_MAX_SIDE = 1568;

/**
 * Shared screenshot downscale for vision grounding (UI-TARS + cloud). Caps the
 * longest side at `maxSide` and returns the dims of the image ACTUALLY produced
 * so callers scale model coords by what the model saw. Lazy `sharp`, fail-open:
 * on any sharp error returns the input with PNG IHDR dims (0x0 for non-PNG).
 * Returns the input untouched when already small enough (unless `jpeg`).
 */
export async function downscaleForVision(
    input: Buffer,
    opts: { maxSide?: number; jpeg?: boolean } = {},
): Promise<{ buf: Buffer; width: number; height: number; mime: string }> {
    const maxSide = opts.maxSide ?? VISION_MAX_SIDE;
    const isPng = input.length >= 24 && input[0] === 0x89 && input[1] === 0x50 && input[2] === 0x4e && input[3] === 0x47;
    const isJpeg = input.length >= 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff;
    // PNG IHDR: width uint32 BE @16, height @20.
    const fallback = {
        buf: input,
        width: isPng ? input.readUInt32BE(16) : 0,
        height: isPng ? input.readUInt32BE(20) : 0,
        mime: isJpeg ? "image/jpeg" : "image/png",
    };
    try {
        const sharp = (await import("sharp")).default;
        const meta = await sharp(input).metadata();
        const width = meta.width ?? fallback.width;
        const height = meta.height ?? fallback.height;
        if (Math.max(width, height) <= maxSide && !opts.jpeg) return { ...fallback, width, height };
        const pipeline = sharp(input).resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true });
        const asJpeg = opts.jpeg || isJpeg; // a resized JPEG as PNG is ~3x bigger
        const out = await (asJpeg ? pipeline.jpeg({ quality: 90 }) : pipeline.png()).toBuffer({ resolveWithObject: true });
        return { buf: out.data, width: out.info.width, height: out.info.height, mime: asJpeg ? "image/jpeg" : "image/png" };
    } catch {
        return fallback; // sharp missing/failed — send as-is
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
    const model = opts.model || process.env.ATLAS_UI_TARS_TAG || DEFAULT_UI_TARS_TAG;
    const host = opts.host || process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const start = Date.now();

    const hostCheck = validateOllamaHost(host);
    if (!hostCheck.ok) return errorResult(model, start, hostCheck.reason || "host_rejected");
    const canonHost = hostCheck.canonical || host;
    if (!isSafeScreenshotPath(screenshotPath)) {
        return errorResult(model, start, "screenshot_path_rejected:must be under tmpdir or Bhai Files directory");
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
        // Downscale to UI-TARS-1.5's native max (longest side 1568px) BEFORE encode.
        // Retina/window full-res frames are 2-3MP — the vision encoder pass scales
        // with pixel count, so this is the single biggest per-call inference saving.
        // imageWidth/Height are the SENT dims so toScreenCoords scales by what the
        // model actually saw. ATLAS_NO_UITARS_DOWNSCALE opts out (fail-open to full-res).
        const scaled = await downscaleForVision(await fs.readFile(screenshotPath), {
            maxSide: process.env.ATLAS_NO_UITARS_DOWNSCALE === "true" ? Number.POSITIVE_INFINITY : VISION_MAX_SIDE,
        });
        const buf = scaled.buf;
        imageWidth = scaled.width;
        imageHeight = scaled.height;
        base64 = buf.toString("base64");
    } catch (err) {
        return errorResult(model, start, `image_read_failed:${(err as Error).message}`);
    }

    // UI-TARS prompt format (per the model card): describe target → emit coordinate.
    const prompt = `You are a GUI grounding model. Given a screenshot and a target description, return the click coordinate.

Target: ${instruction}

Respond with ONLY a JSON object of the form: {"x": <pixel_x>, "y": <pixel_y>, "confidence": <0.0-1.0>, "reasoning": "<one sentence>"}`;

    // keep_alive is a TOP-LEVEL /api/generate field (not inside options). "30m"
    // keeps the ~5GB model resident so subsequent clicks skip the cold reload —
    // the dominant cost on the first call. num_predict 64 is ample for the tiny
    // {x,y,confidence,reasoning} JSON (was 256).
    const keepAlive = opts.keepAlive ?? process.env.ATLAS_UITARS_KEEP_ALIVE ?? "30m";
    const requestBody = JSON.stringify({
        model,
        prompt,
        images: [base64],
        stream: false,
        keep_alive: keepAlive,
        options: { num_predict: opts.maxTokens ?? 64, temperature: 0.0 },
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
    // Candidates, best first: the outermost {...} span (handles nested braces in
    // reasoning like "the {Save} button"), then every flat {...} object from LAST
    // to first (handles prose/thinking that mentions braces or drafts a guess
    // before the final answer). First candidate that parses with numeric x/y wins.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    const candidates = [text.slice(start, end + 1), ...(text.match(/\{[^{}]*\}/g) ?? []).reverse()];
    for (const c of candidates) {
        const r = parseGroundingObject(c);
        if (r) return r;
    }
    return null;
}

function parseGroundingObject(
    json: string,
): { x: number; y: number; confidence: number; reasoning?: string } | null {
    try {
        const obj = JSON.parse(json) as Record<string, unknown>;
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
    const model = opts.model || process.env.ATLAS_UI_TARS_TAG || DEFAULT_UI_TARS_TAG;
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

// A model can be PULLED but crash at vision inference (e.g. a GGUF with a
// broken/mismatched mmproj projector → GGML_ASSERT / Ollama 500). isUITarsAvailable
// only checks /api/tags, so such a model passes the gate then wastes a 30s timeout
// + crash on every click. isUITarsHealthy() runs a ONE-TIME cached vision smoke
// test so the cascade can skip a broken model and fall straight to cloud grounding.
interface HealthCacheEntry { healthy: boolean; reason?: string; expiresAt: number; }
const _healthCache = new Map<string, HealthCacheEntry>();
const HEALTH_CACHE_TTL_MS = 30 * 60_000; // 30min — re-probe occasionally in case a model is re-pulled

// Minimal 4x4 white PNG (base64) — enough to exercise the vision/mmproj path
// without a real screenshot. If the projector is broken this errors fast.
const SMOKE_PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEUlEQVR4nGP8////fwYkwDgKAERWBQ8C3J3IAAAAAElFTkSuQmCC";

/**
 * One-time (cached) vision-inference smoke test. Returns healthy:false with a
 * reason when the model can't run image inference (crash/timeout), so the
 * cascade skips a pulled-but-broken UI-TARS quant. Short timeout — a healthy
 * model answers a 4x4 image in a few seconds even cold-ish.
 */
export async function isUITarsHealthy(
    opts: { model?: string; host?: string; timeoutMs?: number } = {},
): Promise<{ healthy: boolean; reason?: string }> {
    const model = opts.model || process.env.ATLAS_UI_TARS_TAG || DEFAULT_UI_TARS_TAG;
    const host = opts.host || process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
    const cacheKey = `${host}|${model}`;
    const cached = _healthCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return { healthy: cached.healthy, reason: cached.reason };

    const hostCheck = validateOllamaHost(host);
    if (!hostCheck.ok) {
        const r = { healthy: false, reason: hostCheck.reason };
        _healthCache.set(cacheKey, { ...r, expiresAt: Date.now() + HEALTH_CACHE_TTL_MS });
        return r;
    }

    // Generous timeout — the FIRST inference loads ~5.5GB into RAM (cold start),
    // which legitimately takes longer than a normal call. A broken model errors
    // out (Ollama 500) well before this, so the timeout only bites a slow-but-OK
    // cold load — acceptable for a one-time probe.
    const timeoutMs = opts.timeoutMs ?? 90_000;
    let result: { healthy: boolean; reason?: string };
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const resp = await fetch(`${hostCheck.canonical || host}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model,
                prompt: "Return the click coordinate as JSON {\"x\":0,\"y\":0}.",
                images: [SMOKE_PNG_B64],
                stream: false,
                // Keep resident after the probe — this doubles as the boot warm-up
                // so the first REAL click reuses the loaded model instead of paying
                // the ~5GB cold reload.
                keep_alive: process.env.ATLAS_UITARS_KEEP_ALIVE ?? "30m",
                options: { num_predict: 32, temperature: 0.0 },
            }),
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (!resp.ok) {
            // 500 here = the inference crashed (broken mmproj / GGML_ASSERT).
            result = { healthy: false, reason: `inference_${resp.status}` };
        } else {
            // Any 200 with a response body means the vision path executed.
            const data = (await resp.json()) as { response?: string };
            result = typeof data.response === "string"
                ? { healthy: true }
                : { healthy: false, reason: "empty_inference_response" };
        }
    } catch (err) {
        const msg = (err as Error).message;
        result = { healthy: false, reason: msg.includes("aborted") ? "inference_timeout" : `inference_error:${msg}` };
    }
    _healthCache.set(cacheKey, { ...result, expiresAt: Date.now() + HEALTH_CACHE_TTL_MS });
    return result;
}

/** Clears the health-probe cache (e.g. after a model is re-pulled). */
export function clearUITarsHealthCache(): void {
    _healthCache.clear();
}
