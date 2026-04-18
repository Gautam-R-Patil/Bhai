// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { getSessionToken } from "../../session.js";
import { getConvexSiteUrl } from "../../config/keys.js";
import { encryptedFetch } from "../../crypto-transport.js";
import { getWorkspaceSubdir } from "../../config/paths.js";
import type { Asset } from "./types.js";

const IMAGE_MODEL = "openai/gpt-5-image";
const ASSETS_SUBDIR = "Presentations/.assets";

// Per-deck dedup cache (prompt hash -> absolute path).
// Cleared when a deck render finishes.
const dedupCache = new Map<string, string>();

export function clearAssetCache(): void {
    dedupCache.clear();
}

function assetsDir(): string {
    return getWorkspaceSubdir(ASSETS_SUBDIR);
}

function hashKey(input: string): string {
    return createHash("sha1").update(input).digest("hex").slice(0, 16);
}

// ── Tier 2: AI Image Generation (Convex proxy, same pipeline as generate_image tool) ──

async function generateAIImage(prompt: string): Promise<string | null> {
    try {
        const sessionToken = await getSessionToken();
        if (!sessionToken) return null;

        const proxyUrl = `${getConvexSiteUrl()}/api/llm/chat`;
        const response = await encryptedFetch(proxyUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${sessionToken}`,
            },
            body: JSON.stringify({
                model: IMAGE_MODEL,
                modalities: ["text", "image"],
                messages: [{
                    role: "user",
                    content: `Generate an image: ${prompt}`,
                }],
            }),
        });

        if (!response.ok) return null;

        const data = await response.json() as Record<string, unknown>;
        const base64 = extractImageBase64(data);
        if (!base64) return null;

        const outPath = path.join(assetsDir(), `ai_${hashKey(prompt)}_${Date.now()}.png`);
        fs.writeFileSync(outPath, Buffer.from(base64, "base64"));
        return outPath;
    } catch {
        return null;
    }
}

function extractImageBase64(data: Record<string, unknown>): string | null {
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    if (!choices?.length) return null;

    const msg = choices[0].message as Record<string, unknown> | undefined;
    if (!msg) return null;

    // Path A: GPT-5 Image format — msg.images
    const images = msg.images as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(images) && images.length > 0) {
        const img = images[0];
        if (typeof img.b64_json === "string") return img.b64_json;
        const url = img.url as string | undefined;
        if (url) {
            const m = url.match(/^data:[^;]+;base64,(.+)$/s);
            if (m) return m[1];
        }
        if (typeof img.data === "string") return img.data;
    }

    // Path B: content array
    const content = msg.content;
    if (Array.isArray(content)) {
        for (const part of content as Array<Record<string, unknown>>) {
            if (part.type === "image_url") {
                const url = (part.image_url as Record<string, unknown>)?.url as string;
                const m = url?.match(/^data:[^;]+;base64,(.+)$/s);
                if (m) return m[1];
            }
            if (part.inline_data) {
                return (part.inline_data as Record<string, unknown>).data as string;
            }
        }
    }
    return null;
}

// ── Tier 3: Pexels Stock (optional, requires PEXELS_API_KEY env var) ──

async function fetchPexelsImage(query: string): Promise<{ path: string; attribution: string } | null> {
    const apiKey = process.env.PEXELS_API_KEY;
    if (!apiKey) return null;

    try {
        const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`;
        const res = await fetch(url, { headers: { Authorization: apiKey } });
        if (!res.ok) return null;
        const data = await res.json() as { photos?: Array<{ src: { large2x?: string; large?: string }; photographer: string; url: string; alt?: string }> };
        const photo = data.photos?.[0];
        if (!photo) return null;

        const imgUrl = photo.src.large2x ?? photo.src.large;
        if (!imgUrl) return null;
        const imgRes = await fetch(imgUrl);
        if (!imgRes.ok) return null;
        const buf = Buffer.from(await imgRes.arrayBuffer());

        const outPath = path.join(assetsDir(), `pexels_${hashKey(query)}_${Date.now()}.jpg`);
        fs.writeFileSync(outPath, buf);
        return {
            path: outPath,
            attribution: `Photo by ${photo.photographer} on Pexels (${photo.url})`,
        };
    } catch {
        return null;
    }
}

// ── Sharp smart crop + downsize ──

async function processImage(
    inputPath: string,
    opts: { targetWidth?: number; targetHeight?: number; quality?: number },
): Promise<string> {
    const { targetWidth = 1920, targetHeight, quality = 82 } = opts;
    try {
        const meta = await sharp(inputPath).metadata();
        const needsResize = (meta.width ?? 0) > targetWidth;
        if (!needsResize && !targetHeight) return inputPath;

        const outPath = inputPath.replace(/\.(png|jpe?g|webp)$/i, "_processed.jpg");
        const pipe = sharp(inputPath);
        if (targetHeight && targetWidth) {
            // Sharp's "attention" crop picks salient regions — keeps faces and key subjects in-frame.
            pipe.resize(targetWidth, targetHeight, { fit: "cover", position: "attention" });
        } else if (needsResize) {
            pipe.resize({ width: targetWidth });
        }
        await pipe.jpeg({ quality, mozjpeg: true }).toFile(outPath);
        return outPath;
    } catch {
        return inputPath;
    }
}

// ── Primary resolver ─────────────────────────

export interface ResolveOpts {
    prompt: string;
    slideTitle: string;
    aspectRatio?: "16:9" | "4:3" | "1:1" | "free";
    preferStock?: boolean;          // skip AI gen (faster, cheaper)
}

/**
 * Resolve a single asset. Tries AI-gen first (highest quality, custom to content),
 * falls back to Pexels stock, finally returns null if all fail.
 * Results are deduped within the current deck render by prompt hash.
 */
export async function resolveAsset(opts: ResolveOpts): Promise<Asset | null> {
    const cacheKey = hashKey(opts.prompt);
    const cached = dedupCache.get(cacheKey);
    if (cached && fs.existsSync(cached)) {
        return {
            kind: "ai-image",
            path: cached,
            altText: opts.slideTitle,
            hash: cacheKey,
        };
    }

    // Tier 2: AI generation (unless user opted into stock-first)
    let sourcePath: string | null = null;
    let kind: Asset["kind"] = "ai-image";
    let attribution: string | undefined;

    if (!opts.preferStock) {
        sourcePath = await generateAIImage(opts.prompt);
    }

    // Tier 3: Pexels fallback
    if (!sourcePath) {
        const pex = await fetchPexelsImage(opts.prompt);
        if (pex) {
            sourcePath = pex.path;
            kind = "photo";
            attribution = pex.attribution;
        }
    }

    if (!sourcePath) return null;

    // Post-process: resize / crop to slide aspect
    const dims = aspectToDims(opts.aspectRatio);
    const finalPath = await processImage(sourcePath, dims);

    dedupCache.set(cacheKey, finalPath);

    return {
        kind,
        path: finalPath,
        altText: opts.slideTitle,
        attribution,
        hash: cacheKey,
    };
}

function aspectToDims(aspect?: ResolveOpts["aspectRatio"]): { targetWidth: number; targetHeight?: number } {
    switch (aspect) {
        case "16:9": return { targetWidth: 1920, targetHeight: 1080 };
        case "4:3": return { targetWidth: 1600, targetHeight: 1200 };
        case "1:1": return { targetWidth: 1200, targetHeight: 1200 };
        default: return { targetWidth: 1920 };
    }
}

// ── Batch resolver — parallel with bounded concurrency ──

export async function resolveAssets(
    requests: Array<{ id: string; opts: ResolveOpts }>,
    concurrency = 4,
): Promise<Map<string, Asset | null>> {
    const results = new Map<string, Asset | null>();
    const queue = [...requests];

    async function worker(): Promise<void> {
        while (queue.length > 0) {
            const item = queue.shift();
            if (!item) return;
            try {
                const asset = await resolveAsset(item.opts);
                results.set(item.id, asset);
            } catch {
                results.set(item.id, null);
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, worker));
    return results;
}
