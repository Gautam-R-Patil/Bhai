// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── codebase_index Tool ────────────────────────
// Build / refresh / stats / wipe the per-repo codebase index.
// Kill-switch: BHAI_NO_CODEBASE_INDEX=true disables build/refresh
// (stats/wipe still work so the user can inspect/clean up).

import { buildIndex, getIndexStats, refreshIndex, wipeIndex } from "../../memory/codebase-index.js";
import { auditLog } from "../../security/audit-log.js";
import type { ToolDefinition } from "../get-current-time.js";

function isDisabled(): boolean {
    return (process.env.BHAI_NO_CODEBASE_INDEX ?? "").toLowerCase() === "true";
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
Env overrides: BHAI_INDEX_DEPTH=symbols|imports|calls forces a tier; BHAI_NO_CODEBASE_INDEX=true blocks build/refresh.`,
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
        const rawDepth = typeof input.depth === "string" ? input.depth : undefined;
        const depth: "symbols" | "imports" | "calls" | undefined =
            rawDepth === "symbols" || rawDepth === "imports" || rawDepth === "calls" ? rawDepth : undefined;

        try {
            if (command === "build") {
                if (isDisabled()) {
                    return JSON.stringify({
                        success: false,
                        error: "codebase_index disabled via BHAI_NO_CODEBASE_INDEX",
                    });
                }
                const r = await buildIndex(root, depth ? { depth } : {});
                auditLog("codebase_index.build", {
                    root: r.repoRoot,
                    hash: r.repoHash,
                    depth: r.depth,
                    depthAuto: r.depthAuto,
                    added: r.added,
                    updated: r.updated,
                    unchanged: r.unchanged,
                    deleted: r.deleted,
                    fileCount: r.fileCount,
                    symbolCount: r.symbolCount,
                    errorCount: r.errors.length,
                    elapsedMs: r.elapsedMs,
                });
                return JSON.stringify({ success: true, ...r });
            }
            if (command === "refresh") {
                if (isDisabled()) {
                    return JSON.stringify({
                        success: false,
                        error: "codebase_index disabled via BHAI_NO_CODEBASE_INDEX",
                    });
                }
                const r = await refreshIndex(root, depth ? { depth } : {});
                auditLog("codebase_index.refresh", {
                    root: r.repoRoot,
                    hash: r.repoHash,
                    depth: r.depth,
                    depthAuto: r.depthAuto,
                    added: r.added,
                    updated: r.updated,
                    unchanged: r.unchanged,
                    deleted: r.deleted,
                    fileCount: r.fileCount,
                    symbolCount: r.symbolCount,
                    errorCount: r.errors.length,
                    elapsedMs: r.elapsedMs,
                });
                return JSON.stringify({ success: true, ...r });
            }
            if (command === "stats") {
                const s = getIndexStats(root);
                return JSON.stringify({ success: true, ...s });
            }
            if (command === "wipe") {
                // Snapshot stats before wiping so the audit log records what was actually deleted.
                const preWipeStats = getIndexStats(root);
                wipeIndex(root);
                auditLog("codebase_index.wipe", {
                    root,
                    hash: preWipeStats.repoHash,
                    existed: preWipeStats.exists,
                    sidecarBytes: preWipeStats.sidecarBytes,
                    fileCount: preWipeStats.fileCount,
                    symbolCount: preWipeStats.symbolCount,
                });
                return JSON.stringify({ success: true, wiped: true, ...preWipeStats });
            }
            return JSON.stringify({ success: false, error: `unknown command: ${command}` });
        } catch (err) {
            return JSON.stringify({ success: false, error: `codebase_index failed: ${(err as Error).message}` });
        }
    },
};
