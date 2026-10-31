// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// A generated image reaches WhatsApp, Discord and Slack whole: no prompt caption, PNGs keep their
// transparency, one bad file doesn't lose the rest, and only the owner's DM hears where a failed one was saved.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const uploads: unknown[] = [];
let uploadError: unknown = null;
vi.mock("@slack/bolt", () => ({
    App: class {
        client = {
            files: {
                uploadV2: async (args: unknown) => {
                    if (uploadError) throw uploadError;
                    uploads.push(args);
                },
            },
        };
        event() {}
        async start() {}
    },
}));
vi.mock("discord.js", () => {
    const stub = class {};
    return {
        Client: stub,
        GatewayIntentBits: {},
        Events: {},
        ChannelType: {},
        Partials: {},
        InteractionContextType: {},
        SlashCommandBuilder: stub,
        REST: stub,
        Routes: {},
        EmbedBuilder: stub,
        AttachmentBuilder: class {
            constructor(
                public buf: unknown,
                public opts: { name: string },
            ) {}
        },
    };
});

const dir = mkdtempSync(join(tmpdir(), "channel-images-"));
process.env.ATLAS_DATA_DIR = dir;
const png = join(dir, "cat.png");
const jpg = join(dir, "dog.jpg");
writeFileSync(png, "png");
writeFileSync(jpg, "jpg");
const missing = join(dir, "gone.png");
// The tool registry first: whatsapp.ts imported cold re-enters it through agent.ts mid-load.
await import("./tools/index.js");
const img = (path: string, mimeType: string) => ({ path, mimeType, prompt: "a cat ".repeat(80), kind: "generated" as const });

describe("WhatsApp", async () => {
    const { sendImages } = await import("./whatsapp.js");

    it("sends a PNG as a document, numbers several, never the prompt", async () => {
        const sent: Record<string, unknown>[] = [];
        await sendImages("j", [img(png, "image/png"), img(jpg, "image/jpeg")], true, async (c) => sent.push(c as never));
        expect(sent).toMatchObject([
            { mimetype: "image/png", fileName: "cat.png", caption: "1/2" },
            { mimetype: "image/jpeg", caption: "2/2" },
        ]);
        expect(sent[0].document).toBeDefined();
        expect(sent[1].image).toBeDefined();
        sent.length = 0;
        await sendImages("j", [img(jpg, "image/jpeg")], true, async (c) => sent.push(c as never));
        expect(sent[0].caption).toBeUndefined();
    });

    it("tells the owner where a failed image is saved, and nobody else", async () => {
        const sent: Record<string, unknown>[] = [];
        await sendImages("j", [img(missing, "image/png"), img(jpg, "image/jpeg")], true, async (c) => sent.push(c as never));
        expect(sent.at(-1)?.text).toBe(`Couldn't send the image here; it's saved at ${missing}`);
        sent.length = 0;
        await sendImages("j", [img(missing, "image/png")], false, async (c) => sent.push(c as never));
        expect(sent).toEqual([]);
    });
});

describe("Discord", async () => {
    const { sendImages } = await import("./discord.js");
    const names = (m: unknown) => (m as { files: { opts: { name: string } }[] }).files.map((f) => f.opts.name);

    it("sends all images in one message", async () => {
        const sent: unknown[] = [];
        await sendImages([img(png, "image/png"), img(jpg, "image/jpeg")], async (m) => sent.push(m), true);
        expect(sent.map(names)).toEqual([["cat.png", "dog.jpg"]]);
    });

    it("on a failed batch retries one file per send, then tells only the owner's DM", async () => {
        for (const ownerDm of [true, false]) {
            const sent: unknown[] = [];
            const send = async (m: unknown) => {
                if (typeof m === "object" && names(m).length > 1) throw new Error("Request entity too large");
                sent.push(m);
            };
            await sendImages([img(missing, "image/png"), img(jpg, "image/jpeg")], send, ownerDm);
            expect(sent.slice(0, 1).map(names)).toEqual([["dog.jpg"]]);
            expect(sent.slice(1)).toEqual(ownerDm ? [`Couldn't send the image here; it's saved at ${missing}`] : []);
        }
    });
});

describe("Slack", async () => {
    process.env.SLACK_BOT_TOKEN = "b";
    process.env.SLACK_APP_TOKEN = "a";
    const { initSlack, sendImages } = await import("./slack.js");
    await initSlack({} as never);

    it("uploads every image in one files.uploadV2 call", async () => {
        const said: unknown[] = [];
        await sendImages([img(png, "image/png"), img(jpg, "image/jpeg")], async (m) => said.push(m) as never, "D1", "t1", true);
        expect(uploads).toMatchObject([
            { channel_id: "D1", thread_ts: "t1", file_uploads: [{ filename: "cat.png" }, { filename: "dog.jpg" }] },
        ]);
        expect(said).toEqual([]);
    });

    it("without files:write the owner gets one line naming the scope; others get nothing", async () => {
        uploadError = Object.assign(new Error("An API error occurred: missing_scope"), { data: { error: "missing_scope" } });
        const said: { text: string }[] = [];
        const say = async (m: unknown) => said.push(m as { text: string }) as never;
        await sendImages([img(png, "image/png"), img(jpg, "image/jpeg")], say, "D1", "t1", true);
        expect(said).toHaveLength(1);
        expect(said[0].text).toContain("files:write");
        expect(said[0].text).toContain(`${png}, ${jpg}`);
        said.length = 0;
        await sendImages([img(png, "image/png")], say, "C1", "t1", false);
        expect(said).toEqual([]);
        uploadError = null;
    });
});
