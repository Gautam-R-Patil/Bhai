// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    callAzureImage,
    claimImageJob,
    enqueueImageJob,
    getImageJobStatus,
    IMAGE_MAX_INPUT_BYTES,
    ImageError,
    imageConfigFromEnv,
    imageCreditCost,
    imageErrorResponse,
    type ImageRequest,
    processImageQueue,
    settleImageJob,
    tickImageQueue,
    validateImageRequest,
} from "./image";

const cfg = { endpoint: "https://res.openai.azure.com/openai/v1", apiKey: "k", deployment: "gpt-image-2.5-sunburst" };
const ok = (n = 1) =>
    vi.fn(
        async () =>
            new Response(JSON.stringify({ data: Array.from({ length: n }, (_, i) => ({ b64_json: `img${i}` })) }), {
                status: 200,
            }),
    );
const valid = (body: unknown) => {
    const r = validateImageRequest(body);
    if ("error" in r) throw new Error(r.error);
    return r as ImageRequest;
};

describe("server image generation", () => {
    it("reads its own Azure env, falls back to the Grok resource, and is off without one", () => {
        expect(imageConfigFromEnv({})).toBeNull();
        expect(imageConfigFromEnv({ AZURE_GROK_ENDPOINT: "https://g/openai/v1/", AZURE_GROK_API_KEY: "g" })).toEqual({
            endpoint: "https://g/openai/v1",
            apiKey: "g",
            deployment: "gpt-image-2.5-sunburst",
        });
        expect(
            imageConfigFromEnv({
                AZURE_IMAGE_ENDPOINT: "https://i/openai/v1",
                AZURE_IMAGE_API_KEY: "i",
                AZURE_GROK_ENDPOINT: "https://g",
                AZURE_GROK_API_KEY: "g",
                AZURE_IMAGE_MODEL: "dep",
            }),
        ).toEqual({ endpoint: "https://i/openai/v1", apiKey: "i", deployment: "dep" });
    });

    it("charges per image by quality", () => {
        expect(imageCreditCost("low", 1)).toBe(1);
        expect(imageCreditCost("medium", 1)).toBe(2);
        expect(imageCreditCost("high", 3)).toBe(12);
    });

    it("validates and defaults the request", () => {
        expect(valid({ prompt: " a cat " })).toMatchObject({ prompt: "a cat", size: "1024x1024", quality: "medium", n: 1 });
        expect(valid({ prompt: "x", images: [{ data: btoa("p"), mimeType: "image/png" }] }).size).toBe("auto");
        expect(validateImageRequest({})).toEqual({ error: "prompt required", status: 400 });
        expect(validateImageRequest({ prompt: "x", n: 5 })).toMatchObject({ status: 400 });
        expect(validateImageRequest({ prompt: "x", size: "100x100" })).toMatchObject({ status: 400 });
        expect(validateImageRequest({ prompt: "x", images: [{ data: "a", mimeType: "image/gif" }] })).toMatchObject({
            status: 400,
        });
        const five = Array.from({ length: 5 }, () => ({ data: btoa("p"), mimeType: "image/png" }));
        expect(validateImageRequest({ prompt: "x", images: five })).toMatchObject({ status: 400 });
        const big = btoa("a".repeat(IMAGE_MAX_INPUT_BYTES + 3));
        expect(validateImageRequest({ prompt: "x", images: [{ data: big, mimeType: "image/png" }] })).toEqual({
            error: "image_too_large",
            status: 413,
        });
    });

    it("posts JSON to /images/generations for a fresh image", async () => {
        const fetchFn = ok(2);
        const out = await callAzureImage(cfg, valid({ prompt: "a cat", n: 2, quality: "high" }), fetchFn);
        expect(out).toEqual({
            images: [
                { data: "img0", mimeType: "image/jpeg" },
                { data: "img1", mimeType: "image/jpeg" },
            ],
            dropped: 0,
        });
        const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(`${cfg.endpoint}/images/generations`);
        expect((init.headers as Record<string, string>)["api-key"]).toBe("k");
        expect(JSON.parse(init.body as string)).toEqual({
            model: "gpt-image-2.5-sunburst",
            prompt: "a cat",
            n: 2,
            size: "1024x1024",
            quality: "high",
            output_format: "jpeg",
        });
    });

    it("posts multipart to /images/edits with every image as image[]", async () => {
        const fetchFn = ok();
        const req = valid({
            prompt: "combine them",
            background: "transparent",
            images: [
                { data: btoa("one"), mimeType: "image/png" },
                { data: btoa("two"), mimeType: "image/jpeg" },
            ],
        });
        const out = await callAzureImage(cfg, req, fetchFn);
        expect(out.images).toEqual([{ data: "img0", mimeType: "image/png" }]);
        const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(`${cfg.endpoint}/images/edits`);
        const form = init.body as FormData;
        const files = form.getAll("image[]") as File[];
        expect(files.map((f) => f.name)).toEqual(["image0.png", "image1.jpg"]);
        expect(files[1].type).toBe("image/jpeg");
        expect(form.get("model")).toBe("gpt-image-2.5-sunburst");
        expect(form.get("output_format")).toBe("png");
        expect(form.get("background")).toBe("transparent");
        expect(form.get("size")).toBe("auto");
        expect(form.get("n")).toBe("1");
    });

    it("classifies the content filter as blocked_by_safety (422)", async () => {
        const bodies = [
            { error: { code: "content_policy_violation", message: "nope" } },
            { error: { code: "moderation_blocked", message: "nope" } },
            { error: { code: "BadRequest", message: "x", innererror: { code: "ResponsibleAIPolicyViolation" } } },
            { error: { code: "BadRequest", message: "Your request was rejected by the safety system." } },
        ];
        for (const b of bodies) {
            const err = await callAzureImage(
                cfg,
                valid({ prompt: "x" }),
                vi.fn(async () => new Response(JSON.stringify(b), { status: 400 })),
            ).catch((e) => e);
            expect(err).toBeInstanceOf(ImageError);
            expect(err.code).toBe("blocked_by_safety");
            expect(imageErrorResponse(err)).toMatchObject({ status: 422, body: { error: "blocked_by_safety" } });
        }
    });

    it("maps DeploymentNotFound to image_not_configured (503)", async () => {
        const fetchFn = vi.fn(
            async () =>
                new Response(JSON.stringify({ error: { code: "DeploymentNotFound", message: "no such" } }), { status: 404 }),
        );
        const err = await callAzureImage(cfg, valid({ prompt: "x" }), fetchFn).catch((e) => e);
        expect(err.code).toBe("not_configured");
        expect(imageErrorResponse(err)).toEqual({ status: 503, body: { error: "image_not_configured" } });
    });

    it("treats a 200 with no images, or any other error, as image_failed (502)", async () => {
        const empty = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
        const err = await callAzureImage(cfg, valid({ prompt: "x" }), empty).catch((e) => e);
        expect(err.code).toBe("image_failed");
        expect(imageErrorResponse(err)).toMatchObject({ status: 502, body: { error: "image_failed" } });

        const bad = { error: { code: "invalid_request", message: "bad size here" } };
        const boom = vi.fn(async () => new Response(JSON.stringify(bad), { status: 400 }));
        const err2 = await callAzureImage(cfg, valid({ prompt: "x" }), boom).catch((e) => e);
        expect([err2.code, err2.status]).toEqual(["image_failed", 400]);
        expect(err2.message).toContain("bad size here");
        // Azure's text (deployment, region, tier) is logged server-side, never sent to the client.
        expect(imageErrorResponse(err2).body).toEqual({ error: "image_failed", message: "The image model failed." });
        expect(imageErrorResponse(new Error("network")).status).toBe(502);
    });

    it("keeps the first images that fit in a Convex response and drops the rest", async () => {
        const reply = (sizes: number[]) =>
            vi.fn(
                async () =>
                    new Response(JSON.stringify({ data: sizes.map((n, i) => ({ b64_json: String(i).repeat(n) })) }), {
                        status: 200,
                    }),
            );
        const out = await callAzureImage(cfg, valid({ prompt: "x", n: 4 }), reply([5_500_000, 5_500_000, 5_500_000, 10]));
        expect(out.images.map((i) => i.data[0])).toEqual(["0", "1"]);
        expect(out.dropped).toBe(2);
        // Not even one fits: fail, so the route refunds everything.
        const err = await callAzureImage(cfg, valid({ prompt: "x" }), reply([15_000_000])).catch((e) => e);
        expect(err.code).toBe("image_failed");
    });

    it("accepts custom WxH sizes on the 16px grid within 256-2048 and 3:1", () => {
        for (const size of ["1600x1200", "1088x1920", "2048x2048", "256x768", "1536x1024", "auto"])
            expect(valid({ prompt: "x", size }).size).toBe(size);
        for (const size of ["1000x1000", "4096x1024", "240x240", "256x1024", "1024", 1024, "1024x1024x1"])
            expect(validateImageRequest({ prompt: "x", size })).toEqual({ error: "invalid size", status: 400 });
    });

    describe("rate limits (429) and dropped connections", () => {
        const r429 = (headers: Record<string, string> = {}, message = "Rate limit is exceeded.") =>
            new Response(JSON.stringify({ error: { code: "429", message } }), { status: 429, headers });

        it("retries once after a short wait, then succeeds", async () => {
            vi.useFakeTimers({ toFake: ["setTimeout"] });
            try {
                const fetchFn = vi
                    .fn()
                    .mockResolvedValueOnce(r429({}, "Please retry after 2 seconds."))
                    .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: "ok" }] }), { status: 200 }));
                const p = callAzureImage(cfg, valid({ prompt: "x" }), fetchFn);
                await vi.advanceTimersByTimeAsync(1_900);
                expect(fetchFn).toHaveBeenCalledTimes(1);
                await vi.advanceTimersByTimeAsync(200);
                expect((await p).images[0].data).toBe("ok");
                expect(fetchFn).toHaveBeenCalledTimes(2);
            } finally {
                vi.useRealTimers();
            }
        });

        it("is busy (429 image_busy) after a second 429 or a long wait, with retryAfter", async () => {
            const twice = vi.fn(async () => r429({ "retry-after": "0" }));
            const err = await callAzureImage(cfg, valid({ prompt: "x" }), twice).catch((e) => e);
            expect(twice).toHaveBeenCalledTimes(2);
            expect(err.code).toBe("busy");
            expect(imageErrorResponse(err)).toEqual({ status: 429, body: { error: "image_busy", retryAfter: 1 } });

            const long = vi.fn(async () => r429({ "x-ratelimit-reset-requests": "1m0s" }, "West US 3 S0 tier"));
            const err2 = await callAzureImage(cfg, valid({ prompt: "x" }), long).catch((e) => e);
            expect(long).toHaveBeenCalledTimes(1);
            expect(imageErrorResponse(err2)).toEqual({ status: 429, body: { error: "image_busy", retryAfter: 60 } });
        });

        it("treats a reset while the body is arriving as busy too", async () => {
            const body = new ReadableStream({
                start(c) {
                    c.error(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
                },
            });
            const err = await callAzureImage(
                cfg,
                valid({ prompt: "x" }),
                vi.fn(async () => new Response(body, { status: 200 })),
            ).catch((e) => e);
            expect(imageErrorResponse(err)).toEqual({ status: 429, body: { error: "image_busy", retryAfter: 60 } });
        });

        it("treats a dropped connection as busy, not failed", async () => {
            const reset = vi.fn(async () => {
                throw new TypeError("fetch failed");
            });
            const err = await callAzureImage(cfg, valid({ prompt: "x" }), reset).catch((e) => e);
            expect(imageErrorResponse(err)).toEqual({ status: 429, body: { error: "image_busy", retryAfter: 60 } });
        });

        it("treats a 5xx, a 408 and a timeout as busy, with Azure's wait if it names one", async () => {
            for (const status of [500, 502, 503, 504, 408]) {
                const fetchFn = vi.fn(async () => new Response("upstream down", { status }));
                const err = await callAzureImage(cfg, valid({ prompt: "x" }), fetchFn).catch((e) => e);
                expect(fetchFn).toHaveBeenCalledTimes(1); // no in-call retry: that is only for a short 429
                expect([err.code, err.retryAfter]).toEqual(["busy", undefined]);
                expect(imageErrorResponse(err)).toEqual({ status: 429, body: { error: "image_busy", retryAfter: 60 } });
            }
            const named = vi.fn(async () => new Response("down", { status: 503, headers: { "retry-after": "7" } }));
            expect((await callAzureImage(cfg, valid({ prompt: "x" }), named).catch((e) => e)).retryAfter).toBe(7);
            const timeout = vi.fn(async () => {
                throw new DOMException("The operation timed out.", "TimeoutError");
            });
            expect((await callAzureImage(cfg, valid({ prompt: "x" }), timeout).catch((e) => e)).code).toBe("busy");
        });

        it("from the queue (no in-call retry), surfaces the 429 at once with Azure's wait, if any", async () => {
            const short = vi.fn(async () => r429({}, "Please retry after 2 seconds."));
            const err = await callAzureImage(cfg, valid({ prompt: "x" }), short, false).catch((e) => e);
            expect(short).toHaveBeenCalledTimes(1);
            expect([err.code, err.retryAfter]).toEqual(["busy", 2]);
            const unknown = await callAzureImage(cfg, valid({ prompt: "x" }), vi.fn(async () => r429()), false).catch((e) => e);
            expect([unknown.code, unknown.retryAfter]).toEqual(["busy", undefined]);
        });
    });
});

describe("image queue", () => {
    // In-memory tables: enough for the queue's mutations (index = the fields in its name, eq/lt only).
    const fakeCtx = () => {
        const tables: Record<string, any[]> = { accounts: [], image_jobs: [], image_queue_state: [] };
        let next = 0;
        const find = (id: string) => Object.values(tables).flat().find((r) => r._id === id);
        const query = (table: string) => {
            let rows = [...tables[table]];
            const result = {
                withIndex: (name: string, f: (q: any) => unknown) => {
                    const q: any = {
                        eq: (k: string, val: unknown) => ((rows = rows.filter((r) => r[k] === val)), q),
                        lt: (k: string, val: number) => ((rows = rows.filter((r) => r[k] < val)), q),
                    };
                    f(q);
                    const fields = name.replace(/^by_/, "").split("_and_");
                    rows.sort((a, b) => {
                        for (const k of fields) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
                        return 0;
                    });
                    return result;
                },
                first: async () => rows[0] ?? null,
                unique: async () => rows[0] ?? null,
                take: async (n: number) => rows.slice(0, n),
            };
            return result;
        };
        const c = {
            tables,
            scheduled: [] as number[],
            deleted: [] as string[],
            db: {
                query,
                get: async (id: string) => find(id) ?? null,
                normalizeId: (table: string, id: string) => (tables[table].some((r) => r._id === id) ? id : null),
                insert: async (table: string, doc: any) => {
                    const _id = `${table}:${next++}`;
                    tables[table].push({ _id, ...doc });
                    return _id;
                },
                patch: async (id: string, f: any) => void Object.assign(find(id), f),
                delete: async (id: string) => {
                    for (const t of Object.values(tables)) {
                        const i = t.findIndex((r) => r._id === id);
                        if (i >= 0) t.splice(i, 1);
                    }
                },
            },
            scheduler: { runAfter: async (ms: number) => void c.scheduled.push(ms) },
            storage: { delete: async (id: string) => void c.deleted.push(id) },
        };
        return c;
    };
    const run = (fn: any, ctx: any, args: any = {}) => fn._handler(ctx, args);
    const credits = (ctx: any) => ctx.tables.accounts[0].ai_credits;

    let ctx: any;
    /** Submits like the route: the mutation takes the credits and queues the job together. */
    const submit = async (fields: Record<string, unknown> = {}, accountId = "accounts:acct") => {
        const job = { prompt: "a cat", size: "1024x1024", quality: "medium", n: 1, inputs: [], ...fields };
        const { otplessUserId } = ctx.tables.accounts.find((a: any) => a._id === accountId);
        const out = await run(enqueueImageJob, ctx, { accountId, otplessUserId, ...job });
        vi.advanceTimersByTime(1_000);
        return out;
    };
    const jobOf = (id: string) => ctx.tables.image_jobs.find((j: any) => j._id === id);
    const outputs = (k: number) => Array.from({ length: k }, (_, i) => ({ storageId: `out${i}`, mimeType: "image/jpeg" }));

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        ctx = fakeCtx();
        ctx.tables.accounts.push(
            { _id: "accounts:acct", otplessUserId: "u", status: "active", ai_credits: 20 },
            { _id: "accounts:other", otplessUserId: "u2", status: "active", ai_credits: 20 },
        );
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it("charges and queues in one step, and on a shortfall does neither", async () => {
        const a = await submit({ quality: "high", n: 4 }); // 16 credits
        expect(a).toMatchObject({ shortfall: false, position: 0, credits: 4 });
        expect(jobOf(a.jobId)).toMatchObject({ status: "queued", creditsCharged: 16 });
        expect(await submit({ quality: "high", n: 2 })).toEqual({ shortfall: true }); // 8 > 4
        expect(credits(ctx)).toBe(4);
        expect(ctx.tables.image_jobs).toHaveLength(1);
    });

    it("claims strictly oldest first, one at a time, and kicks the worker on submit", async () => {
        const a = await submit();
        const b = await submit();
        expect([a.position, b.position]).toEqual([0, 1]);
        expect(ctx.scheduled).toEqual([0, 0]);
        const first = await run(claimImageJob, ctx);
        expect(first._id).toBe(a.jobId);
        expect(await run(claimImageJob, ctx)).toBeNull(); // single flight: the lease is held
        expect(await submit()).toMatchObject({ position: 1 }); // b is still ahead
        expect(ctx.scheduled).toHaveLength(2); // no kick while the worker holds the lease
        await run(settleImageJob, ctx, { jobId: a.jobId, startedAt: first.startedAt, outcome: { kind: "done", outputs: outputs(1), dropped: 0 } });
        expect((await run(claimImageJob, ctx))._id).toBe(b.jobId);
    });

    it("a job that keeps timing out while Azure works for others fails after 4 strikes; in an outage it waits", async () => {
        const a = await submit();
        const b = await submit();
        const c = await submit();
        // Azure made a's image: it's up.
        let claimed = await run(claimImageJob, ctx);
        await run(settleImageJob, ctx, { jobId: a.jobId, startedAt: claimed.startedAt, outcome: { kind: "done", outputs: outputs(1), dropped: 0 } });
        for (let i = 1; i <= 4; i++) {
            claimed = await run(claimImageJob, ctx);
            expect(claimed._id).toBe(b.jobId);
            const wait = await run(settleImageJob, ctx, { jobId: b.jobId, startedAt: claimed.startedAt, outcome: { kind: "busy", strike: true } });
            vi.advanceTimersByTime(wait);
        }
        expect(jobOf(b.jobId)).toMatchObject({ status: "failed", refunded: true });
        expect((await run(claimImageJob, ctx))._id).toBe(c.jobId); // the line moves on
        // Over 30 min since anything worked (an outage): strikes don't count, c keeps waiting.
        vi.advanceTimersByTime(31 * 60_000);
        for (let i = 0; i < 6; i++) {
            claimed = claimed ?? (await run(claimImageJob, ctx));
            const wait = await run(settleImageJob, ctx, { jobId: c.jobId, startedAt: claimed.startedAt, outcome: { kind: "busy", strike: true } });
            vi.advanceTimersByTime(wait);
            claimed = null;
        }
        expect(jobOf(c.jobId)).toMatchObject({ status: "queued", refunded: false, busyStrikes: 0 });
    });

    it("on a 429 puts the job back in its place, pauses the queue, and never fails or charges for it", async () => {
        const a = await submit();
        const b = await submit();
        const claimed = await run(claimImageJob, ctx);
        const ok = await run(settleImageJob, ctx, { jobId: a.jobId, startedAt: claimed.startedAt, outcome: { kind: "busy", retryAfter: 40 } });
        expect(ok).toBe(40_000);
        expect(jobOf(a.jobId)).toMatchObject({ status: "queued", attempts: 0, refunded: false });
        expect(credits(ctx)).toBe(16);
        expect(await run(claimImageJob, ctx)).toBeNull(); // paused
        expect(await run(getImageJobStatus, ctx, { jobId: b.jobId, accountId: "accounts:acct" })).toEqual({
            status: "queued",
            position: 1,
            etaSeconds: 2 * 25 + 40,
        });
        vi.advanceTimersByTime(40_000);
        expect((await run(claimImageJob, ctx))._id).toBe(a.jobId);
    });

    it("on success keeps the images and refunds only the dropped ones", async () => {
        const a = await submit({ n: 3 }); // 6 credits
        const claimed = await run(claimImageJob, ctx);
        await run(settleImageJob, ctx, { jobId: a.jobId, startedAt: claimed.startedAt, outcome: { kind: "done", outputs: outputs(2), dropped: 1 } });
        expect(jobOf(a.jobId)).toMatchObject({ status: "done", creditsCharged: 4, refunded: true });
        expect(credits(ctx)).toBe(16);
        expect(await run(getImageJobStatus, ctx, { jobId: a.jobId, accountId: "accounts:acct" })).toEqual({
            status: "done",
            outputs: outputs(2),
            dropped: 1,
            credits: 16,
        });
    });

    it("refunds a failed job in full, exactly once", async () => {
        const a = await submit({ quality: "high" }); // 4 credits
        const claimed = await run(claimImageJob, ctx);
        const settle = () =>
            run(settleImageJob, ctx, {
                jobId: a.jobId,
                startedAt: claimed.startedAt,
                outcome: { kind: "failed", code: "blocked_by_safety", message: "blocked" },
            });
        expect(await settle()).toBe(0);
        expect(await settle()).toBeNull(); // a second settle changes nothing
        await run(tickImageQueue, ctx);
        expect(credits(ctx)).toBe(20);
        expect(await run(getImageJobStatus, ctx, { jobId: a.jobId, accountId: "accounts:acct" })).toEqual({
            status: "failed",
            error: { code: "blocked_by_safety", message: "blocked" },
            credits: 20,
        });
    });

    it("retries unknown failures up to 3 attempts in all, 10s apart, then fails with a full refund", async () => {
        const a = await submit();
        for (let i = 1; i <= 3; i++) {
            const claimed = await run(claimImageJob, ctx);
            expect(claimed).toMatchObject({ _id: a.jobId, attempts: i });
            const wait = await run(settleImageJob, ctx, {
                jobId: a.jobId,
                startedAt: claimed.startedAt,
                outcome: { kind: "failed", code: "image_failed", message: "no images" },
            });
            expect(wait).toBe(i < 3 ? 10_000 : 0);
            if (i < 3) {
                vi.advanceTimersByTime(9_999);
                expect(await run(claimImageJob, ctx)).toBeNull(); // paused before the retry
                vi.advanceTimersByTime(1);
            }
        }
        expect(jobOf(a.jobId)).toMatchObject({ status: "failed", refunded: true });
        expect(credits(ctx)).toBe(20);
    });

    it("fails a request Azure refused (4xx) at once, with a full refund", async () => {
        const a = await submit();
        const claimed = await run(claimImageJob, ctx);
        const outcome = { kind: "failed", code: "image_failed", message: "Azure 400: bad", final: true };
        expect(await run(settleImageJob, ctx, { jobId: a.jobId, startedAt: claimed.startedAt, outcome })).toBe(0);
        expect(jobOf(a.jobId)).toMatchObject({ status: "failed", attempts: 1, refunded: true });
        expect(credits(ctx)).toBe(20);
    });

    it("backs off 30s, doubling to 5 minutes, while Azure stays busy without a wait; a success resets it", async () => {
        const a = await submit();
        const busyOnce = async (outcome: any = { kind: "busy" }) => {
            const claimed = await run(claimImageJob, ctx);
            const wait = await run(settleImageJob, ctx, { jobId: a.jobId, startedAt: claimed.startedAt, outcome });
            vi.advanceTimersByTime(wait);
            return wait;
        };
        const waits = [];
        for (let i = 0; i < 6; i++) waits.push(await busyOnce());
        expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
        expect(await busyOnce({ kind: "busy", retryAfter: 5 })).toBe(5_000); // Azure's own wait wins
        expect(jobOf(a.jobId)).toMatchObject({ status: "queued", attempts: 0 });
        await busyOnce({ kind: "done", outputs: outputs(1), dropped: 0 });
        const b = await submit();
        const claimed = await run(claimImageJob, ctx);
        expect(await run(settleImageJob, ctx, { jobId: b.jobId, startedAt: claimed.startedAt, outcome: { kind: "busy" } })).toBe(30_000);
    });

    it("puts a job back in line when its worker died, and ignores that worker's late result", async () => {
        const a = await submit();
        const first = await run(claimImageJob, ctx);
        vi.advanceTimersByTime(4 * 60_000);
        expect(await run(claimImageJob, ctx)).toBeNull();
        vi.advanceTimersByTime(60_000);
        const again = await run(claimImageJob, ctx);
        expect(again).toMatchObject({ _id: a.jobId, attempts: 2 });
        const late = { jobId: a.jobId, startedAt: first.startedAt, outcome: { kind: "done", outputs: outputs(1), dropped: 0 } };
        expect(await run(settleImageJob, ctx, late)).toBeNull();
        expect(jobOf(a.jobId).status).toBe("running");
    });

    it("shows a job only to the account that made it", async () => {
        const a = await submit();
        expect(await run(getImageJobStatus, ctx, { jobId: a.jobId, accountId: "accounts:acct" })).toMatchObject({ status: "queued", position: 0 });
        expect(await run(getImageJobStatus, ctx, { jobId: a.jobId, accountId: "accounts:other" })).toBeNull();
        expect(await run(getImageJobStatus, ctx, { jobId: "nope", accountId: "accounts:acct" })).toBeNull();
    });

    it("expires a job queued for a day (full refund) and deletes finished jobs and files after 2h", async () => {
        const a = await submit({ inputs: [{ storageId: "in0", mimeType: "image/png" }] });
        vi.advanceTimersByTime(24 * 60 * 60_000);
        await run(tickImageQueue, ctx);
        expect(jobOf(a.jobId)).toMatchObject({ status: "failed", refunded: true });
        expect(credits(ctx)).toBe(20);
        vi.advanceTimersByTime(2 * 60 * 60_000 - 1);
        await run(tickImageQueue, ctx);
        expect(jobOf(a.jobId)).toBeDefined(); // still fetchable
        vi.advanceTimersByTime(2);
        await run(tickImageQueue, ctx);
        expect(jobOf(a.jobId)).toBeUndefined();
        expect(ctx.deleted).toEqual(["in0"]);
    });

    it("tick kicks the worker only while a job is queued, and requeues a job whose worker died", async () => {
        await run(tickImageQueue, ctx);
        expect(ctx.scheduled).toEqual([]);
        const a = await submit();
        await run(claimImageJob, ctx);
        await run(tickImageQueue, ctx);
        expect(ctx.scheduled).toHaveLength(1); // only the submit's kick: nothing queued
        vi.advanceTimersByTime(5 * 60_000);
        await run(tickImageQueue, ctx);
        expect(jobOf(a.jobId).status).toBe("queued");
        expect(ctx.scheduled).toHaveLength(2);
    });

    describe("the worker (processImageQueue)", () => {
        let act: any;
        beforeEach(() => {
            vi.stubEnv("AZURE_IMAGE_ENDPOINT", cfg.endpoint);
            vi.stubEnv("AZURE_IMAGE_API_KEY", "k");
            const handlers: Record<string, any> = {
                "image:claimImageJob": claimImageJob,
                "image:settleImageJob": settleImageJob,
            };
            const call = async (ref: any, args: any) => handlers[getFunctionName(ref)]?._handler(ctx, args) ?? null;
            const blobs = new Map<string, Blob>([["in0", new Blob(["png"])]]);
            let next = 0;
            act = {
                blobs,
                runMutation: call,
                runQuery: call,
                scheduler: ctx.scheduler,
                storage: {
                    get: async (id: string) => blobs.get(id) ?? null,
                    store: async (blob: Blob) => {
                        const id = `stored${next++}`;
                        blobs.set(id, blob);
                        return id;
                    },
                    delete: async (id: string) => {
                        blobs.delete(id);
                        await ctx.storage.delete(id);
                    },
                },
            };
        });
        const work = () => run(processImageQueue, act);
        const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
            vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers })));

        it("pauses for Azure's wait on a 429, then stores the images and finishes the job", async () => {
            const a = await submit({ inputs: [{ storageId: "in0", mimeType: "image/png" }] });
            respond(429, { error: { code: "429" } }, { "retry-after": "40" });
            await work();
            expect(ctx.scheduled.at(-1)).toBe(40_000);
            expect(jobOf(a.jobId)).toMatchObject({ status: "queued", attempts: 0, refunded: false });

            vi.advanceTimersByTime(40_000);
            respond(200, { data: [{ b64_json: "aW1n" }] });
            await work();
            expect(ctx.scheduled.at(-1)).toBe(0);
            const job = jobOf(a.jobId);
            expect(job).toMatchObject({ status: "done", creditsCharged: 2, outputs: [{ storageId: "stored0", mimeType: "image/jpeg" }] });
            expect(await act.blobs.get("stored0").text()).toBe("aW1n");
            expect(((globalThis.fetch as any).mock.calls[0][0] as string).endsWith("/images/edits")).toBe(true);
        });

        it("on a 503 or a timeout requeues and pauses, without failing the job", async () => {
            const a = await submit();
            respond(503, { error: { message: "down" } });
            await work();
            expect(ctx.scheduled.at(-1)).toBe(30_000);
            expect(jobOf(a.jobId)).toMatchObject({ status: "queued", attempts: 0 });
            vi.advanceTimersByTime(30_000);
            vi.stubGlobal(
                "fetch",
                vi.fn(async () => {
                    throw new DOMException("The operation timed out.", "TimeoutError");
                }),
            );
            await work();
            expect(ctx.scheduled.at(-1)).toBe(60_000);
            expect(jobOf(a.jobId)).toMatchObject({ status: "queued", attempts: 0, refunded: false });
            expect(credits(ctx)).toBe(18);
        });

        it("fails a 400 at once with a full refund", async () => {
            const a = await submit();
            respond(400, { error: { code: "invalid_request", message: "bad" } });
            await work();
            expect(jobOf(a.jobId)).toMatchObject({ status: "failed", attempts: 1, refunded: true });
            expect(credits(ctx)).toBe(20);
        });

        it("deletes the images of a late result whose job was already taken back", async () => {
            const a = await submit();
            vi.stubGlobal(
                "fetch",
                vi.fn(async () => {
                    jobOf(a.jobId).startedAt = -1; // requeued as stale and claimed again meanwhile
                    return new Response(JSON.stringify({ data: [{ b64_json: "aW1n" }] }), { status: 200 });
                }),
            );
            await work();
            expect(ctx.deleted).toEqual(["stored0"]);
            expect(act.blobs.has("stored0")).toBe(false);
            expect(jobOf(a.jobId).status).toBe("running");
        });
    });
});

