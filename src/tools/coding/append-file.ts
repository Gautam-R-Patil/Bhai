// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── append_file ───────────────────────────────
// Appends content to the end of a file. This is the narrow-scope replacement
// for the old `write_file` tool's `append=true` mode. Kept separate from
// `write` so the primary write path stays strict (read-before-overwrite).

import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { getPathBlockedReason, isPathAllowed, isProtectedPath } from "../../security/allowlist.js";
import { auditLog } from "../../security/audit-log.js";
import type { ToolDefinition } from "../get-current-time.js";
import { forget } from "./read-registry.js";

export const appendFile: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "append_file",
            description:
                "Append content to the end of a file. Creates the file if it doesn't exist. " +
                "Use this for log files, CSV accumulation, or any additive write. " +
                "For targeted edits inside an existing file, use `edit` instead.",
            parameters: {
                type: "object",
                properties: {
                    file_path: { type: "string", description: "Absolute or relative file path." },
                    content: { type: "string", description: "Content to append." },
                },
                required: ["file_path", "content"],
            },
        },
    },

    async handler(input) {
        const rawPath = input.file_path as string;
        const content = (input.content as string) ?? "";

        if (!rawPath) {
            return JSON.stringify({ error: "file_path is required" });
        }

        const filePath = path.resolve(rawPath);
        auditLog("file_append", { path: filePath });

        if (!isPathAllowed(filePath)) {
            const reason = getPathBlockedReason(filePath) ?? `Path "${filePath}" is not allowed.`;
            return JSON.stringify({ error: reason });
        }
        if (isProtectedPath(filePath)) {
            return JSON.stringify({
                error: `Appending to "${filePath}" is not allowed — this path is part of the bot's own codebase and is write-protected.`,
            });
        }

        try {
            const dir = path.dirname(filePath);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            appendFileSync(filePath, content, "utf-8");
        } catch (err) {
            return JSON.stringify({ error: (err as Error).message });
        }

        // The file has changed; forget any stale read-registry entry so
        // a subsequent `edit`/`write` requires a fresh read.
        forget(filePath);

        let size = 0;
        try {
            size = statSync(filePath).size;
        } catch {
            /* ignore */
        }

        return JSON.stringify({
            success: true,
            path: filePath,
            appended_bytes: Buffer.byteLength(content, "utf-8"),
            total_size: size,
        });
    },
};
