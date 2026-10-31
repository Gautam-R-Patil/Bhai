// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Image generation + editing for /api/image ───────────────────
// OpenAI Images API on Azure (v1 surface), set in the Convex env:
//   AZURE_IMAGE_ENDPOINT  https://<resource>.openai.azure.com/openai/v1
//                         (falls back to AZURE_GROK_ENDPOINT)
//   AZURE_IMAGE_API_KEY   (falls back to AZURE_GROK_API_KEY)
//   AZURE_IMAGE_MODEL     deployment name, default gpt-image-2.5-sunburst
// No images = POST /images/generations (JSON); images = POST /images/edits
// (multipart, each as "image[]").

import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { decodeBase64 } from "./stt";

export const IMAGE_MAX_INPUTS = 4;
/** Per input image, decoded. Convex caps the whole request at 20MB, so the client must shrink several large inputs. */
export const IMAGE_MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_CHARS = 32_000;
const MAX_OUTPUT_B64_CHARS = 14_000_000;

const SIZES = ["1024x1024", "1024x1536", "1536x1024", "auto"] as const;
const QUALITIES = ["low", "medium", "high"] as const;
const BACKGROUNDS = ["transparent", "opaque", "auto"] as const;
const INPUT_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

export type ImageQuality = (typeof QUALITIES)[number];

/** Credits per output image, by quality. */
export const IMAGE_CREDIT_COST: Record<ImageQuality, number> = { low: 1, medium: 2, high: 4 };

export function imageCreditCost(quality: ImageQuality, n: number): number {
    return IMAGE_CREDIT_COST[quality] * n;
}

// ── Per-account limits: the deployment's ~2 requests a minute are shared by every install ──
/** Requests a minute per account (sessions.checkRequestRateLimit). */
export const IMAGE_MAX_PER_MINUTE = 6;
/**
 * Images in flight per account. Counted by images, not requests, so one count-4 ask fits whether it
 * goes as one n=4 call or as the client's four parallel n=1 calls (transparent or high quality).
 */
export const IMAGE_MAX_IN_FLIGHT = 4;
/** Past CALL_BUDGET_MS plus the route's own work: a slot whose action died stops counting. */
const IN_FLIGHT_STALE_MS = 5 * 60_000;

// One request_rate_limits row per account: requestCount = images in flight, windowStart = the last take.
const inFlightKey = (accountId: string) => `image_inflight|${accountId}`;
const inFlightRow = (ctx: MutationCtx, accountId: string) =>
    ctx.db
        .query("request_rate_limits")
        .withIndex("by_key", (q) => q.eq("key", inFlightKey(accountId)))
        .unique();

/** Takes `n` in-flight images for the account; false = at the cap. Every true needs a releaseImageSlot. */
export const acquireImageSlot = internalMutation({
    args: { accountId: v.string(), n: v.number() },
    handler: async (ctx, { accountId, n }): Promise<boolean> => {
        const row = await inFlightRow(ctx, accountId);
        const now = Date.now();
        // ponytail: a leaked slot clears only after a quiet IN_FLIGHT_STALE_MS; per-request lease rows if that bites.
        const held = row && now - row.windowStart < IN_FLIGHT_STALE_MS ? row.requestCount : 0;
        if (held + n > IMAGE_MAX_IN_FLIGHT) return false;
        if (row) await ctx.db.patch(row._id, { windowStart: now, requestCount: held + n });
        else
            await ctx.db.insert("request_rate_limits", {
                key: inFlightKey(accountId),
                windowStart: now,
                requestCount: n,
            });
        return true;
    },
});

export const releaseImageSlot = internalMutation({
    args: { accountId: v.string(), n: v.number() },
    handler: async (ctx, { accountId, n }) => {
        const row = await inFlightRow(ctx, accountId);
        if (row) await ctx.db.patch(row._id, { requestCount: Math.max(0, row.requestCount - n) });
    },
});

/** The route's release, tried twice: one lost release would hold the slot until IN_FLIGHT_STALE_MS of quiet. */
export async function releaseImageSlotRetrying(release: () => Promise<unknown>): Promise<void> {
    await release()
        .catch(release)
        .catch((e: unknown) => console.error("[Image] slot release failed:", e));
}

export interface ImageConfig {
    endpoint: string;
    apiKey: string;
    deployment: string;
}

export function imageConfigFromEnv(env: Record<string, string | undefined>): ImageConfig | null {
    const endpoint = (env.AZURE_IMAGE_ENDPOINT || env.AZURE_GROK_ENDPOINT)?.trim();
    const apiKey = (env.AZURE_IMAGE_API_KEY || env.AZURE_GROK_API_KEY)?.trim();
    if (!endpoint || !apiKey) return null;
    return {
        endpoint: endpoint.replace(/\/+$/, ""),
        apiKey,
        deployment: env.AZURE_IMAGE_MODEL?.trim() || "gpt-image-2.5-sunburst",
    };
}

export interface ImageRequest {
    prompt: string;
    /** Decoded inputs; present = edit. */
    images: Array<{ bytes: Uint8Array<ArrayBuffer>; mimeType: string }>;
    /** A named size, "auto", or a custom "WxH" (see isCustomSize). */
    size: string;
    quality: ImageQuality;
    n: number;
    background?: (typeof BACKGROUNDS)[number];
}

export interface ImageOutput {
    data: string;
    mimeType: string;
}

/** Normalizes the client body; on bad input returns the error and its HTTP status (400, or 413 for size). */
export function validateImageRequest(body: any): ImageRequest | { error: string; status: 400 | 413 } {
    const bad = (error: string) => ({ error, status: 400 as const });
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return bad("prompt required");
    if (prompt.length > MAX_PROMPT_CHARS) return bad("prompt too long");

    const raw = body.images ?? [];
    if (!Array.isArray(raw)) return bad("images must be an array");
    if (raw.length > IMAGE_MAX_INPUTS) return bad(`at most ${IMAGE_MAX_INPUTS} images`);
    const images: ImageRequest["images"] = [];
    for (const img of raw) {
        if (typeof img?.data !== "string" || !img.data) return bad("image data required");
        const mimeType = String(img.mimeType ?? "").toLowerCase();
        if (!INPUT_MIME.has(mimeType)) return bad("images must be png, jpeg or webp");
        // base64 is 4/3 of the bytes; refuse before decoding something huge.
        if (img.data.length * 0.75 > IMAGE_MAX_INPUT_BYTES + 3) return { error: "image_too_large", status: 413 };
        let bytes: Uint8Array<ArrayBuffer>;
        try {
            bytes = decodeBase64(img.data);
        } catch {
            return bad("image data must be base64");
        }
        if (bytes.length > IMAGE_MAX_INPUT_BYTES) return { error: "image_too_large", status: 413 };
        images.push({ bytes, mimeType: mimeType === "image/jpg" ? "image/jpeg" : mimeType });
    }

    const size = body.size ?? (images.length ? "auto" : "1024x1024");
    if (!SIZES.includes(size) && !isCustomSize(size)) return bad("invalid size");
    const quality = body.quality ?? "medium";
    if (!QUALITIES.includes(quality)) return bad("invalid quality");
    const n = body.n ?? 1;
    if (!Number.isInteger(n) || n < 1 || n > 4) return bad("n must be 1-4");
    const background = body.background;
    if (background !== undefined && !BACKGROUNDS.includes(background)) return bad("invalid background");
    return { prompt, images, size, quality, n, background };
}

/** Custom "WxH": both edges multiples of 16, each 256-2048, long/short at most 3 (all verified on the deployment). */
function isCustomSize(size: unknown): boolean {
    const m = typeof size === "string" ? /^(\d{3,4})x(\d{3,4})$/.exec(size) : null;
    if (!m) return false;
    const [w, h] = [Number(m[1]), Number(m[2])];
    const edgeOk = (e: number) => e % 16 === 0 && e >= 256 && e <= 2048;
    return edgeOk(w) && edgeOk(h) && Math.max(w, h) <= 3 * Math.min(w, h);
}

export type ImageErrorCode = "not_configured" | "blocked_by_safety" | "image_failed" | "busy";

export class ImageError extends Error {
    constructor(
        readonly code: ImageErrorCode,
        message: string,
        /** Seconds to wait, for "busy". */
        readonly retryAfter?: number,
    ) {
        super(message);
    }
}

/**
 * HTTP status + body for each failure, per the /api/image contract. The message
 * (Azure's text: deployment, region, tier) stays server-side; bodies are generic.
 */
export function imageErrorResponse(err: unknown): {
    status: number;
    body: { error: string; message?: string; retryAfter?: number };
} {
    const e = err instanceof ImageError ? err : new ImageError("image_failed", (err as Error)?.message || "failed");
    if (e.code === "not_configured") return { status: 503, body: { error: "image_not_configured" } };
    if (e.code === "blocked_by_safety")
        return { status: 422, body: { error: "blocked_by_safety", message: e.message } };
    if (e.code === "busy") return { status: 429, body: { error: "image_busy", retryAfter: e.retryAfter ?? 60 } };
    return { status: 502, body: { error: "image_failed", message: "The image model failed." } };
}

/** Seconds to wait from a 429: retry-after, else x-ratelimit-reset-requests ("6", "1m0s"), else the message text. */
function waitSeconds(res: Response, text: string): number | undefined {
    for (const v of [res.headers.get("retry-after"), res.headers.get("x-ratelimit-reset-requests")]) {
        const m = v?.trim().match(/^(?:(\d+)m)?(\d+(?:\.\d+)?)s?$/);
        if (m) return Math.ceil(Number(m[1] ?? 0) * 60 + Number(m[2]));
    }
    const m = /retry after (\d+) seconds?/i.exec(text);
    return m ? Number(m[1]) : undefined;
}

/** Connection-level failures (the deployment drops sockets under load): busy, not broken. */
function isNetworkError(e: any): boolean {
    return e instanceof TypeError || [e?.code, e?.cause?.code, e?.message].some((v) => /ECONNRESET/.test(String(v)));
}

const SAFETY_CODES = new Set(["content_filter", "contentFilter", "content_policy_violation", "moderation_blocked"]);

function classifyFailure(status: number, data: any, text: string): ImageError {
    const err = data?.error ?? {};
    const code = String(err.code ?? "");
    const message = String(err.message ?? text ?? "")
        .replace(/\s+/g, " ")
        .trim();
    if (code === "DeploymentNotFound" || status === 404) {
        return new ImageError("not_configured", "image model not deployed");
    }
    if (
        SAFETY_CODES.has(code) ||
        err.innererror?.code === "ResponsibleAIPolicyViolation" ||
        /safety system/i.test(message)
    ) {
        return new ImageError("blocked_by_safety", "The request was blocked by the image safety filter.");
    }
    return new ImageError("image_failed", `Azure ${status}: ${message.slice(0, 300) || "no detail"}`);
}

/** One short in-route retry on a 429 that asks for at most this long. */
const MAX_RETRY_WAIT_S = 20;
const RETRY_WINDOW_MS = 100_000;
/** Whole call, retry included: under the client's 190s timeout, so it is never charged for images it gave up on. */
const CALL_BUDGET_MS = 170_000;

export async function callAzureImage(
    cfg: ImageConfig,
    req: ImageRequest,
    fetchFn: typeof fetch = fetch,
): Promise<{ images: ImageOutput[]; dropped: number }> {
    const outputFormat = req.background === "transparent" ? "png" : "jpeg";
    const fields: Record<string, string> = {
        model: cfg.deployment,
        prompt: req.prompt,
        n: String(req.n),
        size: req.size,
        quality: req.quality,
        output_format: outputFormat,
    };
    if (req.background) fields.background = req.background;

    let url: string;
    let init: RequestInit;
    if (req.images.length) {
        const form = new FormData();
        for (const [k, val] of Object.entries(fields)) form.append(k, val);
        req.images.forEach((img, i) => {
            const ext = img.mimeType.split("/")[1] === "jpeg" ? "jpg" : img.mimeType.split("/")[1];
            form.append("image[]", new Blob([img.bytes], { type: img.mimeType }), `image${i}.${ext}`);
        });
        url = `${cfg.endpoint}/images/edits`;
        init = { method: "POST", headers: { "api-key": cfg.apiKey }, body: form };
    } else {
        url = `${cfg.endpoint}/images/generations`;
        init = {
            method: "POST",
            headers: { "api-key": cfg.apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({ ...fields, n: req.n }),
        };
    }

    const startedAt = Date.now();
    let res: Response;
    let text: string;
    for (let attempt = 0; ; attempt++) {
        try {
            res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(startedAt + CALL_BUDGET_MS - Date.now()) });
            // Inside the try: the socket can also reset while the body is still arriving.
            text = await res.text();
        } catch (e) {
            if (isNetworkError(e)) throw new ImageError("busy", `network: ${(e as Error)?.message}`, 60);
            throw e;
        }
        if (res.status !== 429) break;
        const wait = waitSeconds(res, text);
        if (
            attempt === 0 &&
            wait !== undefined &&
            wait <= MAX_RETRY_WAIT_S &&
            Date.now() - startedAt + wait * 1000 < RETRY_WINDOW_MS
        ) {
            await new Promise((r) => setTimeout(r, wait * 1000));
            continue;
        }
        throw new ImageError("busy", `Azure 429: ${text.slice(0, 300)}`, Math.max(1, wait ?? 60));
    }
    let data: any = null;
    try {
        data = JSON.parse(text);
    } catch {}
    if (!res.ok) throw classifyFailure(res.status, data, text);

    const mimeType = outputFormat === "png" ? "image/png" : "image/jpeg";
    const all: ImageOutput[] = (Array.isArray(data?.data) ? data.data : [])
        .filter((d: any) => typeof d?.b64_json === "string" && d.b64_json)
        .map((d: any) => ({ data: d.b64_json as string, mimeType }));
    if (!all.length) throw new ImageError("image_failed", "Azure returned no images");
    // Convex responses cap at 20MB and the encrypted envelope adds ~1/3: keep what fits, in order
    // (the route charges only for those), and fail (full refund) only when not even one fits.
    const images: ImageOutput[] = [];
    let total = 0;
    for (const img of all) {
        if (total + img.data.length > MAX_OUTPUT_B64_CHARS) break;
        total += img.data.length;
        images.push(img);
    }
    if (!images.length) throw new ImageError("image_failed", "The image came out too large to send.");
    return { images, dropped: all.length - images.length };
}
