// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs/promises";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    conversationKey,
    currentGenerated,
    lastInboundImages,
    pushGenerated,
    rememberInboundImages,
    toReadableImage,
    undoGenerated,
} from "./image-memory.js";

const img = (s: string) => ({ base64: s, mimeType: "image/jpeg" });

describe("image memory", () => {
    afterEach(() => vi.useRealTimers());

    it("keeps the latest message's images per conversation, for 6h", () => {
        vi.useFakeTimers();
        const k = conversationKey("telegram", "u1");
        expect(k).not.toBe(conversationKey("telegram", "u2"));
        rememberInboundImages(k, [img("a"), img("b")]);
        vi.advanceTimersByTime(121_000);
        rememberInboundImages(k, [img("c")]);
        rememberInboundImages(k, []); // a text-only message doesn't forget the photo
        expect(lastInboundImages(k)).toEqual([img("c")]);
        expect(lastInboundImages(conversationKey("telegram", "u2"))).toEqual([]);
        vi.advanceTimersByTime(6 * 60 * 60 * 1000 + 1);
        expect(lastInboundImages(k)).toEqual([]);
    });

    it("photos sent within 2 min add up (newest 4); later ones replace them", () => {
        vi.useFakeTimers();
        const k = "album";
        rememberInboundImages(k, [img("a")]);
        vi.advanceTimersByTime(10_000);
        rememberInboundImages(k, [img("b")]);
        expect(lastInboundImages(k)).toEqual([img("a"), img("b")]);
        rememberInboundImages(k, [img("c"), img("d"), img("e")]);
        expect(lastInboundImages(k)).toEqual([img("b"), img("c"), img("d"), img("e")]);
        vi.advanceTimersByTime(3 * 60_000);
        rememberInboundImages(k, [img("f")]);
        expect(lastInboundImages(k)).toEqual([img("f")]);
    });

    it("skips an image too big to edit", () => {
        const k = "huge";
        rememberInboundImages(k, [img("x".repeat(11_200_001))]);
        expect(lastInboundImages(k)).toEqual([]);
        rememberInboundImages(k, [img("x".repeat(11_200_001)), img("ok")]);
        expect(lastInboundImages(k)).toEqual([img("ok")]);
    });

    it("drops the least recently used conversation past 20", () => {
        for (let i = 0; i < 21; i++) rememberInboundImages(`lru:${i}`, [img(String(i))]);
        expect(lastInboundImages("lru:0")).toEqual([]);
        expect(lastInboundImages("lru:20")).toEqual([img("20")]);
    });

    it("undo walks back the generated versions, capped at 10", () => {
        const k = "hist";
        expect(undoGenerated(k)).toBeUndefined();
        pushGenerated(k, "/v1.png");
        expect(undoGenerated(k)).toBeUndefined(); // nothing before the first version
        expect(currentGenerated(k)).toBe("/v1.png");
        pushGenerated(k, "/v2.png");
        pushGenerated(k, "/v3.png");
        expect(undoGenerated(k)).toBe("/v2.png");
        expect(currentGenerated(k)).toBe("/v2.png");
        for (let i = 0; i < 12; i++) pushGenerated(k, `/x${i}.png`);
        let steps = 0;
        while (undoGenerated(k)) steps++;
        expect(steps).toBe(9);
    });

    it("turns a format the models can't read into a JPEG, else leaves it", async () => {
        const png = (await sharp({ create: { width: 3000, height: 1000, channels: 3, background: "red" } }).png().toBuffer()).toString("base64");
        const out = await toReadableImage({ base64: png, mimeType: "image/tiff" });
        expect(out.mimeType).toBe("image/jpeg");
        const meta = await sharp(Buffer.from(out.base64, "base64")).metadata();
        expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 2048, 683]);
        const keep = { base64: png, mimeType: "image/png" };
        expect(await toReadableImage(keep)).toBe(keep);
        const junk = { base64: "bm90IGFuIGltYWdl", mimeType: "image/heic" };
        expect(await toReadableImage(junk)).toBe(junk); // neither sharp nor sips can: the original goes on
    });

    it("never throws into the reply path, even when no temp dir can be made", async () => {
        const spy = vi.spyOn(fs, "mkdtemp").mockRejectedValue(new Error("ENOSPC"));
        const junk = { base64: "bm90IGFuIGltYWdl", mimeType: "image/heic" };
        try {
            expect(await toReadableImage(junk)).toBe(junk);
        } finally {
            spy.mockRestore();
        }
    });
});
