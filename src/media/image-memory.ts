// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Per-conversation image memory for generate_image: the photos the user sent
// last ("edit this" one message later) and the versions Bhai made (for "last"
// and undo). In-process only; a restart forgets it.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export interface InboundImage {
    base64: string;
    mimeType: string;
}

const MAX_KEYS = 20;
const INBOUND_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_HISTORY = 10;
// Photos sent one after another (an album, several drops) add up for "combine these".
const APPEND_WINDOW_MS = 120_000;
// ~8MB decoded: past that an edit can't send it anyway, and memory stays bounded.
const MAX_IMAGE_BASE64 = 11_200_000;
const READABLE = /^image\/(jpeg|png|webp|gif)$/;

const inbound = new Map<string, { images: InboundImage[]; at: number }>();
const generated = new Map<string, string[]>();

/** Re-insert as newest and drop the oldest key past the cap (Map keeps insertion order). */
function touch<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    if (map.size > MAX_KEYS) map.delete(map.keys().next().value as string);
}

export function conversationKey(channel: string, userId: string): string {
    return `${channel}:${userId}`;
}

/** A message's images add to those sent in the last 2 min, else replace them (the newest 4, all an edit can use). */
export function rememberInboundImages(key: string, images: InboundImage[]): void {
    const fit = images.filter((i) => i.base64.length <= MAX_IMAGE_BASE64);
    if (!fit.length) return;
    const now = Date.now();
    for (const [k, e] of inbound) if (now - e.at > INBOUND_TTL_MS) inbound.delete(k);
    const prev = inbound.get(key);
    const all = prev && now - prev.at < APPEND_WINDOW_MS ? [...prev.images, ...fit] : fit;
    touch(inbound, key, { images: all.slice(-4), at: now });
}

/**
 * An image Claude and the image model can both read: HEIC, TIFF, BMP, AVIF… become a
 * ≤2048px JPEG (sharp, then macOS sips, which has the HEVC decoder sharp lacks).
 * Unchanged when already readable or when neither can convert it.
 */
export async function toReadableImage(img: InboundImage): Promise<InboundImage> {
    if (READABLE.test(img.mimeType)) return img;
    const buf = Buffer.from(img.base64, "base64");
    try {
        const sharp = (await import("sharp")).default;
        const out = await sharp(buf, { limitInputPixels: 1e9 })
            .rotate()
            .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 90 })
            .toBuffer();
        return { base64: out.toString("base64"), mimeType: "image/jpeg" };
    } catch {
        if (process.platform !== "darwin") return img;
    }
    let dir: string | undefined;
    try {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "bhai-img-"));
        const inp = path.join(dir, "in");
        const out = path.join(dir, "out.jpg");
        await fs.writeFile(inp, buf);
        await promisify(execFile)("sips", ["-s", "format", "jpeg", "-Z", "2048", inp, "--out", out], {
            timeout: 30_000,
        });
        return { base64: (await fs.readFile(out)).toString("base64"), mimeType: "image/jpeg" };
    } catch {
        return img;
    } finally {
        if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

export function lastInboundImages(key: string): InboundImage[] {
    const e = inbound.get(key);
    if (!e || Date.now() - e.at > INBOUND_TTL_MS) return [];
    return e.images;
}

export function pushGenerated(key: string, path: string): void {
    const stack = generated.get(key) ?? [];
    stack.push(path);
    if (stack.length > MAX_HISTORY) stack.shift();
    touch(generated, key, stack);
}

export function currentGenerated(key: string): string | undefined {
    return generated.get(key)?.at(-1);
}

/** Drops the current version; returns the one before it (undefined when there is none, history untouched). */
export function undoGenerated(key: string, usable: (path: string) => boolean = () => true): string | undefined {
    const stack = generated.get(key);
    const prev = stack?.at(-2);
    // A deleted earlier version leaves the history where it was.
    if (!stack || !prev || !usable(prev)) return undefined;
    stack.pop();
    return prev;
}
