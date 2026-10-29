// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import * as storeClient from "../store/client.js";
import type { StoreItemCategory, StoreItemType } from "../store/types.js";
import type { ToolDefinition } from "./get-current-time.js";

type Op = "search" | "list" | "info" | "featured" | "trending" | "categories" | "installed";

const VALID_TYPES = new Set(["skill", "mcp", "tool"]);

async function dispatch(op: Op, input: Record<string, unknown>): Promise<string> {
    switch (op) {
        case "search": {
            const query = String(input.query ?? "").trim();
            if (!query) return JSON.stringify({ error: "query is required for search" });
            const type = input.type as StoreItemType | undefined;
            if (type && !VALID_TYPES.has(type)) {
                return JSON.stringify({ error: `invalid type: ${type}` });
            }
            const items = await storeClient.searchItems(query, {
                type,
                category: input.category as StoreItemCategory | undefined,
                limit: typeof input.limit === "number" ? input.limit : 20,
            });
            return JSON.stringify({ op, count: items.length, items });
        }
        case "list": {
            const type = input.type as StoreItemType | undefined;
            if (type && !VALID_TYPES.has(type)) {
                return JSON.stringify({ error: `invalid type: ${type}` });
            }
            const items = await storeClient.listItems({
                type,
                category: input.category as StoreItemCategory | undefined,
                featured: typeof input.featured === "boolean" ? input.featured : undefined,
                limit: typeof input.limit === "number" ? input.limit : 20,
            });
            return JSON.stringify({ op, count: items.length, items });
        }
        case "info": {
            const slug = String(input.slug ?? "").trim();
            if (!slug) return JSON.stringify({ error: "slug is required for info" });
            const item = await storeClient.getItemBySlug(slug);
            if (!item) return JSON.stringify({ error: "not_found", slug });
            return JSON.stringify({ op, item });
        }
        case "featured": {
            const limit = typeof input.limit === "number" ? input.limit : 10;
            const items = await storeClient.getFeaturedItems(limit);
            return JSON.stringify({ op, count: items.length, items });
        }
        case "trending": {
            const limit = typeof input.limit === "number" ? input.limit : 10;
            const items = await storeClient.getTrendingItems(limit);
            return JSON.stringify({ op, count: items.length, items });
        }
        case "categories": {
            const cats = await storeClient.getCategories();
            return JSON.stringify({ op, categories: cats });
        }
        case "installed": {
            const installs = await storeClient.getUserInstalls();
            return JSON.stringify({ op, count: installs.length, installs });
        }
    }
}

export const storeBrowse: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "store_browse",
            description:
                "Read-only view of the Bhai marketplace: search items, list by type/category, look up a single item by slug, pull featured/trending lists, enumerate categories, or show the user's currently-installed items. Does NOT install or uninstall — users do that from the desktop UI.",
            parameters: {
                type: "object",
                properties: {
                    op: {
                        type: "string",
                        enum: ["search", "list", "info", "featured", "trending", "categories", "installed"],
                        description:
                            "Which read operation to run. search needs query. info needs slug. featured/trending/categories/installed take no args other than optional limit.",
                    },
                    query: { type: "string", description: "Search query (required for op=search)." },
                    slug: { type: "string", description: "Item slug (required for op=info)." },
                    type: {
                        type: "string",
                        enum: ["skill", "mcp", "tool"],
                        description: "Optional type filter.",
                    },
                    category: { type: "string", description: "Optional category filter." },
                    featured: { type: "boolean", description: "Filter for featured items when op=list." },
                    limit: { type: "number", description: "Max results (default 10–20 depending on op)." },
                },
                required: ["op"],
            },
        },
    },

    async handler(input) {
        const op = input.op as Op;
        if (
            op !== "search" &&
            op !== "list" &&
            op !== "info" &&
            op !== "featured" &&
            op !== "trending" &&
            op !== "categories" &&
            op !== "installed"
        ) {
            return JSON.stringify({ error: `invalid op: ${String(op)}` });
        }
        try {
            return await dispatch(op, input);
        } catch (err) {
            return JSON.stringify({ error: (err as Error).message, op });
        }
    },
};
