// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { promises as fs } from "node:fs";
import { join } from "node:path";

export type StockProvider = "internet_archive" | "pexels";

export interface StockClip {
    durationSec: number;
    height: number;
    id: string;
    provider: StockProvider;
    thumbnailUrl?: string;
    url: string;
    width: number;
}

export interface SearchOpts {
    count?: number;
    /** Force a provider. Defaults to `pexels` if PEXELS_API_KEY is set, else `internet_archive`. */
    provider?: StockProvider;
}

export function selectDefaultProvider(): StockProvider {
    return process.env.PEXELS_API_KEY ? "pexels" : "internet_archive";
}

interface PexelsVideoFile {
    height: number;
    link: string;
    quality: string;
    width: number;
}

interface PexelsVideo {
    duration: number;
    id: number;
    image?: string;
    video_files: PexelsVideoFile[];
}

interface PexelsSearchResponse {
    videos: PexelsVideo[];
}

function pickLargestFile(files: PexelsVideoFile[]): PexelsVideoFile | undefined {
    if (files.length === 0) return undefined;
    return files.reduce((best, f) => (f.width * f.height > best.width * best.height ? f : best), files[0]);
}

function sanitizeCacheSegment(id: string): string {
    return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function clipCacheName(clip: StockClip): string {
    return `${clip.provider}-${sanitizeCacheSegment(clip.id)}.mp4`;
}

async function searchPexels(query: string, count: number): Promise<StockClip[]> {
    const key = process.env.PEXELS_API_KEY;
    if (!key) throw new Error("[stock-broll] Pexels provider selected but PEXELS_API_KEY is not set");

    const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${count}`;

    let resp: Response;
    try {
        resp = await fetch(url, { headers: { Authorization: key } });
    } catch (err) {
        throw new Error(`[stock-broll] Pexels search network error: ${String(err)}`);
    }

    if (resp.status === 401) {
        throw new Error("[stock-broll] Pexels auth failed (401) — check PEXELS_API_KEY");
    }
    if (!resp.ok) {
        throw new Error(`[stock-broll] Pexels search HTTP error ${resp.status}`);
    }

    const data = (await resp.json()) as PexelsSearchResponse;
    const videos: PexelsVideo[] = data.videos ?? [];

    return videos.map((v): StockClip => {
        const best = pickLargestFile(v.video_files);
        return {
            durationSec: v.duration,
            height: best?.height ?? 0,
            id: String(v.id),
            provider: "pexels",
            thumbnailUrl: v.image,
            url: best?.link ?? "",
            width: best?.width ?? 0,
        };
    });
}

interface IASearchDoc {
    identifier: string;
    title?: string;
}

interface IASearchResponse {
    response?: { docs?: IASearchDoc[] };
}

interface IAMetadataFile {
    format?: string;
    height?: string;
    length?: string;
    name: string;
    width?: string;
}

interface IAMetadataResponse {
    files?: IAMetadataFile[];
}

function parseIADuration(raw: string | undefined): number {
    if (!raw) return 0;
    const trimmed = raw.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) return Number.parseFloat(trimmed);
    const parts = trimmed.split(":").map((p) => Number.parseFloat(p));
    if (parts.some(Number.isNaN)) return 0;
    let seconds = 0;
    for (const p of parts) seconds = seconds * 60 + p;
    return seconds;
}

function pickIAVideoFile(files: IAMetadataFile[]): IAMetadataFile | undefined {
    const mp4s = files.filter((f) => /\.mp4$/i.test(f.name));
    if (mp4s.length === 0) return undefined;
    return mp4s.reduce((best, f) => {
        const bestPx = Number.parseInt(best.width ?? "0", 10) * Number.parseInt(best.height ?? "0", 10);
        const fPx = Number.parseInt(f.width ?? "0", 10) * Number.parseInt(f.height ?? "0", 10);
        return fPx > bestPx ? f : best;
    });
}

async function searchInternetArchive(query: string, count: number): Promise<StockClip[]> {
    const searchUrl =
        "https://archive.org/advancedsearch.php" +
        `?q=${encodeURIComponent(`${query} AND mediatype:movies`)}` +
        "&fl[]=identifier&fl[]=title" +
        `&rows=${count}` +
        "&output=json";

    let searchResp: Response;
    try {
        searchResp = await fetch(searchUrl);
    } catch (err) {
        throw new Error(`[stock-broll] Internet Archive search network error: ${String(err)}`);
    }

    if (!searchResp.ok) {
        throw new Error(`[stock-broll] Internet Archive search HTTP error ${searchResp.status}`);
    }

    const data = (await searchResp.json()) as IASearchResponse;
    const docs = data.response?.docs ?? [];

    const clips = await Promise.all(
        docs.map(async (doc): Promise<StockClip | null> => {
            const metaUrl = `https://archive.org/metadata/${encodeURIComponent(doc.identifier)}`;
            let metaResp: Response;
            try {
                metaResp = await fetch(metaUrl);
            } catch {
                return null;
            }
            if (!metaResp.ok) return null;

            const meta = (await metaResp.json()) as IAMetadataResponse;
            const files = meta.files ?? [];
            const video = pickIAVideoFile(files);
            if (!video) return null;

            const width = Number.parseInt(video.width ?? "0", 10) || 0;
            const height = Number.parseInt(video.height ?? "0", 10) || 0;

            return {
                durationSec: parseIADuration(video.length),
                height,
                id: doc.identifier,
                provider: "internet_archive",
                thumbnailUrl: `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`,
                url: `https://archive.org/download/${encodeURIComponent(doc.identifier)}/${encodeURIComponent(video.name)}`,
                width,
            };
        }),
    );

    return clips.filter((c): c is StockClip => c !== null);
}

export async function searchStockVideo(query: string, opts?: SearchOpts): Promise<StockClip[]> {
    const count = opts?.count ?? 10;
    const provider = opts?.provider ?? selectDefaultProvider();
    if (provider === "pexels") return searchPexels(query, count);
    return searchInternetArchive(query, count);
}

export async function downloadStockClip(clip: StockClip, destDir: string): Promise<string> {
    await fs.mkdir(destDir, { recursive: true });
    const cacheName = clipCacheName(clip);
    const destPath = join(destDir, cacheName);

    try {
        await fs.access(destPath);
        return destPath;
    } catch {
        // cache miss — fall through
    }

    let resp: Response;
    try {
        resp = await fetch(clip.url);
    } catch (err) {
        throw new Error(`[stock-broll] Download network error for clip ${clip.id}: ${String(err)}`);
    }

    if (!resp.ok) {
        throw new Error(
            `[stock-broll] Download HTTP error ${resp.status} ${resp.statusText} for clip ${clip.id}: ${clip.url}`,
        );
    }

    const buffer = await resp.arrayBuffer();
    await fs.writeFile(destPath, new Uint8Array(buffer));
    return destPath;
}
