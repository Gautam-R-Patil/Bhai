// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── read ──────────────────────────────────────
// Claude Code–style file reader: `cat -n` output, offset/limit pagination,
// PDF + Jupyter notebook support, and ReadRegistry integration so later
// `edit`/`write` calls know the file has been seen.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { getPathBlockedReason, isPathAllowed } from "../../security/allowlist.js";
import { auditLog } from "../../security/audit-log.js";
import type { ToolDefinition } from "../get-current-time.js";
import { hashContent, recordRead } from "./read-registry.js";

// ── Constants ─────────────────────────────────

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const DEFAULT_LINE_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000; // Truncate individual lines that exceed this

// ── Helpers ───────────────────────────────────

/** Format plain text with `cat -n`-style line numbers (right-aligned, tab-separated). */
function formatWithLineNumbers(content: string, startLine = 1): string {
    const lines = content.split("\n");
    return lines
        .map((line, i) => {
            const truncated =
                line.length > MAX_LINE_LENGTH
                    ? line.slice(0, MAX_LINE_LENGTH) + ` … [line truncated at ${MAX_LINE_LENGTH} chars]`
                    : line;
            return `${String(startLine + i).padStart(6, " ")}\t${truncated}`;
        })
        .join("\n");
}

/** Detect binary files by looking for NUL bytes in the first 8KB. */
function looksBinary(buf: Buffer): boolean {
    const sample = buf.subarray(0, Math.min(buf.length, 8192));
    for (let i = 0; i < sample.length; i++) {
        if (sample[i] === 0) return true;
    }
    return false;
}

/** Parse a Jupyter notebook to a reviewable text form. */
function renderNotebook(raw: string): string {
    try {
        const nb = JSON.parse(raw);
        const cells: unknown[] = Array.isArray(nb.cells) ? nb.cells : [];
        const out: string[] = [];
        cells.forEach((rawCell, idx) => {
            const cell = rawCell as { cell_type?: string; source?: string | string[] };
            const type = cell.cell_type || "unknown";
            const src = Array.isArray(cell.source) ? cell.source.join("") : cell.source || "";
            out.push(`=== cell ${idx} [${type}] ===`);
            out.push(src);
            out.push("");
        });
        return out.join("\n");
    } catch (err) {
        return `(Failed to parse notebook: ${(err as Error).message})`;
    }
}

// ── Tool ──────────────────────────────────────

export const read: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "read",
            description:
                "Read a file and return its contents with line numbers in `cat -n` format (right-aligned line number + tab + content). " +
                "Supports plain text, PDFs (text-extracted), and Jupyter notebooks (.ipynb — rendered per cell). " +
                "Use `offset` and `limit` to read a specific line range; default reads up to 2000 lines. " +
                "You MUST use this tool before calling `edit` or `write` on an existing file.",
            parameters: {
                type: "object",
                properties: {
                    file_path: {
                        type: "string",
                        description: "Absolute or relative file path.",
                    },
                    offset: {
                        type: "number",
                        description: "1-based line number to start reading from. Optional.",
                    },
                    limit: {
                        type: "number",
                        description: `Maximum number of lines to read (default ${DEFAULT_LINE_LIMIT}).`,
                    },
                    pages: {
                        type: "string",
                        description: 'Page range for PDFs, e.g. "1-5" or "3". Only applies to PDFs.',
                    },
                },
                required: ["file_path"],
            },
        },
    },
    async handler(input) {
        const rawPath = input.file_path as string;
        if (!rawPath) {
            return JSON.stringify({ error: "file_path is required" });
        }
        const filePath = path.resolve(rawPath);
        auditLog("file_read", { path: filePath });

        if (!isPathAllowed(filePath)) {
            const reason = getPathBlockedReason(filePath) ?? `Path "${filePath}" is not allowed.`;
            return JSON.stringify({ error: reason });
        }

        let stats;
        try {
            stats = statSync(filePath);
        } catch (err) {
            return JSON.stringify({ error: `File not found: ${filePath} (${(err as Error).message})` });
        }
        if (!stats.isFile()) {
            return JSON.stringify({ error: `Not a file: ${filePath}` });
        }
        if (stats.size > MAX_FILE_SIZE) {
            return JSON.stringify({
                error: `File too large (${stats.size} bytes, max ${MAX_FILE_SIZE}). Read a smaller range with offset/limit.`,
            });
        }

        let buf: Buffer;
        try {
            buf = readFileSync(filePath);
        } catch (err) {
            return JSON.stringify({ error: (err as Error).message });
        }

        const lowerName = filePath.toLowerCase();

        // ── PDF branch ───────────────────────────
        if (lowerName.endsWith(".pdf")) {
            try {
                const { createRequire } = await import("node:module");
                const require = createRequire(import.meta.url);
                const pdfParse = require("pdf-parse");
                const opts: Record<string, unknown> = {};
                if (input.pages) {
                    const [startS, endS] = String(input.pages).split("-");
                    const start = parseInt(startS, 10);
                    const end = endS ? parseInt(endS, 10) : start;
                    if (Number.isFinite(start) && Number.isFinite(end)) {
                        opts.max = end;
                    }
                }
                const data = await pdfParse(buf, opts);
                const text = data.text || "";
                const numbered = formatWithLineNumbers(text);
                recordRead(filePath, hashContent(buf));
                return JSON.stringify({
                    success: true,
                    path: filePath,
                    content: numbered,
                    size: stats.size,
                    format: "pdf",
                });
            } catch (err) {
                return JSON.stringify({ error: `PDF parse failed: ${(err as Error).message}` });
            }
        }

        // ── Jupyter branch ───────────────────────
        if (lowerName.endsWith(".ipynb")) {
            const rendered = renderNotebook(buf.toString("utf-8"));
            const numbered = formatWithLineNumbers(rendered);
            recordRead(filePath, hashContent(buf));
            return JSON.stringify({
                success: true,
                path: filePath,
                content: numbered,
                size: stats.size,
                format: "notebook",
            });
        }

        // ── Binary refusal ───────────────────────
        if (looksBinary(buf)) {
            return JSON.stringify({
                error: `Binary file not supported: ${filePath}. Use a specialized tool or shell command to inspect binary content.`,
            });
        }

        // ── Text branch ──────────────────────────
        const text = buf.toString("utf-8");
        const allLines = text.split("\n");
        const totalLines = allLines.length;

        const offset1 = Math.max(1, Math.floor(Number(input.offset) || 1));
        const limit = Math.max(1, Math.floor(Number(input.limit) || DEFAULT_LINE_LIMIT));
        const startIdx = offset1 - 1; // 0-based
        const endIdx = Math.min(allLines.length, startIdx + limit);
        const slice = allLines.slice(startIdx, endIdx).join("\n");
        const numbered = formatWithLineNumbers(slice, offset1);

        recordRead(filePath, hashContent(buf));

        const truncated = endIdx < totalLines;
        return JSON.stringify({
            success: true,
            path: filePath,
            content: numbered,
            size: stats.size,
            line_range: { start: offset1, end: Math.min(totalLines, startIdx + limit) },
            total_lines: totalLines,
            truncated,
            format: "text",
        });
    },
};
