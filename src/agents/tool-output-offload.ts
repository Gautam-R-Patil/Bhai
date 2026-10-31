// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Tool Output Offload-to-Disk ───────────────
// When a tool result is huge (e.g. `shell_exec` dumping a 100KB log,
// `web_search` returning a giant JSON), the full output would blow
// through the model's context window. We save the full output to a
// tmp file on disk and hand the model a compact preview plus the file
// path. The model can then call `read` on the path when (and only
// when) it needs the full content.
//
// Files live under `data/tool-outputs/{turnId}/` and survive the
// session for debugging. A best-effort GC prunes old turn directories
// when they exceed a count threshold.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getDataDir } from "../config/paths.js";
import { CODE_TOOLS, protect } from "../security/pii-vault.js";

// ── Tuning ────────────────────────────────────

/**
 * Only offload when the serialized result exceeds this many bytes. Below
 * this, the existing truncate layer handles it. Pick a value that's big
 * enough that we don't spam the disk for normal tool calls, but small
 * enough to matter: a 4KB preview is already plenty to see what happened.
 */
export const OFFLOAD_THRESHOLD_BYTES = 8 * 1024;

/**
 * Size of the preview emitted into LLM context when we offload. Keep
 * this tight — the point of offloading is to save tokens.
 */
const PREVIEW_BYTES = 2 * 1024;

/** Absolute directory root for offloaded outputs. */
const OFFLOAD_ROOT = path.join(getDataDir(), "tool-outputs");

/** Retain at most this many turn directories; GC drops oldest. */
const MAX_TURN_DIRS = 50;

// ── Helpers ───────────────────────────────────

function ensureRoot(): void {
    if (!existsSync(OFFLOAD_ROOT)) mkdirSync(OFFLOAD_ROOT, { recursive: true });
}

function gcOldTurnDirs(): void {
    try {
        ensureRoot();
        const entries = readdirSync(OFFLOAD_ROOT, { withFileTypes: true });
        const dirs = entries
            .filter((e) => e.isDirectory())
            .map((e) => {
                const p = path.join(OFFLOAD_ROOT, e.name);
                let mtime = 0;
                try {
                    mtime = statSync(p).mtimeMs;
                } catch {
                    /* ignore */
                }
                return { p, mtime };
            });
        if (dirs.length <= MAX_TURN_DIRS) return;
        dirs.sort((a, b) => a.mtime - b.mtime); // oldest first
        for (let i = 0; i < dirs.length - MAX_TURN_DIRS; i++) {
            try {
                rmSync(dirs[i].p, { recursive: true, force: true });
            } catch {
                /* */
            }
        }
    } catch {
        /* GC failures are never fatal */
    }
}

function slug(s: string): string {
    return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

// ── Public API ────────────────────────────────

export interface OffloadResult {
    /** The (possibly shortened) content to inject into LLM context. */
    content: string;
    /** Absolute path of the full saved output, if offloaded. */
    savedAt?: string;
    /** True if offload happened; false means content is the full result. */
    offloaded: boolean;
}

/**
 * Offload a tool result to disk when it exceeds the size threshold.
 * Returns the model-facing content plus the saved path. Fail-open —
 * any filesystem error falls through to returning the original output
 * untouched.
 */
export function offloadIfLarge(
    toolName: string,
    toolCallId: string,
    turnId: string,
    result: string,
    ownLimit = 0,
): OffloadResult {
    const size = Buffer.byteLength(result, "utf-8");
    // A tool whose own cap is above this line (a finished research report) stays
    // inline while it fits that cap: a 2KB preview would hide most of it. Past the
    // cap it is offloaded, so the model still gets the saved path to the rest.
    if (size <= Math.max(OFFLOAD_THRESHOLD_BYTES, ownLimit)) {
        return { content: result, offloaded: false };
    }

    try {
        const abs = saveToolOutput(toolName, toolCallId, turnId, result);
        const note = `[Output truncated — ${size} bytes total. Full content saved to ${abs}. Call \`read\` with file_path="${abs}" if you need more.]`;
        // Preview: a head+tail slice of what was saved (masked). Preview plus note fit the tool's
        // own cap (glob's is 2000), or the cut that follows drops the note and the path with it.
        const room = ownLimit > 0 ? Math.min(PREVIEW_BYTES, ownLimit - note.length - 2) : PREVIEW_BYTES;
        const preview = buildPreview(protect(result, { credentials: !CODE_TOOLS.has(toolName) }), room);
        return {
            content: `${preview}\n\n${note}`,
            savedAt: abs,
            offloaded: true,
        };
    } catch (err) {
        // If offload fails, return the original content — the downstream
        // truncate layer in agent.ts will clip it to fit the context.
        console.warn(`[OFFLOAD] Failed for ${toolName}: ${(err as Error).message}`);
        return { content: result, offloaded: false };
    }
}

/**
 * Save a tool's full output where the model can `read` it back; returns the path.
 * What goes to disk is what the model may read back: masked the same way
 * (a typed secret, a dashboard showing an API key), never the raw values. Throws on fs errors.
 */
export function saveToolOutput(toolName: string, toolCallId: string, turnId: string, result: string): string {
    ensureRoot();
    const turnDir = path.join(OFFLOAD_ROOT, slug(turnId));
    if (!existsSync(turnDir)) mkdirSync(turnDir, { recursive: true });
    const abs = path.join(turnDir, `${slug(toolName)}-${slug(toolCallId || String(Date.now()))}.txt`);
    writeFileSync(abs, protect(readableForm(result), { credentials: !CODE_TOOLS.has(toolName) }), "utf-8");
    // Best-effort GC so the dir doesn't grow unbounded across sessions.
    gcOldTurnDirs();
    return abs;
}

/**
 * `cut` is what's left of `full` after truncation. When something was cut, save
 * the whole output and say where, or the rest is gone for good (results under
 * the offload line are cut, not offloaded).
 */
export function keepRestReadable(toolName: string, toolCallId: string, turnId: string, full: string, cut: string): string {
    if (cut.length >= full.length) return cut;
    try {
        const abs = saveToolOutput(toolName, toolCallId, turnId, full);
        return `${cut}\n[Full output saved to ${abs}. Call \`read\` with file_path="${abs}" if you need the rest.]`;
    } catch {
        return cut;
    }
}

/**
 * `read` pages a file by line, and a JSON result is one line with every newline
 * escaped (a 47K page came back as its first 5K, no way further). Write a JSON
 * object's string fields out with real newlines; anything else as it was.
 */
function readableForm(result: string): string {
    let v: unknown;
    try {
        v = JSON.parse(result);
    } catch {
        return result;
    }
    if (!v || typeof v !== "object") return result;
    if (Array.isArray(v)) return JSON.stringify(v, null, 2);
    return Object.entries(v)
        .map(([k, x]) => `## ${k}\n${typeof x === "string" ? x : JSON.stringify(x, null, 2)}`)
        .join("\n\n");
}

function buildPreview(result: string, max = PREVIEW_BYTES): string {
    // Head+tail preview works for every shape — more reliable than trying
    // to parse (tool results from Bhai are usually JSON strings, but
    // shell_exec output and many others aren't).
    if (result.length <= max) return result;
    const headBytes = Math.floor(max * 0.6);
    const tailBytes = Math.max(0, max - headBytes - 40);
    const head = result.slice(0, headBytes);
    const tail = result.slice(result.length - tailBytes);
    return `${head}\n\n...[preview cut]...\n\n${tail}`;
}

/**
 * Explicit cleanup — call on session reset if desired. Not required:
 * the GC in offloadIfLarge keeps the disk bounded automatically.
 */
export function clearOffloadedOutputs(): void {
    try {
        if (!existsSync(OFFLOAD_ROOT)) return;
        rmSync(OFFLOAD_ROOT, { recursive: true, force: true });
    } catch {
        /* ignore */
    }
}
