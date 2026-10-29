// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── icon_search ──────────────────────────────
// Searches Iconify (https://icon-sets.iconify.design/) — 150k+ free
// icons across 150+ icon sets including Lucide, Heroicons, Phosphor,
// Material, Tabler, Bootstrap, Feather, Remix, etc. Free, no API key.
// Returns icon names, downloadable SVG URLs, and ready-to-paste
// @iconify/react component hints so the agent can drop icons into a
// React/Vue/Svelte project in one step.

import type { ToolDefinition } from "../get-current-time.js";

const ICONIFY_BASE = "https://api.iconify.design";
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 40;

interface IconResult {
    name: string; // full prefix:name, e.g. "lucide:arrow-right"
    set: string; // set identifier (prefix), e.g. "lucide"
    svg_url: string; // direct SVG URL
    react_import: string; // paste-ready hint for @iconify/react
    html_snippet: string; // paste-ready <span class="iconify" …> snippet
    license?: string;
}

// ── Search ──────────────────────────────────

async function searchIconify(query: string, limit: number, prefix?: string): Promise<IconResult[]> {
    const url = new URL(`${ICONIFY_BASE}/search`);
    url.searchParams.set("query", query);
    url.searchParams.set("limit", String(Math.min(limit, MAX_LIMIT)));
    if (prefix) url.searchParams.set("prefix", prefix);

    const res = await fetch(url.toString());
    if (!res.ok) return [];
    const data = (await res.json()) as {
        icons?: string[];
        collections?: Record<string, { name?: string; license?: { title?: string } }>;
    };
    const icons = data.icons || [];
    const collections = data.collections || {};

    return icons.slice(0, limit).map((ref) => {
        const [set, ...rest] = ref.split(":");
        const name = rest.join(":");
        const meta = collections[set] || {};
        return {
            name: ref,
            set,
            svg_url: `${ICONIFY_BASE}/${set}/${name}.svg`,
            react_import: `import { Icon } from "@iconify/react"; <Icon icon="${ref}" />`,
            html_snippet: `<span class="iconify" data-icon="${ref}"></span>`,
            license: meta.license?.title,
        };
    });
}

// ── Tool ─────────────────────────────────────

export const iconSearch: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "icon_search",
            description:
                "Find free icons from Iconify (150k+ icons across Lucide, Heroicons, Phosphor, Tabler, Material, Feather, Bootstrap, etc.). No API key needed. Returns icon names, direct SVG download URLs, and paste-ready @iconify/react imports. Use for UI glyphs, action buttons, navigation, status indicators. Prefer filled/outline sets from a single family for visual consistency.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Search terms, e.g. 'arrow right', 'shopping cart', 'cloud upload', 'settings'.",
                    },
                    set: {
                        type: "string",
                        description:
                            "Restrict to a single icon set by prefix, e.g. 'lucide', 'heroicons', 'phosphor', 'tabler'. Omit for cross-set search.",
                    },
                    limit: {
                        type: "number",
                        description: `Max results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
                    },
                },
                required: ["query"],
            },
        },
    },

    async handler(input) {
        const query = (input.query as string) || "";
        if (!query.trim()) return JSON.stringify({ error: "query is required" });
        const limit = Math.max(1, Math.min(MAX_LIMIT, Number(input.limit) || DEFAULT_LIMIT));
        const prefix = ((input.set as string) || "").trim().toLowerCase() || undefined;

        try {
            const results = await searchIconify(query, limit, prefix);
            return JSON.stringify({
                success: true,
                query,
                set: prefix,
                count: results.length,
                results,
                tip: "To use: `npm i @iconify/react` then paste the `react_import` line. For a no-JS site, the `html_snippet` works with the iconify CDN script.",
            });
        } catch (err) {
            return JSON.stringify({ error: `Iconify search failed: ${(err as Error).message}` });
        }
    },
};
