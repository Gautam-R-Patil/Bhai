// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { browseRecentMessages, searchSessionMessages } from "../memory/sqlite.js";
import type { ToolDefinition } from "./get-current-time.js";

// ── session_search ────────────────────────────
// Zero-LLM keyword recall over the agent's own past conversation transcripts.
// Arg-inferred op: a non-empty `query` → BM25 discovery; omitted → recent browse.
// Fail-open: missing index / no data → friendly empty result, never throws.

export const sessionSearch: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "session_search",
            description:
                "Search your own past conversation transcripts by keyword (zero-cost, no LLM). Returns ACTUAL stored messages with a highlighted snippet. Use to recall what was literally said in earlier sessions. Omit 'query' to browse the most recent messages.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Keywords to search transcripts for. Omit to browse recent messages.",
                    },
                    limit: {
                        type: "number",
                        description: "Max results (default 10 for search, 20 for browse, max 50).",
                    },
                },
                required: [],
            },
        },
    },

    async handler(input) {
        const q = ((input.query as string) ?? "").trim();
        const requested = input.limit as number | undefined;
        const limit = Math.min(Math.max(requested || (q ? 10 : 20), 1), 50);

        if (q.length >= 2) {
            const results = searchSessionMessages(q, limit);
            return JSON.stringify(
                {
                    op: "discovery",
                    count: results.length,
                    results,
                    ...(results.length === 0 ? { note: "No matching past messages found." } : {}),
                },
                null,
                2,
            );
        }

        const results = browseRecentMessages(limit);
        return JSON.stringify(
            {
                op: "recent",
                count: results.length,
                results,
                ...(results.length === 0 ? { note: "No conversation history indexed yet." } : {}),
            },
            null,
            2,
        );
    },
};
