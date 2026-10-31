// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Generated images on Telegram: the follow-up buttons, how files go out, albums as one turn,
// and the "sending a photo…" action while generate_image runs.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import type { GeneratedImage } from "./agent.js";

const dir = mkdtempSync(join(tmpdir(), "tg-images-"));
process.env.ATLAS_DATA_DIR = dir;
const { bufferMediaGroup, chatActionFor, imageKeyboard, sendImages } = await import("./telegram.js");

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
    // A combine of several photos has no single before image to go back to.
    expect(labels([{ ...base, kind: "edited" }])).not.toContain("↩️ Undo");
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
