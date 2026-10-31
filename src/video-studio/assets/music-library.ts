// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const _require = createRequire(import.meta.url);
const MUSIC_CACHE_DIR = path.resolve(process.env.BHAI_DATA_DIR ?? "data", "video-studio", "music-cache");

export interface MusicEntry {
    title: string;
    artist: string;
    url: string;
    license: string;
    mood: string[];
    bpm: number;
    durationSec: number;
}

export interface MusicSearchQuery {
    mood?: string;
    bpm?: number;
    duration?: number;
}

const _manifest: MusicEntry[] = _require("./music/index.json") as MusicEntry[];

function urlCacheKey(url: string): string {
    return createHash("sha1").update(url).digest("hex");
}

function cachedPath(entry: MusicEntry, dir: string): string {
    const key = urlCacheKey(entry.url);
    return path.join(dir, `${key}.mp3`);
}

export async function searchMusic(query: MusicSearchQuery): Promise<MusicEntry[]> {
    return _manifest.filter((entry) => {
        if (query.mood) {
            const keyword = query.mood.toLowerCase();
            if (!entry.mood.some((m) => m.toLowerCase().includes(keyword))) return false;
        }
        if (query.bpm !== undefined && Math.abs(entry.bpm - query.bpm) > 10) return false;
        if (query.duration !== undefined && entry.durationSec < query.duration) return false;
        return true;
    });
}

export async function downloadMusic(entry: MusicEntry, destDir: string): Promise<string> {
    await fs.mkdir(MUSIC_CACHE_DIR, { recursive: true });
    await fs.mkdir(destDir, { recursive: true });

    const cached = cachedPath(entry, MUSIC_CACHE_DIR);
    const dest = cachedPath(entry, destDir);

    try {
        await fs.access(cached);
        if (cached !== dest) await fs.copyFile(cached, dest);
        return dest;
    } catch {
        // not cached — continue to fetch
    }

    let response: Response;
    try {
        response = await fetch(entry.url);
    } catch (err) {
        throw new Error(`Music download failed (offline or network error): ${entry.url} — ${String(err)}`);
    }

    if (!response.ok) {
        throw new Error(`Music download HTTP error ${response.status} ${response.statusText}: ${entry.url}`);
    }

    const buffer = await response.arrayBuffer();
    await fs.writeFile(cached, new Uint8Array(buffer));
    if (cached !== dest) await fs.copyFile(cached, dest);
    return dest;
}
