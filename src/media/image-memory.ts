// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Per-conversation image memory for generate_image: the photos the user sent
// last ("edit this" one message later, in memory only) and the versions Bhai made
// (for "last", "variation N" and undo; file paths only, kept in data/ across restarts).

import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getDataDir } from "../config/paths.js";

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
// Each entry is one generate_image call's output: one path, or a batch of variations.
const generated = new Map<string, string[][]>();
let loaded = false;

/** The owner's generated history, shared by every channel (guests keep their conversation key). */
export const OWNER_IMAGE_KEY = "owner";

const historyFile = () => path.join(getDataDir(), "image-history.json");

/** Loads the saved history once, dropping files that are gone. */
function load(): void {
    if (loaded) return;
    loaded = true;
    try {
        const saved = JSON.parse(fsSync.readFileSync(historyFile(), "utf8")) as Record<string, string[][]>;
        for (const [key, stack] of Object.entries(saved)) {
            const kept = stack.map((e) => e.filter((p) => fsSync.existsSync(p))).filter((e) => e.length);
            // A retried load keeps what was made meanwhile, newest last.
            if (kept.length) generated.set(key, [...kept, ...(generated.get(key) ?? [])].slice(-MAX_HISTORY));
        }
    } catch (e) {
        // Only a missing file is an empty history; anything else retries, so a save can't wipe the file.
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") loaded = false;
    }
}

function persist(): void {
    if (!loaded) return; // the saved history couldn't be read: don't overwrite it
    const file = historyFile();
    try {
        fsSync.mkdirSync(path.dirname(file), { recursive: true });
        fsSync.writeFileSync(`${file}.tmp`, JSON.stringify(Object.fromEntries(generated)), { mode: 0o600 });
        fsSync.renameSync(`${file}.tmp`, file);
    } catch (e) {
        console.log(`  🎨 image history: can't save (${(e as Error).message})`);
    }
}

/** Re-insert as newest and drop the oldest key past the cap (Map keeps insertion order); never the owner's. */
function touch<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    if (map.size > MAX_KEYS) map.delete([...map.keys()].find((k) => k !== OWNER_IMAGE_KEY) as string);
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

// A photo sent with no words got "What should I do with it?": the owner's next message there is
// about that photo, chip or typed. Process memory only; a restart just loses the question.
const photoQuestions = new Map<string, number>();
const PHOTO_QUESTION_TTL_MS = 30 * 60 * 1000;

export function markPhotoQuestion(key: string): void {
    photoQuestions.set(key, Date.now());
}

/** The photo the question was about, once: the next message's media. Empty when none is pending. */
export function takePhotoQuestion(key: string): InboundImage[] {
    const at = photoQuestions.get(key);
    photoQuestions.delete(key);
    return at !== undefined && Date.now() - at <= PHOTO_QUESTION_TTL_MS ? lastInboundImages(key) : [];
}

/** One call's result: a single version, or a batch of variations (one undo step, "last" = its last one). */
export function pushGenerated(key: string, paths: string | string[]): void {
    load();
    const stack = generated.get(key) ?? [];
    stack.push(typeof paths === "string" ? [paths] : paths);
    if (stack.length > MAX_HISTORY) stack.shift();
    touch(generated, key, stack);
    persist();
}

export function currentGenerated(key: string): string | undefined {
    load();
    return generated.get(key)?.at(-1)?.at(-1);
}

/** The newest batch of variations still in the history ("variation N"), or undefined. */
export function lastGeneratedBatch(key: string): string[] | undefined {
    load();
    const stack = generated.get(key) ?? [];
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].length > 1) return stack[i];
    return undefined;
}

/** Drops the current version; returns the one before it (undefined when there is none, history untouched). */
export function undoGenerated(key: string, usable: (path: string) => boolean = () => true): string | undefined {
    load();
    const stack = generated.get(key);
    const prev = stack?.at(-2)?.at(-1);
    // A deleted earlier version leaves the history where it was.
    if (!stack || !prev || !usable(prev)) return undefined;
    stack.pop();
    persist();
    return prev;
}
