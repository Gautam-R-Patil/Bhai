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

import { type Infer, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { deductCredits } from "./accounts";
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
        /** Seconds to wait, for "busy"; undefined = Azure didn't say. */
        readonly retryAfter?: number,
        /** Azure's HTTP status, when it answered with an error. */
        readonly status?: number,
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

/** Connection-level failures (the deployment drops sockets under load) and timeouts: busy, not broken. */
function isNetworkError(e: any): boolean {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") return true;
    return e instanceof TypeError || [e?.code, e?.cause?.code, e?.message].some((v) => /ECONNRESET/.test(String(v)));
}

/** An outage or overload, not this request's fault: 429, 408, any 5xx. */
const isBusyStatus = (status: number) => status === 429 || status === 408 || status >= 500;

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
    return new ImageError("image_failed", `Azure ${status}: ${message.slice(0, 300) || "no detail"}`, undefined, status);
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
    /** The route's one short in-call retry on a 429; the queue (false) waits outside instead. */
    retry429 = true,
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
            if (isNetworkError(e)) throw new ImageError("busy", `network: ${(e as Error)?.message}`);
            throw e;
        }
        if (!isBusyStatus(res.status)) break;
        const wait = waitSeconds(res, text);
        if (
            retry429 &&
            res.status === 429 &&
            attempt === 0 &&
            wait !== undefined &&
            wait <= MAX_RETRY_WAIT_S &&
            Date.now() - startedAt + wait * 1000 < RETRY_WINDOW_MS
        ) {
            await new Promise((r) => setTimeout(r, wait * 1000));
            continue;
        }
        throw new ImageError(
            "busy",
            `Azure ${res.status}: ${text.slice(0, 300)}`,
            wait === undefined ? undefined : Math.max(1, wait),
            res.status,
        );
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

// ── The queue (/api/image/jobs) ─────────────────────────────────
// The deployment's ~2 requests a minute are shared by every install, so jobs wait here and
// one worker sends them to Azure strictly one at a time, oldest first. A busy Azure (429,
// 408, 5xx, timeout, dropped socket) pauses the queue and the job keeps its place: it never
// fails for that (the day-long expiry still bounds the wait).
// image_queue_state (one row) holds the worker's lease, the pause and the busy backoff.

/** Rough seconds per job, for etaSeconds. */
const SECONDS_PER_JOB = 25;
/** A job "running" longer than this lost its worker and goes back in line. Also the worker's lease. */
const RUNNING_STALE_MS = 5 * 60_000;
/** Pause after a busy answer that names no wait; doubles while Azure stays busy, back to this on a success. */
const DEFAULT_BUSY_WAIT_S = 30;
const MAX_BUSY_WAIT_S = 5 * 60;
/** Hard (non-busy) attempts per job, lost workers included. */
const MAX_ATTEMPTS = 3;
/** Pause before retrying a job that failed for an unknown reason. */
const RETRY_PAUSE_S = 10;
/** Timeouts/5xx a job may hit while Azure made other images in the last 30 min (~15 min of backoff). */
const MAX_BUSY_STRIKES = 4;
const STRIKE_WINDOW_MS = 30 * 60_000;
const QUEUE_EXPIRY_MS = 24 * 60 * 60_000;
/** Finished jobs (and their files) are kept this long, so a client can fetch again. */
const KEEP_FINISHED_MS = 2 * 60 * 60_000;

type Job = Doc<"image_jobs">;
export type ImageJobErrorCode = "blocked_by_safety" | "image_failed" | "not_configured";

const storedImage = v.object({ storageId: v.id("_storage"), mimeType: v.string() });
const jobErrorCode = v.union(v.literal("blocked_by_safety"), v.literal("image_failed"), v.literal("not_configured"));
const jobOutcome = v.union(
    v.object({ kind: v.literal("done"), outputs: v.array(storedImage), dropped: v.number() }),
    /** retryAfter: Azure's wait in seconds; absent = back off. strike: not Azure's 429 (a timeout, a 5xx). */
    v.object({ kind: v.literal("busy"), retryAfter: v.optional(v.number()), strike: v.optional(v.boolean()) }),
    /** final: retrying can't help (Azure refused this request with a 4xx). */
    v.object({ kind: v.literal("failed"), code: jobErrorCode, message: v.string(), final: v.optional(v.boolean()) }),
);

const queueState = (ctx: QueryCtx) => ctx.db.query("image_queue_state").first();

async function setQueueState(
    ctx: MutationCtx,
    fields: { leaseUntil?: number; pausedUntil?: number; backoffS?: number; lastSuccessAt?: number },
): Promise<void> {
    const state = await queueState(ctx);
    if (state) await ctx.db.patch(state._id, fields);
    else await ctx.db.insert("image_queue_state", { leaseUntil: 0, pausedUntil: 0, ...fields });
}

/** Schedules the worker unless it is running or paused (a paused queue already has its run scheduled). */
async function kickWorker(ctx: MutationCtx): Promise<void> {
    const state = await queueState(ctx);
    const now = Date.now();
    if (state && (state.leaseUntil > now || state.pausedUntil > now)) return;
    await ctx.scheduler.runAfter(0, internal.image.processImageQueue, {});
}

/** Gives credits back once per job, whichever path gets there first. */
async function refundJob(ctx: MutationCtx, job: Job, amount: number): Promise<void> {
    if (job.refunded) return;
    await ctx.db.patch(job._id, { refunded: true });
    const account = await ctx.db.get(job.accountId);
    if (account && amount > 0) await ctx.db.patch(account._id, { ai_credits: Math.max(0, account.ai_credits + amount) });
}

async function failJob(ctx: MutationCtx, job: Job, code: ImageJobErrorCode, message: string): Promise<void> {
    await refundJob(ctx, job, job.creditsCharged);
    await ctx.db.patch(job._id, { status: "failed", error: { code, message }, creditsCharged: 0, finishedAt: Date.now() });
}

// ponytail: counts by reading the queue (capped at 1000); a counter row if it ever grows that long.
async function queuedAhead(ctx: QueryCtx, createdAt: number): Promise<number> {
    const ahead = await ctx.db
        .query("image_jobs")
        .withIndex("by_status_and_createdAt", (q) => q.eq("status", "queued").lt("createdAt", createdAt))
        .take(1000);
    return ahead.length;
}

/**
 * POST /api/image/jobs, after the inputs are stored: takes the full cost and queues the job in
 * one transaction, so credits never go without a job. shortfall = not charged, nothing queued.
 */
export const enqueueImageJob = internalMutation({
    args: {
        accountId: v.id("accounts"),
        otplessUserId: v.string(),
        prompt: v.string(),
        size: v.string(),
        quality: v.union(v.literal("low"), v.literal("medium"), v.literal("high")),
        n: v.number(),
        background: v.optional(v.union(v.literal("transparent"), v.literal("opaque"), v.literal("auto"))),
        inputs: v.array(storedImage),
    },
    handler: async (
        ctx,
        args,
    ): Promise<{ shortfall: true } | { shortfall: false; jobId: Id<"image_jobs">; position: number; credits: number }> => {
        const creditsCharged = imageCreditCost(args.quality, args.n);
        const deducted = await deductCredits(ctx, args.otplessUserId, creditsCharged);
        if (!deducted.success) return { shortfall: true };
        const createdAt = Date.now();
        const jobId = await ctx.db.insert("image_jobs", {
            ...args,
            creditsCharged,
            status: "queued",
            refunded: false,
            attempts: 0,
            createdAt,
        });
        await kickWorker(ctx);
        return { shortfall: false, jobId, position: await queuedAhead(ctx, createdAt), credits: deducted.remaining };
    },
});

/** A job still running past RUNNING_STALE_MS (the lease ran out with it): its worker died. */
async function requeueStaleJobs(ctx: MutationCtx, now: number): Promise<void> {
    const running = await ctx.db
        .query("image_jobs")
        .withIndex("by_status_and_createdAt", (q) => q.eq("status", "running"))
        .take(10);
    for (const job of running) {
        if (now - (job.startedAt ?? 0) < RUNNING_STALE_MS) continue;
        if (job.attempts >= MAX_ATTEMPTS) await failJob(ctx, job, "image_failed", "The image worker kept stopping.");
        else await ctx.db.patch(job._id, { status: "queued" });
    }
}

/** The oldest queued job, now running under the worker's lease; null = paused, leased or nothing queued. */
export const claimImageJob = internalMutation({
    args: {},
    handler: async (ctx): Promise<Job | null> => {
        const now = Date.now();
        const state = await queueState(ctx);
        if (state && (state.leaseUntil > now || state.pausedUntil > now)) return null;
        await requeueStaleJobs(ctx, now);
        const job = await ctx.db
            .query("image_jobs")
            .withIndex("by_status_and_createdAt", (q) => q.eq("status", "queued"))
            .first();
        if (!job) return null;
        const claimed = { status: "running" as const, startedAt: now, attempts: job.attempts + 1 };
        await ctx.db.patch(job._id, claimed);
        await setQueueState(ctx, { leaseUntil: now + RUNNING_STALE_MS });
        return { ...job, ...claimed };
    },
});

/**
 * Ends the worker's turn on a job and frees the lease. Returns the ms until the worker's next
 * run (the pause, if any). `startedAt` is the claim's token: a worker whose job was already
 * requeued as stale changes nothing (returns null).
 */
export const settleImageJob = internalMutation({
    args: { jobId: v.id("image_jobs"), startedAt: v.number(), outcome: jobOutcome },
    handler: async (ctx, { jobId, startedAt, outcome }): Promise<number | null> => {
        const job = await ctx.db.get(jobId);
        if (job?.status !== "running" || job.startedAt !== startedAt) return null;
        const now = Date.now();
        let pauseS = 0;
        const state = await queueState(ctx);
        let backoffS = state?.backoffS ?? 0;
        if (outcome.kind === "busy") {
            if (outcome.retryAfter !== undefined) pauseS = outcome.retryAfter;
            else pauseS = backoffS = backoffS ? Math.min(backoffS * 2, MAX_BUSY_WAIT_S) : DEFAULT_BUSY_WAIT_S;
        } else if (outcome.kind === "done") backoffS = 0;
        const retry = outcome.kind === "failed" && outcome.code === "image_failed" && !outcome.final && job.attempts < MAX_ATTEMPTS;
        if (retry) pauseS = RETRY_PAUSE_S;
        await setQueueState(ctx, {
            leaseUntil: 0,
            pausedUntil: now + pauseS * 1000,
            backoffS,
            ...(outcome.kind === "done" ? { lastSuccessAt: now } : {}),
        });
        // A job that keeps timing out or getting a 5xx while Azure made images for others lately is
        // this job's problem, not an outage: after a few strikes it fails, so it can't hold the line.
        // In an outage nothing has succeeded for a while and the strikes don't count: everyone waits.
        const strikes =
            outcome.kind === "busy" && outcome.strike && now - (state?.lastSuccessAt ?? 0) < STRIKE_WINDOW_MS
                ? (job.busyStrikes ?? 0) + 1
                : (job.busyStrikes ?? 0);
        if (outcome.kind === "done") {
            const charged = imageCreditCost(job.quality, outcome.outputs.length);
            if (charged < job.creditsCharged) await refundJob(ctx, job, job.creditsCharged - charged);
            await ctx.db.patch(job._id, {
                status: "done",
                outputs: outcome.outputs,
                dropped: outcome.dropped,
                creditsCharged: charged,
                finishedAt: now,
            });
        } else if (outcome.kind === "busy" && strikes >= MAX_BUSY_STRIKES) {
            await failJob(ctx, job, "image_failed", "Azure kept timing out or failing on this image");
        } else if (outcome.kind === "busy") {
            // Not the job's fault: the attempt is given back, and createdAt keeps its place in line.
            await ctx.db.patch(job._id, { status: "queued", attempts: job.attempts - 1, busyStrikes: strikes });
        } else if (retry) {
            await ctx.db.patch(job._id, { status: "queued" });
        } else {
            await failJob(ctx, job, outcome.code, outcome.message);
        }
        return pauseS * 1000;
    },
});

/** The worker: one job per run, then it schedules itself again until nothing is queued. */
export const processImageQueue = internalAction({
    args: {},
    handler: async (ctx) => {
        const job: Job | null = await ctx.runMutation(internal.image.claimImageJob, {});
        if (!job) return null;
        const cfg = imageConfigFromEnv(process.env);
        const startedAt = Date.now();
        const settle = (outcome: Infer<typeof jobOutcome>): Promise<number | null> =>
            ctx.runMutation(internal.image.settleImageJob, { jobId: job._id, startedAt: job.startedAt ?? 0, outcome });
        const log = (status: "success" | "failed", credits: number, errorMessage?: string) =>
            ctx
                .runMutation(internal.llmCallLog.record, {
                    accountId: job.accountId,
                    otplessUserId: job.otplessUserId,
                    model: `image:${cfg?.deployment ?? "none"}`,
                    status,
                    credits,
                    latencyMs: Date.now() - startedAt,
                    errorMessage,
                    hasMedia: true,
                })
                .catch(() => {});
        let nextRunMs = 0;
        try {
            if (!cfg) throw new ImageError("not_configured", "image model not configured");
            const images: ImageRequest["images"] = [];
            for (const input of job.inputs) {
                const blob = await ctx.storage.get(input.storageId);
                if (!blob) throw new ImageError("image_failed", "input image missing from storage");
                images.push({ bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: input.mimeType });
            }
            const { prompt, size, quality, n, background } = job;
            const out = await callAzureImage(cfg, { prompt, size, quality, n, background, images }, fetch, false);
            // Kept as base64 text: the status route sends it back as is.
            const outputs = await Promise.all(
                out.images.map(async (img) => ({
                    storageId: await ctx.storage.store(new Blob([img.data], { type: "text/plain" })),
                    mimeType: img.mimeType,
                })),
            );
            const settled = await settle({ kind: "done", outputs, dropped: out.dropped });
            if (settled !== null) await log("success", imageCreditCost(quality, outputs.length));
            else for (const o of outputs) await ctx.storage.delete(o.storageId);
        } catch (err) {
            const e = err instanceof ImageError ? err : new ImageError("image_failed", (err as Error)?.message || "failed");
            if (e.code === "busy") {
                nextRunMs = (await settle({ kind: "busy", retryAfter: e.retryAfter, strike: e.status !== 429 })) ?? 0;
                console.warn(`[Image] Azure busy, queue paused ${nextRunMs / 1000}s: ${e.message}`);
            } else {
                console.error(`[Image] job ${job._id} ${e.code}:`, e.message);
                // Azure refused this very request (4xx): sending it again can't help.
                const final = e.status !== undefined && e.status >= 400 && e.status < 500;
                nextRunMs = (await settle({ kind: "failed", code: e.code, message: e.message, final })) ?? 0;
                await log("failed", 0, e.message);
            }
        }
        await ctx.scheduler.runAfter(nextRunMs, internal.image.processImageQueue, {});
        return null;
    },
});

export type ImageJobStatus =
    | { status: "queued"; position: number; etaSeconds: number }
    | { status: "running"; etaSeconds: number }
    | { status: "done"; outputs: Array<Infer<typeof storedImage>>; dropped?: number; credits: number }
    | { status: "failed"; error: { code: ImageJobErrorCode; message: string }; credits: number };

/** A job as its owner sees it (credits = the balance now); null = no such job, or not theirs. */
export const getImageJobStatus = internalQuery({
    args: { jobId: v.string(), accountId: v.id("accounts") },
    handler: async (ctx, { jobId, accountId }): Promise<ImageJobStatus | null> => {
        const id = ctx.db.normalizeId("image_jobs", jobId);
        const job = id && (await ctx.db.get(id));
        if (!job || job.accountId !== accountId) return null;
        const now = Date.now();
        if (job.status === "queued") {
            const pausedUntil = (await queueState(ctx))?.pausedUntil ?? 0;
            const position = await queuedAhead(ctx, job.createdAt);
            const pauseS = Math.max(0, Math.ceil((pausedUntil - now) / 1000));
            return { status: "queued", position, etaSeconds: (position + 1) * SECONDS_PER_JOB + pauseS };
        }
        if (job.status === "running") {
            const elapsedS = Math.floor((now - (job.startedAt ?? now)) / 1000);
            return { status: "running", etaSeconds: Math.max(5, SECONDS_PER_JOB - elapsedS) };
        }
        const credits = (await ctx.db.get(accountId))?.ai_credits ?? 0;
        if (job.status === "done")
            return { status: "done", outputs: job.outputs ?? [], ...(job.dropped ? { dropped: job.dropped } : {}), credits };
        return { status: "failed", error: job.error ?? { code: "image_failed", message: "failed" }, credits };
    },
});

/**
 * Every minute: requeue jobs whose worker died, expire day-old queued jobs, delete finished ones
 * past KEEP_FINISHED_MS, and kick the worker if anything is queued.
 */
export const tickImageQueue = internalMutation({
    args: {},
    handler: async (ctx) => {
        const now = Date.now();
        await requeueStaleJobs(ctx, now);
        const expired = await ctx.db
            .query("image_jobs")
            .withIndex("by_status_and_createdAt", (q) => q.eq("status", "queued").lt("createdAt", now - QUEUE_EXPIRY_MS))
            .take(50);
        for (const job of expired) await failJob(ctx, job, "image_failed", "The image model stayed busy for a day.");
        for (const status of ["done", "failed"] as const) {
            const old = await ctx.db
                .query("image_jobs")
                .withIndex("by_status_and_finishedAt", (q) => q.eq("status", status).lt("finishedAt", now - KEEP_FINISHED_MS))
                .take(50);
            for (const job of old) {
                for (const f of [...job.inputs, ...(job.outputs ?? [])]) await ctx.storage.delete(f.storageId);
                await ctx.db.delete(job._id);
            }
        }
        const queued = await ctx.db
            .query("image_jobs")
            .withIndex("by_status_and_createdAt", (q) => q.eq("status", "queued"))
            .first();
        if (queued) await kickWorker(ctx);
    },
});
