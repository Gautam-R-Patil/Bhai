// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Legacy file primitives ──────────────────────
// Reading, writing, and filename-based search were moved to the new
// coding tools in `src/tools/coding/` (`read`, `write`, `edit`, `append_file`,
// `grep`, `glob`). This file retains the two primitives that aren't part
// of the coding suite: directory listing and file deletion.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPathBlockedReason, isPathAllowed, isProtectedPath } from "../security/allowlist.js";
import { auditLog } from "../security/audit-log.js";
import { forget as forgetRead } from "./coding/read-registry.js";
import type { ToolDefinition } from "./get-current-time.js";

// ── Constants ─────────────────────────────────

const MAX_LIST = 100;
const HOME_DIR = os.homedir();

// ── Helpers ──────────────────────────────────

function isOutsideHome(filePath: string): boolean {
    const resolved = path.resolve(filePath);
    return !resolved.startsWith(HOME_DIR + path.sep) && resolved !== HOME_DIR;
}

// ── List Directory ────────────────────────────

export const listDirectory: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "list_directory",
            description: "List files and directories at a path.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "Directory path" },
                    recursive: { type: "boolean", description: "List recursively" },
                },
                required: ["path"],
            },
        },
    },
    async handler(input) {
        const dirPath = path.resolve(input.path as string);
        if (!isPathAllowed(dirPath)) {
            const reason = getPathBlockedReason(dirPath) ?? "Path not allowed.";
            return JSON.stringify({ error: reason });
        }
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true }).slice(0, MAX_LIST);
            const items = entries.map((e) => ({
                name: e.name,
                type: e.isDirectory() ? "directory" : "file",
                size: e.isFile() ? fs.statSync(path.join(dirPath, e.name)).size : undefined,
            }));
            return JSON.stringify({ success: true, items, count: items.length });
        } catch (err) {
            return JSON.stringify({ error: (err as Error).message });
        }
    },
};

// ── Delete File ───────────────────────────────

export const deleteFile: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "delete_file",
            description: "Delete a file. Requires confirmation for safety.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "File path to delete" },
                },
                required: ["path"],
            },
        },
    },
    async handler(input) {
        const filePath = path.resolve(input.path as string);
        auditLog("file_delete", { path: filePath });
        if (!isPathAllowed(filePath)) {
            const reason = getPathBlockedReason(filePath) ?? "Path not allowed.";
            return JSON.stringify({ error: reason });
        }
        if (isProtectedPath(filePath)) {
            return JSON.stringify({
                error: `Deleting "${filePath}" is not allowed — this path is part of the bot's own codebase and is write-protected.`,
            });
        }
        try {
            fs.unlinkSync(filePath);
            forgetRead(filePath);

            const warning = isOutsideHome(filePath)
                ? `Note: This file was outside your home directory (${HOME_DIR}). Ensure this was intentional.`
                : undefined;

            return JSON.stringify({ success: true, deleted: filePath, ...(warning ? { warning } : {}) });
        } catch (err) {
            return JSON.stringify({ error: (err as Error).message });
        }
    },
};
