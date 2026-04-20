// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── codebase_query Tool ────────────────────────
// Six pure-SQL operations against the per-repo sidecar:
// find_symbol, find_usages, file_neighborhood, describe_file,
// architecture_overview (Mermaid + ASCII), dependency_chain.
// Fail-open: no sidecar → { success: false, error } with no throw.

import path from "node:path";
import { resolveRepoRoot } from "../../memory/codebase-merkle.js";
import { hasSidecar, openSidecar } from "../../memory/codebase-sidecar.js";
import type { ToolDefinition } from "../get-current-time.js";

interface SymbolMatch {
    name: string;
    kind: string;
    file: string;
    lineStart: number;
    exported: boolean;
}

function ensureIndex(
    root: string,
): { ok: true; db: ReturnType<typeof openSidecar>; repoRoot: string } | { ok: false; error: string } {
    const repoRoot = resolveRepoRoot(root);
    if (!hasSidecar(repoRoot)) {
        return { ok: false, error: `No codebase index for ${repoRoot}. Run codebase_index build first.` };
    }
    return { ok: true, db: openSidecar(repoRoot), repoRoot };
}

function findSymbol(db: ReturnType<typeof openSidecar>, name: string, kind?: string): SymbolMatch[] {
    const sql = kind
        ? "SELECT s.name, s.kind, f.path, s.line_start, s.exported FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name = ? AND s.kind = ? ORDER BY f.path LIMIT 50"
        : "SELECT s.name, s.kind, f.path, s.line_start, s.exported FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name = ? ORDER BY f.path LIMIT 50";
    const params = kind ? [name, kind] : [name];
    const rows = db.exec(sql, params);
    if (rows.length === 0) return [];
    return rows[0].values.map((r) => ({
        name: r[0] as string,
        kind: r[1] as string,
        file: r[2] as string,
        lineStart: r[3] as number,
        exported: (r[4] as number) === 1,
    }));
}

function ftsAvailable(db: ReturnType<typeof openSidecar>): boolean {
    const rows = db.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='symbols_fts'");
    return rows.length > 0 && rows[0].values.length > 0;
}

function sanitizeFtsQuery(raw: string): string {
    // Strip FTS5 special syntax the user shouldn't need to escape manually.
    // Split into tokens, keep word-chars + underscores, drop empties, join
    // with OR so "authenticate user" matches either token (more forgiving
    // recall — BM25 then reranks on co-occurrence).
    const tokens = raw
        .toLowerCase()
        .split(/[^\p{L}\p{N}_]+/u)
        .filter((t) => t.length >= 2 && t.length <= 64);
    if (tokens.length === 0) return "";
    // Quote each token so FTS treats it as a literal phrase (handles
    // camelCase pieces like "auth" matching "authenticateUser").
    return tokens.map((t) => `"${t}"*`).join(" OR ");
}

function searchSymbols(
    db: ReturnType<typeof openSidecar>,
    query: string,
    limit: number,
): Array<{ name: string; kind: string; file: string; lineStart: number; score: number }> {
    if (!ftsAvailable(db)) return [];
    const ftsQ = sanitizeFtsQuery(query);
    if (!ftsQ) return [];
    const sql = `SELECT s.name, s.kind, f.path, s.line_start, bm25(symbols_fts) AS score
                 FROM symbols_fts
                 JOIN symbols s ON s.id = symbols_fts.rowid
                 JOIN files f ON f.id = s.file_id
                 WHERE symbols_fts MATCH ?
                 ORDER BY score
                 LIMIT ?`;
    try {
        const rows = db.exec(sql, [ftsQ, limit]);
        if (rows.length === 0) return [];
        return rows[0].values.map((r) => ({
            name: r[0] as string,
            kind: r[1] as string,
            file: r[2] as string,
            lineStart: r[3] as number,
            score: r[4] as number,
        }));
    } catch {
        return [];
    }
}

function findUsages(
    db: ReturnType<typeof openSidecar>,
    name: string,
): Array<{ file: string; line: number; caller: string | null }> {
    const sql = `SELECT f.path, c.line, s.name
                 FROM calls c
                 JOIN symbols s ON s.id = c.from_symbol_id
                 JOIN files f ON f.id = s.file_id
                 WHERE c.callee_name = ?
                 ORDER BY f.path, c.line
                 LIMIT 200`;
    const rows = db.exec(sql, [name]);
    if (rows.length === 0) return [];
    return rows[0].values.map((r) => ({ file: r[0] as string, line: r[1] as number, caller: r[2] as string }));
}

// ── Line-level ego-graph retrieval (RepoGraph, ICLR 2025) ─────
// For bug-fix and fault-localize tasks, the SOTA is to return the
// symbols that surround a specific file:line in the call graph (both
// directions, to depth N) instead of grep'ing the file in isolation.

function symbolsNear(
    db: ReturnType<typeof openSidecar>,
    file: string,
    line: number,
): Array<{ id: number; name: string; kind: string; lineStart: number }> {
    // Returns symbols whose definition range most likely contains the
    // given line. regex-based parsers don't record line_end for every
    // symbol, so we fall back to "the symbol with the greatest lineStart
    // ≤ line in this file" — typically the enclosing function/class.
    const sql = `SELECT s.id, s.name, s.kind, s.line_start
                 FROM symbols s
                 JOIN files f ON f.id = s.file_id
                 WHERE f.path = ? AND s.line_start <= ?
                 ORDER BY s.line_start DESC
                 LIMIT 5`;
    const rows = db.exec(sql, [file, line]);
    if (rows.length === 0) return [];
    return rows[0].values.map((r) => ({
        id: r[0] as number,
        name: r[1] as string,
        kind: r[2] as string,
        lineStart: r[3] as number,
    }));
}

interface EgoEdge {
    from: string;
    to: string;
    file: string;
    line: number;
    kind: "calls" | "called_by";
}

function egoGraph(
    db: ReturnType<typeof openSidecar>,
    seedSymbolIds: number[],
    depth: number,
    maxEdges: number,
): { nodes: Array<{ id: number; name: string; kind: string; file: string; line: number }>; edges: EgoEdge[] } {
    const nodes = new Map<number, { id: number; name: string; kind: string; file: string; line: number }>();
    const edges: EgoEdge[] = [];
    const frontier = new Set<number>(seedSymbolIds);
    const visited = new Set<number>();

    const resolveSymbol = (id: number): { name: string; kind: string; file: string; line: number } | null => {
        const r = db.exec(
            "SELECT s.name, s.kind, f.path, s.line_start FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?",
            [id],
        );
        if (r.length === 0 || r[0].values.length === 0) return null;
        const v = r[0].values[0];
        return { name: v[0] as string, kind: v[1] as string, file: v[2] as string, line: v[3] as number };
    };

    // Seed node hydration
    for (const id of frontier) {
        const info = resolveSymbol(id);
        if (info) nodes.set(id, { id, ...info });
    }

    for (let hop = 0; hop < depth && frontier.size > 0 && edges.length < maxEdges; hop++) {
        const nextFrontier = new Set<number>();
        for (const id of frontier) {
            if (visited.has(id)) continue;
            visited.add(id);

            // Outgoing calls (this symbol → others). Prefer resolved
            // to_symbol_id; fall back to callee_name → symbol.name lookup.
            const outgoing = db.exec(
                `SELECT c.to_symbol_id, c.callee_name, c.line, f.path
                 FROM calls c JOIN symbols fs ON fs.id = c.from_symbol_id
                 JOIN files f ON f.id = fs.file_id
                 WHERE c.from_symbol_id = ? LIMIT ?`,
                [id, Math.min(30, maxEdges - edges.length)],
            );
            if (outgoing.length > 0) {
                for (const r of outgoing[0].values) {
                    const toId = r[0] as number | null;
                    const calleeName = r[1] as string;
                    const line = r[2] as number;
                    const fromFile = r[3] as string;
                    const fromInfo = nodes.get(id);
                    if (!fromInfo) continue;
                    edges.push({ from: fromInfo.name, to: calleeName, file: fromFile, line, kind: "calls" });
                    if (toId != null && !visited.has(toId)) {
                        if (!nodes.has(toId)) {
                            const info = resolveSymbol(toId);
                            if (info) nodes.set(toId, { id: toId, ...info });
                        }
                        nextFrontier.add(toId);
                    }
                    if (edges.length >= maxEdges) break;
                }
            }
            if (edges.length >= maxEdges) break;

            // Incoming calls (others → this symbol). Join on callee_name.
            const incoming = db.exec(
                `SELECT c.from_symbol_id, c.line, ff.path, fs.name
                 FROM calls c
                 JOIN symbols fs ON fs.id = c.from_symbol_id
                 JOIN files ff ON ff.id = fs.file_id
                 JOIN symbols target ON target.id = ?
                 WHERE c.callee_name = target.name LIMIT ?`,
                [id, Math.min(30, maxEdges - edges.length)],
            );
            if (incoming.length > 0) {
                for (const r of incoming[0].values) {
                    const fromId = r[0] as number;
                    const line = r[1] as number;
                    const fromFile = r[2] as string;
                    const callerName = r[3] as string;
                    const toInfo = nodes.get(id);
                    if (!toInfo) continue;
                    edges.push({ from: callerName, to: toInfo.name, file: fromFile, line, kind: "called_by" });
                    if (!visited.has(fromId)) {
                        if (!nodes.has(fromId)) {
                            const info = resolveSymbol(fromId);
                            if (info) nodes.set(fromId, { id: fromId, ...info });
                        }
                        nextFrontier.add(fromId);
                    }
                    if (edges.length >= maxEdges) break;
                }
            }
        }
        frontier.clear();
        for (const id of nextFrontier) frontier.add(id);
    }

    return { nodes: Array.from(nodes.values()), edges };
}

function describeFile(
    db: ReturnType<typeof openSidecar>,
    file: string,
): { path: string; lang: string; loc: number; symbols: SymbolMatch[]; imports: string[]; importers: string[] } | null {
    const fileRow = db.exec("SELECT id, lang, loc FROM files WHERE path = ?", [file]);
    if (fileRow.length === 0 || fileRow[0].values.length === 0) return null;
    const fileId = fileRow[0].values[0][0] as number;
    const lang = fileRow[0].values[0][1] as string;
    const loc = fileRow[0].values[0][2] as number;

    const symsRow = db.exec(
        "SELECT name, kind, line_start, exported FROM symbols WHERE file_id = ? ORDER BY line_start",
        [fileId],
    );
    const symbols: SymbolMatch[] =
        symsRow.length > 0
            ? symsRow[0].values.map((r) => ({
                  name: r[0] as string,
                  kind: r[1] as string,
                  file,
                  lineStart: r[2] as number,
                  exported: (r[3] as number) === 1,
              }))
            : [];

    const impRow = db.exec("SELECT specifier FROM imports WHERE from_file_id = ?", [fileId]);
    const imports = impRow.length > 0 ? impRow[0].values.map((r) => r[0] as string) : [];

    const impByRow = db.exec(
        "SELECT f.path FROM imports i JOIN files f ON f.id = i.from_file_id WHERE i.to_file_id = ? ORDER BY f.path",
        [fileId],
    );
    const importers = impByRow.length > 0 ? impByRow[0].values.map((r) => r[0] as string) : [];

    return { path: file, lang, loc, symbols, imports, importers };
}

function fileNeighborhood(
    db: ReturnType<typeof openSidecar>,
    file: string,
    depth: number,
): { center: string; imports: string[]; importers: string[]; depth: number } {
    const desc = describeFile(db, file);
    if (!desc) return { center: file, imports: [], importers: [], depth };
    return { center: file, imports: desc.imports, importers: desc.importers, depth };
}

function dependencyChain(
    db: ReturnType<typeof openSidecar>,
    fromFile: string,
    toFile: string,
): { path: string[] | null } {
    // Recursive CTE walk through imports (best-effort). Cap depth at 6.
    const sql = `
        WITH RECURSIVE chain(cur_path, steps, depth) AS (
            SELECT path, path, 0 FROM files WHERE path = ?
            UNION ALL
            SELECT f2.path, chain.steps || '|' || f2.path, chain.depth + 1
            FROM chain
            JOIN files f1 ON f1.path = chain.cur_path
            JOIN imports i ON i.from_file_id = f1.id AND i.to_file_id IS NOT NULL
            JOIN files f2 ON f2.id = i.to_file_id
            WHERE chain.depth < 6 AND instr(chain.steps, f2.path) = 0
        )
        SELECT steps FROM chain WHERE cur_path = ? ORDER BY depth LIMIT 1
    `;
    const rows = db.exec(sql, [fromFile, toFile]);
    if (rows.length === 0 || rows[0].values.length === 0) return { path: null };
    const steps = (rows[0].values[0][0] as string).split("|");
    return { path: steps };
}

function architectureOverview(
    db: ReturnType<typeof openSidecar>,
    repoRoot: string,
): { mermaid: string; ascii: string; groups: Array<{ dir: string; files: number; symbols: number }> } {
    // Group files by top-2 directory segments.
    const rows = db.exec("SELECT path FROM files ORDER BY path");
    const group = new Map<string, { files: number }>();
    if (rows.length > 0) {
        for (const r of rows[0].values) {
            const p = r[0] as string;
            const segs = p.split(path.posix.sep);
            const key = segs.slice(0, Math.min(2, segs.length - 1)).join("/") || ".";
            const g = group.get(key) ?? { files: 0 };
            g.files++;
            group.set(key, g);
        }
    }
    const groups = Array.from(group.entries()).map(([dir, v]) => ({ dir, files: v.files, symbols: 0 }));
    for (const g of groups) {
        const cnt = db.exec("SELECT COUNT(*) FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path LIKE ?", [
            `${g.dir}/%`,
        ]);
        g.symbols = cnt.length > 0 ? (cnt[0].values[0][0] as number) : 0;
    }
    // Mermaid flowchart
    const mermaidLines = ["flowchart LR", `  root["${path.basename(repoRoot)}"]`];
    for (let i = 0; i < groups.length; i++) {
        mermaidLines.push(`  n${i}["${groups[i].dir}\\n${groups[i].files} files · ${groups[i].symbols} symbols"]`);
        mermaidLines.push(`  root --> n${i}`);
    }
    const mermaid = mermaidLines.join("\n");
    // ASCII tree
    const asciiLines = [path.basename(repoRoot)];
    for (let i = 0; i < groups.length; i++) {
        const last = i === groups.length - 1;
        asciiLines.push(
            `${last ? "└── " : "├── "}${groups[i].dir} (${groups[i].files} files, ${groups[i].symbols} symbols)`,
        );
    }
    const ascii = asciiLines.join("\n");
    return { mermaid, ascii, groups };
}

export const codebaseQueryTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "codebase_query",
            description: `Query the persistent codebase index. Eight operations:
- find_symbol(name, kind?)             → exact-name symbol definitions with file:line
- find_usages(name)                    → call-sites of a symbol across the repo
- search(query)                        → BM25 full-text search over symbol names + signatures + paths (NL-friendly)
- ego_graph(file, line, depth=2)       → BFS call-graph neighborhood around a file:line; pulls enclosing symbol + k-hop callers and callees (RepoGraph-style; great for fault localization)
- describe_file(file)                  → symbols, imports, importers for a file
- file_neighborhood(file, depth=1)     → imports + importers graph around a file
- architecture_overview()              → Mermaid + ASCII subsystem overview
- dependency_chain(from_file, to_file) → shortest import path between two files

Use 'search' when the user asks something like "how do we authenticate users" — it ranks on name + signature + file tokens. Use 'find_symbol' when you already know the exact identifier. Use 'ego_graph' when you're localizing a bug at a specific file:line and need to see the surrounding call structure.

Requires the index to exist. If not, returns { success: false } with a hint to run codebase_index build.`,
            parameters: {
                type: "object",
                properties: {
                    operation: {
                        type: "string",
                        enum: [
                            "find_symbol",
                            "find_usages",
                            "search",
                            "ego_graph",
                            "file_neighborhood",
                            "describe_file",
                            "architecture_overview",
                            "dependency_chain",
                        ],
                    },
                    name: { type: "string", description: "Symbol name (find_symbol / find_usages)" },
                    kind: { type: "string", description: "Symbol kind filter (find_symbol)" },
                    query: { type: "string", description: "Free-text search query (search)" },
                    limit: { type: "number", description: "Max results for 'search' (default 20, max 100)" },
                    file: {
                        type: "string",
                        description: "Repo-relative file path (describe_file / file_neighborhood / ego_graph)",
                    },
                    line: { type: "number", description: "1-based line number (ego_graph)" },
                    from_file: { type: "string", description: "Starting file (dependency_chain)" },
                    to_file: { type: "string", description: "Target file (dependency_chain)" },
                    depth: {
                        type: "number",
                        description: "Radius for file_neighborhood (default 1) and ego_graph (default 2)",
                    },
                    path: { type: "string", description: "Repo root (defaults to cwd)" },
                },
                required: ["operation"],
            },
        },
    },

    async handler(input: Record<string, unknown>): Promise<string> {
        const operation = String(input.operation ?? "");
        const root = typeof input.path === "string" && input.path ? input.path : process.cwd();
        try {
            const g = ensureIndex(root);
            if (!g.ok) return JSON.stringify({ success: false, error: g.error });
            if (operation === "find_symbol") {
                const name = String(input.name ?? "");
                if (!name) return JSON.stringify({ success: false, error: "name required" });
                const kind = typeof input.kind === "string" ? input.kind : undefined;
                return JSON.stringify({ success: true, matches: findSymbol(g.db, name, kind) });
            }
            if (operation === "find_usages") {
                const name = String(input.name ?? "");
                if (!name) return JSON.stringify({ success: false, error: "name required" });
                return JSON.stringify({ success: true, usages: findUsages(g.db, name) });
            }
            if (operation === "search") {
                const query = String(input.query ?? "").trim();
                if (!query) return JSON.stringify({ success: false, error: "query required" });
                const limit = Math.min(100, Math.max(1, Number(input.limit) || 20));
                const matches = searchSymbols(g.db, query, limit);
                if (matches.length === 0 && !ftsAvailable(g.db)) {
                    return JSON.stringify({
                        success: false,
                        error: "BM25 search unavailable — sidecar index predates 4L.2 schema. Re-run codebase_index build to populate the symbols_fts table.",
                    });
                }
                return JSON.stringify({ success: true, matches });
            }
            if (operation === "ego_graph") {
                const file = String(input.file ?? "");
                if (!file) return JSON.stringify({ success: false, error: "file required" });
                const line = Number(input.line);
                if (!Number.isFinite(line) || line < 1) {
                    return JSON.stringify({ success: false, error: "line (1-based) required" });
                }
                const depth = Math.min(4, Math.max(1, Number(input.depth) || 2));
                const seeds = symbolsNear(g.db, file, line);
                if (seeds.length === 0) {
                    return JSON.stringify({
                        success: false,
                        error: `No symbol definitions found at or before ${file}:${line}. Is the file indexed at 'calls' depth? Re-run codebase_index build with ATLAS_INDEX_DEPTH=calls.`,
                    });
                }
                const graph = egoGraph(g.db, seeds.map((s) => s.id), depth, 80);
                return JSON.stringify({
                    success: true,
                    seed: { file, line, enclosing: seeds[0] },
                    depth,
                    nodes: graph.nodes,
                    edges: graph.edges,
                });
            }
            if (operation === "describe_file") {
                const file = String(input.file ?? "");
                if (!file) return JSON.stringify({ success: false, error: "file required" });
                const d = describeFile(g.db, file);
                if (!d) return JSON.stringify({ success: false, error: `file not indexed: ${file}` });
                return JSON.stringify({ success: true, ...d });
            }
            if (operation === "file_neighborhood") {
                const file = String(input.file ?? "");
                if (!file) return JSON.stringify({ success: false, error: "file required" });
                const depth = typeof input.depth === "number" ? input.depth : 1;
                return JSON.stringify({ success: true, ...fileNeighborhood(g.db, file, depth) });
            }
            if (operation === "architecture_overview") {
                return JSON.stringify({ success: true, ...architectureOverview(g.db, g.repoRoot) });
            }
            if (operation === "dependency_chain") {
                const fromFile = String(input.from_file ?? "");
                const toFile = String(input.to_file ?? "");
                if (!fromFile || !toFile)
                    return JSON.stringify({ success: false, error: "from_file and to_file required" });
                return JSON.stringify({ success: true, ...dependencyChain(g.db, fromFile, toFile) });
            }
            return JSON.stringify({ success: false, error: `unknown operation: ${operation}` });
        } catch (err) {
            return JSON.stringify({ success: false, error: `codebase_query failed: ${(err as Error).message}` });
        }
    },
};
