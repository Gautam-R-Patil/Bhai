// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it, vi } from "vitest";
import {
    callAzureImage,
    IMAGE_MAX_INPUT_BYTES,
    ImageError,
    imageConfigFromEnv,
    imageCreditCost,
    imageErrorResponse,
    type ImageRequest,
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

        const boom = vi.fn(async () => new Response("upstream down", { status: 500 }));
        const err2 = await callAzureImage(cfg, valid({ prompt: "x" }), boom).catch((e) => e);
        expect(err2.code).toBe("image_failed");
        expect(err2.message).toContain("upstream down");
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
    });
});
