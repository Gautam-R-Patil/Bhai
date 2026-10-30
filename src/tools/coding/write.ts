// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── write ─────────────────────────────────────
// Claude Code–style full-file writer. Unlike `edit` (point mutation),
// `write` replaces the entire file content.
//   • Creating a new file is always allowed.
//   • Overwriting an existing file requires a prior `read` so the model
//     has seen the current state. Prevents accidental clobbering.
//   • No append mode — use the dedicated `append_file` tool for that.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkWritePathInApprovalMode, checkWritePathInSpecMode } from "../../agents/plan-mode.js";
import { getPathBlockedReason, isPathAllowed, isProtectedPath } from "../../security/allowlist.js";
import { auditLog } from "../../security/audit-log.js";
import { logToolAction } from "../../utils/debug-log.js";
import type { ToolDefinition } from "../get-current-time.js";
import { hashContent, hasRegistryEntry, recordRead, wasRead } from "./read-registry.js";

const HOME_DIR = os.homedir();

function isOutsideHome(filePath: string): boolean {
    const resolved = path.resolve(filePath);
    return !resolved.startsWith(HOME_DIR + path.sep) && resolved !== HOME_DIR;
}

export const write: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "write",
            description:
                "Write content to a file (creating it if necessary, or fully overwriting an existing one). " +
                "For overwrites, you MUST `read` the file first so you know what you're replacing. " +
                "Prefer `edit` for targeted changes; use `write` for new files or full rewrites.",
            parameters: {
                type: "object",
                properties: {
                    file_path: { type: "string", description: "Absolute or relative file path." },
                    content: { type: "string", description: "Full content to write." },
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
        auditLog("file_write", { path: filePath });

        // Text written into a binary format is a broken file: gpt-4.1-nano "made a PDF" by
        // writing a sentence to photo.pdf.
        const binary = /\.(pdf|png|jpe?g|heic|gif|tiff?|webp|bmp|zip|docx|xlsx|pptx|mp3|mp4|mov)$/i.exec(filePath);
        if (binary)
            return JSON.stringify({
                error: `write makes text files; ${path.basename(filePath)} isn't one. For a PDF use pdf_edit or image_edit (format "pdf"), for images image_edit, for a zip compress_files.`,
            });

        if (!isPathAllowed(filePath)) {
            const reason = getPathBlockedReason(filePath) ?? `Path "${filePath}" is not allowed.`;
            return JSON.stringify({ error: reason });
        }
        if (isProtectedPath(filePath)) {
            return JSON.stringify({
                error: `Writing to "${filePath}" is not allowed — this path is part of the bot's own codebase and is write-protected.`,
            });
        }
        const approvalGate = checkWritePathInApprovalMode(filePath);
        if (!approvalGate.allowed) {
            return JSON.stringify({ error: approvalGate.reason });
        }
        const specGate = checkWritePathInSpecMode(filePath);
        if (!specGate.allowed) {
            return JSON.stringify({ error: specGate.reason });
        }

        const fileExists = existsSync(filePath);
        if (fileExists && !wasRead(filePath)) {
            const reason = hasRegistryEntry(filePath)
                ? "File has changed on disk since the last read. Call `read` again before overwriting."
                : "You must call `read` on this file before overwriting it. If you want to replace the whole file, read it first; if you want a small change, use `edit`.";
            return JSON.stringify({ error: reason });
        }

        try {
            const dir = path.dirname(filePath);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            writeFileSync(filePath, content, "utf-8");
        } catch (err) {
            return JSON.stringify({ error: (err as Error).message });
        }

        recordRead(filePath, hashContent(content));

        const lineCount = content.split("\n").length;
        logToolAction({
            tool: "write",
            filePath,
            action: `${fileExists ? "overwrote" : "created"} file (${content.length} bytes, ${lineCount} lines)`,
        });

        const warning = isOutsideHome(filePath)
            ? `Note: This file is outside your home directory (${HOME_DIR}). Ensure this was intentional.`
            : undefined;

        return JSON.stringify({
            success: true,
            path: filePath,
            created: !fileExists,
            bytes: Buffer.byteLength(content, "utf-8"),
            ...(warning ? { warning } : {}),
        });
    },
};
