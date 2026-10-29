// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── stock_image_search ───────────────────────
// Unified image search for web design. Provider order:
//   1. Unsplash    (needs UNSPLASH_ACCESS_KEY)  — curated, high-quality
//   2. Pexels      (needs PEXELS_API_KEY)       — curated, high-quality
//   3. Openverse   (keyless public API)         — aggregates 800M+ CC
//                                                  images from Wikimedia,
//                                                  Flickr, Nappy, Rawpixel,
//                                                  DeviantArt, etc.
//   4. Wikimedia Commons (keyless MediaWiki)    — 90M+ educational /
//                                                  encyclopedic photos
//   5. Picsum      (keyless)                    — deterministic placeholders
//                                                  (NOT real photos; clearly
//                                                  labelled as such)
// Each returned image includes a direct download URL, dimensions, alt
// text, photographer credit, a source page to link back to, and a
// license string so the agent can attribute correctly.

import type { ToolDefinition } from "../get-current-time.js";

type Orientation = "landscape" | "portrait" | "square" | "any";

interface StockImage {
    url: string; // full-size download URL
    thumb_url?: string; // small preview URL
    width?: number;
    height?: number;
    alt?: string;
    photographer?: string;
    photographer_url?: string;
    source: "unsplash" | "pexels" | "openverse" | "wikimedia" | "picsum";
    source_url?: string; // page to credit
    license: string; // short license name
}

// ── Unsplash ────────────────────────────────

async function searchUnsplash(query: string, orientation: Orientation, count: number): Promise<StockImage[]> {
    const key = process.env.UNSPLASH_ACCESS_KEY;
    if (!key) return [];
    const o = orientation === "any" ? "" : orientation === "square" ? "squarish" : orientation;
    const url = new URL("https://api.unsplash.com/search/photos");
    url.searchParams.set("query", query);
    url.searchParams.set("per_page", String(Math.min(count, 20)));
    if (o) url.searchParams.set("orientation", o);

    const res = await fetch(url.toString(), {
        headers: { Authorization: `Client-ID ${key}` },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
    const results = data.results || [];
    return results
        .slice(0, count)
        .map((r) => {
            const urls = r.urls as Record<string, string> | undefined;
            const user = r.user as Record<string, unknown> | undefined;
            const links = user?.links as Record<string, string> | undefined;
            return {
                url: urls?.regular || urls?.full || "",
                thumb_url: urls?.small || urls?.thumb,
                width: typeof r.width === "number" ? r.width : undefined,
                height: typeof r.height === "number" ? r.height : undefined,
                alt: (r.alt_description as string) || (r.description as string) || query,
                photographer: user?.name as string | undefined,
                photographer_url: links?.html,
                source: "unsplash" as const,
                source_url: (r.links as Record<string, string> | undefined)?.html,
                license: "Unsplash License (free, attribution appreciated)",
            };
        })
        .filter((i) => i.url);
}

// ── Pexels ──────────────────────────────────

async function searchPexels(query: string, orientation: Orientation, count: number): Promise<StockImage[]> {
    const key = process.env.PEXELS_API_KEY;
    if (!key) return [];
    const url = new URL("https://api.pexels.com/v1/search");
    url.searchParams.set("query", query);
    url.searchParams.set("per_page", String(Math.min(count, 20)));
    if (orientation !== "any") {
        url.searchParams.set("orientation", orientation === "square" ? "square" : orientation);
    }

    const res = await fetch(url.toString(), { headers: { Authorization: key } });
    if (!res.ok) return [];
    const data = (await res.json()) as { photos?: Array<Record<string, unknown>> };
    const photos = data.photos || [];
    return photos
        .slice(0, count)
        .map((p) => {
            const src = p.src as Record<string, string> | undefined;
            return {
                url: src?.large2x || src?.large || src?.original || "",
                thumb_url: src?.medium || src?.small,
                width: typeof p.width === "number" ? p.width : undefined,
                height: typeof p.height === "number" ? p.height : undefined,
                alt: (p.alt as string) || query,
                photographer: p.photographer as string | undefined,
                photographer_url: p.photographer_url as string | undefined,
                source: "pexels" as const,
                source_url: p.url as string | undefined,
                license: "Pexels License (free, attribution appreciated)",
            };
        })
        .filter((i) => i.url);
}

// ── Openverse (keyless, aggregates 800M+ CC-licensed images) ─

async function searchOpenverse(query: string, orientation: Orientation, count: number): Promise<StockImage[]> {
    const url = new URL("https://api.openverse.org/v1/images/");
    url.searchParams.set("q", query);
    url.searchParams.set("page_size", String(Math.min(count, 20)));
    url.searchParams.set("license_type", "commercial,modification");
    if (orientation !== "any") {
        url.searchParams.set(
            "aspect_ratio",
            orientation === "square" ? "square" : orientation === "portrait" ? "tall" : "wide",
        );
    }

    const res = await fetch(url.toString(), {
        headers: { "User-Agent": "Bhai/1.0 web-designer (+openverse client)" },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
    const results = data.results || [];
    return results
        .slice(0, count)
        .map((r) => {
            const licenseName = typeof r.license === "string" ? r.license.toUpperCase() : "CC";
            const licenseVersion = typeof r.license_version === "string" ? ` ${r.license_version}` : "";
            return {
                url: (r.url as string) || "",
                thumb_url: (r.thumbnail as string) || undefined,
                width: typeof r.width === "number" ? r.width : undefined,
                height: typeof r.height === "number" ? r.height : undefined,
                alt: (r.title as string) || query,
                photographer: (r.creator as string) || undefined,
                photographer_url: (r.creator_url as string) || undefined,
                source: "openverse" as const,
                source_url: (r.foreign_landing_url as string) || (r.url as string),
                license: `${licenseName}${licenseVersion} (via Openverse; confirm ${r.source ?? "origin"} terms)`,
            };
        })
        .filter((i) => i.url);
}

// ── Wikimedia Commons (keyless MediaWiki API) ─

async function searchWikimedia(query: string, count: number): Promise<StockImage[]> {
    const url = new URL("https://commons.wikimedia.org/w/api.php");
    url.searchParams.set("action", "query");
    url.searchParams.set("format", "json");
    url.searchParams.set("origin", "*");
    url.searchParams.set("generator", "search");
    url.searchParams.set("gsrnamespace", "6"); // File: namespace
    url.searchParams.set("gsrlimit", String(Math.min(count, 20)));
    url.searchParams.set("gsrsearch", `${query} filemime:image/jpeg|image/png|image/webp`);
    url.searchParams.set("prop", "imageinfo");
    url.searchParams.set("iiprop", "url|size|mime|extmetadata");
    url.searchParams.set("iiurlwidth", "1600");

    const res = await fetch(url.toString(), {
        headers: { "User-Agent": "Bhai/1.0 web-designer (commons@atlas)" },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { query?: { pages?: Record<string, Record<string, unknown>> } };
    const pages = Object.values(data.query?.pages || {});

    const out: StockImage[] = [];
    for (const p of pages) {
        const imageInfo = (p.imageinfo as Array<Record<string, unknown>> | undefined)?.[0];
        if (!imageInfo) continue;
        const fullUrl = (imageInfo.thumburl as string) || (imageInfo.url as string);
        if (!fullUrl) continue;
        const meta = imageInfo.extmetadata as Record<string, { value?: string }> | undefined;
        const license = meta?.License?.value || meta?.LicenseShortName?.value || "See Wikimedia terms";
        const artist = meta?.Artist?.value || undefined;
        // Artist field frequently contains HTML — keep only the text between tags. Splitting on
        // "<" means no "<" survives, so a nested "<scr<b>ipt>" cannot reassemble into a tag in a page credit
        const artistClean =
            typeof artist === "string"
                ? artist
                      .split("<")
                      .map((part, i) => (i === 0 ? part : part.slice(part.indexOf(">") + 1)))
                      .join("")
                      .replace(/>/g, "")
                      .slice(0, 120)
                : undefined;
        out.push({
            url: fullUrl,
            thumb_url: (imageInfo.thumburl as string) || undefined,
            width:
                typeof imageInfo.thumbwidth === "number"
                    ? (imageInfo.thumbwidth as number)
                    : typeof imageInfo.width === "number"
                      ? (imageInfo.width as number)
                      : undefined,
            height:
                typeof imageInfo.thumbheight === "number"
                    ? (imageInfo.thumbheight as number)
                    : typeof imageInfo.height === "number"
                      ? (imageInfo.height as number)
                      : undefined,
            alt: (p.title as string) || query,
            photographer: artistClean,
            source: "wikimedia" as const,
            source_url: (imageInfo.descriptionurl as string) || undefined,
            license: `${license} (Wikimedia Commons)`,
        });
        if (out.length >= count) break;
    }
    return out;
}

// ── Picsum (fallback placeholders) ──────────

function picsumPlaceholders(query: string, orientation: Orientation, count: number): StockImage[] {
    const out: StockImage[] = [];
    const dims = orientation === "portrait" ? [800, 1200] : orientation === "square" ? [1000, 1000] : [1600, 900]; // landscape / any default
    // Use seeded picsum so results are deterministic per-query
    const base = "https://picsum.photos/seed";
    for (let i = 0; i < count; i++) {
        const seed = `${encodeURIComponent(query.slice(0, 40))}-${i}`;
        out.push({
            url: `${base}/${seed}/${dims[0]}/${dims[1]}`,
            thumb_url: `${base}/${seed}/400/${Math.round((dims[1] * 400) / dims[0])}`,
            width: dims[0],
            height: dims[1],
            alt: `Placeholder for "${query}" (${i + 1})`,
            source: "picsum" as const,
            source_url: "https://picsum.photos",
            license:
                "Placeholder — NOT a real photo. Replace before shipping. Set UNSPLASH_ACCESS_KEY or PEXELS_API_KEY for real results.",
        });
    }
    return out;
}

// ── Tool ─────────────────────────────────────

export const stockImageSearch: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "stock_image_search",
            description:
                "Search free stock photography for a website. Provider chain: Unsplash (UNSPLASH_ACCESS_KEY) → Pexels (PEXELS_API_KEY) → Openverse (keyless, 800M+ CC-licensed images aggregated from Wikimedia/Flickr/Nappy/Rawpixel/etc.) → Wikimedia Commons (keyless, 90M+ photos) → Picsum placeholders. Works without any API keys — Openverse + Wikimedia cover the no-key case with real photos. Returns direct download URLs plus attribution/license. Pair with web_asset_download to save locally and credit the photographer in your UI/README.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description:
                            "Search terms, e.g. 'mountain sunrise', 'product-launch keynote', 'team collaboration'.",
                    },
                    orientation: {
                        type: "string",
                        enum: ["landscape", "portrait", "square", "any"],
                        description: "Aspect ratio preference. Default 'landscape' (common for hero sections).",
                    },
                    count: {
                        type: "number",
                        description: "How many results to return (default 5, max 20).",
                    },
                    provider: {
                        type: "string",
                        enum: ["auto", "unsplash", "pexels", "openverse", "wikimedia", "picsum"],
                        description:
                            "Force a specific provider. Default 'auto' tries: Unsplash (if keyed) → Pexels (if keyed) → Openverse → Wikimedia → Picsum placeholders.",
                    },
                },
                required: ["query"],
            },
        },
    },

    async handler(input) {
        const query = (input.query as string) || "";
        if (!query.trim()) return JSON.stringify({ error: "query is required" });

        const orientation = ((input.orientation as string) || "landscape") as Orientation;
        const count = Math.max(1, Math.min(20, Number(input.count) || 5));
        const provider = ((input.provider as string) || "auto").toLowerCase();

        let results: StockImage[] = [];
        const errors: string[] = [];
        const tried: string[] = [];

        // Ordered fallback chain for "auto". Forcing a provider short-
        // circuits to just that provider.
        const chain: Array<() => Promise<StockImage[]>> = [];
        if (provider === "auto" || provider === "unsplash") {
            chain.push(async () => {
                tried.push("unsplash");
                return searchUnsplash(query, orientation, count);
            });
        }
        if (provider === "auto" || provider === "pexels") {
            chain.push(async () => {
                tried.push("pexels");
                return searchPexels(query, orientation, count);
            });
        }
        if (provider === "auto" || provider === "openverse") {
            chain.push(async () => {
                tried.push("openverse");
                return searchOpenverse(query, orientation, count);
            });
        }
        if (provider === "auto" || provider === "wikimedia") {
            chain.push(async () => {
                tried.push("wikimedia");
                return searchWikimedia(query, count);
            });
        }
        if (provider === "picsum") {
            chain.push(async () => {
                tried.push("picsum");
                return picsumPlaceholders(query, orientation, count);
            });
        }

        for (const step of chain) {
            try {
                const got = await step();
                if (got.length > 0) {
                    results = got;
                    break;
                }
            } catch (err) {
                errors.push(`${tried[tried.length - 1]}: ${(err as Error).message}`);
            }
        }

        // Last-resort fallback to Picsum placeholders (only on auto)
        if (results.length === 0 && provider === "auto") {
            tried.push("picsum-fallback");
            results = picsumPlaceholders(query, orientation, count);
        }

        const hasRealKeys = !!process.env.UNSPLASH_ACCESS_KEY || !!process.env.PEXELS_API_KEY;
        const usedKeyless = results.some((r) => r.source === "openverse" || r.source === "wikimedia");
        const usedPlaceholder = results.some((r) => r.source === "picsum");
        return JSON.stringify({
            success: true,
            query,
            count: results.length,
            providers_tried: tried,
            results,
            notes: usedPlaceholder
                ? "Only placeholder (Picsum) results available — all real-photo providers returned nothing for this query. Try a broader search term."
                : !hasRealKeys && usedKeyless
                  ? "Using keyless providers (Openverse / Wikimedia Commons). Results are real CC-licensed photos — attribute the photographer and check the license before shipping. For curated/commercial-grade photography set UNSPLASH_ACCESS_KEY or PEXELS_API_KEY."
                  : undefined,
            errors: errors.length > 0 ? errors : undefined,
        });
    },
};
