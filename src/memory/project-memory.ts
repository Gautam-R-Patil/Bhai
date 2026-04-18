// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Project Memory (ATLAS.md walk-up) ─────────
// Claude-Code-style hierarchical project memory. When the agent starts a
// coding task, walk from the current working directory up to the home/root
// boundary, collecting any ATLAS.md / .atlas/ATLAS.md / ATLAS.local.md
// files found along the way. Also consult the user-level `~/.atlas/ATLAS.md`.
//
// Precedence: the MORE SPECIFIC (closer to CWD) file wins on conflict.
// We concatenate in order from most-specific → least-specific, clearly
// labeled, so the model knows where each block came from.
//
// Fail-open: any FS or parse error results in an empty snippet, never a
// thrown exception. Project memory is additive — its absence never
// changes behavior.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// ── Tuning ────────────────────────────────────

/** Maximum bytes of project memory to concatenate. Hard cap to avoid prompt bloat. */
const MAX_TOTAL_BYTES = 16 * 1024;
/** Maximum bytes to read from any single file. */
const MAX_FILE_BYTES = 8 * 1024;
/** Hard stop on how many parent levels to walk. */
const MAX_DEPTH = 20;

// ── File name candidates (most-specific first) ─────

const FILE_CANDIDATES = ["ATLAS.md", ".atlas/ATLAS.md", "ATLAS.local.md"];

// ── Types ─────────────────────────────────────

interface LoadedMemoryFile {
    path: string;
    /** 0 = CWD, 1 = CWD's parent, etc. Lower = more specific. */
    depth: number;
    /** "user" = ~/.atlas/ATLAS.md, "project" = anything in the walk-up */
    source: "project" | "user";
    content: string;
}

// ── Helpers ───────────────────────────────────

function readCapped(p: string): string | null {
    try {
        const stats = statSync(p);
        if (!stats.isFile()) return null;
        const buf = readFileSync(p);
        const text = buf.length > MAX_FILE_BYTES
            ? buf.subarray(0, MAX_FILE_BYTES).toString("utf-8") + "\n[... truncated]"
            : buf.toString("utf-8");
        return text;
    } catch {
        return null;
    }
}

function shouldStopAt(dir: string): boolean {
    // Stop walking when we hit the home directory exactly. We don't want to
    // bubble out past $HOME because that's the user's private space — but we
    // also don't want to stop prematurely when the project lives outside
    // $HOME (e.g. /tmp, /opt, /workspace). The fs-root stop is handled by
    // the caller noticing `parent === dir`.
    return path.resolve(dir) === homedir();
}

// ── Public API ────────────────────────────────

/**
 * Walk up from `startDir` (default: process.cwd()) collecting ATLAS.md
 * files. Stops at the home directory boundary or after MAX_DEPTH levels.
 * Returns files ordered MOST-specific first.
 */
export function loadProjectMemoryFiles(startDir?: string): LoadedMemoryFile[] {
    const out: LoadedMemoryFile[] = [];
    let totalBytes = 0;
    const pushIfRoom = (f: LoadedMemoryFile) => {
        if (totalBytes + f.content.length > MAX_TOTAL_BYTES) return false;
        out.push(f);
        totalBytes += f.content.length;
        return true;
    };

    let dir = path.resolve(startDir ?? process.cwd());
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
        for (const name of FILE_CANDIDATES) {
            const p = path.join(dir, name);
            if (!existsSync(p)) continue;
            const content = readCapped(p);
            if (!content) continue;
            pushIfRoom({ path: p, depth, source: "project", content });
        }

        // Stop at home, and at filesystem root.
        if (shouldStopAt(dir)) break;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }

    // Global user-level memory: ~/.atlas/ATLAS.md
    try {
        const userPath = path.join(homedir(), ".atlas", "ATLAS.md");
        if (existsSync(userPath)) {
            const content = readCapped(userPath);
            if (content) {
                pushIfRoom({ path: userPath, depth: MAX_DEPTH, source: "user", content });
            }
        }
    } catch {
        /* ignore */
    }

    return out;
}

/**
 * Assemble a single <project_memory>...</project_memory> snippet ready
 * for injection into the system prompt. Returns an empty string when no
 * memory files are found, so callers can simply concatenate.
 */
export function getProjectMemorySnippet(startDir?: string): string {
    let files: LoadedMemoryFile[];
    try {
        files = loadProjectMemoryFiles(startDir);
    } catch {
        return "";
    }
    if (files.length === 0) return "";

    const parts: string[] = ["<project_memory>"];
    for (const f of files) {
        const label = f.source === "user" ? "user-level" : `depth=${f.depth}`;
        parts.push(`--- ${label}: ${f.path} ---`);
        parts.push(f.content.trim());
    }
    parts.push("</project_memory>");
    return parts.join("\n");
}
