// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { promises as fs } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import type { ToolDefinition } from "./get-current-time.js";

// ── Constants ────────────────────────────────

const TENOR_DEMO_KEY = process.env.TENOR_API_KEY ?? "";
const TENOR_BASE = "https://tenor.googleapis.com/v2";
const GIPHY_BASE = "https://api.giphy.com/v1/gifs";

// ── Helpers ──────────────────────────────────

interface GifResult {
    id: string;
    title: string;
    url: string;
    preview_url: string;
    width: number;
    height: number;
}

function parseTenorResults(results: any[]): GifResult[] {
    return results.map((r: any) => ({
        id: r.id,
        title: r.title || r.content_description || "",
        url: r.media_formats?.gif?.url || "",
        preview_url: r.media_formats?.tinygif?.url || "",
        width: r.media_formats?.gif?.dims?.[0] || 0,
        height: r.media_formats?.gif?.dims?.[1] || 0,
    }));
}

function parseGiphyResults(results: any[]): GifResult[] {
    return results.map((r: any) => ({
        id: r.id,
        title: r.title || "",
        url: r.images?.original?.url || "",
        preview_url: r.images?.fixed_height_small?.url || "",
        width: parseInt(r.images?.original?.width || "0", 10),
        height: parseInt(r.images?.original?.height || "0", 10),
    }));
}

// ── gif_search ───────────────────────────────

export const gifSearch: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "gif_search",
            description:
                "Search for GIFs, browse trending GIFs, or download a GIF to disk. Supports Tenor (default, no key needed) and Giphy (requires GIPHY_API_KEY env var).",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["search", "trending", "download"],
                        description:
                            "The action to perform: search for GIFs by query, get trending GIFs, or download a specific GIF by URL.",
                    },
                    query: {
                        type: "string",
                        description: "Search query string. Required when action is 'search'.",
                    },
                    limit: {
                        type: "number",
                        description: "Maximum number of results to return (1-20). Defaults to 5.",
                    },
                    provider: {
                        type: "string",
                        enum: ["tenor", "giphy"],
                        description: "GIF provider to use. Defaults to 'tenor'. Giphy requires GIPHY_API_KEY env var.",
                    },
                    url: {
                        type: "string",
                        description: "The GIF URL to download. Required when action is 'download'.",
                    },
                    output_path: {
                        type: "string",
                        description: "File path to save the downloaded GIF. Defaults to ~/Downloads/.",
                    },
                },
                required: ["action"],
            },
        },
    },

    async handler(input) {
        try {
            const action = input.action as string;
            const query = input.query as string | undefined;
            const limit = Math.min(Math.max((input.limit as number) || 5, 1), 20);
            const provider = (input.provider as string) || "tenor";
            const url = input.url as string | undefined;
            const outputPath = input.output_path as string | undefined;

            // ── Search ───────────────────────────
            if (action === "search") {
                if (!query) {
                    return JSON.stringify({ error: "query is required for search action" });
                }

                let results: GifResult[];

                if (provider === "giphy") {
                    const giphyKey = process.env.GIPHY_API_KEY;
                    if (!giphyKey) {
                        return JSON.stringify({
                            error: "GIPHY_API_KEY env var is not set. Use provider 'tenor' or set the env var.",
                        });
                    }
                    const res = await fetch(
                        `${GIPHY_BASE}/search?api_key=${encodeURIComponent(giphyKey)}&q=${encodeURIComponent(query)}&limit=${limit}`,
                    );
                    if (!res.ok) {
                        return JSON.stringify({ error: `Giphy API error: ${res.status} ${res.statusText}` });
                    }
                    const data = await res.json();
                    results = parseGiphyResults(data.data || []);
                } else {
                    const res = await fetch(
                        `${TENOR_BASE}/search?q=${encodeURIComponent(query)}&key=${TENOR_DEMO_KEY}&limit=${limit}&media_filter=gif`,
                    );
                    if (!res.ok) {
                        return JSON.stringify({ error: `Tenor API error: ${res.status} ${res.statusText}` });
                    }
                    const data = await res.json();
                    results = parseTenorResults(data.results || []);
                }

                return JSON.stringify({
                    success: true,
                    action: "search",
                    query,
                    provider,
                    count: results.length,
                    results,
                });
            }

            // ── Trending ─────────────────────────
            if (action === "trending") {
                let results: GifResult[];

                if (provider === "giphy") {
                    const giphyKey = process.env.GIPHY_API_KEY;
                    if (!giphyKey) {
                        return JSON.stringify({
                            error: "GIPHY_API_KEY env var is not set. Use provider 'tenor' or set the env var.",
                        });
                    }
                    const res = await fetch(
                        `${GIPHY_BASE}/trending?api_key=${encodeURIComponent(giphyKey)}&limit=${limit}`,
                    );
                    if (!res.ok) {
                        return JSON.stringify({ error: `Giphy API error: ${res.status} ${res.statusText}` });
                    }
                    const data = await res.json();
                    results = parseGiphyResults(data.data || []);
                } else {
                    const res = await fetch(
                        `${TENOR_BASE}/featured?key=${TENOR_DEMO_KEY}&limit=${limit}&media_filter=gif`,
                    );
                    if (!res.ok) {
                        return JSON.stringify({ error: `Tenor API error: ${res.status} ${res.statusText}` });
                    }
                    const data = await res.json();
                    results = parseTenorResults(data.results || []);
                }

                return JSON.stringify({ success: true, action: "trending", provider, count: results.length, results });
            }

            // ── Download ─────────────────────────
            if (action === "download") {
                if (!url) {
                    return JSON.stringify({ error: "url is required for download action" });
                }

                const res = await fetch(url);
                if (!res.ok) {
                    return JSON.stringify({ error: `Failed to download GIF: ${res.status} ${res.statusText}` });
                }

                const buffer = Buffer.from(await res.arrayBuffer());

                let dest: string;
                if (outputPath) {
                    dest = outputPath;
                } else {
                    const filename = basename(new URL(url).pathname) || "downloaded.gif";
                    const downloadsDir = join(homedir(), "Downloads");
                    await fs.mkdir(downloadsDir, { recursive: true });
                    dest = join(downloadsDir, filename);
                }

                await fs.writeFile(dest, buffer);

                return JSON.stringify({ success: true, action: "download", path: dest, size_bytes: buffer.length });
            }

            return JSON.stringify({ error: `Unknown action: ${action}. Use 'search', 'trending', or 'download'.` });
        } catch (err: any) {
            return JSON.stringify({ error: err?.message || String(err) });
        }
    },
};
