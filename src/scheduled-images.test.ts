// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Images made where the reply used to be text only now arrive: a scheduled run hands them to its
// deliverTo channel, Matrix uploads them as m.image. turnShowsImages says so exactly there, so
// generate_image's note and send_file's duplicate guard stay truthful.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "scheduled-images-"));
process.env.BHAI_DATA_DIR = dir;
const cat = join(dir, "cat.png");
writeFileSync(cat, "png");
const img = (path: string) => ({ path, mimeType: "image/png", prompt: "a cat", kind: "generated" as const });

const job = { id: "j1", prompt: "draw a cat", deliverTo: "telegram", isOwner: true };
const markRun = vi.fn(async () => {});
vi.mock("./cron/store.js", () => ({ getDueJobs: () => [job], markRun }));

// The tool registry first: agent.ts imported cold re-enters it mid-load.
await import("./tools/index.js");
const { runWithCallerContext, turnShowsImages } = await import("./tools/cron-tool.js");
const { bhaiMailContext } = await import("./bhai-mail.js");

describe("turnShowsImages", () => {
    const shows = (ctx: Record<string, unknown>) =>
        runWithCallerContext({ isOwner: true, ...ctx }, () => turnShowsImages()) as boolean;

    it("chat turns on every channel that now delivers, email and Matrix included", () => {
        for (const ch of ["telegram", "whatsapp", "discord", "slack", "overlay", "matrix", "email"])
            expect(shows({ conversationKey: `${ch}:1` })).toBe(true);
        expect(shows({ conversationKey: "cron:cron" })).toBe(false);
    });

    it("autonomous runs only when they say so: a scheduled run with deliverTo, not research", () => {
        expect(shows({ conversationKey: "telegram:1", autonomous: true })).toBe(false);
        expect(shows({ conversationKey: "telegram:1", autonomous: true, showsImages: true })).toBe(true);
        expect(shows({ conversationKey: "cron:cron", autonomous: true, showsImages: false })).toBe(false);
    });

    it("Bhai-mail can't carry images, though its channel is email", () => {
        const ctx = bhaiMailContext("me@x.com", { from: "me@x.com", fromName: "", fromOwner: true, direct: true });
        expect(ctx.showsImages).toBe(false);
        expect(shows({ conversationKey: "email:me@x.com", showsImages: ctx.showsImages })).toBe(false);
    });
});

describe("runCronTick", () => {
    it("hands the run's images to deliver with its text", async () => {
        const { runCronTick } = await import("./cron/tick.js");
        const deliver = vi.fn(async () => true);
        await runCronTick({ runPrompt: async () => ({ text: "Here's your cat", images: [img(cat)] }), deliver });
        expect(deliver).toHaveBeenCalledWith(job, "Here's your cat", [img(cat)]);
        expect(markRun).toHaveBeenCalledWith("j1", "success");
    });
});

describe("Matrix", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let uploadFails = false;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
        if (url.includes("/login")) return json({ access_token: "t", user_id: "@bhai:hs", device_id: "d" });
        if (url.includes("/sync")) return json({ next_batch: "b1" });
        if (url.includes("/media/v3/upload"))
            return uploadFails ? new Response("too big", { status: 413 }) : json({ content_uri: "mxc://hs/abc" });
        return json({ event_id: "$e" });
    });
    process.env.MATRIX_HOMESERVER = "https://hs";
    process.env.MATRIX_USER_ID = "@bhai:hs";
    process.env.MATRIX_PASSWORD = "p";
    const { initMatrix, closeMatrix, sendImages } = await import("./matrix.js");
    await initMatrix({} as never);
    closeMatrix(); // stop the sync loop; sends still go to the homeserver
    const sends = () => calls.filter((c) => c.url.includes("/send/m.room.message/"));

    it("uploads each image and sends it as an m.image", async () => {
        calls.length = 0;
        await sendImages("!r:hs", [img(cat)], true);
        const upload = calls.find((c) => c.url.includes("/media/v3/upload"));
        expect(upload?.url).toBe("https://hs/_matrix/media/v3/upload?filename=cat.png");
        expect((upload?.init.headers as Record<string, string>)["Content-Type"]).toBe("image/png");
        expect(JSON.parse(sends()[0].init.body as string)).toEqual({
            msgtype: "m.image",
            body: "cat.png",
            url: "mxc://hs/abc",
            info: { mimetype: "image/png", size: 3 },
        });
    });

    it("a failed upload tells only the owner's DM where it's saved", async () => {
        uploadFails = true;
        for (const ownerDm of [true, false]) {
            calls.length = 0;
            await sendImages("!r:hs", [img(cat)], ownerDm);
            expect(sends().map((c) => JSON.parse(c.init.body as string).body)).toEqual(
                ownerDm ? [`Couldn't send the image here; it's saved at ${cat}`] : [],
            );
        }
        uploadFails = false;
    });
});
