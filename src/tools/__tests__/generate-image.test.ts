// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
    const fs = require("node:fs") as typeof import("node:fs");
    const os = require("node:os") as typeof import("node:os");
    const path = require("node:path") as typeof import("node:path");
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bhai-genimg-")));
    process.env.ATLAS_WORKSPACE = ws;
    return { ws, fetch: vi.fn() };
});
vi.mock("../../crypto-transport.js", () => ({ encryptedFetch: h.fetch }));
vi.mock("../../session.js", () => ({ getSessionToken: async () => "tok", handleAuthError: async () => "tok2" }));
vi.mock("../../config/keys.js", () => ({ getConvexSiteUrl: () => "https://site.test" }));

import {
    currentGenerated,
    OWNER_IMAGE_KEY as OWNER,
    pushGenerated,
    rememberInboundImages,
} from "../../media/image-memory.js";
import { type CronCallerContext, runWithCallerContext } from "../cron-tool.js";
import { blendLocal, editSizeFor, generateImage } from "../generate-image.js";

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
let n = 0;
const call = async (args: Record<string, unknown>, ctx: Partial<CronCallerContext> = {}) => {
    ctx.conversationKey ??= `telegram:${++n}`;
    const key = ctx.conversationKey;
    ctx.isOwner ??= true;
    const out = await runWithCallerContext(ctx as CronCallerContext, () => generateImage.handler(args));
    return { key, res: JSON.parse(out as string) };
};

describe("generate_image", () => {
    let jpeg: string;
    beforeEach(async () => {
        h.fetch.mockReset();
        jpeg ??= (await sharp({ create: { width: 8, height: 8, channels: 3, background: "#f00" } }).jpeg().toBuffer()).toString("base64");
    });
    afterAll(() => rmSync(h.ws, { recursive: true, force: true }));

    it("creates an image: calls /api/image, saves it to Images, remembers it", async () => {
        h.fetch.mockResolvedValue(reply(200, { images: [{ data: jpeg, mimeType: "image/jpeg" }], credits: 4 }));
        const { key, res } = await call({ prompt: "A red fox in snow" });
        expect(res).toMatchObject({ success: true, kind: "generated", credits: 4 });
        const file = res.images[0].file_path as string;
        expect(file.startsWith(join(h.ws, "Images"))).toBe(true);
        expect(file).toMatch(/a_red_fox_in_snow_\d+\.jpg$/);
        // Re-encoded at q85 (never larger than what came back).
        expect(readFileSync(file).length).toBeLessThanOrEqual(Buffer.from(jpeg, "base64").length);
        expect((await sharp(file).metadata()).format).toBe("jpeg");
        expect(res.note).toMatch(/already shown/);
        expect(currentGenerated(OWNER)).toBe(file);
        const [url, init] = h.fetch.mock.calls[0];
        expect(url).toBe("https://site.test/api/image");
        expect(JSON.parse(init.body)).toEqual({ prompt: "A red fox in snow", size: "1024x1024", quality: "medium", n: 1 });
    });

    it("edits the attached photo: sends it, keeps the original as a file for undo", async () => {
        h.fetch.mockResolvedValue(reply(200, { images: [{ data: jpeg, mimeType: "image/jpeg" }], credits: 4 }));
        const ctx: Partial<CronCallerContext> = { turnImages: [{ base64: jpeg, mimeType: "image/jpeg" }] };
        const { key, res } = await call(
            { prompt: "Remove the man on the left. Keep everything else exactly the same.", source: "attached" },
            ctx,
        );
        expect(res.kind).toBe("edited");
        // The turn's reply carries it (AgentResponse.images), with the original as the "before".
        expect(ctx.generatedImages).toEqual([
            {
                path: res.images[0].file_path,
                mimeType: "image/jpeg",
                prompt: "Remove the man on the left. Keep everything else exactly the same.",
                kind: "edited",
                sourcePath: res.source_path,
            },
        ]);
        const body = JSON.parse(h.fetch.mock.calls[0][1].body);
        expect(body.images).toHaveLength(1);
        // A square photo snaps to the square size; edits default to low quality.
        expect(body).toMatchObject({ size: "1024x1024", quality: "low" });
        expect(existsSync(res.source_path)).toBe(true);
        const undo = await runWithCallerContext({ isOwner: true, conversationKey: key }, () =>
            generateImage.handler({ prompt: "", undo: true }),
        );
        expect(JSON.parse(undo as string).images[0].file_path).toBe(res.source_path);
    });

    it("undo after variations goes back past the whole batch", async () => {
        h.fetch.mockResolvedValue(
            reply(200, { images: [{ data: jpeg, mimeType: "image/jpeg" }, { data: jpeg, mimeType: "image/jpeg" }] }),
        );
        const { key, res } = await call(
            { prompt: "Make it blue", source: "attached", count: 2 },
            { turnImages: [{ base64: jpeg, mimeType: "image/jpeg" }], message: "make it blue, give me 2" },
        );
        expect(res.images).toHaveLength(2);
        expect(currentGenerated(OWNER)).toBe(res.images[1].file_path);
        const undo = await runWithCallerContext({ isOwner: true, conversationKey: key }, () =>
            generateImage.handler({ prompt: "", undo: true }),
        );
        expect(JSON.parse(undo as string).images[0].file_path).toBe(res.source_path);
    });

    it("the owner's versions follow them across channels; a contact's stay in their chat", async () => {
        h.fetch.mockImplementation(async () => reply(200, { images: [{ data: jpeg, mimeType: "image/jpeg" }] }));
        const made = (await call({ prompt: "A lighthouse" }, { conversationKey: "telegram:42" })).res.images[0].file_path;
        const { res } = await call({ prompt: "Make it brighter", source: "last" }, { conversationKey: "overlay:local" });
        expect(res.source_path).toBe(made);
        expect(JSON.parse(h.fetch.mock.calls[1][1].body).images).toHaveLength(1);
        // A photo sent on Telegram is still only "attached" there.
        rememberInboundImages("telegram:42", [{ base64: jpeg, mimeType: "image/jpeg" }]);
        expect((await call({ prompt: "x", source: "attached" }, { conversationKey: "overlay:local" })).res.error).toMatch(/don't see a photo/);
        const guest = { isOwner: false, conversationKey: "telegram:guest:7" };
        expect((await call({ prompt: "x", source: "last" }, guest)).res.error).toMatch(/haven't made an image/);
    });

    it("\"variation N\" edits that one of the last batch; undo walks back to before the batch", async () => {
        const before = join(h.ws, "before.jpg");
        writeFileSync(before, Buffer.from(jpeg, "base64"));
        pushGenerated(OWNER, before);
        h.fetch.mockResolvedValue(
            reply(200, { images: [1, 2, 3].map(() => ({ data: jpeg, mimeType: "image/jpeg" })) }),
        );
        const batch = (await call({ prompt: "A logo", count: 3 }, { message: "give me 3 logo options" })).res.images.map(
            (i: { file_path: string }) => i.file_path,
        );
        expect(batch).toHaveLength(3);
        h.fetch.mockImplementation(async () => reply(200, { images: [{ data: jpeg, mimeType: "image/jpeg" }] }));
        const edit = (await call({ prompt: "Make it brighter", source: "variation 2" })).res;
        expect(edit.source_path).toBe(batch[1]);
        // The batch is still there after editing one of it.
        expect((await call({ prompt: "x", source: "Variation 3" })).res.source_path).toBe(batch[2]);
        expect((await call({ prompt: "x", source: "variation 4" })).res.error).toMatch(/There were 3 variations; pick variation 1 to 3/);
        expect(h.fetch).toHaveBeenCalledTimes(3);
        // Each edit's "before" is its variation: undo shows it, then the edit before, then the batch.
        const undo = async () => (await call({ prompt: "", undo: true })).res.images?.[0].file_path;
        expect(await undo()).toBe(batch[2]);
        expect(await undo()).toBe(edit.images[0].file_path);
        expect(await undo()).toBe(batch[1]);
        expect(await undo()).toBe(batch[2]); // the batch, shown by its last image
        expect(await undo()).toBe(before); // what was current before the batch
        expect((await call({ prompt: "x", source: "variation 1" })).res.error).toMatch(/several variations/);
    });

    it("made versions survive a restart (missing files dropped); sent photos never reach disk", async () => {
        const keep = join(h.ws, "keep.jpg");
        const gone = join(h.ws, "gone.jpg");
        writeFileSync(keep, "x");
        writeFileSync(gone, "x");
        pushGenerated("restart", [keep, gone]);
        pushGenerated("restart", gone);
        rememberInboundImages("restart", [{ base64: "U0VDUkVU", mimeType: "image/jpeg" }]);
        rmSync(gone);
        expect(readFileSync(join(process.env.ATLAS_DATA_DIR as string, "image-history.json"), "utf8")).not.toContain("U0VDUkVU");
        vi.resetModules();
        const fresh = await import("../../media/image-memory.js");
        expect(fresh.currentGenerated("restart")).toBe(keep);
        expect(fresh.lastGeneratedBatch("restart")).toBeUndefined();
        expect(fresh.lastInboundImages("restart")).toEqual([]);
        expect(fresh.currentGenerated(OWNER)).toBe(currentGenerated(OWNER));
    });

    it("\"last\" with nothing made yet says so, without calling the server", async () => {
        const { res } = await call({ prompt: "make it blue", source: "last" }, { isOwner: false });
        expect(res.error).toMatch(/haven't made an image/);
        expect(h.fetch).not.toHaveBeenCalled();
    });

    it("undo goes back one version for free", async () => {
        const key = "telegram:undo";
        pushGenerated(OWNER, join(h.ws, "v1.jpg"));
        pushGenerated(OWNER, join(h.ws, "v2.jpg"));
        writeFileSync(join(h.ws, "v1.jpg"), "x");
        const out = JSON.parse(
            (await runWithCallerContext({ isOwner: true, conversationKey: key }, () =>
                generateImage.handler({ prompt: "", undo: true }),
            )) as string,
        );
        expect(out).toMatchObject({ success: true, kind: "undo", source_path: join(h.ws, "v2.jpg") });
        expect(out.images[0]).toEqual({ file_path: join(h.ws, "v1.jpg"), mime_type: "image/jpeg" });
        expect(h.fetch).not.toHaveBeenCalled();
        expect((await call({ prompt: "", undo: true }, { isOwner: false })).res.error).toMatch(/no earlier version/);
    });

    it("refuses a path outside Bhai's folders, and any path for a non-owner", async () => {
        const outside = mkdtempSync(join(tmpdir(), "bhai-outside-"));
        writeFileSync(join(outside, "p.jpg"), Buffer.from(jpeg, "base64"));
        expect((await call({ prompt: "x", source: join(outside, "p.jpg") })).res.error).toMatch(/files folder/);
        mkdirSync(join(h.ws, "Images"), { recursive: true });
        writeFileSync(join(h.ws, "Images", "in.jpg"), Buffer.from(jpeg, "base64"));
        expect((await call({ prompt: "x", source: join(h.ws, "Images", "in.jpg") }, { isOwner: false })).res.error).toMatch(/owner/);
        expect(h.fetch).not.toHaveBeenCalled();
        rmSync(outside, { recursive: true, force: true });
    });

    it("a safety block (422) suggests rephrasing", async () => {
        h.fetch.mockResolvedValue(reply(422, { error: "blocked_by_safety", message: "content filter" }));
        const before = currentGenerated(OWNER);
        const { res } = await call({ prompt: "something risky" });
        expect(res.error).toMatch(/safety filter.*Rephrase/s);
        expect(currentGenerated(OWNER)).toBe(before);
    });

    it("two parallel calls with the same prompt in the same millisecond both save", async () => {
        h.fetch.mockImplementation(async () => reply(200, { images: [{ data: jpeg, mimeType: "image/jpeg" }] }));
        const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
        try {
            const [a, b] = await Promise.all([call({ prompt: "A blue logo" }), call({ prompt: "A blue logo" })]);
            expect(a.res.success && b.res.success).toBe(true);
            expect(a.res.images[0].file_path).not.toBe(b.res.images[0].file_path);
            expect(existsSync(a.res.images[0].file_path) && existsSync(b.res.images[0].file_path)).toBe(true);
        } finally {
            now.mockRestore();
        }
    });

    it("a busy model (429) says when to try again and not to retry now", async () => {
        h.fetch.mockResolvedValue(reply(429, { error: "image_busy", retryAfter: 40 }));
        const { res } = await call({ prompt: "A cat" });
        expect(res.error).toBe("The image model is busy right now; try again in about 40s. Don't retry in this turn.");
    });

    it("a 502 never shows the provider's text; an unreachable server says so", async () => {
        h.fetch.mockResolvedValue(reply(502, { error: "image_failed", message: "Azure 429: West US 3 S0 tier" }));
        expect((await call({ prompt: "A cat" })).res.error).not.toMatch(/Azure|West/);
        h.fetch.mockRejectedValue(new TypeError("fetch failed"));
        expect((await call({ prompt: "A cat" })).res.error).toMatch(/couldn't reach Bhai's server/);
    });

    it("an expired session (401) re-authenticates and retries once", async () => {
        h.fetch
            .mockResolvedValueOnce(reply(401, { error: "invalid_session" }))
            .mockResolvedValueOnce(reply(200, { images: [{ data: jpeg, mimeType: "image/jpeg" }] }));
        const { res } = await call({ prompt: "A cat" });
        expect(res.success).toBe(true);
        expect(h.fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer tok2");
    });

    it("a custom size the server doesn't take yet falls back to a named one", async () => {
        h.fetch
            .mockResolvedValueOnce(reply(400, { error: "invalid size" }))
            .mockResolvedValueOnce(reply(200, { images: [{ data: jpeg, mimeType: "image/jpeg" }] }));
        const { res } = await call({ prompt: "A beach wallpaper", aspect: "phone" });
        expect(res.success).toBe(true);
        expect(JSON.parse(h.fetch.mock.calls[0][1].body).size).toBe("1088x1920");
        expect(JSON.parse(h.fetch.mock.calls[1][1].body).size).toBe("1024x1536");
    });

    it("transparent count 3 goes as 3 n=1 requests; a failed one is reported as dropped", async () => {
        h.fetch
            .mockResolvedValueOnce(reply(200, { images: [{ data: jpeg, mimeType: "image/png" }], credits: 2 }))
            .mockResolvedValueOnce(reply(429, { error: "image_busy" }))
            .mockResolvedValueOnce(reply(200, { images: [{ data: jpeg, mimeType: "image/png" }], credits: 2 }));
        const { res } = await call(
            { prompt: "A fox logo", count: 3, transparent: true },
            { message: "make 3 transparent fox logo options" },
        );
        expect(h.fetch).toHaveBeenCalledTimes(3);
        for (const [, init] of h.fetch.mock.calls) expect(JSON.parse(init.body)).toMatchObject({ n: 1, background: "transparent" });
        expect(res).toMatchObject({ success: true, credits: 4, dropped: 1 });
        expect(res.images).toHaveLength(2);
        expect(res.note).toMatch(/Only 2 of 3/);
    });

    it("count and high quality need the owner's own words", async () => {
        h.fetch.mockResolvedValue(reply(200, { images: [{ data: jpeg, mimeType: "image/jpeg" }] }));
        await call({ prompt: "A cat", count: 4, quality: "high" }, { message: "draw a cat" });
        expect(JSON.parse(h.fetch.mock.calls[0][1].body)).toMatchObject({ n: 1, quality: "medium" });
    });

    it("a contact gets one low-quality image at a time, three a day", async () => {
        h.fetch.mockImplementation(async () => reply(200, { images: [{ data: jpeg, mimeType: "image/jpeg" }] }));
        const ctx = { isOwner: false, conversationKey: "whatsapp:guest" } as CronCallerContext;
        const go = async () =>
            JSON.parse(
                (await runWithCallerContext(ctx, () =>
                    generateImage.handler({ prompt: "A cat", count: 4, quality: "high" }),
                )) as string,
            );
        for (let i = 0; i < 3; i++) expect((await go()).success).toBe(true);
        expect(JSON.parse(h.fetch.mock.calls[0][1].body)).toMatchObject({ n: 1, quality: "low" });
        expect((await go()).error).toMatch(/couple of images a day/);
        expect(h.fetch).toHaveBeenCalledTimes(3);
    });

    it("the owner's autonomous runs keep medium quality but share the daily cap", async () => {
        h.fetch.mockImplementation(async () => reply(200, { images: [{ data: jpeg, mimeType: "image/jpeg" }] }));
        const ctx = { isOwner: true, autonomous: true, conversationKey: "cron:cron" } as CronCallerContext;
        const go = async () =>
            JSON.parse((await runWithCallerContext(ctx, () => generateImage.handler({ prompt: "Good morning" }))) as string);
        for (let i = 0; i < 3; i++) expect((await go()).note).toMatch(/send_file/);
        expect(JSON.parse(h.fetch.mock.calls[0][1].body)).toMatchObject({ n: 1, quality: "medium" });
        expect((await go()).error).toMatch(/couple of images a day/);
    });

    it("combining photos has no single before: no source_path, no undo target", async () => {
        h.fetch.mockResolvedValue(reply(200, { images: [{ data: jpeg, mimeType: "image/jpeg" }] }));
        const ctx: Partial<CronCallerContext> = {
            turnImages: [
                { base64: jpeg, mimeType: "image/jpeg" },
                { base64: jpeg, mimeType: "image/jpeg" },
            ],
        };
        const { res } = await call({ prompt: "Put both together", source: "attached" }, ctx);
        expect(res.source_path).toBeUndefined();
        expect(ctx.generatedImages?.[0].sourcePath).toBeUndefined();
        expect(JSON.parse(h.fetch.mock.calls[0][1].body).size).toBe("auto");
    });

    it("a chat that doesn't show images (cron, Matrix, email) is told to send_file", async () => {
        h.fetch.mockResolvedValue(reply(200, { images: [{ data: jpeg, mimeType: "image/jpeg" }] }));
        const { res } = await call({ prompt: "A sunrise" }, { conversationKey: "matrix:1" });
        expect(res.note).toMatch(/send_file/);
    });

    it("an undecodable photo gets a friendly error and no server call", async () => {
        const { res } = await call(
            { prompt: "Make it blue", source: "attached" },
            { turnImages: [{ base64: Buffer.from("not an image").toString("base64"), mimeType: "image/heic" }] },
        );
        expect(res.error).toMatch(/can't open that photo format/);
        expect(h.fetch).not.toHaveBeenCalled();
    });

    it("a directory named like an image is refused, not thrown", async () => {
        mkdirSync(join(h.ws, "Images", "dir.png"), { recursive: true });
        expect((await call({ prompt: "x", source: join(h.ws, "Images", "dir.png") })).res.error).toMatch(/couldn't find/);
    });

    it("edit sizes follow the photo's shape", () => {
        expect(editSizeFor(8, 8)).toBe("1024x1024");
        expect(editSizeFor(1000, 1500)).toBe("1024x1536");
        expect(editSizeFor(1500, 1000)).toBe("1536x1024");
        expect(editSizeFor(300, 400)).toBe("880x1184");
        expect(editSizeFor(2048, 1536)).toBe("2048x1536");
        expect(editSizeFor(4000, 1000)).toBe("auto");
    });

    it("a local edit keeps the source's pixels outside what changed", async () => {
        const solid = (c: string) => sharp({ create: { width: 256, height: 256, channels: 3, background: c } });
        const src = await solid("#808080").jpeg().toBuffer();
        const red = await sharp({ create: { width: 48, height: 48, channels: 3, background: "#ff0000" } }).png().toBuffer();
        // The model's re-render drifts slightly everywhere and adds a red square.
        const out = await solid("#888888").composite([{ input: red, left: 16, top: 16 }]).jpeg().toBuffer();
        h.fetch.mockResolvedValue(reply(200, { images: [{ data: out.toString("base64"), mimeType: "image/jpeg" }] }));
        const { res } = await call(
            { prompt: "Add a red square", source: "attached", local: true },
            { turnImages: [{ base64: src.toString("base64"), mimeType: "image/jpeg" }] },
        );
        const { data } = await sharp(res.images[0].file_path).raw().toBuffer({ resolveWithObject: true });
        const px = (x: number, y: number) => data[(y * 256 + x) * 3];
        expect(Math.abs(px(240, 240) - 0x80)).toBeLessThan(4);
        expect(px(40, 40)).toBeGreaterThan(200);
        // Most of the frame changed: not local, the raw output stays.
        expect(await blendLocal(src, await solid("#ff0000").jpeg().toBuffer())).toBeNull();
    });
});
