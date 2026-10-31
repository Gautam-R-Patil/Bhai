// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
    const fs = require("node:fs") as typeof import("node:fs");
    const os = require("node:os") as typeof import("node:os");
    const path = require("node:path") as typeof import("node:path");
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bhai-genimg-")));
    process.env.BHAI_WORKSPACE = ws;
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
import { checkImageJobs, registerImageDelivery } from "../../media/image-jobs.js";
import { type CronCallerContext, lateReplyTarget, runWithCallerContext } from "../cron-tool.js";
import { blendLocal, editSizeFor, generateImage } from "../generate-image.js";

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const job = (i: number) => reply(200, { jobId: `job${i}`, position: 0, credits: 10 });
/** The server's image queue: submit k gets job k; a status answers `status(k)`. */
const serve = (status: (k: number) => object, submit: (k: number) => Response = job) => {
    let k = 0;
    h.fetch.mockImplementation(async (url: string, init: { body: string }) =>
        url.endsWith("/status") ? reply(200, status(Number(JSON.parse(init.body).jobId.slice(3)))) : submit(k++),
    );
};
/** The request bodies sent to the queue. */
const submits = () =>
    h.fetch.mock.calls.filter(([url]) => url.endsWith("/api/image/jobs")).map(([, init]) => JSON.parse(init.body));
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
    const done = (count = 1, extra: object = {}, mimeType = "image/jpeg") => ({
        status: "done",
        images: Array.from({ length: count }, () => ({ base64: jpeg, mimeType })),
        ...extra,
    });

    it("creates an image: queues it on the server, saves it to Images, remembers it", async () => {
        serve(() => done(1, { credits: 4 }));
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
        const [[url, init], [statusUrl, statusInit]] = h.fetch.mock.calls;
        expect(url).toBe("https://site.test/api/image/jobs");
        expect(JSON.parse(init.body)).toEqual({ prompt: "A red fox in snow", size: "1024x1024", quality: "medium", n: 1 });
        expect(statusUrl).toBe("https://site.test/api/image/jobs/status");
        expect(JSON.parse(statusInit.body)).toEqual({ jobId: "job0" });
    });

    it("edits the attached photo: sends it, keeps the original as a file for undo", async () => {
        serve(() => done(1, { credits: 4 }));
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
        const body = submits()[0];
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
        serve(() => done(2));
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
        serve(() => done());
        const made = (await call({ prompt: "A lighthouse" }, { conversationKey: "telegram:42" })).res.images[0].file_path;
        const { res } = await call({ prompt: "Make it brighter", source: "last" }, { conversationKey: "overlay:local" });
        expect(res.source_path).toBe(made);
        expect(submits()[1].images).toHaveLength(1);
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
        serve(() => done(3));
        const batch = (await call({ prompt: "A logo", count: 3 }, { message: "give me 3 logo options" })).res.images.map(
            (i: { file_path: string }) => i.file_path,
        );
        expect(batch).toHaveLength(3);
        serve(() => done());
        const edit = (await call({ prompt: "Make it brighter", source: "variation 2" })).res;
        expect(edit.source_path).toBe(batch[1]);
        // The batch is still there after editing one of it.
        expect((await call({ prompt: "x", source: "Variation 3" })).res.source_path).toBe(batch[2]);
        expect((await call({ prompt: "x", source: "variation 4" })).res.error).toMatch(/There were 3 variations; pick variation 1 to 3/);
        expect(submits()).toHaveLength(3);
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
        expect(readFileSync(join(process.env.BHAI_DATA_DIR as string, "image-history.json"), "utf8")).not.toContain("U0VDUkVU");
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

    it("accepts a path in the received-media dir, old atlas_media name included", async () => {
        serve(() => ({ status: "done", images: [{ base64: jpeg, mimeType: "image/jpeg" }], credits: 10 }));
        for (const dir of ["bhai_media", "atlas_media"]) {
            const media = join(tmpdir(), dir);
            mkdirSync(media, { recursive: true });
            const file = join(media, `genimg-test-${process.pid}.jpg`);
            writeFileSync(file, Buffer.from(jpeg, "base64"));
            try {
                expect((await call({ prompt: "Make it blue", source: file })).res.success).toBe(true);
            } finally {
                rmSync(file, { force: true });
            }
        }
    });

    it("a safety block suggests rephrasing", async () => {
        serve(() => ({ status: "failed", error: { code: "blocked_by_safety", message: "content filter" }, credits: 10 }));
        const before = currentGenerated(OWNER);
        const { res } = await call({ prompt: "something risky" });
        expect(res.error).toMatch(/safety filter.*Rephrase/s);
        expect(currentGenerated(OWNER)).toBe(before);
    });

    it("two parallel calls with the same prompt in the same millisecond both save", async () => {
        serve(() => done());
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

    describe("a request that outlasts the call", () => {
        const sent: Array<{ to: string; images: Array<{ path: string; kind: string }>; text: string; ownerDm: boolean }> = [];
        // The chat can't take it (not connected, no window): false, or a throw for a failed send.
        let refuse: Array<"false" | "throw"> = [];
        registerImageDelivery("telegram", async (to, images, text, ownerDm) => {
            const r = refuse.shift();
            if (r === "throw") throw new Error("socket closed");
            if (r === "false") return false;
            sent.push({ to, images, text, ownerDm });
            return true;
        });
        const jobsFile = () => join(process.env.BHAI_DATA_DIR as string, "image-jobs.json");
        const saved = () => JSON.parse(readFileSync(jobsFile(), "utf8"));
        const statusLooks = () => h.fetch.mock.calls.filter(([url]) => url.endsWith("/status")).length;
        // Each look at a queued job moves the clock past the tool's wait.
        const queued = async (
            args: Record<string, unknown> = { prompt: "A red kite" },
            ctx: Partial<CronCallerContext> = { isPrivate: true, replyTo: { channel: "telegram", to: "42" } },
        ) => {
            const real = Date.now.bind(Date);
            let skew = 0;
            const now = vi.spyOn(Date, "now").mockImplementation(() => real() + skew);
            serve(() => {
                skew += 200_000;
                return { status: "queued", position: 3, etaSeconds: 90 };
            });
            try {
                return (await call(args, ctx)).res;
            } finally {
                now.mockRestore();
            }
        };
        beforeEach(() => {
            sent.length = 0;
            refuse = [];
        });

        it("is handed to the watcher, saved to disk, and the model says so once", async () => {
            const res = await queued();
            expect(res).toMatchObject({ queued: true, position: 3 });
            expect(res.note).toMatch(/3 ahead\) and will be sent to this chat by itself/);
            expect(saved()).toEqual([
                expect.objectContaining({
                    jobIds: ["job0"],
                    prompt: "A red kite",
                    kind: "generated",
                    history: OWNER,
                    ownerDm: true,
                    target: { channel: "telegram", to: "42" },
                }),
            ]);
            // Still queued: nothing sent, still saved.
            await checkImageJobs();
            expect(sent).toEqual([]);
            expect(saved()).toHaveLength(1);
            // Done: saved like the tool does, remembered, sent to the chat that asked.
            serve(() => done());
            await checkImageJobs();
            expect(sent).toHaveLength(1);
            expect(sent[0]).toMatchObject({ to: "42", text: "Here's your image.", ownerDm: true });
            const file = sent[0].images[0].path;
            expect(file).toMatch(/a_red_kite_\d+\.jpg$/);
            expect(existsSync(file)).toBe(true);
            // The watcher loads the tool lazily: after the restart test above, from a fresh module graph.
            expect((await import("../../media/image-memory.js")).currentGenerated(OWNER)).toBe(file);
            expect(saved()).toEqual([]);
        });

        it("a failure is sent as one line, with the refund", async () => {
            await queued();
            serve(() => ({ status: "failed", error: { code: "blocked_by_safety", message: "x" }, credits: 10 }));
            await checkImageJobs();
            expect(sent).toEqual([
                expect.objectContaining({ to: "42", images: [], text: expect.stringMatching(/safety filter.*credits were refunded/s) }),
            ]);
            expect(saved()).toEqual([]);
        });

        it("a job the server lost (404 after its cleanup) claims no refund", async () => {
            await queued();
            h.fetch.mockImplementation(async (url: string) => (url.endsWith("/status") ? reply(404, {}) : job(0)));
            await checkImageJobs();
            expect(sent).toHaveLength(1);
            expect(sent[0].text).toMatch(/got lost/);
            expect(sent[0].text).not.toMatch(/refund/);
        });

        it("a local failure (saving) sends a generic line, never its paths or a refund", async () => {
            await queued();
            serve(() => done());
            const write = fs.writeFileSync;
            const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((file, ...rest) => {
                if (!String(file).endsWith(".json") && !String(file).endsWith(".tmp"))
                    throw new Error(`EACCES: permission denied, open '${String(file)}'`);
                return write(file, ...rest);
            });
            try {
                await checkImageJobs();
            } finally {
                spy.mockRestore();
            }
            expect(sent).toHaveLength(1);
            expect(sent[0].text).toMatch(/went wrong on my side/);
            expect(sent[0].text).not.toMatch(/\/|refund/);
            expect(saved()).toEqual([]);
        });

        it("after a day still in the queue it gives up and says so", async () => {
            await queued();
            const real = Date.now.bind(Date);
            const now = vi.spyOn(Date, "now").mockImplementation(() => real() + 25 * 60 * 60 * 1000);
            try {
                await checkImageJobs();
            } finally {
                now.mockRestore();
            }
            expect(sent).toEqual([expect.objectContaining({ to: "42", images: [], text: expect.stringMatching(/gave up/) })]);
            expect(saved()).toEqual([]);
        });

        it("a scheduled task with deliverTo: the image goes to the owner's chats on that channel", async () => {
            const target = lateReplyTarget({ channel: "telegram", replyTo: "owner", autonomous: true });
            expect(target).toEqual({ channel: "telegram", to: "owner" });
            // Any other target on an autonomous run is dropped; a chat turn keeps its own.
            expect(lateReplyTarget({ channel: "telegram", replyTo: "42", autonomous: true })).toBeUndefined();
            expect(lateReplyTarget({ channel: "telegram", replyTo: "42" })).toEqual({ channel: "telegram", to: "42" });
            const res = await queued(
                { prompt: "Good morning card" },
                { isOwner: true, autonomous: true, conversationKey: "cron:deliver", replyTo: target },
            );
            expect(res.note).toMatch(/will be sent to this chat by itself/);
            serve(() => done());
            await checkImageJobs();
            expect(sent).toEqual([expect.objectContaining({ to: "owner", text: "Here's your image.", ownerDm: true })]);
        });

        it("a queued local edit blends onto the prepared photo (upright, <=2048px), not the original file", async () => {
            const big = join(h.ws, "Images", "big.jpg");
            mkdirSync(join(h.ws, "Images"), { recursive: true });
            await sharp({ create: { width: 2100, height: 2100, channels: 3, background: "#808080" } }).jpeg().toFile(big);
            await queued({ prompt: "Add a red square", source: big, local: true });
            const [queuedJob] = saved();
            expect(queuedJob.sourcePath).toBe(big);
            expect((await sharp(queuedJob.blendSource).metadata()).width).toBe(2048);
            const red = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#ff0000" } }).png().toBuffer();
            const out = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#888888" } })
                .composite([{ input: red, left: 32, top: 32 }])
                .jpeg()
                .toBuffer();
            serve(() => ({ status: "done", images: [{ base64: out.toString("base64"), mimeType: "image/jpeg" }] }));
            await checkImageJobs();
            // Blended at the prepared photo's size; the copy is gone once saved.
            expect((await sharp(sent[0].images[0].path).metadata()).width).toBe(2048);
            expect(existsSync(queuedJob.blendSource)).toBe(false);
        });

        it("no status call runs past the tool's wait, and each is cut to the time left", async () => {
            const real = Date.now.bind(Date);
            let skew = 0;
            const now = vi.spyOn(Date, "now").mockImplementation(() => real() + skew);
            const timeouts = vi.spyOn(AbortSignal, "timeout");
            serve(() => {
                skew += 130_000;
                return { status: "queued", position: 1 };
            });
            try {
                const { res } = await call(
                    { prompt: "A fox logo", count: 3, transparent: true },
                    { message: "make 3 transparent fox logo options", isPrivate: true, replyTo: { channel: "telegram", to: "42" } },
                );
                expect(res.queued).toBe(true);
            } finally {
                now.mockRestore();
            }
            const statusTimeouts = h.fetch.mock.calls.flatMap(([url], i) =>
                url.endsWith("/status") ? [timeouts.mock.calls[i][0] as number] : [],
            );
            timeouts.mockRestore();
            // 3 jobs: the first look at 150s left (capped at 30s), the second at ~20s left, the third never.
            expect(statusTimeouts).toHaveLength(2);
            expect(statusTimeouts[0]).toBe(30_000);
            expect(statusTimeouts[1]).toBeGreaterThan(0);
            expect(statusTimeouts[1]).toBeLessThanOrEqual(20_000);
            serve(() => done(1, {}, "image/png"));
            await checkImageJobs();
            expect(sent[0].images).toHaveLength(3);
        });

        it("a result that only comes in near the tool's timeout goes to the watcher, not the finished turn", async () => {
            const real = Date.now.bind(Date);
            let skew = 0;
            const now = vi.spyOn(Date, "now").mockImplementation(() => real() + skew);
            serve(() => {
                skew += 190_000;
                return done();
            });
            const ctx: Partial<CronCallerContext> = { isPrivate: true, replyTo: { channel: "telegram", to: "42" } };
            try {
                expect((await call({ prompt: "A slow kite" }, ctx)).res).toMatchObject({ queued: true });
            } finally {
                now.mockRestore();
            }
            expect(ctx.generatedImages).toBeUndefined();
            serve(() => done());
            await checkImageJobs();
            expect(sent).toEqual([expect.objectContaining({ to: "42", text: "Here's your image." })]);
        });

        it("a restart picks the saved jobs up again", async () => {
            writeFileSync(
                jobsFile(),
                JSON.stringify([
                    {
                        jobIds: ["job0"],
                        prompt: "A cat",
                        kind: "generated",
                        slug: "restart_cat",
                        history: OWNER,
                        ownerDm: true,
                        target: { channel: "telegram", to: "7" },
                        createdAt: Date.now(),
                    },
                ]),
            );
            vi.resetModules();
            const fresh = await import("../../media/image-jobs.js");
            const delivered: string[] = [];
            fresh.registerImageDelivery("telegram", async (to, images) => {
                delivered.push(to, images[0].path);
                return true;
            });
            serve(() => done());
            await fresh.checkImageJobs();
            expect(delivered[0]).toBe("7");
            expect(delivered[1]).toMatch(/restart_cat_\d+\.jpg$/);
            expect((await import("../../media/image-memory.js")).currentGenerated(OWNER)).toBe(delivered[1]);
            expect(saved()).toEqual([]);
        });

        it("a chat that can't take it yet gets it on a later tick: saved once, sent once, also over a restart", async () => {
            await queued();
            serve(() => done());
            refuse = ["false"];
            await checkImageJobs();
            expect(sent).toEqual([]);
            // Saved and recorded on the job: a restart reads the files, not the server.
            const [kept] = saved();
            expect(kept).toMatchObject({ text: "Here's your image.", files: [expect.objectContaining({ kind: "generated" })] });
            const file = kept.files[0].path as string;
            expect(existsSync(file)).toBe(true);
            const looks = statusLooks();
            // Each failed send waits longer before the next (5s, doubling to 5 min): no try right away.
            expect(kept.nextTryAt).toBeGreaterThan(Date.now());
            let now = Date.now();
            const later = vi.spyOn(Date, "now").mockImplementation(() => now);
            vi.resetModules();
            const fresh = await import("../../media/image-jobs.js");
            const delivered: string[] = [];
            let down = true;
            fresh.registerImageDelivery("telegram", async (to, images) => {
                if (down) {
                    down = false;
                    throw new Error("socket closed");
                }
                delivered.push(to, images[0].path);
                return true;
            });
            await fresh.checkImageJobs();
            expect(down).toBe(true); // still waiting out the first failure: not even tried
            now += 6_000;
            await fresh.checkImageJobs();
            expect(delivered).toEqual([]);
            expect(saved()).toHaveLength(1);
            await fresh.checkImageJobs();
            expect(delivered).toEqual([]); // the second failure waits 10s
            now += 11_000;
            await fresh.checkImageJobs();
            expect(delivered).toEqual(["42", file]);
            expect(saved()).toEqual([]);
            expect(statusLooks()).toBe(looks);
            // The module from before the "restart" still holds the job in memory: let it finish too.
            await checkImageJobs();
            later.mockRestore();
        });
    });

    it("a 502 never shows the provider's text; an unreachable server says so", async () => {
        serve(done, () => reply(502, { error: "image_failed", message: "Azure 429: West US 3 S0 tier" }));
        expect((await call({ prompt: "A cat" })).res.error).not.toMatch(/Azure|West/);
        h.fetch.mockRejectedValue(new TypeError("fetch failed"));
        expect((await call({ prompt: "A cat" })).res.error).toMatch(/couldn't reach Bhai's server/);
    });

    it("an expired session (401) re-authenticates and retries once", async () => {
        serve(() => done());
        h.fetch.mockResolvedValueOnce(reply(401, { error: "invalid_session" }));
        const { res } = await call({ prompt: "A cat" });
        expect(res.success).toBe(true);
        expect(h.fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer tok2");
    });

    it("a custom size the server doesn't take yet falls back to a named one", async () => {
        serve(
            () => done(),
            (k) => (k ? job(k) : reply(400, { error: "invalid size" })),
        );
        const { res } = await call({ prompt: "A beach wallpaper", aspect: "phone" });
        expect(res.success).toBe(true);
        expect(submits()[0].size).toBe("1088x1920");
        expect(submits()[1].size).toBe("1024x1536");
    });

    it("transparent count 3 goes as 3 n=1 jobs; a failed one is reported as dropped", async () => {
        serve((k) =>
            k === 1
                ? { status: "failed", error: { code: "image_failed", message: "Azure 500" }, credits: 9 }
                : done(1, { credits: 10 - k }, "image/png"),
        );
        const { res } = await call(
            { prompt: "A fox logo", count: 3, transparent: true },
            { message: "make 3 transparent fox logo options" },
        );
        expect(submits()).toHaveLength(3);
        for (const body of submits()) expect(body).toMatchObject({ n: 1, background: "transparent" });
        expect(res).toMatchObject({ success: true, credits: 8, dropped: 1 });
        expect(res.images).toHaveLength(2);
        expect(res.note).toMatch(/Only 2 of 3/);
    });

    it("count and high quality need the owner's own words", async () => {
        serve(() => done());
        await call({ prompt: "A cat", count: 4, quality: "high" }, { message: "draw a cat" });
        expect(submits()[0]).toMatchObject({ n: 1, quality: "medium" });
    });

    it("a contact gets one low-quality image at a time, three a day", async () => {
        serve(() => done());
        const ctx = { isOwner: false, conversationKey: "whatsapp:guest" } as CronCallerContext;
        const go = async () =>
            JSON.parse(
                (await runWithCallerContext(ctx, () =>
                    generateImage.handler({ prompt: "A cat", count: 4, quality: "high" }),
                )) as string,
            );
        for (let i = 0; i < 3; i++) expect((await go()).success).toBe(true);
        expect(submits()[0]).toMatchObject({ n: 1, quality: "low" });
        expect((await go()).error).toMatch(/couple of images a day/);
        expect(submits()).toHaveLength(3);
    });

    it("the owner's autonomous runs keep medium quality but share the daily cap", async () => {
        serve(() => done());
        const ctx = { isOwner: true, autonomous: true, conversationKey: "cron:cron" } as CronCallerContext;
        const go = async () =>
            JSON.parse((await runWithCallerContext(ctx, () => generateImage.handler({ prompt: "Good morning" }))) as string);
        for (let i = 0; i < 3; i++) expect((await go()).note).toMatch(/send_file/);
        expect(submits()[0]).toMatchObject({ n: 1, quality: "medium" });
        expect((await go()).error).toMatch(/couple of images a day/);
    });

    it("combining photos has no single before: no source_path, no undo target", async () => {
        serve(() => done());
        const ctx: Partial<CronCallerContext> = {
            turnImages: [
                { base64: jpeg, mimeType: "image/jpeg" },
                { base64: jpeg, mimeType: "image/jpeg" },
            ],
        };
        const { res } = await call({ prompt: "Put both together", source: "attached" }, ctx);
        expect(res.source_path).toBeUndefined();
        expect(ctx.generatedImages?.[0].sourcePath).toBeUndefined();
        expect(submits()[0].size).toBe("auto");
    });

    it("a chat that doesn't show images (cron without deliverTo, Bhai-mail) is told to send_file", async () => {
        serve(() => done());
        const { res } = await call({ prompt: "A sunrise" }, { conversationKey: "cron:1" });
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
        serve(() => ({ status: "done", images: [{ base64: out.toString("base64"), mimeType: "image/jpeg" }] }));
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
