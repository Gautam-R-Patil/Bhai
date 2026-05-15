// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── notebook_edit ─────────────────────────────
// Claude-Code-style Jupyter notebook (.ipynb) cell editor. Three modes:
//   • replace — overwrite an existing cell's source
//   • insert  — insert a new cell after the target index (or at head if
//               cell_number is omitted)
//   • delete  — remove the target cell entirely
//
// Parses the notebook JSON, mutates in memory, writes back. Outputs and
// metadata of non-mutated cells are preserved verbatim.
//
// Read-before-Edit is enforced via the shared ReadRegistry — call `read`
// on the .ipynb first so you've seen the current structure.

import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getPathBlockedReason, isPathAllowed, isProtectedPath } from "../../security/allowlist.js";
import { auditLog } from "../../security/audit-log.js";
import type { ToolDefinition } from "../get-current-time.js";
import { hashContent, hasRegistryEntry, recordRead, wasRead } from "./read-registry.js";

// ── Types ─────────────────────────────────────

type CellType = "code" | "markdown" | "raw";
type EditMode = "replace" | "insert" | "delete";

interface NotebookCell {
    cell_type: CellType;
    source: string | string[];
    metadata?: Record<string, unknown>;
    outputs?: unknown[];
    execution_count?: number | null;
    id?: string;
    [key: string]: unknown;
}

interface Notebook {
    cells: NotebookCell[];
    metadata?: Record<string, unknown>;
    nbformat?: number;
    nbformat_minor?: number;
    [key: string]: unknown;
}

// ── Helpers ───────────────────────────────────

function makeCell(type: CellType, source: string): NotebookCell {
    const cell: NotebookCell = {
        cell_type: type,
        source,
        metadata: {},
    };
    if (type === "code") {
        cell.outputs = [];
        cell.execution_count = null;
    }
    return cell;
}

function findCellIndex(nb: Notebook, input: Record<string, unknown>): number {
    const byNumber = input.cell_number;
    if (typeof byNumber === "number" && Number.isFinite(byNumber)) {
        return Math.floor(byNumber);
    }
    const byId = input.cell_id;
    if (typeof byId === "string" && byId.length > 0) {
        return nb.cells.findIndex((c) => c.id === byId);
    }
    return -1;
}

// ── Tool ──────────────────────────────────────

export const notebookEdit: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "notebook_edit",
            description:
                "Edit a cell of a Jupyter notebook (.ipynb). Use `edit_mode`: " +
                "'replace' overwrites the cell at `cell_number`; 'insert' adds a new cell after " +
                "`cell_number` (or at the head if omitted); 'delete' removes the cell at " +
                "`cell_number`. For replace/insert, `new_source` is the cell source. For insert, " +
                "optionally pass `cell_type` ('code' or 'markdown' — default 'code'). " +
                "You MUST `read` the notebook first (read-before-edit is enforced).",
            parameters: {
                type: "object",
                properties: {
                    notebook_path: { type: "string", description: "Path to the .ipynb file." },
                    cell_number: {
                        type: "number",
                        description: "0-based cell index. For 'insert' without this, inserts at the beginning.",
                    },
                    cell_id: {
                        type: "string",
                        description: "Alternative cell addressing by id (from an earlier `read` of the notebook).",
                    },
                    new_source: {
                        type: "string",
                        description: "New cell content. Required for 'replace' and 'insert'.",
                    },
                    edit_mode: {
                        type: "string",
                        enum: ["replace", "insert", "delete"],
                        description: "What to do: replace / insert / delete.",
                    },
                    cell_type: {
                        type: "string",
                        enum: ["code", "markdown"],
                        description: "Cell type for 'insert'. Defaults to 'code'.",
                    },
                },
                required: ["notebook_path", "edit_mode"],
            },
        },
    },

    async handler(input) {
        const rawPath = input.notebook_path as string;
        const mode = (input.edit_mode as EditMode) || "replace";

        if (!rawPath) {
            return JSON.stringify({ error: "notebook_path is required" });
        }
        if (!["replace", "insert", "delete"].includes(mode)) {
            return JSON.stringify({ error: `Invalid edit_mode: ${mode}. Use replace, insert, or delete.` });
        }

        const filePath = path.resolve(rawPath);
        auditLog("notebook_edit", { path: filePath, mode });

        if (!isPathAllowed(filePath)) {
            const reason = getPathBlockedReason(filePath) ?? `Path "${filePath}" is not allowed.`;
            return JSON.stringify({ error: reason });
        }
        if (isProtectedPath(filePath)) {
            return JSON.stringify({
                error: `Editing "${filePath}" is not allowed — this path is part of the bot's own codebase and is write-protected.`,
            });
        }

        if (!filePath.toLowerCase().endsWith(".ipynb")) {
            return JSON.stringify({
                error: "notebook_edit only works on .ipynb files. For text files use `edit` or `write`.",
            });
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

        // Read-before-edit enforcement
        if (!wasRead(filePath)) {
            const reason = hasRegistryEntry(filePath)
                ? "Notebook has changed on disk since the last read. Call `read` again before editing."
                : "You must call `read` on this notebook before editing it.";
            return JSON.stringify({ error: reason });
        }

        // Load
        let nb: Notebook;
        let raw: string;
        try {
            raw = readFileSync(filePath, "utf-8");
            nb = JSON.parse(raw) as Notebook;
            if (!Array.isArray(nb.cells)) {
                return JSON.stringify({ error: "Invalid notebook: `cells` array missing." });
            }
        } catch (err) {
            return JSON.stringify({ error: `Failed to parse notebook: ${(err as Error).message}` });
        }

        const idx = findCellIndex(nb, input);
        const newSource = (input.new_source as string) ?? "";

        if (mode === "replace") {
            if (idx < 0 || idx >= nb.cells.length) {
                return JSON.stringify({
                    error: `cell_number ${idx} out of range (notebook has ${nb.cells.length} cells)`,
                });
            }
            if ((input.new_source ?? undefined) === undefined) {
                return JSON.stringify({ error: "new_source is required for replace mode." });
            }
            const cell = nb.cells[idx];
            cell.source = newSource;
            if (cell.cell_type === "code") {
                cell.outputs = [];
                cell.execution_count = null;
            }
        } else if (mode === "insert") {
            if ((input.new_source ?? undefined) === undefined) {
                return JSON.stringify({ error: "new_source is required for insert mode." });
            }
            const requestedType = (input.cell_type as CellType) || "code";
            if (!["code", "markdown", "raw"].includes(requestedType)) {
                return JSON.stringify({ error: `Invalid cell_type: ${requestedType}` });
            }
            const cell = makeCell(requestedType, newSource);
            // Insert AFTER cell_number (or at head when cell_number is missing/invalid)
            const insertAt = idx < 0 ? 0 : Math.min(idx + 1, nb.cells.length);
            nb.cells.splice(insertAt, 0, cell);
        } else if (mode === "delete") {
            if (idx < 0 || idx >= nb.cells.length) {
                return JSON.stringify({
                    error: `cell_number ${idx} out of range (notebook has ${nb.cells.length} cells)`,
                });
            }
            nb.cells.splice(idx, 1);
        }

        // Write back with the same indentation Jupyter uses (2 spaces).
        let serialized: string;
        try {
            serialized = JSON.stringify(nb, null, 1);
            writeFileSync(filePath, serialized, "utf-8");
        } catch (err) {
            return JSON.stringify({ error: `Write failed: ${(err as Error).message}` });
        }

        // Update registry so follow-on edits pass read-before-edit.
        recordRead(filePath, hashContent(serialized));

        return JSON.stringify({
            success: true,
            path: filePath,
            edit_mode: mode,
            cell_index: idx < 0 ? (mode === "insert" ? 0 : undefined) : idx,
            total_cells: nb.cells.length,
        });
    },
};
