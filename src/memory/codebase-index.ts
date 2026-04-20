// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Codebase Index Core ────────────────────────
// Build / refresh / stats / wipe. Walks a repo root, dispatches parse,
// upserts into the sidecar in a single transaction per pass. Merkle-style
// dirty detection: per-file SHA-256 comparison against stored row.

import fs from "node:fs";
import path from "node:path";
import { type Language, MAX_FILE_BYTES, parseFile } from "./code-parse/index.js";
import { repoHash, resolveRepoRoot, sha256File } from "./codebase-merkle.js";
import { getRawSidecar, openSidecar, SIDECAR_SCHEMA_VERSION, wipeSidecar } from "./codebase-sidecar.js";

// ── Tuning ────────────────────────────────────

export const MAX_WALK_FILES = 20_000;

const ALWAYS_SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "__pycache__",
    ".tox",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "venv",
    ".venv",
    "env",
    "dist",
    "build",
    "out",
    "target",
    ".next",
    ".nuxt",
    ".output",
    "coverage",
    ".cache",
    ".parcel-cache",
    ".turbo",
    ".angular",
    "vendor",
    "Pods",
    ".idea",
    ".vscode",
    ".vs",
    "agent-worktrees",
]);

const ALWAYS_SKIP_FILES = new Set([
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
    "Cargo.lock",
    "Gemfile.lock",
    "poetry.lock",
    "composer.lock",
    "go.sum",
]);

const EXT_LANG: Record<string, Language> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".pyw": "python",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".hpp": "cpp",
    ".hxx": "cpp",
    ".cs": "csharp",
    ".rb": "ruby",
    ".swift": "swift",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".php": "php",
    ".sh": "shell",
    ".bash": "shell",
    ".zsh": "shell",
    ".lua": "lua",
};

// ── Types ─────────────────────────────────────

export type Depth = "symbols" | "imports" | "calls";
export type Timing = "block" | "async";

export interface BuildOptions {
    depth?: Depth;
    timing?: Timing;
    incremental?: boolean;
    maxFiles?: number;
}

export interface BuildResult {
    repoRoot: string;
    repoHash: string;
    depth: Depth;
    depthAuto: boolean;
    added: number;
    updated: number;
    unchanged: number;
    deleted: number;
    errors: Array<{ path: string; error: string }>;
    elapsedMs: number;
    fileCount: number;
    symbolCount: number;
}

export interface IndexStats {
    exists: boolean;
    repoRoot: string;
    repoHash: string;
    depth: Depth | null;
    depthAuto: boolean | null;
    fileCount: number;
    symbolCount: number;
    createdAt: number | null;
    lastRefreshedAt: number | null;
    sidecarBytes: number;
    toolVersion: string | null;
}

// ── Depth + Timing pickers ────────────────────

export function pickDepth(signals: { fileCount: number; typedRatio: number; lang: Language | "mixed" }): Depth {
    const env = (process.env.ATLAS_INDEX_DEPTH || "").toLowerCase();
    if (env === "symbols" || env === "imports" || env === "calls") return env;

    let tier: Depth;
    if (signals.fileCount <= 500) tier = "calls";
    else if (signals.fileCount <= 5000) tier = "imports";
    else tier = "symbols";

    if (signals.typedRatio < 0.3) {
        if (tier === "calls") tier = "imports";
        else if (tier === "imports") tier = "symbols";
    }
    return tier;
}

export function pickTiming(fileCount: number): Timing {
    const env = (process.env.ATLAS_INDEX_ASYNC || "").toLowerCase();
    if (env === "force") return "async";
    if (env === "never") return "block";
    return fileCount <= 100 ? "block" : "async";
}

// ── Walker ────────────────────────────────────

interface DiscoveredFile {
    abs: string;
    rel: string;
    lang: Language;
}

function listFiles(root: string, maxFiles: number): DiscoveredFile[] {
    const out: DiscoveredFile[] = [];
    const visited = new Set<string>();
    // Resolve root once so the symlink-escape check compares real paths.
    let rootReal: string;
    try {
        rootReal = fs.realpathSync(root);
    } catch {
        rootReal = path.resolve(root);
    }
    const visit = (dir: string): void => {
        if (out.length >= maxFiles) return;
        let real: string;
        try {
            real = fs.realpathSync(dir);
        } catch {
            return;
        }
        // Refuse to follow symlinks that escape the repo — otherwise a
        // stray `ln -s /etc etc-link` in the source tree would get indexed
        // and leak /etc/* contents into the sidecar DB.
        if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return;
        if (visited.has(real)) return;
        visited.add(real);

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const e of entries) {
            if (out.length >= maxFiles) return;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (ALWAYS_SKIP_DIRS.has(e.name)) continue;
                if (e.name.startsWith(".") && e.name !== ".github") continue;
                visit(full);
            } else if (e.isFile()) {
                if (ALWAYS_SKIP_FILES.has(e.name)) continue;
                if (e.name.startsWith(".")) continue;
                const ext = path.extname(e.name).toLowerCase();
                const lang = EXT_LANG[ext];
                if (!lang) continue;
                out.push({ abs: full, rel: path.relative(root, full), lang });
            }
        }
    };
    visit(root);
    return out;
}

function detectTypedRatio(files: DiscoveredFile[]): { ratio: number; mainLang: Language | "mixed" } {
    if (files.length === 0) return { ratio: 1, mainLang: "mixed" };
    const TYPED: Language[] = ["typescript", "rust", "go", "java", "csharp", "swift", "kotlin"];
    const counts = new Map<Language, number>();
    for (const f of files) counts.set(f.lang, (counts.get(f.lang) ?? 0) + 1);
    const typed = files.filter((f) => TYPED.includes(f.lang)).length;
    const ratio = typed / files.length;
    let mainLang: Language | "mixed" = "mixed";
    let max = 0;
    for (const [l, n] of counts) {
        if (n > max) {
            max = n;
            mainLang = l;
        }
    }
    return { ratio, mainLang };
}

function readText(p: string): string | null {
    try {
        const buf = fs.readFileSync(p);
        if (buf.length === 0) return "";
        if (buf.length > MAX_FILE_BYTES) {
            return buf.subarray(0, MAX_FILE_BYTES + 1).toString("utf-8");
        }
        try {
            return buf.toString("utf-8");
        } catch {
            return buf.toString("latin1");
        }
    } catch {
        return null;
    }
}

// ── Build / Refresh core ──────────────────────

async function doIndex(root: string, opts: BuildOptions, incremental: boolean): Promise<BuildResult> {
    const t0 = Date.now();
    const repoRoot = resolveRepoRoot(root);
    const hash = repoHash(repoRoot);
    const db = openSidecar(repoRoot);
    // Raw better-sqlite3 handle — transactions MUST be wrapped on the sidecar
    // itself, not on the main memories.db via sqlite.ts transaction helpers.
    const raw = getRawSidecar(repoRoot);

    const maxFiles = opts.maxFiles ?? MAX_WALK_FILES;
    const files = listFiles(repoRoot, maxFiles);
    const typed = detectTypedRatio(files);

    const depthAuto = !opts.depth;
    const depth: Depth =
        opts.depth ??
        pickDepth({
            fileCount: files.length,
            typedRatio: typed.ratio,
            lang: typed.mainLang,
        });

    const errors: BuildResult["errors"] = [];
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    let deleted = 0;

    const existingRows = db.exec("SELECT path, sha256, id FROM files");
    const existing = new Map<string, { sha: string; id: number }>();
    if (existingRows.length > 0) {
        for (const r of existingRows[0].values) {
            existing.set(r[0] as string, { sha: r[1] as string, id: r[2] as number });
        }
    }

    raw.exec("BEGIN");
    // Prepared statements hoisted inside the transaction — reused across all files.
    // Using raw.prepare gives direct access to lastInsertRowid (better-sqlite3 idiom)
    // instead of the N+1 "SELECT last_insert_rowid()" pattern through the wrapper,
    // which also avoids an undefined-access hazard if the wrapped exec silently fails.
    const fileInsert = raw.prepare(
        "INSERT INTO files (path, sha256, lang, loc, workspace, indexed_at) VALUES (?, ?, ?, ?, NULL, ?)",
    );
    const symbolInsert = raw.prepare(
        "INSERT INTO symbols (file_id, name, kind, line_start, line_end, signature, exported) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    try {
        const currentPaths = new Set<string>();
        for (const f of files) {
            currentPaths.add(f.rel);
            const sha = sha256File(f.abs);
            const prev = existing.get(f.rel);

            if (incremental && prev && prev.sha === sha && sha.length > 0) {
                unchanged++;
                continue;
            }

            const content = readText(f.abs);
            if (content === null) {
                errors.push({ path: f.rel, error: "read-failed" });
                continue;
            }

            const res = parseFile(f.lang, f.abs, content);

            let fileId: number;
            if (prev) {
                db.run("UPDATE files SET sha256 = ?, lang = ?, loc = ?, indexed_at = ? WHERE id = ?", [
                    sha,
                    f.lang,
                    res.loc,
                    Date.now(),
                    prev.id,
                ]);
                fileId = prev.id;
                db.run("DELETE FROM symbols WHERE file_id = ?", [fileId]);
                db.run("DELETE FROM imports WHERE from_file_id = ?", [fileId]);
                updated++;
            } else {
                const fileResult = fileInsert.run(f.rel, sha, f.lang, res.loc, Date.now());
                fileId = Number(fileResult.lastInsertRowid);
                added++;
            }

            const symbolIdByName = new Map<string, number>();
            for (const s of res.symbols) {
                const sr = symbolInsert.run(
                    fileId,
                    s.name,
                    s.kind,
                    s.lineStart,
                    s.lineEnd,
                    s.signature,
                    s.exported ? 1 : 0,
                );
                const sid = Number(sr.lastInsertRowid);
                symbolIdByName.set(s.name, sid);
            }

            if (depth !== "symbols") {
                for (const imp of res.imports) {
                    db.run("INSERT INTO imports (from_file_id, to_file_id, specifier, line) VALUES (?, NULL, ?, ?)", [
                        fileId,
                        imp.specifier,
                        imp.line,
                    ]);
                }
            }

            if (depth === "calls") {
                for (const c of res.calls) {
                    const fromSid = c.fromSymbolName ? symbolIdByName.get(c.fromSymbolName) : undefined;
                    if (fromSid === undefined) continue;
                    db.run(
                        "INSERT INTO calls (from_symbol_id, to_symbol_id, callee_name, line) VALUES (?, NULL, ?, ?)",
                        [fromSid, c.calleeName, c.line],
                    );
                }
            }

            if (res.error && res.error !== "lfs-pointer") {
                errors.push({ path: f.rel, error: res.error });
            }
        }

        if (incremental) {
            for (const [p, row] of existing.entries()) {
                if (!currentPaths.has(p)) {
                    db.run("DELETE FROM files WHERE id = ?", [row.id]);
                    deleted++;
                }
            }
        }

        if (depth !== "symbols") {
            resolveImports(db);
        }

        const fc = db.exec("SELECT COUNT(*) FROM files")[0].values[0][0] as number;
        const sc = db.exec("SELECT COUNT(*) FROM symbols")[0].values[0][0] as number;
        const nowMs = Date.now();
        const existingMeta = db.exec("SELECT repo_root FROM index_meta WHERE repo_root = ?", [repoRoot]);
        if (existingMeta.length === 0 || existingMeta[0].values.length === 0) {
            db.run(
                "INSERT INTO index_meta (repo_root, repo_hash, depth, depth_auto, file_count, symbol_count, created_at, last_refreshed_at, tool_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [repoRoot, hash, depth, depthAuto ? 1 : 0, fc, sc, nowMs, nowMs, SIDECAR_SCHEMA_VERSION],
            );
        } else {
            db.run(
                "UPDATE index_meta SET depth = ?, depth_auto = ?, file_count = ?, symbol_count = ?, last_refreshed_at = ?, tool_version = ? WHERE repo_root = ?",
                [depth, depthAuto ? 1 : 0, fc, sc, nowMs, SIDECAR_SCHEMA_VERSION, repoRoot],
            );
        }

        try {
            raw.exec("COMMIT");
        } catch (commitErr) {
            throw new Error(`commit-failed: ${(commitErr as Error).message}`);
        }

        const elapsed = Date.now() - t0;
        console.log(
            `[codebase-index] ${incremental ? "refresh" : "build"} ${repoRoot}: ${fc} files, ${sc} symbols, ${added} added, ${updated} updated, ${elapsed}ms`,
        );
        return {
            repoRoot,
            repoHash: hash,
            depth,
            depthAuto,
            added,
            updated,
            unchanged,
            deleted,
            errors,
            elapsedMs: elapsed,
            fileCount: fc,
            symbolCount: sc,
        };
    } catch (err) {
        try {
            raw.exec("ROLLBACK");
        } catch {
            /* */
        }
        const elapsed = Date.now() - t0;
        console.warn(`[codebase-index] build failed: ${(err as Error).message}`);
        return {
            repoRoot,
            repoHash: hash,
            depth,
            depthAuto,
            added,
            updated,
            unchanged,
            deleted,
            errors: [{ path: "(global)", error: (err as Error).message }],
            elapsedMs: elapsed,
            fileCount: 0,
            symbolCount: 0,
        };
    }
}

/** Best-effort specifier → to_file_id. Only handles relative imports. */
function resolveImports(db: ReturnType<typeof openSidecar>): void {
    const filesRow = db.exec("SELECT id, path FROM files");
    const pathToId = new Map<string, number>();
    if (filesRow.length > 0) {
        for (const r of filesRow[0].values) {
            pathToId.set(r[1] as string, r[0] as number);
        }
    }
    const importsRow = db.exec("SELECT id, from_file_id, specifier FROM imports WHERE to_file_id IS NULL");
    if (importsRow.length === 0) return;

    for (const r of importsRow[0].values) {
        const impId = r[0] as number;
        const fromId = r[1] as number;
        const spec = r[2] as string;
        if (!spec.startsWith(".") && !spec.startsWith("/")) continue;
        const fromPathRow = db.exec("SELECT path FROM files WHERE id = ?", [fromId]);
        if (fromPathRow.length === 0 || fromPathRow[0].values.length === 0) continue;
        const fromPath = fromPathRow[0].values[0][0] as string;
        const baseDir = path.posix.dirname(fromPath.replace(/\\/g, "/"));
        const joined = path.posix.normalize(path.posix.join(baseDir, spec));
        const candidates = [
            joined,
            `${joined}.ts`,
            `${joined}.tsx`,
            `${joined}.js`,
            `${joined}.jsx`,
            `${joined}/index.ts`,
            `${joined}/index.js`,
            joined.replace(/\.js$/, ".ts"),
            joined.replace(/\.js$/, ".tsx"),
        ];
        for (const c of candidates) {
            const toId = pathToId.get(c);
            if (toId !== undefined) {
                db.run("UPDATE imports SET to_file_id = ? WHERE id = ?", [toId, impId]);
                break;
            }
        }
    }
}

export async function buildIndex(root: string, opts: BuildOptions = {}): Promise<BuildResult> {
    return doIndex(root, opts, false);
}

export async function refreshIndex(root: string, opts: BuildOptions = {}): Promise<BuildResult> {
    return doIndex(root, { ...opts, incremental: true }, true);
}

export function getIndexStats(root: string): IndexStats {
    const repoRoot = resolveRepoRoot(root);
    const hash = repoHash(repoRoot);
    const db = openSidecar(repoRoot);
    const metaRow = db.exec(
        "SELECT depth, depth_auto, file_count, symbol_count, created_at, last_refreshed_at, tool_version FROM index_meta WHERE repo_root = ?",
        [repoRoot],
    );
    if (metaRow.length === 0 || metaRow[0].values.length === 0) {
        return {
            exists: false,
            repoRoot,
            repoHash: hash,
            depth: null,
            depthAuto: null,
            fileCount: 0,
            symbolCount: 0,
            createdAt: null,
            lastRefreshedAt: null,
            sidecarBytes: 0,
            toolVersion: null,
        };
    }
    const row = metaRow[0].values[0];
    let sidecarBytes = 0;
    try {
        const sp = path.join(process.env.ATLAS_DATA_DIR || path.resolve("data"), "codebase-index", `${hash}.db`);
        sidecarBytes = fs.statSync(sp).size;
    } catch {
        /* */
    }
    return {
        exists: true,
        repoRoot,
        repoHash: hash,
        depth: row[0] as Depth,
        depthAuto: (row[1] as number) === 1,
        fileCount: row[2] as number,
        symbolCount: row[3] as number,
        createdAt: row[4] as number,
        lastRefreshedAt: row[5] as number,
        sidecarBytes,
        toolVersion: row[6] as string,
    };
}

export function wipeIndex(root: string): void {
    const repoRoot = resolveRepoRoot(root);
    wipeSidecar(repoRoot);
}

/**
 * Best-effort architecture snippet. Returns an empty string when:
 *  - the sidecar does not exist, OR
 *  - ATLAS_NO_ARCHITECTURE_INJECTION=true, OR
 *  - ATLAS_NO_CODEBASE_INDEX=true, OR
 *  - any SQL / fs error occurs.
 * Never throws.
 */
export async function getArchitectureSnippet(root: string): Promise<string> {
    try {
        if ((process.env.ATLAS_NO_ARCHITECTURE_INJECTION ?? "").toLowerCase() === "true") return "";
        if ((process.env.ATLAS_NO_CODEBASE_INDEX ?? "").toLowerCase() === "true") return "";
        const repoRoot = resolveRepoRoot(root);
        const { hasSidecar, openSidecar } = await import("./codebase-sidecar.js");
        if (!hasSidecar(repoRoot)) return "";
        const db = openSidecar(repoRoot);
        const rows = db.exec("SELECT path FROM files ORDER BY path");
        if (rows.length === 0 || rows[0].values.length === 0) return "";
        const group = new Map<string, number>();
        for (const r of rows[0].values) {
            const p = r[0] as string;
            const segs = p.split("/");
            const key = segs.slice(0, Math.min(2, segs.length - 1)).join("/") || ".";
            group.set(key, (group.get(key) ?? 0) + 1);
        }
        const groups = Array.from(group.entries()).slice(0, 20);
        const mermaidLines = ["flowchart LR", `  root["${path.basename(repoRoot)}"]`];
        for (let i = 0; i < groups.length; i++) {
            mermaidLines.push(`  n${i}["${groups[i][0]}\\n${groups[i][1]} files"]`);
            mermaidLines.push(`  root --> n${i}`);
        }
        const asciiLines = [path.basename(repoRoot)];
        for (let i = 0; i < groups.length; i++) {
            const last = i === groups.length - 1;
            asciiLines.push(`${last ? "└── " : "├── "}${groups[i][0]} (${groups[i][1]} files)`);
        }
        return `<architecture>\n\`\`\`mermaid\n${mermaidLines.join("\n")}\n\`\`\`\n\`\`\`\n${asciiLines.join("\n")}\n\`\`\`\n</architecture>`;
    } catch {
        return "";
    }
}

/**
 * First-iteration hook: auto-build or async-refresh the sidecar. Non-blocking
 * beyond the ≤100-file case (per pickTiming). Never throws.
 */
export async function ensureIndexForCoding(root: string): Promise<void> {
    try {
        if ((process.env.ATLAS_NO_CODEBASE_INDEX ?? "").toLowerCase() === "true") return;
        const repoRoot = resolveRepoRoot(root);
        const { hasSidecar } = await import("./codebase-sidecar.js");
        // Probe file count without opening the sidecar (quick walk, capped).
        const files = listFiles(repoRoot, 200);
        const timing = pickTiming(files.length);
        if (!hasSidecar(repoRoot)) {
            if (timing === "block") await buildIndex(repoRoot);
            else {
                void buildIndex(repoRoot).catch((err) =>
                    console.warn("[codebase-index] bg build failed:", (err as Error).message),
                );
            }
        } else {
            if (timing === "block") await refreshIndex(repoRoot);
            else {
                void refreshIndex(repoRoot).catch((err) =>
                    console.warn("[codebase-index] bg refresh failed:", (err as Error).message),
                );
            }
        }
    } catch (err) {
        console.warn("[codebase-index] ensureIndexForCoding failed (non-fatal):", (err as Error).message);
    }
}
