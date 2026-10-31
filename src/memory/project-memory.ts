// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Project Memory (walk-up loader) ────────────
// Walks from CWD up to $HOME, collecting AGENTS.md + .bhai/agents/*.md
// + BHAI.md files. Selective by task type. Section markers let callers
// pull specific sub-zones out of sub-docs.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { getBhaiHome } from "../config/paths.js";

const MAX_TOTAL_BYTES = 16 * 1024;
const MAX_FILE_BYTES = 8 * 1024;
const MAX_DEPTH = 20;

// Root-level candidates (most-specific first — same-directory precedence).
// Each entry lists the current name, then the pre-rename ATLAS one, read only
// when the BHAI file is absent (users' repos are theirs; we never migrate them).
const FILE_CANDIDATES = [
    ["BHAI.md", "ATLAS.md"],
    [".bhai/BHAI.md", ".atlas/ATLAS.md"],
    ["BHAI.local.md", "ATLAS.local.md"],
    ["AGENTS.md"],
];
const AGENT_DIRS = [".bhai", ".atlas"];

function firstExisting(dir: string, names: string[]): string | undefined {
    return names.map((n) => path.join(dir, n)).find((p) => existsSync(p));
}

// Sub-docs under .bhai/agents/ that are candidates for injection.
const SUBDOC_BASENAMES = [
    "architecture.md",
    "conventions.md",
    "workflows.md",
    "quickref.md",
    "gotchas.md",
    "commands.md",
    "recent.md",
    "notes.md",
];

interface LoadedMemoryFile {
    path: string;
    depth: number;
    source: "project" | "user";
    content: string;
    subdoc: string | null;
}

export type TaskType = "coding" | "build" | "debug" | "refactor" | "setup" | "other";

export interface LoadOptions {
    taskType?: TaskType;
    /** Optional per-sub-doc section filter: { "architecture.md": ["mermaid"] } */
    sections?: Record<string, string[]>;
}

function readCapped(p: string): string | null {
    try {
        const stats = statSync(p);
        if (!stats.isFile()) return null;
        const buf = readFileSync(p);
        return buf.length > MAX_FILE_BYTES
            ? `${buf.subarray(0, MAX_FILE_BYTES).toString("utf-8")}\n[... truncated]`
            : buf.toString("utf-8");
    } catch {
        return null;
    }
}

function shouldStopAt(dir: string): boolean {
    return path.resolve(dir) === homedir();
}

/** Pick sub-docs relevant to the task type per the spec's table. */
function subdocsForTask(taskType: TaskType): Set<string> {
    const always = new Set(["gotchas.md", "notes.md"]);
    if (taskType === "coding") {
        always.add("architecture.md");
        always.add("conventions.md");
        always.add("quickref.md");
    }
    if (taskType === "build" || taskType === "setup") {
        always.add("commands.md");
    }
    if (taskType === "debug" || taskType === "refactor") {
        always.add("recent.md");
    }
    return always;
}

/** Given a sub-doc content and a section-name filter, return the concatenated sections (or the whole content if no filter). */
function applySectionFilter(content: string, sections: string[] | undefined): string {
    if (!sections || sections.length === 0) return content;
    const out: string[] = [];
    for (const name of sections) {
        for (const brand of ["bhai", "atlas"]) {
            const startMarker = `<!-- @${brand}:section:${name} -->`;
            const endMarker = `<!-- @${brand}:section:${name}:end -->`;
            const si = content.indexOf(startMarker);
            if (si === -1) continue;
            const ei = content.indexOf(endMarker, si);
            if (ei === -1) continue;
            out.push(content.slice(si + startMarker.length, ei).trim());
            break;
        }
    }
    return out.join("\n\n");
}

/**
 * Walk up from startDir collecting AGENTS.md + BHAI.md + the task-type-relevant
 * sub-docs under .bhai/agents/. Stops at home or root. Caps total bytes at 16K.
 */
export function loadProjectMemoryFiles(startDir?: string, options: LoadOptions = {}): LoadedMemoryFile[] {
    const taskType: TaskType = options.taskType ?? "other";
    const wanted = subdocsForTask(taskType);
    const out: LoadedMemoryFile[] = [];
    let totalBytes = 0;

    const pushIfRoom = (f: LoadedMemoryFile): boolean => {
        if (totalBytes + f.content.length > MAX_TOTAL_BYTES) return false;
        out.push(f);
        totalBytes += f.content.length;
        return true;
    };

    let dir = path.resolve(startDir ?? process.cwd());
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
        // Root-level candidates
        for (const names of FILE_CANDIDATES) {
            const p = firstExisting(dir, names);
            if (!p) continue;
            const content = readCapped(p);
            if (!content) continue;
            pushIfRoom({ path: p, depth, source: "project", content, subdoc: null });
        }
        // .bhai/agents/*.md sub-docs (then .atlas/agents/, same basename once)
        const seen = new Set<string>();
        for (const agentDir of AGENT_DIRS) {
            const subdir = path.join(dir, agentDir, "agents");
            if (!existsSync(subdir)) continue;
            let entries: string[] = [];
            try {
                entries = readdirSync(subdir);
            } catch {
                /* */
            }
            for (const name of entries) {
                if (!SUBDOC_BASENAMES.includes(name)) continue;
                if (!wanted.has(name)) continue;
                if (seen.has(name)) continue;
                seen.add(name);
                const p = path.join(subdir, name);
                const raw = readCapped(p);
                if (!raw) continue;
                const filtered = applySectionFilter(raw, options.sections?.[name]);
                if (!filtered) continue;
                pushIfRoom({ path: p, depth, source: "project", content: filtered, subdoc: name });
            }
        }
        if (shouldStopAt(dir)) break;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }

    // Global user memory
    try {
        const userPath = firstExisting(getBhaiHome(), ["BHAI.md", "ATLAS.md"]);
        if (userPath) {
            const content = readCapped(userPath);
            if (content) pushIfRoom({ path: userPath, depth: MAX_DEPTH, source: "user", content, subdoc: null });
        }
    } catch {
        /* */
    }

    return out;
}

/**
 * Assemble the <project_memory>…</project_memory> block. Returns empty
 * string when no files were found so callers can concatenate safely.
 */
export function getProjectMemorySnippet(startDir?: string, options: LoadOptions = {}): string {
    let files: LoadedMemoryFile[];
    try {
        files = loadProjectMemoryFiles(startDir, options);
    } catch {
        return "";
    }
    if (files.length === 0) return "";

    const parts: string[] = ["<project_memory>"];
    for (const f of files) {
        const label = f.source === "user" ? "user-level" : `depth=${f.depth}${f.subdoc ? `:subdoc=${f.subdoc}` : ""}`;
        parts.push(`--- ${label}: ${f.path} ---`);
        parts.push(f.content.trim());
    }
    parts.push("</project_memory>");
    return parts.join("\n");
}
