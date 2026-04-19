// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── codebase_index Tool ────────────────────────
// Build / refresh / stats / wipe the per-repo codebase index.
// Kill-switch: ATLAS_NO_CODEBASE_INDEX=true disables build/refresh
// (stats/wipe still work so the user can inspect/clean up).

import { buildIndex, getIndexStats, refreshIndex, wipeIndex } from "../../memory/codebase-index.js";
import { auditLog } from "../../security/audit-log.js";
import type { ToolDefinition } from "../get-current-time.js";

function isDisabled(): boolean {
    return (process.env.ATLAS_NO_CODEBASE_INDEX ?? "").toLowerCase() === "true";
}

export const codebaseIndexTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "codebase_index",
            description: `Build, refresh, inspect, or wipe the persistent per-repo codebase index.

Commands:
- build:   full cold index (parse everything, write to sidecar SQLite)
- refresh: Merkle-based incremental refresh (skip files whose sha256 matches)
- stats:   return current file count, symbol count, depth, last refresh time
- wipe:    delete the sidecar DB for this repo (safe — just deletes index rows)

Depth picker (if not overridden): ≤500 files → calls, ≤5000 → imports, else symbols.
Env overrides: ATLAS_INDEX_DEPTH=symbols|imports|calls forces a tier; ATLAS_NO_CODEBASE_INDEX=true blocks build/refresh.`,
            parameters: {
                type: "object",
                properties: {
                    command: {
                        type: "string",
                        enum: ["build", "refresh", "stats", "wipe"],
                        description: "Which operation to run.",
                    },
                    path: {
                        type: "string",
                        description: "Repo root (or a subdirectory within it). Defaults to cwd.",
                    },
                    depth: {
                        type: "string",
                        enum: ["symbols", "imports", "calls"],
                        description: "Override depth tier. Default: auto.",
                    },
                },
                required: ["command"],
            },
        },
    },

    async handler(input: Record<string, unknown>): Promise<string> {
        const command = String(input.command ?? "").toLowerCase();
        const root = typeof input.path === "string" && input.path ? input.path : process.cwd();
        const depth = typeof input.depth === "string" ? (input.depth as "symbols" | "imports" | "calls") : undefined;

        try {
            if (command === "build") {
                if (isDisabled()) {
                    return JSON.stringify({
                        success: false,
                        error: "codebase_index disabled via ATLAS_NO_CODEBASE_INDEX",
                    });
                }
                const r = await buildIndex(root, depth ? { depth } : {});
                auditLog("codebase_index.build", {
                    root: r.repoRoot,
                    hash: r.repoHash,
                    added: r.added,
                    updated: r.updated,
                });
                return JSON.stringify({ success: true, ...r });
            }
            if (command === "refresh") {
                if (isDisabled()) {
                    return JSON.stringify({
                        success: false,
                        error: "codebase_index disabled via ATLAS_NO_CODEBASE_INDEX",
                    });
                }
                const r = await refreshIndex(root, depth ? { depth } : {});
                auditLog("codebase_index.refresh", {
                    root: r.repoRoot,
                    hash: r.repoHash,
                    updated: r.updated,
                    unchanged: r.unchanged,
                });
                return JSON.stringify({ success: true, ...r });
            }
            if (command === "stats") {
                const s = getIndexStats(root);
                return JSON.stringify({ success: true, ...s });
            }
            if (command === "wipe") {
                wipeIndex(root);
                auditLog("codebase_index.wipe", { root });
                return JSON.stringify({ success: true, wiped: true });
            }
            return JSON.stringify({ success: false, error: `unknown command: ${command}` });
        } catch (err) {
            return JSON.stringify({ success: false, error: `codebase_index failed: ${(err as Error).message}` });
        }
    },
};
