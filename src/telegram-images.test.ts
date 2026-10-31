// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Generated images on Telegram: the follow-up buttons, how files go out, albums as one turn,
// and the "sending a photo…" action while generate_image runs; the owner's photo with no words.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import type { GeneratedImage } from "./agent.js";

const runAgent = vi.hoisted(() => vi.fn(async () => ({ text: "[NO_REPLY]", toolCalls: 0 })));
vi.mock("./agent.js", async (orig) => ({ ...(await orig<object>()), runAgent }));

const dir = mkdtempSync(join(tmpdir(), "tg-images-"));
process.env.ATLAS_DATA_DIR = dir;
process.env.ATLAS_WORKSPACE = dir;
const {
    bufferMediaGroup,
    chatActionFor,
    imageCallbackMessage,
    imageKeyboard,
    photoCallbackMessage,
    photoKeyboard,
    runMediaTurn,
    sendImages,
} = await import("./telegram.js");
const { lastInboundImages, takePhotoQuestion } = await import("./media/image-memory.js");
const { noteGeneratedImages, runWithCallerContext } = await import("./tools/cron-tool.js");
const { sendFileTool, setTelegramContext } = await import("./tools/send-file.js");

const labels = (images: GeneratedImage[]) =>
    imageKeyboard(images).inline_keyboard.flat().map((b) => b.text);

async function image(name: string, size: number, format: "png" | "jpeg"): Promise<GeneratedImage> {
    const path = join(dir, name);
    await sharp({ create: { width: size, height: size, channels: 3, background: "#888" } })
        .toFormat(format)
        .toFile(path);
    return { path, mimeType: `image/${format}`, prompt: "a cat in a hat", kind: "generated" };
}

function fakeApi() {
    const calls: { method: string; opts?: Record<string, unknown>; media?: Array<{ type: string }> }[] = [];
    const api = {
        sendPhoto: async (_c: number, _f: unknown, opts: Record<string, unknown>) => {
            calls.push({ method: "sendPhoto", opts });
            return { message_id: 1 };
        },
        sendDocument: async (_c: number, _f: unknown, opts: Record<string, unknown>) => {
            calls.push({ method: "sendDocument", opts });
            return { message_id: 2 };
        },
        sendMediaGroup: async (_c: number, media: Array<{ type: string }>) => {
            calls.push({ method: "sendMediaGroup", media });
            return [];
        },
        sendMessage: async (_c: number, _t: string, opts: Record<string, unknown>) => {
            calls.push({ method: "sendMessage", opts });
            return { message_id: 3 };
        },
    };
    return { api: api as never, calls };
}

afterEach(() => vi.useRealTimers());

it("offers Undo only when an edit has a before file", () => {
    const base = { path: "/x.png", mimeType: "image/png", prompt: "p" };
    expect(labels([{ ...base, kind: "generated" }])).toEqual(["🔁 Another version", "✨ HD"]);
    expect(labels([{ ...base, kind: "edited", sourcePath: "/before.png" }])).toContain("↩️ Undo");
    expect(labels([{ ...base, kind: "undo", sourcePath: "/after.png" }])).toContain("↩️ Undo"); // steps further back
    // A combine of several photos has no single before image to go back to.
    expect(labels([{ ...base, kind: "edited" }])).not.toContain("↩️ Undo");
});

it("buttons name their image, so a tap after a restart or newer images acts on that file", () => {
    const images = join(dir, "Images");
    mkdirSync(images, { recursive: true });
    const made = join(images, "a_cat_1761900000000.jpg");
    const before = join(images, "a_cat_original_1761900000000.jpg");
    writeFileSync(made, "x");
    writeFileSync(before, "x");
    writeFileSync(join(images, "a_cat_1761900099999.jpg"), "x"); // a newer image
    const data = imageKeyboard([{ path: made, mimeType: "image/jpeg", prompt: "p", kind: "edited", sourcePath: before }])
        .inline_keyboard.flat()
        .map((b) => (b as { callback_data: string }).callback_data);
    expect(data.slice(0, 2).every((d) => /^img:(again|hq):[0-9a-f]{12}$/.test(d))).toBe(true);
    // Undo stays plain: generate_image's undo walks the saved history (an undo of an undo goes further back).
    expect(data[2]).toBe("img:undo");
    expect(imageCallbackMessage(data[0])).toBe(`Make one more version of that image: ${made}`);
    expect(imageCallbackMessage(data[1])).toBe(`Make that image again, one copy, in high quality: ${made}`);
    expect(imageCallbackMessage(data[2])).toBe("Undo that last image edit");
    // Old buttons and ids whose file is gone: the plain message, as before.
    expect(imageCallbackMessage("img:again")).toBe("Make one more version of that image");
    expect(imageCallbackMessage("img:hq:000000000000")).toBe("Make that image again, one copy, in high quality");
    // Anything else in the callback data is refused, never read as a path.
    for (const bad of ["img:again:../../etc", "img:hq:ABCDEF012345", "img:again:0123456789ab:x", "img:redo", "img:undo:0123456789ab"])
        expect(imageCallbackMessage(bad)).toBeUndefined();
});

it("send_file skips an image generate_image already showed this turn, sends it where the chat can't show images", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "tg-send-")), "made.jpg"); // outside the data dir
    writeFileSync(file, "x");
    const sent: string[] = [];
    setTelegramContext({ api: { sendPhoto: async () => sent.push("photo") } }, 1);
    const run = (conversationKey: string) =>
        runWithCallerContext({ isOwner: true, conversationKey }, async () => {
            noteGeneratedImages([{ path: file, mimeType: "image/jpeg", prompt: "p", kind: "generated" }]);
            return JSON.parse(await sendFileTool.handler({ file_path: file }));
        });
    expect(await run("telegram:1")).toEqual({ success: true, note: "already shown in the chat" });
    expect(sent).toEqual([]);
    expect(await run("cron:1")).toMatchObject({ success: true, type: "photo" });
    expect(sent).toEqual(["photo"]);
});

it("shows 'sending a photo' while generate_image runs, typing otherwise", () => {
    expect(chatActionFor("🎨 Painting the image...")).toBe("upload_photo");
    expect(chatActionFor("step 2 · 🖼️ Editing your photo... · 21s")).toBe("upload_photo");
    expect(chatActionFor("🔍 Searching: \"cats\"")).toBe("typing");
    expect(chatActionFor("")).toBe("typing");
});

it("runs an album once, from its first part, after the last part arrives", () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const later = vi.fn();
    bufferMediaGroup("1:album", "a", first);
    vi.advanceTimersByTime(1000);
    bufferMediaGroup("1:album", "b", later);
    vi.advanceTimersByTime(1000);
    bufferMediaGroup("1:album", "c", later);
    vi.advanceTimersByTime(1499);
    expect(first).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(first).toHaveBeenCalledExactlyOnceWith(["a", "b", "c"]);
    expect(later).not.toHaveBeenCalled();
    // The key is free again: the next album starts fresh.
    bufferMediaGroup("1:album", "d", later);
    vi.advanceTimersByTime(1500);
    expect(later).toHaveBeenCalledExactlyOnceWith(["d"]);
});

it("sends a small JPEG as one uncaptioned photo carrying the buttons", async () => {
    const { api, calls } = fakeApi();
    await sendImages(api, 1, [await image("small.jpg", 64, "jpeg")], true);
    expect(calls.map((c) => c.method)).toEqual(["sendPhoto"]);
    expect(calls[0].opts?.caption).toBeUndefined();
    expect(calls[0].opts?.reply_markup).toBeDefined();
});

it("sends a PNG as a document only, so its transparency survives", async () => {
    const { api, calls } = fakeApi();
    await sendImages(api, 1, [await image("logo.png", 64, "png")], true);
    expect(calls.map((c) => c.method)).toEqual(["sendDocument"]);
    expect(calls[0].opts?.reply_markup).toBeDefined();
});

it("sends an image over 1280px as a photo and then the full file", async () => {
    const { api, calls } = fakeApi();
    await sendImages(api, 1, [await image("big.jpg", 1600, "jpeg")], true);
    expect(calls.map((c) => c.method)).toEqual(["sendPhoto", "sendDocument"]);
    expect(calls[0].opts?.reply_markup).toBeDefined();
    expect(calls[1].opts?.reply_markup).toBeUndefined();
});

it("sends several images as an album, then the buttons on their own line", async () => {
    const { api, calls } = fakeApi();
    const images = [await image("a.jpg", 64, "jpeg"), await image("b.jpg", 64, "jpeg")];
    await sendImages(api, 1, images, true, { reply_parameters: { message_id: 7 } });
    expect(calls.map((c) => c.method)).toEqual(["sendMediaGroup", "sendMessage"]);
    // The button line replies to the same message, so a tap carries the same reply context.
    expect(calls[1].opts?.reply_parameters).toEqual({ message_id: 7 });
    expect(calls[0].media?.map((m) => m.type)).toEqual(["photo", "photo"]);
    expect(calls[0].media?.some((m) => "caption" in m)).toBe(false);
});

it("asks the owner what to do with a photo sent with no words, once per album, without a model call", async () => {
    vi.stubGlobal("fetch", async () => new Response("jpegbytes"));
    type Reply = [string, { reply_markup?: { inline_keyboard: Array<Array<{ callback_data: string }>> } }?];
    const replies: Reply[] = [];
    const ctx = (from: number, type: string, caption?: string) => ({
        message: { photo: [{ file_id: "f" }], caption },
        from: { id: from, first_name: "A" },
        chat: { id: from, type },
        reply: async (...a: Reply) => replies.push(a),
        replyWithChatAction: async () => {},
    });
    const bot = { api: { getFile: async () => ({ file_path: "p", file_size: 9 }) } };
    const config = { allowedUserIds: [7], telegramBotToken: "t" };
    const llm = { chat: async () => Promise.reject(new Error("no model")) };
    const run = (c: ReturnType<typeof ctx>, n = 2) =>
        runMediaTurn(
            c as never,
            bot as never,
            config as never,
            llm as never,
            Array(n).fill({ message: c.message, mediaType: "image" }),
            undefined,
            false,
        );

    await run(ctx(7, "private"));
    expect(replies).toHaveLength(1);
    expect(replies[0][0]).toBe("What should I do with it?");
    const buttons = replies[0][1]?.reply_markup?.inline_keyboard.flat() ?? [];
    expect(buttons.map((b) => b.callback_data)).toEqual(["photo:describe", "photo:nobg", "photo:light", "photo:cartoon"]);
    expect(lastInboundImages("telegram:7")).toHaveLength(2); // agent.ts's key: a tap's "attached"
    expect(takePhotoQuestion("telegram:7")).toHaveLength(2); // the next message (tap or typed) sees them, once
    expect(takePhotoQuestion("telegram:7")).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
    expect(photoCallbackMessage("photo:describe")).toBe("Describe the photo I just sent");
    expect(photoCallbackMessage("photo:toString")).toBeUndefined();
    expect(photoKeyboard().inline_keyboard.map((r) => r.length)).toEqual([2, 2]);

    // A caption, a guest or a group: a turn as before.
    await run(ctx(7, "private", "make it pop"), 1);
    await run(ctx(8, "private"), 1);
    await run(ctx(7, "group"), 1);
    expect(replies).toHaveLength(1);
    expect(runAgent).toHaveBeenCalledTimes(3);
    expect(lastInboundImages("telegram:8")).toEqual([]);
    vi.unstubAllGlobals();
});
