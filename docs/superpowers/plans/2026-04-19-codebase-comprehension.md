# Codebase Comprehension Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a persistent per-repo codebase index, a queryable mindmap, a split AGENTS.md/.atlas/agents/*.md scaffold, local-only git read + write tools, and an agent-first-iteration hook that auto-triggers indexing and injects architecture overview — all additive, fail-open, with hard kill-switches.

**Architecture:** Hybrid storage — per-repo sidecar SQLite (`data/codebase-index/<repo_hash>.db`) for all structural data (files, symbols, imports, calls), plus selective cross-session observations in the existing `memories.db` knowledge-graph. Five new tools (`codebase_index`, `codebase_query`, `agents_md_scaffold`, `code_change_summary`, `git_op`). Walk-up project-memory loader extended to read AGENTS.md + `.atlas/agents/*.md` with task-type-aware selective injection.

**Tech Stack:** TypeScript (ESM, NodeNext), better-sqlite3 (sidecar), Node `child_process` (git), Node `crypto` (SHA-256), existing regex-based language patterns from `src/tools/repo-map.ts`, existing `auditLog()` + `isPathAllowed()` + `isProtectedPath()`, Mermaid (text output only — no renderer needed).

**Approved spec:** `/Users/user/Desktop/ATLAS/docs/superpowers/specs/2026-04-19-codebase-comprehension-design.md`

**Conventions inherited from the codebase** — every task follows these:
- ES modules, NodeNext, `.js` import extensions on every relative import (even on TS source). `import type` for type-only imports.
- Copyright header on every new `.ts` file:
  ```
  // Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
  // This software is proprietary. Copying or reuse is prohibited.
  // See LICENSE.md for details.
  ```
- Tool handlers always return `JSON.stringify({ success: boolean, ... })`.
- All filesystem writes go through `isPathAllowed()` + `isProtectedPath()` from `src/security/allowlist.js`; call `auditLog()` from `src/security/audit-log.js` on every mutation.
- Fail-open: wrap new subsystem call-sites in try/catch; log + continue, never throw up into the agent loop.
- Kill-switches: env vars default to "feature enabled" and are checked at the call site, not at module load.
- No test framework. "Tests" are scratch smoke scripts run via `npx tsx /tmp/smoke-<name>.mts` that `console.log` structured outputs.
- Lint: `npx biome check --write --unsafe <path>` after edits, then `npm run typecheck`, then `npm run build`. **Never** `npm run lint`.
- Commits: one NEW commit per task (never amend). Use HEREDOC format, end with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`. Stage specific files only (never `git add .`).

**Existing files to reuse (canonical references):**
- `src/memory/sqlite.ts` — exports `wrapDatabase()` (private in file) — **the plan pulls it out to a module-level export for reuse**; also defines `beginTransaction/commitTransaction/rollbackTransaction`.
- `src/memory/project-memory.ts` — 144 lines, full current walk-up loader. Extend `FILE_CANDIDATES`; add task-type-aware selective section loading via `<!-- @atlas:section:X -->` markers.
- `src/tools/repo-map.ts` — canonical per-language `PATTERNS`, language detection, and `parseGitignore()`. Extractors REUSE these via imports.
- `src/tools/index.ts` — all tools registered via `registry.set(tool.schema.function.name, tool)`.
- `src/agents/sub-agent.ts:61-71` — `ROLE_TOOLS.coder` array.
- `src/tool-router.ts:106-121` (`CATEGORIES.coding.tools`) and `:422+` (`KEYWORD_BOOSTS`).
- `src/agent.ts:~942+` — `<project_memory>` + `<repo_map>` injection block (Phase 3 + 4D).
- `src/security/allowlist.ts` — `isPathAllowed`, `isProtectedPath`, `getPathBlockedReason`.
- `src/security/audit-log.ts` — `auditLog(action, details)`.
- `src/memory/knowledge-graph.ts` — `addEntity`, `addRelationship`, `getKnowledgeGraphDB`.
- `src/memory/self-evolving.ts` — `synapticPrune` prunes only `memories` table; the plan adds a guard in the caller that skips `code_`-prefixed categories.
- `prompts/coding.md` — receives a new "Codebase comprehension" section + a "Git operations" section.
- `package.json` — `"better-sqlite3": "^12.6.2"` already installed.

---

## Task list overview

| # | Task | Commit message prefix |
|---|---|---|
| 1 | Export `wrapDatabase` from `src/memory/sqlite.ts` | `refactor(memory):` |
| 2 | `codebase-merkle.ts` — SHA-256 + repo root resolver | `feat(codebase-index):` |
| 3 | `codebase-sidecar.ts` — per-repo sidecar open/close | `feat(codebase-index):` |
| 4 | `code-parse/types.ts` + `code-parse/regex-extractors.ts` + `code-parse/index.ts` | `feat(codebase-index):` |
| 5 | `codebase-index.ts` core (build/refresh/stats/wipe, depth/timing pickers, walker) | `feat(codebase-index):` |
| 6 | `src/tools/coding/codebase-index.ts` tool handler | `feat(codebase-index):` |
| 7 | `src/tools/coding/codebase-query.ts` tool handler | `feat(codebase-query):` |
| 8 | `src/tools/coding/code-change-summary.ts` tool handler | `feat(git-read):` |
| 9 | `src/tools/coding/agents-md-scaffold.ts` tool handler | `feat(agents-md):` |
| 10 | Walk-up loader extension (`src/memory/project-memory.ts`) | `feat(project-memory):` |
| 11 | Knowledge-graph opt-out (`src/memory/self-evolving.ts`) | `feat(memory):` |
| 12 | `src/agent.ts` first-iteration auto-trigger + `<architecture>` injection | `feat(agent):` |
| 13 | `src/tools/coding/git-op.ts` tool handler | `feat(git-op):` |
| 14 | `prompts/coding.md` additions | `docs(coding):` |
| 15 | Router sync + sub-agent role + tools/index registration | `feat(router):` |
| 16 | Regression smoke matrix | `test(codebase):` |

Total: 16 tasks, 5 new tool files, 7 existing-file modifications, ~2500 LOC across sources + ~200 LOC across smoke scripts.

---


### Task 1: Export `wrapDatabase` from `src/memory/sqlite.ts`

**Files:**
- Modify: `src/memory/sqlite.ts:53` (change `function wrapDatabase` to `export function wrapDatabase`)
- Test: `/tmp/smoke-wrap-database-export.mts`

**Why:** The sidecar opener in Task 3 needs `wrapDatabase` to convert a fresh `better-sqlite3` instance into the `CompatDatabase` interface the rest of the memory subsystem uses. Today it's file-private.

- [ ] **Step 1: Write the failing smoke script**

`/tmp/smoke-wrap-database-export.mts`:
```typescript
// Smoke: verify wrapDatabase is exported from sqlite.ts
import { wrapDatabase } from "/Users/user/Desktop/ATLAS/src/memory/sqlite.ts";
import BetterSqlite3 from "better-sqlite3";

const raw = new BetterSqlite3(":memory:");
const db = wrapDatabase(raw);
db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
db.run("INSERT INTO t (v) VALUES (?)", ["hello"]);
const rows = db.exec("SELECT v FROM t");
console.log("rows:", JSON.stringify(rows));
if (rows.length !== 1 || rows[0].values[0][0] !== "hello") {
    console.error("FAIL: unexpected rows");
    process.exit(1);
}
console.log("PASS: wrapDatabase exported and round-trips");
db.close();
```

- [ ] **Step 2: Run smoke to verify it fails**

```bash
npx tsx /tmp/smoke-wrap-database-export.mts
```
Expected: TypeScript / runtime import error `"wrapDatabase" has no exported member` because it's currently file-private.

- [ ] **Step 3: Modify `src/memory/sqlite.ts`**

```typescript
// OLD (line 53):
function wrapDatabase(raw: BetterSqlite3.Database): CompatDatabase {
// NEW:
export function wrapDatabase(raw: BetterSqlite3.Database): CompatDatabase {
```

Use Edit with `old_string: "function wrapDatabase(raw: BetterSqlite3.Database): CompatDatabase"` and `new_string: "export function wrapDatabase(raw: BetterSqlite3.Database): CompatDatabase"`.

- [ ] **Step 4: Run smoke to verify pass**

```bash
npx tsx /tmp/smoke-wrap-database-export.mts
```
Expected output:
```
rows: [{"columns":["v"],"values":[["hello"]]}]
PASS: wrapDatabase exported and round-trips
```

- [ ] **Step 5: Lint + typecheck + build**

```bash
npx biome check --write --unsafe /Users/user/Desktop/ATLAS/src/memory/sqlite.ts
npm run typecheck
npm run build
```
Expected: all clean. Build completes without errors.

- [ ] **Step 6: Commit**

```bash
git add src/memory/sqlite.ts
git commit -m "$(cat <<'EOF'
refactor(memory): export wrapDatabase for sidecar reuse

Phase 4L prep: the per-repo codebase-index sidecar needs to wrap its
own better-sqlite3 instance into the project's CompatDatabase interface.
No behavior change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `codebase-merkle.ts` — SHA-256 + repo root resolver

**Files:**
- Create: `src/memory/codebase-merkle.ts`
- Test: `/tmp/smoke-codebase-merkle.mts`

**Why:** Merkle-style dirty detection + per-repo keying. Every sidecar lookup needs `resolveRepoRoot(cwd)` (git rev-parse → fallback to cwd) and `repoHash(root)` (16-char SHA-256 prefix). File-level dirty detection uses `sha256File(path)` against `files.sha256` row to skip unchanged files on refresh.

- [ ] **Step 1: Write the failing smoke script**

`/tmp/smoke-codebase-merkle.mts`:
```typescript
import { resolveRepoRoot, repoHash, sha256File, sha256String } from "/Users/user/Desktop/ATLAS/src/memory/codebase-merkle.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// 1. sha256String is deterministic
const h1 = sha256String("hello");
const h2 = sha256String("hello");
if (h1 !== h2 || h1.length !== 64) {
    console.error("FAIL: sha256String not deterministic or wrong length:", h1);
    process.exit(1);
}

// 2. sha256File returns a 64-char hex and matches manual calc
const tmp = path.join(os.tmpdir(), "atlas-merkle-smoke.txt");
fs.writeFileSync(tmp, "world");
const fh = sha256File(tmp);
const expected = sha256String("world");
if (fh !== expected) {
    console.error(`FAIL: sha256File=${fh} expected=${expected}`);
    process.exit(1);
}
fs.unlinkSync(tmp);

// 3. resolveRepoRoot on the ATLAS repo gives the repo root
const atlas = "/Users/user/Desktop/ATLAS";
const root = resolveRepoRoot(atlas);
if (root !== atlas) {
    console.error(`FAIL: resolveRepoRoot=${root} expected=${atlas}`);
    process.exit(1);
}

// 4. resolveRepoRoot on a non-git dir falls back to cwd
const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "nogit-"));
const fallback = resolveRepoRoot(nonGit);
if (fallback !== nonGit) {
    console.error(`FAIL: non-git fallback=${fallback} expected=${nonGit}`);
    process.exit(1);
}
fs.rmdirSync(nonGit);

// 5. repoHash is 16 chars hex and deterministic
const rh1 = repoHash(atlas);
const rh2 = repoHash(atlas);
if (rh1 !== rh2 || rh1.length !== 16) {
    console.error(`FAIL: repoHash=${rh1} unstable or wrong length`);
    process.exit(1);
}
console.log("PASS: sha256String/sha256File/resolveRepoRoot/repoHash all correct");
console.log(`atlas root=${root} hash=${rh1}`);
```

- [ ] **Step 2: Run smoke to verify it fails**

```bash
npx tsx /tmp/smoke-codebase-merkle.mts
```
Expected: `Cannot find module` error — the file doesn't exist yet.

- [ ] **Step 3: Create `src/memory/codebase-merkle.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Codebase Merkle Helpers ───────────────────
// SHA-256 hashing for content-based dirty detection, plus repo-root
// resolution (git rev-parse → cwd fallback) and per-repo keying.
// All helpers are pure + fail-open: any error returns a safe default.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** SHA-256 hex digest of an arbitrary string. Always 64 chars lowercase. */
export function sha256String(input: string): string {
    return createHash("sha256").update(input).digest("hex");
}

/**
 * SHA-256 hex digest of a file's contents. Returns an empty string on any
 * read error so callers can treat it as "unknown" without throwing.
 */
export function sha256File(filePath: string): string {
    try {
        const buf = fs.readFileSync(filePath);
        return createHash("sha256").update(buf).digest("hex");
    } catch {
        return "";
    }
}

/**
 * Resolve the git repo root for a directory. Runs `git rev-parse --show-toplevel`
 * with a 1s timeout; on any failure (non-git, git unavailable, timeout) falls
 * back to the resolved input directory.
 */
export function resolveRepoRoot(startDir: string): string {
    const dir = path.resolve(startDir);
    try {
        const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
            cwd: dir,
            encoding: "utf-8",
            timeout: 1000,
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (out && fs.existsSync(out)) return out;
    } catch {
        /* fall through */
    }
    return dir;
}

/** 16-char lowercase hex prefix of SHA-256(repoRoot). Used to key sidecar DBs. */
export function repoHash(repoRoot: string): string {
    return sha256String(path.resolve(repoRoot)).slice(0, 16);
}

/** True when the git command is available on PATH. */
export function gitAvailable(): boolean {
    try {
        execFileSync("git", ["--version"], {
            timeout: 500,
            stdio: ["ignore", "ignore", "ignore"],
        });
        return true;
    } catch {
        return false;
    }
}
```

- [ ] **Step 4: Run smoke to verify pass**

```bash
npx tsx /tmp/smoke-codebase-merkle.mts
```
Expected output:
```
PASS: sha256String/sha256File/resolveRepoRoot/repoHash all correct
atlas root=/Users/user/Desktop/ATLAS hash=<16-hex-chars>
```

- [ ] **Step 5: Lint + typecheck + build**

```bash
npx biome check --write --unsafe /Users/user/Desktop/ATLAS/src/memory/codebase-merkle.ts
npm run typecheck
npm run build
```
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add src/memory/codebase-merkle.ts
git commit -m "$(cat <<'EOF'
feat(codebase-index): add Merkle helpers and repo-root resolver

Introduces sha256String/sha256File/resolveRepoRoot/repoHash under
src/memory/codebase-merkle.ts. Fail-open: git errors fall back to cwd;
read errors return empty hash. Foundation for per-repo sidecar keying
and file-level dirty detection in Phase 4L.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `codebase-sidecar.ts` — per-repo sidecar open/close

**Files:**
- Create: `src/memory/codebase-sidecar.ts`
- Test: `/tmp/smoke-codebase-sidecar.mts`

**Why:** Centralizes sidecar lifecycle. Given a repo root, opens/creates `data/codebase-index/<repo_hash>.db`, runs the schema on first open, runs `PRAGMA integrity_check` on every open, rebuilds on corruption, and returns the wrapped `CompatDatabase`. Per-process handle cache keyed by hash so repeated queries don't re-open.

- [ ] **Step 1: Write the failing smoke script**

`/tmp/smoke-codebase-sidecar.mts`:
```typescript
import { openSidecar, closeSidecar, sidecarPathFor, hasSidecar } from "/Users/user/Desktop/ATLAS/src/memory/codebase-sidecar.ts";
import fs from "node:fs";

const root = "/Users/user/Desktop/ATLAS";
const p = sidecarPathFor(root);
console.log("sidecar path:", p);

// Open once, tables should exist
const db = openSidecar(root);
const files = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
const tables = files[0]?.values.map(r => r[0] as string) ?? [];
console.log("tables:", tables.join(","));
const required = ["calls", "files", "imports", "index_meta", "parse_errors", "symbols"];
for (const t of required) {
    if (!tables.includes(t)) {
        console.error(`FAIL: missing table ${t}`);
        process.exit(1);
    }
}

// hasSidecar is true
if (!hasSidecar(root)) {
    console.error("FAIL: hasSidecar returned false after open");
    process.exit(1);
}

// Insert + read-back round-trips
db.run("INSERT INTO files (path, sha256, lang, loc, indexed_at) VALUES (?, ?, ?, ?, ?)",
       ["smoke-test.ts", "deadbeef", "typescript", 10, Date.now()]);
const rows = db.exec("SELECT path FROM files WHERE sha256 = ?", ["deadbeef"]);
if (rows.length !== 1 || rows[0].values[0][0] !== "smoke-test.ts") {
    console.error("FAIL: row round-trip");
    process.exit(1);
}

// Re-open returns same instance (cache)
const db2 = openSidecar(root);
if (db !== db2) {
    console.error("FAIL: openSidecar did not cache handle");
    process.exit(1);
}

closeSidecar(root);
// After close the file still exists
if (!fs.existsSync(p)) {
    console.error("FAIL: sidecar file missing after close");
    process.exit(1);
}

// Cleanup the smoke row so subsequent runs are idempotent
const db3 = openSidecar(root);
db3.run("DELETE FROM files WHERE path = ?", ["smoke-test.ts"]);
closeSidecar(root);

console.log("PASS: openSidecar + cache + round-trip all work");
```

- [ ] **Step 2: Run smoke to verify it fails**

```bash
npx tsx /tmp/smoke-codebase-sidecar.mts
```
Expected: `Cannot find module`.

- [ ] **Step 3: Create `src/memory/codebase-sidecar.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Codebase Sidecar SQLite ───────────────────
// Per-repo sidecar database at data/codebase-index/<repo_hash>.db.
// Owns schema creation, integrity check, corruption recovery, and a
// per-process handle cache. Fail-open: any error returns a best-effort
// database (potentially empty) rather than throwing.

import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { wrapDatabase, type Database } from "./sqlite.js";
import { repoHash } from "./codebase-merkle.js";

/** Version bump forces a full sidecar rebuild on next open. */
export const SIDECAR_SCHEMA_VERSION = "4L.1";

const DATA_DIR = process.env.ATLAS_DATA_DIR || path.resolve("data");
const SIDECAR_DIR = path.join(DATA_DIR, "codebase-index");

// Module-level handle cache keyed by repo hash.
const cache = new Map<string, { db: Database; raw: BetterSqlite3.Database; root: string }>();

/** Absolute path to the sidecar DB file for a repo root. */
export function sidecarPathFor(repoRoot: string): string {
    return path.join(SIDECAR_DIR, `${repoHash(repoRoot)}.db`);
}

/** True when a sidecar file exists for the given repo root. */
export function hasSidecar(repoRoot: string): boolean {
    try {
        return fs.existsSync(sidecarPathFor(repoRoot));
    } catch {
        return false;
    }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS files (
    id         INTEGER PRIMARY KEY,
    path       TEXT UNIQUE NOT NULL,
    sha256     TEXT NOT NULL,
    lang       TEXT NOT NULL,
    loc        INTEGER NOT NULL,
    workspace  TEXT,
    indexed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS symbols (
    id         INTEGER PRIMARY KEY,
    file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL,
    line_start INTEGER NOT NULL,
    line_end   INTEGER,
    signature  TEXT,
    exported   INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS imports (
    id           INTEGER PRIMARY KEY,
    from_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    to_file_id   INTEGER REFERENCES files(id) ON DELETE SET NULL,
    specifier    TEXT NOT NULL,
    line         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS calls (
    id             INTEGER PRIMARY KEY,
    from_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
    to_symbol_id   INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
    callee_name    TEXT NOT NULL,
    line           INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS parse_errors (
    file_id                INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    error                  TEXT NOT NULL,
    skip_until_hash_change TEXT NOT NULL,
    recorded_at            INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS index_meta (
    repo_root         TEXT PRIMARY KEY,
    repo_hash         TEXT NOT NULL,
    depth             TEXT NOT NULL,
    depth_auto        INTEGER NOT NULL,
    file_count        INTEGER NOT NULL,
    symbol_count      INTEGER NOT NULL,
    created_at        INTEGER NOT NULL,
    last_refreshed_at INTEGER NOT NULL,
    tool_version      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_imports_from ON imports(from_file_id);
CREATE INDEX IF NOT EXISTS idx_imports_to   ON imports(to_file_id);
CREATE INDEX IF NOT EXISTS idx_calls_from   ON calls(from_symbol_id);
CREATE INDEX IF NOT EXISTS idx_calls_to     ON calls(to_symbol_id);
`;

function runSchema(raw: BetterSqlite3.Database): void {
    raw.exec(SCHEMA_SQL);
}

function ensureDir(): void {
    try {
        if (!fs.existsSync(SIDECAR_DIR)) fs.mkdirSync(SIDECAR_DIR, { recursive: true });
    } catch {
        /* fail-open */
    }
}

function wipeFile(p: string): void {
    try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
        /* ignore */
    }
}

/**
 * Open (or create) the sidecar SQLite for a repo root. Integrity is checked
 * on every open; on failure the DB is deleted + recreated. The handle is
 * cached per-process keyed by repo hash.
 */
export function openSidecar(repoRoot: string): Database {
    const hash = repoHash(repoRoot);
    const cached = cache.get(hash);
    if (cached) return cached.db;

    ensureDir();
    const p = sidecarPathFor(repoRoot);

    let raw: BetterSqlite3.Database;
    try {
        raw = new BetterSqlite3(p);
        // Integrity check — on failure wipe + retry.
        const check = raw.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
        if (!check || check.integrity_check !== "ok") {
            raw.close();
            wipeFile(p);
            raw = new BetterSqlite3(p);
        }
    } catch {
        wipeFile(p);
        raw = new BetterSqlite3(p);
    }

    // Pragmas: WAL for concurrency, NORMAL sync (sidecar is throwaway).
    try { raw.pragma("journal_mode = WAL"); } catch { /* */ }
    try { raw.pragma("synchronous = NORMAL"); } catch { /* */ }
    try { raw.pragma("foreign_keys = ON"); } catch { /* */ }

    runSchema(raw);

    // Schema version check: drop + rebuild on mismatch.
    try {
        const meta = raw.prepare("SELECT tool_version FROM index_meta WHERE repo_root = ?").get(repoRoot) as
            { tool_version?: string } | undefined;
        if (meta && meta.tool_version && meta.tool_version !== SIDECAR_SCHEMA_VERSION) {
            raw.close();
            wipeFile(p);
            raw = new BetterSqlite3(p);
            try { raw.pragma("journal_mode = WAL"); } catch { /* */ }
            try { raw.pragma("foreign_keys = ON"); } catch { /* */ }
            runSchema(raw);
        }
    } catch {
        /* first-open: no meta row yet */
    }

    const db = wrapDatabase(raw);
    cache.set(hash, { db, raw, root: repoRoot });
    return db;
}

/** Close the sidecar handle for a repo root (if cached) and evict the cache entry. */
export function closeSidecar(repoRoot: string): void {
    const hash = repoHash(repoRoot);
    const entry = cache.get(hash);
    if (!entry) return;
    try { entry.raw.close(); } catch { /* */ }
    cache.delete(hash);
}

/** Close every cached sidecar handle. Used at process shutdown. */
export function closeAllSidecars(): void {
    for (const [hash, entry] of cache.entries()) {
        try { entry.raw.close(); } catch { /* */ }
        cache.delete(hash);
    }
}

/** Delete the sidecar DB file entirely and evict cache. */
export function wipeSidecar(repoRoot: string): void {
    closeSidecar(repoRoot);
    wipeFile(sidecarPathFor(repoRoot));
}
```

- [ ] **Step 4: Run smoke to verify pass**

```bash
npx tsx /tmp/smoke-codebase-sidecar.mts
```
Expected output:
```
sidecar path: /Users/user/Desktop/ATLAS/data/codebase-index/<hash>.db
tables: calls,files,imports,index_meta,parse_errors,symbols
PASS: openSidecar + cache + round-trip all work
```

- [ ] **Step 5: Lint + typecheck + build**

```bash
npx biome check --write --unsafe /Users/user/Desktop/ATLAS/src/memory/codebase-sidecar.ts
npm run typecheck
npm run build
```
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add src/memory/codebase-sidecar.ts
git commit -m "$(cat <<'EOF'
feat(codebase-index): add per-repo sidecar SQLite opener

Creates/open data/codebase-index/<repo_hash>.db with full schema
(files, symbols, imports, calls, parse_errors, index_meta). WAL mode,
integrity_check on every open with corruption recovery, schema-version
guard, per-process handle cache. Foundation for the build/refresh core.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `code-parse/` — shared types, regex extractors, and dispatcher

**Files:**
- Create: `src/memory/code-parse/types.ts`
- Create: `src/memory/code-parse/regex-extractors.ts`
- Create: `src/memory/code-parse/index.ts`
- Test: `/tmp/smoke-parse-ts.mts`

**Why:** The per-file parser. `types.ts` defines the shared shapes (`ExtractedSymbol`, `ExtractedImport`, `ExtractedCall`, `ParseResult`). `regex-extractors.ts` layers on top of `src/tools/repo-map.ts` `PATTERNS` (symbols) and adds the two things repo-map lacks: imports and calls. `index.ts` is the language-dispatching entry point. Cap per-file at 100KB + skip LFS pointers.

- [ ] **Step 1: Write the failing smoke script**

`/tmp/smoke-parse-ts.mts`:
```typescript
import { parseFile } from "/Users/user/Desktop/ATLAS/src/memory/code-parse/index.ts";

const src = `
import { foo } from "./lib/foo.js";
import type { Bar } from "./types.js";
import { a, b } from "external-pkg";

export function hello(name: string): string {
    const g = greet(name);
    return g + log(name);
}

export class Greeter {
    greet(x: string) {
        return hello(x);
    }
}

export interface IPerson { id: number }
export type Age = number;
export enum Color { Red, Green }
`;

const res = parseFile("typescript", "/tmp/fake.ts", src);
console.log("symbols:", res.symbols.map(s => \`\${s.kind}:\${s.name}\`).sort().join(","));
console.log("imports:", res.imports.map(i => i.specifier).sort().join(","));
console.log("calls:", res.calls.map(c => c.calleeName).sort().join(","));

const names = new Set(res.symbols.map(s => s.name));
const required = ["hello", "Greeter", "IPerson", "Age", "Color"];
for (const r of required) {
    if (!names.has(r)) {
        console.error(\`FAIL: missing symbol \${r}\`);
        process.exit(1);
    }
}

if (res.symbols.find(s => s.name === "hello")?.lineStart !== 6) {
    console.error("FAIL: hello lineStart wrong");
    process.exit(1);
}

if (!res.imports.find(i => i.specifier === "./lib/foo.js")) {
    console.error("FAIL: missing import ./lib/foo.js");
    process.exit(1);
}

// calls: we expect greet, log, hello
const callees = new Set(res.calls.map(c => c.calleeName));
if (!callees.has("greet") || !callees.has("log")) {
    console.error("FAIL: calls missing greet/log:", [...callees].join(","));
    process.exit(1);
}

console.log("PASS: TS fixture parsed correctly");
```

- [ ] **Step 2: Run smoke to verify it fails**

```bash
npx tsx /tmp/smoke-parse-ts.mts
```
Expected: `Cannot find module`.

- [ ] **Step 3: Create `src/memory/code-parse/types.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Code Parse Shared Types ───────────────────
// Types produced by every language extractor and consumed by the
// indexer. Keep these stable — changing them forces a sidecar rebuild.

export type SymbolKind =
    | "function"
    | "class"
    | "method"
    | "interface"
    | "type"
    | "enum"
    | "export"
    | "trait"
    | "struct"
    | "module"
    | "constant"
    | "variable";

export interface ExtractedSymbol {
    name: string;
    kind: SymbolKind;
    lineStart: number;
    lineEnd: number | null;
    signature: string | null;
    exported: boolean;
}

export interface ExtractedImport {
    specifier: string;
    line: number;
}

export interface ExtractedCall {
    fromSymbolName: string | null; // null when call is module-top-level
    calleeName: string;
    line: number;
}

export interface ParseResult {
    symbols: ExtractedSymbol[];
    imports: ExtractedImport[];
    calls: ExtractedCall[];
    loc: number;
    truncated: boolean;
    error: string | null;
}

export type Language =
    | "typescript" | "javascript" | "python" | "rust" | "go" | "java"
    | "c" | "cpp" | "csharp" | "ruby" | "swift" | "kotlin" | "php"
    | "shell" | "lua" | "file-only";

export const KEYWORD_NAMES = new Set([
    "if", "else", "for", "while", "switch", "case", "try", "catch",
    "return", "throw", "new", "delete", "typeof", "instanceof",
    "constructor", "do", "with", "async", "await", "yield", "const",
    "let", "var", "function", "class", "interface", "type", "enum",
    "import", "export", "from", "as", "break", "continue", "default",
    "finally", "in", "of", "this", "super", "public", "private",
    "protected", "static", "abstract", "readonly",
]);
```

- [ ] **Step 4: Create `src/memory/code-parse/regex-extractors.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Regex Extractors ──────────────────────────
// Thin layer over src/tools/repo-map.ts PATTERNS for symbol extraction,
// plus patterns repo-map lacks: imports and calls. Line-by-line regex
// (no backtracking risk). Strings + comments stripped for imports/calls.

import type {
    ExtractedSymbol,
    ExtractedImport,
    ExtractedCall,
    Language,
    SymbolKind,
} from "./types.js";
import { KEYWORD_NAMES } from "./types.js";

// ── Symbol patterns (duplicated inline for direct control) ──
// Mirrors src/tools/repo-map.ts PATTERNS but typed against our SymbolKind.

interface SymbolPattern { regex: RegExp; kind: SymbolKind; exportGroup?: boolean }

const SYMBOL_PATTERNS: Record<Language, SymbolPattern[]> = {
    typescript: [
        { regex: /^(export\s+)?(?:async\s+)?function\s+(\w+)/, kind: "function", exportGroup: true },
        { regex: /^(export\s+)?(?:abstract\s+)?class\s+(\w+)/, kind: "class", exportGroup: true },
        { regex: /^(export\s+)?interface\s+(\w+)/, kind: "interface", exportGroup: true },
        { regex: /^(export\s+)?type\s+(\w+)\s*[=<]/, kind: "type", exportGroup: true },
        { regex: /^(export\s+)?enum\s+(\w+)/, kind: "enum", exportGroup: true },
        { regex: /^(export\s+)?const\s+(\w+)\s*[=:]/, kind: "constant", exportGroup: true },
        { regex: /^(export\s+)?(?:let|var)\s+(\w+)\s*[=:]/, kind: "variable", exportGroup: true },
        { regex: /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/, kind: "method" },
        { regex: /^\s+(?:public|private|protected)\s+(?:static\s+)?(?:async\s+)?(\w+)\s*[(<]/, kind: "method" },
    ],
    javascript: [
        { regex: /^(export\s+)?(?:async\s+)?function\s+(\w+)/, kind: "function", exportGroup: true },
        { regex: /^(export\s+)?class\s+(\w+)/, kind: "class", exportGroup: true },
        { regex: /^(export\s+)?const\s+(\w+)\s*=/, kind: "constant", exportGroup: true },
        { regex: /^(export\s+)?(?:let|var)\s+(\w+)\s*=/, kind: "variable", exportGroup: true },
        { regex: /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/, kind: "method" },
    ],
    python: [
        { regex: /^(?:async\s+)?def\s+(\w+)/, kind: "function" },
        { regex: /^class\s+(\w+)/, kind: "class" },
        { regex: /^\s{4}(?:async\s+)?def\s+(\w+)/, kind: "method" },
        { regex: /^([A-Z][A-Z_0-9]+)\s*=/, kind: "constant" },
    ],
    rust: [
        { regex: /^(?:pub(?:\(crate\))?\s+)?(?:async\s+)?fn\s+(\w+)/, kind: "function" },
        { regex: /^(?:pub(?:\(crate\))?\s+)?struct\s+(\w+)/, kind: "struct" },
        { regex: /^(?:pub(?:\(crate\))?\s+)?enum\s+(\w+)/, kind: "enum" },
        { regex: /^(?:pub(?:\(crate\))?\s+)?trait\s+(\w+)/, kind: "trait" },
        { regex: /^(?:pub(?:\(crate\))?\s+)?type\s+(\w+)/, kind: "type" },
        { regex: /^(?:pub(?:\(crate\))?\s+)?mod\s+(\w+)/, kind: "module" },
        { regex: /^\s+(?:pub(?:\(crate\))?\s+)?(?:async\s+)?fn\s+(\w+)/, kind: "method" },
        { regex: /^(?:pub(?:\(crate\))?\s+)?const\s+(\w+)/, kind: "constant" },
    ],
    go: [
        { regex: /^func\s+(\w+)/, kind: "function" },
        { regex: /^func\s+\(\w+\s+\*?\w+\)\s+(\w+)/, kind: "method" },
        { regex: /^type\s+(\w+)\s+struct/, kind: "struct" },
        { regex: /^type\s+(\w+)\s+interface/, kind: "interface" },
        { regex: /^type\s+(\w+)\s+/, kind: "type" },
        { regex: /^const\s+(\w+)\s+/, kind: "constant" },
    ],
    java: [
        { regex: /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?class\s+(\w+)/, kind: "class" },
        { regex: /^\s*(?:public|private|protected)\s+(?:static\s+)?interface\s+(\w+)/, kind: "interface" },
        { regex: /^\s*(?:public|private|protected)\s+(?:static\s+)?enum\s+(\w+)/, kind: "enum" },
        { regex: /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:synchronized\s+)?(?:final\s+)?(?:[\w<>\[\],\s]+)\s+(\w+)\s*\(/, kind: "method" },
    ],
    c: [
        { regex: /^(?:static\s+)?(?:inline\s+)?(?:const\s+)?(?:unsigned\s+)?(?:void|int|char|float|double|long|short|size_t|bool|\w+_t|\w+\s*\*)\s+(\w+)\s*\(/, kind: "function" },
        { regex: /^struct\s+(\w+)\s*\{/, kind: "struct" },
    ],
    cpp: [
        { regex: /^(?:virtual\s+)?(?:static\s+)?(?:inline\s+)?(?:const\s+)?(?:[\w:]+(?:<[^>]*>)?[\s*&]+)(\w+)\s*\(/, kind: "function" },
        { regex: /^(?:template\s*<[^>]*>\s*)?class\s+(\w+)/, kind: "class" },
        { regex: /^(?:template\s*<[^>]*>\s*)?struct\s+(\w+)/, kind: "struct" },
        { regex: /^namespace\s+(\w+)/, kind: "module" },
        { regex: /^enum\s+(?:class\s+)?(\w+)/, kind: "enum" },
    ],
    csharp: [
        { regex: /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?(?:partial\s+)?class\s+(\w+)/, kind: "class" },
        { regex: /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?interface\s+(\w+)/, kind: "interface" },
        { regex: /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?enum\s+(\w+)/, kind: "enum" },
        { regex: /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?(?:async\s+)?(?:[\w<>\[\]]+)\s+(\w+)\s*\(/, kind: "method" },
        { regex: /^namespace\s+(\w+)/, kind: "module" },
    ],
    ruby: [
        { regex: /^\s*def\s+(?:self\.)?(\w+)/, kind: "function" },
        { regex: /^\s*class\s+(\w+)/, kind: "class" },
        { regex: /^\s*module\s+(\w+)/, kind: "module" },
    ],
    swift: [
        { regex: /^\s*(?:public\s+|private\s+|internal\s+|open\s+)?func\s+(\w+)/, kind: "function" },
        { regex: /^\s*(?:public\s+|private\s+|internal\s+|open\s+)?class\s+(\w+)/, kind: "class" },
        { regex: /^\s*(?:public\s+|private\s+|internal\s+|open\s+)?struct\s+(\w+)/, kind: "struct" },
        { regex: /^\s*(?:public\s+|private\s+|internal\s+|open\s+)?enum\s+(\w+)/, kind: "enum" },
        { regex: /^\s*(?:public\s+|private\s+|internal\s+|open\s+)?protocol\s+(\w+)/, kind: "interface" },
    ],
    kotlin: [
        { regex: /^\s*(?:public\s+|private\s+|internal\s+|protected\s+)?(?:suspend\s+)?fun\s+(\w+)/, kind: "function" },
        { regex: /^\s*(?:public\s+|private\s+|internal\s+|protected\s+)?(?:data\s+|sealed\s+|abstract\s+)?class\s+(\w+)/, kind: "class" },
        { regex: /^\s*(?:public\s+|private\s+|internal\s+|protected\s+)?interface\s+(\w+)/, kind: "interface" },
        { regex: /^\s*(?:public\s+|private\s+|internal\s+|protected\s+)?enum\s+class\s+(\w+)/, kind: "enum" },
    ],
    php: [
        { regex: /^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?function\s+(\w+)/, kind: "function" },
        { regex: /^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/, kind: "class" },
        { regex: /^\s*interface\s+(\w+)/, kind: "interface" },
        { regex: /^\s*trait\s+(\w+)/, kind: "trait" },
    ],
    shell: [
        { regex: /^(\w+)\s*\(\)\s*\{/, kind: "function" },
        { regex: /^function\s+(\w+)/, kind: "function" },
    ],
    lua: [
        { regex: /^(?:local\s+)?function\s+(\w[\w.]*)/, kind: "function" },
    ],
    "file-only": [],
};

// ── Import patterns (per language) ──

const IMPORT_PATTERNS: Record<Language, RegExp[]> = {
    typescript: [
        /^\s*import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\w+))?\s+from\s+['"]([^'"]+)['"]/,
        /^\s*import\s+['"]([^'"]+)['"]/,
        /^\s*(?:const|let|var)\s+\w+\s*=\s*require\(['"]([^'"]+)['"]\)/,
        /^\s*export\s+\*\s+from\s+['"]([^'"]+)['"]/,
        /^\s*export\s+\{[^}]*\}\s+from\s+['"]([^'"]+)['"]/,
    ],
    javascript: [
        /^\s*import\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\w+))?\s+from\s+['"]([^'"]+)['"]/,
        /^\s*import\s+['"]([^'"]+)['"]/,
        /^\s*(?:const|let|var)\s+\w+\s*=\s*require\(['"]([^'"]+)['"]\)/,
    ],
    python: [
        /^\s*from\s+([\w.]+)\s+import/,
        /^\s*import\s+([\w.]+)/,
    ],
    rust: [
        /^\s*use\s+([\w:]+)/,
        /^\s*(?:pub\s+)?extern\s+crate\s+(\w+)/,
    ],
    go: [
        /^\s*import\s+"([^"]+)"/,
        /^\s*import\s+\(\s*$/,
    ],
    java: [/^\s*import\s+([\w.]+)/],
    c: [/^\s*#include\s+[<"]([^>"]+)[>"]/],
    cpp: [/^\s*#include\s+[<"]([^>"]+)[>"]/],
    csharp: [/^\s*using\s+([\w.]+)/],
    ruby: [/^\s*require\s+['"]([^'"]+)['"]/, /^\s*require_relative\s+['"]([^'"]+)['"]/],
    swift: [/^\s*import\s+(\w+)/],
    kotlin: [/^\s*import\s+([\w.]+)/],
    php: [/^\s*use\s+([\w\\]+)/, /^\s*require(?:_once)?\s+['"]([^'"]+)['"]/],
    shell: [/^\s*(?:source|\.)\s+([^\s;]+)/],
    lua: [/^\s*(?:local\s+\w+\s*=\s*)?require\s*\(?['"]([^'"]+)['"]\)?/],
    "file-only": [],
};

// ── Call patterns (best-effort — only for full-tier languages) ──

const CALL_PATTERN = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

// Languages where we attempt call extraction.
const CALL_LANGS = new Set<Language>([
    "typescript", "javascript", "python", "rust", "go", "java",
    "csharp", "swift", "kotlin", "ruby", "php",
]);

// ── Utilities: strip strings and line comments ──

function stripStringsAndComments(line: string, lang: Language): string {
    let out = line;
    // Strip // and # line comments (language-aware)
    const hashLangs: Language[] = ["python", "ruby", "shell"];
    if (hashLangs.includes(lang)) {
        out = out.replace(/#.*$/, "");
    } else {
        out = out.replace(/\/\/.*$/, "");
    }
    // Strip quoted strings: "...", '...', `...`
    out = out.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    out = out.replace(/'(?:[^'\\]|\\.)*'/g, "''");
    out = out.replace(/`(?:[^`\\]|\\.)*`/g, "``");
    return out;
}

// ── Public extractors ──

export function extractSymbols(lang: Language, content: string): ExtractedSymbol[] {
    const patterns = SYMBOL_PATTERNS[lang];
    if (!patterns || patterns.length === 0) return [];
    const lines = content.split("\n");
    const out: ExtractedSymbol[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const p of patterns) {
            const m = p.regex.exec(line);
            if (!m) continue;
            // Captured name is the last non-empty group (1 or 2 depending on pattern).
            const name = (m[2] && m[2].length > 0) ? m[2] : m[1];
            if (!name || KEYWORD_NAMES.has(name)) continue;
            const exported = p.exportGroup ? (m[1] === "export ") : false;
            out.push({
                name,
                kind: p.kind,
                lineStart: i + 1,
                lineEnd: null,
                signature: line.trim().slice(0, 240),
                exported,
            });
            break; // one symbol per line
        }
    }
    return out;
}

export function extractImports(lang: Language, content: string): ExtractedImport[] {
    const patterns = IMPORT_PATTERNS[lang];
    if (!patterns || patterns.length === 0) return [];
    const lines = content.split("\n");
    const out: ExtractedImport[] = [];
    for (let i = 0; i < lines.length; i++) {
        const stripped = stripStringsAndComments(lines[i], lang);
        for (const re of patterns) {
            const m = re.exec(lines[i]); // run against raw to preserve the specifier string
            if (m && m[1]) {
                out.push({ specifier: m[1], line: i + 1 });
                break;
            }
            // Still try stripped form as a secondary pass
            const m2 = re.exec(stripped);
            if (m2 && m2[1]) {
                out.push({ specifier: m2[1], line: i + 1 });
                break;
            }
        }
    }
    return out;
}

export function extractCalls(lang: Language, content: string, symbols: ExtractedSymbol[]): ExtractedCall[] {
    if (!CALL_LANGS.has(lang)) return [];
    const lines = content.split("\n");
    const out: ExtractedCall[] = [];

    // Build a line → enclosing symbol map (best-effort: symbols in order of lineStart)
    const sortedSyms = [...symbols].sort((a, b) => a.lineStart - b.lineStart);

    for (let i = 0; i < lines.length; i++) {
        const stripped = stripStringsAndComments(lines[i], lang);
        // Reset regex.lastIndex because of the /g flag
        CALL_PATTERN.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = CALL_PATTERN.exec(stripped)) !== null) {
            const name = m[1];
            if (KEYWORD_NAMES.has(name)) continue;
            // Skip single-letter var patterns like `a(` because of loops
            if (name.length <= 1) continue;

            // Find enclosing symbol: the symbol with the greatest lineStart <= i+1
            let enclosing: string | null = null;
            for (const s of sortedSyms) {
                if (s.lineStart <= i + 1) enclosing = s.name;
                else break;
            }
            out.push({ fromSymbolName: enclosing, calleeName: name, line: i + 1 });
        }
    }
    return out;
}

/** Language-agnostic loc (non-empty, non-comment-only lines). */
export function countLoc(content: string, lang: Language): number {
    const hashLangs: Language[] = ["python", "ruby", "shell"];
    const lines = content.split("\n");
    let count = 0;
    for (const ln of lines) {
        const t = ln.trim();
        if (!t) continue;
        if (hashLangs.includes(lang) && t.startsWith("#")) continue;
        if (!hashLangs.includes(lang) && (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*"))) continue;
        count++;
    }
    return count;
}
```

- [ ] **Step 5: Create `src/memory/code-parse/index.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Parse Dispatcher ──────────────────────────
// Single entry point: parseFile(lang, path, content) → ParseResult.
// Handles size caps, encoding fallbacks, LFS pointer detection, and
// per-file error isolation. Never throws.

import type { Language, ParseResult } from "./types.js";
import { extractSymbols, extractImports, extractCalls, countLoc } from "./regex-extractors.js";

export const MAX_FILE_BYTES = 100_000; // 100 KB per file
export const LFS_PREFIX = "version https://git-lfs";

export { parseFile };
export type { ParseResult, Language };
export * from "./types.js";

/**
 * Parse a single file. Returns a best-effort result; on any failure the
 * returned object has the error set and empty arrays.
 *
 * @param lang       Detected language (or "file-only" if unknown)
 * @param filePath   Absolute path (used for error messages only)
 * @param content    Pre-read file contents (caller handles UTF-8/latin-1)
 */
function parseFile(lang: Language, filePath: string, content: string): ParseResult {
    try {
        // LFS pointer → treat as file-only
        if (content.startsWith(LFS_PREFIX) && content.length < 200) {
            return { symbols: [], imports: [], calls: [], loc: 0, truncated: false, error: "lfs-pointer" };
        }
        // Size cap
        let truncated = false;
        if (content.length > MAX_FILE_BYTES) {
            truncated = true;
            return { symbols: [], imports: [], calls: [], loc: countLoc(content, lang), truncated, error: null };
        }
        if (lang === "file-only") {
            return { symbols: [], imports: [], calls: [], loc: countLoc(content, lang), truncated: false, error: null };
        }
        const symbols = extractSymbols(lang, content);
        const imports = extractImports(lang, content);
        const calls = extractCalls(lang, content, symbols);
        return { symbols, imports, calls, loc: countLoc(content, lang), truncated: false, error: null };
    } catch (err) {
        return {
            symbols: [], imports: [], calls: [],
            loc: 0, truncated: false,
            error: `parse-error: ${(err as Error).message}`,
        };
    }
}
```

- [ ] **Step 6: Run smoke to verify pass**

```bash
npx tsx /tmp/smoke-parse-ts.mts
```
Expected output (order may vary within sort):
```
symbols: class:Greeter,constant:g,enum:Color,function:hello,interface:IPerson,method:greet,type:Age
imports: ./lib/foo.js,./types.js,external-pkg
calls: greet,hello,log
PASS: TS fixture parsed correctly
```

- [ ] **Step 7: Lint + typecheck + build**

```bash
npx biome check --write --unsafe \
    /Users/user/Desktop/ATLAS/src/memory/code-parse/types.ts \
    /Users/user/Desktop/ATLAS/src/memory/code-parse/regex-extractors.ts \
    /Users/user/Desktop/ATLAS/src/memory/code-parse/index.ts
npm run typecheck
npm run build
```
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add src/memory/code-parse/types.ts \
        src/memory/code-parse/regex-extractors.ts \
        src/memory/code-parse/index.ts
git commit -m "$(cat <<'EOF'
feat(codebase-index): add regex extractors + parse dispatcher

Shared types for ExtractedSymbol/Import/Call/ParseResult plus line-by-line
regex extractors for 15 languages. parseFile() dispatcher handles LFS
pointers, 100KB size cap, per-file error isolation (never throws). Imports
and calls are new; symbols mirror src/tools/repo-map.ts PATTERNS.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `codebase-index.ts` — build/refresh/stats/wipe core

**Files:**
- Create: `src/memory/codebase-index.ts`
- Test: `/tmp/smoke-codebase-index-build.mts`

**Why:** The orchestrator. Walks the repo (gitignore-aware), dispatches each file to `parseFile`, upserts rows into the sidecar (wrapped in a transaction), runs `pickDepth` + `pickTiming`, records `index_meta`, and resolves imports to `to_file_id` in a second pass.

- [ ] **Step 1: Write the failing smoke script**

`/tmp/smoke-codebase-index-build.mts`:
```typescript
import { buildIndex, refreshIndex, getIndexStats, wipeIndex, pickDepth, pickTiming } from "/Users/user/Desktop/ATLAS/src/memory/codebase-index.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// 1. Pickers return the right tiers
if (pickDepth({ fileCount: 50, typedRatio: 0.9, lang: "typescript" }) !== "calls") {
    console.error("FAIL: pickDepth(50, 0.9) !== calls");
    process.exit(1);
}
if (pickDepth({ fileCount: 2000, typedRatio: 0.9, lang: "typescript" }) !== "imports") {
    console.error("FAIL: pickDepth(2000, 0.9) !== imports");
    process.exit(1);
}
if (pickDepth({ fileCount: 60000, typedRatio: 0.9, lang: "typescript" }) !== "symbols") {
    console.error("FAIL: pickDepth(60000, 0.9) !== symbols");
    process.exit(1);
}
if (pickTiming(50) !== "block") {
    console.error("FAIL: pickTiming(50) !== block");
    process.exit(1);
}
if (pickTiming(500) !== "async") {
    console.error("FAIL: pickTiming(500) !== async");
    process.exit(1);
}

// 2. Build on a tiny fixture repo
const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-idx-"));
fs.writeFileSync(path.join(root, "a.ts"), \`
import { b } from "./b.js";
export function greet(n: string) { return b(n); }
\`);
fs.writeFileSync(path.join(root, "b.ts"), \`
export function b(n: string) { return "hi " + n; }
\`);

const res = await buildIndex(root, { depth: "calls" });
console.log("build:", JSON.stringify({ added: res.added, updated: res.updated, errors: res.errors.length }));
if (res.added !== 2) {
    console.error(\`FAIL: expected 2 files added, got \${res.added}\`);
    process.exit(1);
}

const stats = getIndexStats(root);
console.log("stats:", JSON.stringify({ fileCount: stats.fileCount, symbolCount: stats.symbolCount, depth: stats.depth }));
if (stats.fileCount !== 2 || stats.symbolCount < 2) {
    console.error(\`FAIL: stats wrong\`);
    process.exit(1);
}

// 3. Refresh with no changes: 0 updated
const r2 = await refreshIndex(root);
console.log("refresh-clean:", JSON.stringify({ updated: r2.updated, unchanged: r2.unchanged }));
if (r2.updated !== 0 || r2.unchanged !== 2) {
    console.error("FAIL: clean refresh should be 0 updated / 2 unchanged");
    process.exit(1);
}

// 4. Mutate one file and refresh: exactly 1 updated
fs.writeFileSync(path.join(root, "a.ts"), "export function greet(n: string) { return 'x'; }");
const r3 = await refreshIndex(root);
console.log("refresh-dirty:", JSON.stringify({ updated: r3.updated, unchanged: r3.unchanged }));
if (r3.updated !== 1 || r3.unchanged !== 1) {
    console.error("FAIL: dirty refresh should be 1 updated / 1 unchanged");
    process.exit(1);
}

// 5. Wipe removes everything
wipeIndex(root);
const stats2 = getIndexStats(root);
if (stats2.fileCount !== 0) {
    console.error(\`FAIL: wipe did not reset stats (fileCount=\${stats2.fileCount})\`);
    process.exit(1);
}

// Cleanup
fs.rmSync(root, { recursive: true, force: true });
console.log("PASS: buildIndex + refreshIndex + stats + wipe all correct");
```

- [ ] **Step 2: Run smoke to verify it fails**

```bash
npx tsx /tmp/smoke-codebase-index-build.mts
```
Expected: `Cannot find module`.

- [ ] **Step 3: Create `src/memory/codebase-index.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Codebase Index Core ────────────────────────
// Build / refresh / stats / wipe. Walks a repo root, dispatches parse,
// upserts into the sidecar in a single transaction per pass. Merkle-style
// dirty detection: per-file SHA-256 comparison against stored row.

import fs from "node:fs";
import path from "node:path";
import { parseFile, MAX_FILE_BYTES, type Language } from "./code-parse/index.js";
import { openSidecar, SIDECAR_SCHEMA_VERSION, wipeSidecar } from "./codebase-sidecar.js";
import { resolveRepoRoot, repoHash, sha256File } from "./codebase-merkle.js";
import { beginTransaction, commitTransaction, rollbackTransaction } from "./sqlite.js";

// ── Tuning ────────────────────────────────────

/** Hard ceiling on files walked in one pass. */
export const MAX_WALK_FILES = 20_000;

/** Directories we always skip (mirrors repo-map). */
const ALWAYS_SKIP_DIRS = new Set([
    "node_modules", ".git", ".svn", ".hg", "__pycache__", ".tox",
    ".pytest_cache", ".mypy_cache", ".ruff_cache", "venv", ".venv",
    "env", "dist", "build", "out", "target", ".next",
    ".nuxt", ".output", "coverage", ".cache", ".parcel-cache",
    ".turbo", ".angular", "vendor", "Pods",
    ".idea", ".vscode", ".vs",
    // ATLAS-specific agent isolation directories (per spec)
    "agent-worktrees",
]);

const ALWAYS_SKIP_FILES = new Set([
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
    "Cargo.lock", "Gemfile.lock", "poetry.lock", "composer.lock",
    "go.sum",
]);

const EXT_LANG: Record<string, Language> = {
    ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".py": "python", ".pyw": "python",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".c": "c", ".h": "c",
    ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hxx": "cpp",
    ".cs": "csharp",
    ".rb": "ruby",
    ".swift": "swift",
    ".kt": "kotlin", ".kts": "kotlin",
    ".php": "php",
    ".sh": "shell", ".bash": "shell", ".zsh": "shell",
    ".lua": "lua",
};

// ── Types ─────────────────────────────────────

export type Depth = "symbols" | "imports" | "calls";
export type Timing = "block" | "async";

export interface BuildOptions {
    depth?: Depth;
    timing?: Timing;
    /** Skip file re-parse if its sha256 matches the stored row. */
    incremental?: boolean;
    /** Test-only: override the file-count cap. */
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

    // Downgrade one tier if typed-lang ratio < 30%
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
    const visit = (dir: string): void => {
        if (out.length >= maxFiles) return;
        let real: string;
        try { real = fs.realpathSync(dir); } catch { return; }
        if (visited.has(real)) return;
        visited.add(real);

        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }

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

// ── Language + typed-ratio detection ──

function detectTypedRatio(files: DiscoveredFile[]): { ratio: number; mainLang: Language | "mixed" } {
    if (files.length === 0) return { ratio: 1, mainLang: "mixed" };
    const TYPED: Language[] = ["typescript", "rust", "go", "java", "csharp", "swift", "kotlin"];
    const counts = new Map<Language, number>();
    for (const f of files) counts.set(f.lang, (counts.get(f.lang) ?? 0) + 1);
    const typed = files.filter(f => TYPED.includes(f.lang)).length;
    const ratio = typed / files.length;
    let mainLang: Language | "mixed" = "mixed";
    let max = 0;
    for (const [l, n] of counts) { if (n > max) { max = n; mainLang = l; } }
    return { ratio, mainLang };
}

// ── Read with encoding fallback ──

function readText(p: string): string | null {
    try {
        const buf = fs.readFileSync(p);
        if (buf.length === 0) return "";
        if (buf.length > MAX_FILE_BYTES) {
            // Still return the string so parse can short-circuit and record LOC.
            return buf.subarray(0, MAX_FILE_BYTES + 1).toString("utf-8");
        }
        // UTF-8 first; on error try latin-1.
        try { return buf.toString("utf-8"); }
        catch { return buf.toString("latin1"); }
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

    const maxFiles = opts.maxFiles ?? MAX_WALK_FILES;
    const files = listFiles(repoRoot, maxFiles);
    const typed = detectTypedRatio(files);

    const depthAuto = !opts.depth;
    const depth: Depth = opts.depth ?? pickDepth({
        fileCount: files.length,
        typedRatio: typed.ratio,
        lang: typed.mainLang,
    });

    const errors: BuildResult["errors"] = [];
    let added = 0, updated = 0, unchanged = 0, deleted = 0;

    // ── Existing file rows ──
    const existingRows = db.exec("SELECT path, sha256, id FROM files");
    const existing = new Map<string, { sha: string; id: number }>();
    if (existingRows.length > 0) {
        for (const r of existingRows[0].values) {
            existing.set(r[0] as string, { sha: r[1] as string, id: r[2] as number });
        }
    }

    beginTransaction();
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

            // Upsert file row
            let fileId: number;
            if (prev) {
                db.run(
                    "UPDATE files SET sha256 = ?, lang = ?, loc = ?, indexed_at = ? WHERE id = ?",
                    [sha, f.lang, res.loc, Date.now(), prev.id],
                );
                fileId = prev.id;
                // Clear prior symbols/imports/calls for this file (CASCADE covers calls via symbols).
                db.run("DELETE FROM symbols WHERE file_id = ?", [fileId]);
                db.run("DELETE FROM imports WHERE from_file_id = ?", [fileId]);
                updated++;
            } else {
                db.run(
                    "INSERT INTO files (path, sha256, lang, loc, workspace, indexed_at) VALUES (?, ?, ?, ?, NULL, ?)",
                    [f.rel, sha, f.lang, res.loc, Date.now()],
                );
                const r = db.exec("SELECT last_insert_rowid()");
                fileId = r[0].values[0][0] as number;
                added++;
            }

            // Insert symbols
            const symbolIdByName = new Map<string, number>();
            for (const s of res.symbols) {
                db.run(
                    "INSERT INTO symbols (file_id, name, kind, line_start, line_end, signature, exported) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    [fileId, s.name, s.kind, s.lineStart, s.lineEnd, s.signature, s.exported ? 1 : 0],
                );
                const sr = db.exec("SELECT last_insert_rowid()");
                const sid = sr[0].values[0][0] as number;
                symbolIdByName.set(s.name, sid);
            }

            // Insert imports (only at imports+ depth)
            if (depth !== "symbols") {
                for (const imp of res.imports) {
                    db.run(
                        "INSERT INTO imports (from_file_id, to_file_id, specifier, line) VALUES (?, NULL, ?, ?)",
                        [fileId, imp.specifier, imp.line],
                    );
                }
            }

            // Insert calls (only at calls depth)
            if (depth === "calls") {
                for (const c of res.calls) {
                    const fromSid = c.fromSymbolName ? symbolIdByName.get(c.fromSymbolName) : undefined;
                    if (fromSid === undefined) continue; // only anchor calls that sit inside a known symbol
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

        // Delete rows for files that no longer exist on disk
        if (incremental) {
            for (const [p, row] of existing.entries()) {
                if (!currentPaths.has(p)) {
                    db.run("DELETE FROM files WHERE id = ?", [row.id]); // CASCADE covers symbols/imports/calls
                    deleted++;
                }
            }
        }

        // Resolve specifier → to_file_id (best-effort, depth >= imports only)
        if (depth !== "symbols") {
            resolveImports(db);
        }

        // Upsert index_meta
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

        commitTransaction();

        const elapsed = Date.now() - t0;
        console.log(`[codebase-index] ${incremental ? "refresh" : "build"} ${repoRoot}: ${fc} files, ${sc} symbols, ${added} added, ${updated} updated, ${elapsed}ms`);
        return {
            repoRoot, repoHash: hash, depth, depthAuto,
            added, updated, unchanged, deleted, errors,
            elapsedMs: elapsed, fileCount: fc, symbolCount: sc,
        };
    } catch (err) {
        rollbackTransaction();
        const elapsed = Date.now() - t0;
        console.warn(`[codebase-index] build failed: ${(err as Error).message}`);
        return {
            repoRoot, repoHash: hash, depth, depthAuto,
            added, updated, unchanged, deleted,
            errors: [{ path: "(global)", error: (err as Error).message }],
            elapsedMs: elapsed, fileCount: 0, symbolCount: 0,
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
        if (!spec.startsWith(".") && !spec.startsWith("/")) continue; // external package
        const fromPathRow = db.exec("SELECT path FROM files WHERE id = ?", [fromId]);
        if (fromPathRow.length === 0 || fromPathRow[0].values.length === 0) continue;
        const fromPath = fromPathRow[0].values[0][0] as string;
        const baseDir = path.posix.dirname(fromPath.replace(/\\/g, "/"));
        const joined = path.posix.normalize(path.posix.join(baseDir, spec));
        // Try common extension variants
        const candidates = [
            joined,
            joined + ".ts", joined + ".tsx", joined + ".js", joined + ".jsx",
            joined + "/index.ts", joined + "/index.js",
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

/** Cold build: full walk, full parse, no Merkle skip. */
export async function buildIndex(root: string, opts: BuildOptions = {}): Promise<BuildResult> {
    return doIndex(root, opts, false);
}

/** Warm refresh: skip files whose on-disk sha256 matches the stored sha256. */
export async function refreshIndex(root: string, opts: BuildOptions = {}): Promise<BuildResult> {
    return doIndex(root, { ...opts, incremental: true }, true);
}

/** Return current index stats (or exists=false if nothing built). */
export function getIndexStats(root: string): IndexStats {
    const repoRoot = resolveRepoRoot(root);
    const hash = repoHash(repoRoot);
    const db = openSidecar(repoRoot);
    const metaRow = db.exec("SELECT depth, depth_auto, file_count, symbol_count, created_at, last_refreshed_at, tool_version FROM index_meta WHERE repo_root = ?", [repoRoot]);
    if (metaRow.length === 0 || metaRow[0].values.length === 0) {
        return {
            exists: false, repoRoot, repoHash: hash,
            depth: null, depthAuto: null,
            fileCount: 0, symbolCount: 0,
            createdAt: null, lastRefreshedAt: null,
            sidecarBytes: 0, toolVersion: null,
        };
    }
    const row = metaRow[0].values[0];
    let sidecarBytes = 0;
    try {
        const sp = path.join(process.env.ATLAS_DATA_DIR || path.resolve("data"), "codebase-index", `${hash}.db`);
        sidecarBytes = fs.statSync(sp).size;
    } catch { /* */ }
    return {
        exists: true, repoRoot, repoHash: hash,
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

/** Delete the sidecar for a repo. */
export function wipeIndex(root: string): void {
    const repoRoot = resolveRepoRoot(root);
    wipeSidecar(repoRoot);
}
```

- [ ] **Step 4: Run smoke to verify pass**

```bash
npx tsx /tmp/smoke-codebase-index-build.mts
```
Expected output lines:
```
build: {"added":2,"updated":0,"errors":0}
stats: {"fileCount":2,"symbolCount":2,"depth":"calls"}
refresh-clean: {"updated":0,"unchanged":2}
refresh-dirty: {"updated":1,"unchanged":1}
PASS: buildIndex + refreshIndex + stats + wipe all correct
```

- [ ] **Step 5: Lint + typecheck + build**

```bash
npx biome check --write --unsafe /Users/user/Desktop/ATLAS/src/memory/codebase-index.ts
npm run typecheck
npm run build
```
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add src/memory/codebase-index.ts
git commit -m "$(cat <<'EOF'
feat(codebase-index): build/refresh/stats/wipe core

Directory walker (gitignore-respecting), Merkle-based dirty skip,
depth/timing pickers from spec, per-file parse dispatch, transactional
upsert of files/symbols/imports/calls, specifier→to_file_id resolution
pass, index_meta bookkeeping. Wipe and stats round out the surface.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `codebase_index` tool handler

**Files:**
- Create: `src/tools/coding/codebase-index.ts`
- Test: `/tmp/smoke-codebase-index-tool.mts`

**Why:** The user-facing tool wrapping `buildIndex`/`refreshIndex`/`getIndexStats`/`wipeIndex` with the standard `{ success, ... }` JSON envelope and `ATLAS_NO_CODEBASE_INDEX` kill-switch.

- [ ] **Step 1: Write the failing smoke script**

`/tmp/smoke-codebase-index-tool.mts`:
```typescript
import { codebaseIndexTool } from "/Users/user/Desktop/ATLAS/src/tools/coding/codebase-index.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-idxtool-"));
fs.writeFileSync(path.join(root, "x.ts"), "export const x = 1;");

const build = JSON.parse(await codebaseIndexTool.handler({ command: "build", path: root }));
console.log("build:", JSON.stringify(build));
if (build.success !== true || build.added !== 1) {
    console.error("FAIL: build envelope wrong");
    process.exit(1);
}

const stats = JSON.parse(await codebaseIndexTool.handler({ command: "stats", path: root }));
console.log("stats:", JSON.stringify(stats));
if (stats.success !== true || stats.fileCount !== 1) {
    console.error("FAIL: stats envelope wrong");
    process.exit(1);
}

const refresh = JSON.parse(await codebaseIndexTool.handler({ command: "refresh", path: root }));
if (refresh.success !== true || refresh.updated !== 0) {
    console.error("FAIL: refresh envelope wrong");
    process.exit(1);
}

const wipe = JSON.parse(await codebaseIndexTool.handler({ command: "wipe", path: root }));
if (wipe.success !== true) {
    console.error("FAIL: wipe envelope wrong");
    process.exit(1);
}

// Kill-switch
process.env.ATLAS_NO_CODEBASE_INDEX = "true";
const killed = JSON.parse(await codebaseIndexTool.handler({ command: "build", path: root }));
if (killed.success !== false || !killed.error?.includes("disabled")) {
    console.error("FAIL: kill-switch not honored");
    process.exit(1);
}
delete process.env.ATLAS_NO_CODEBASE_INDEX;

fs.rmSync(root, { recursive: true, force: true });
console.log("PASS: codebase_index tool build/stats/refresh/wipe/kill-switch");
```

- [ ] **Step 2: Run smoke to verify it fails**

```bash
npx tsx /tmp/smoke-codebase-index-tool.mts
```
Expected: `Cannot find module`.

- [ ] **Step 3: Create `src/tools/coding/codebase-index.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── codebase_index Tool ────────────────────────
// Build / refresh / stats / wipe the per-repo codebase index.
// Kill-switch: ATLAS_NO_CODEBASE_INDEX=true disables build/refresh
// (stats/wipe still work so the user can inspect/clean up).

import type { ToolDefinition } from "../get-current-time.js";
import { buildIndex, refreshIndex, getIndexStats, wipeIndex } from "../../memory/codebase-index.js";
import { auditLog } from "../../security/audit-log.js";

function isDisabled(): boolean {
    return (process.env.ATLAS_NO_CODEBASE_INDEX ?? "").toLowerCase() === "true";
}

export const codebaseIndexTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "codebase_index",
            description: `Build, refresh, inspect, or wipe the persistent per-repo codebase index.

Commands:
- build:   full cold index (parse everything, write to sidecar SQLite)
- refresh: Merkle-based incremental refresh (skip files whose sha256 matches)
- stats:   return current file count, symbol count, depth, last refresh time
- wipe:    delete the sidecar DB for this repo (safe — just deletes index rows)

Depth picker (if not overridden): ≤500 files → calls, ≤5000 → imports, else symbols.
Env overrides: ATLAS_INDEX_DEPTH=symbols|imports|calls forces a tier; ATLAS_NO_CODEBASE_INDEX=true blocks build/refresh.`,
            parameters: {
                type: "object",
                properties: {
                    command: { type: "string", enum: ["build", "refresh", "stats", "wipe"], description: "Which operation to run." },
                    path: { type: "string", description: "Repo root (or a subdirectory within it). Defaults to cwd." },
                    depth: { type: "string", enum: ["symbols", "imports", "calls"], description: "Override depth tier. Default: auto." },
                },
                required: ["command"],
            },
        },
    },

    async handler(input: Record<string, unknown>): Promise<string> {
        const command = String(input.command ?? "").toLowerCase();
        const root = typeof input.path === "string" && input.path ? input.path : process.cwd();
        const depth = typeof input.depth === "string" ? input.depth as "symbols" | "imports" | "calls" : undefined;

        try {
            if (command === "build") {
                if (isDisabled()) {
                    return JSON.stringify({ success: false, error: "codebase_index disabled via ATLAS_NO_CODEBASE_INDEX" });
                }
                const r = await buildIndex(root, depth ? { depth } : {});
                auditLog("codebase_index.build", { root: r.repoRoot, hash: r.repoHash, added: r.added, updated: r.updated });
                return JSON.stringify({ success: true, ...r });
            }
            if (command === "refresh") {
                if (isDisabled()) {
                    return JSON.stringify({ success: false, error: "codebase_index disabled via ATLAS_NO_CODEBASE_INDEX" });
                }
                const r = await refreshIndex(root, depth ? { depth } : {});
                auditLog("codebase_index.refresh", { root: r.repoRoot, hash: r.repoHash, updated: r.updated, unchanged: r.unchanged });
                return JSON.stringify({ success: true, ...r });
            }
            if (command === "stats") {
                const s = getIndexStats(root);
                return JSON.stringify({ success: true, ...s });
            }
            if (command === "wipe") {
                wipeIndex(root);
                auditLog("codebase_index.wipe", { root });
                return JSON.stringify({ success: true, wiped: true });
            }
            return JSON.stringify({ success: false, error: `unknown command: ${command}` });
        } catch (err) {
            return JSON.stringify({ success: false, error: `codebase_index failed: ${(err as Error).message}` });
        }
    },
};
```

- [ ] **Step 4: Run smoke to verify pass**

```bash
npx tsx /tmp/smoke-codebase-index-tool.mts
```
Expected:
```
build: {"success":true,"repoRoot":"...","added":1,...}
stats: {"success":true,"exists":true,"fileCount":1,...}
PASS: codebase_index tool build/stats/refresh/wipe/kill-switch
```

- [ ] **Step 5: Lint + typecheck + build**

```bash
npx biome check --write --unsafe /Users/user/Desktop/ATLAS/src/tools/coding/codebase-index.ts
npm run typecheck
npm run build
```
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add src/tools/coding/codebase-index.ts
git commit -m "$(cat <<'EOF'
feat(codebase-index): add codebase_index tool handler

Thin user-facing wrapper exposing build/refresh/stats/wipe with the
standard { success, ... } JSON envelope. Honors ATLAS_NO_CODEBASE_INDEX
kill-switch; audit-logs every mutating call.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `codebase_query` tool handler (6 operations)

**Files:**
- Create: `src/tools/coding/codebase-query.ts`
- Test: `/tmp/smoke-codebase-query.mts`

**Why:** Pure-SQL queries over the sidecar. Operations: `find_symbol`, `find_usages`, `file_neighborhood`, `describe_file`, `architecture_overview`, `dependency_chain`. Architecture overview emits Mermaid + ASCII tree side-by-side.

- [ ] **Step 1: Write the failing smoke script**

`/tmp/smoke-codebase-query.mts`:
```typescript
import { codebaseQueryTool } from "/Users/user/Desktop/ATLAS/src/tools/coding/codebase-query.ts";
import { buildIndex } from "/Users/user/Desktop/ATLAS/src/memory/codebase-index.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-q-"));
fs.mkdirSync(path.join(root, "src"));
fs.writeFileSync(path.join(root, "src", "util.ts"), `
export function helper(x: number): number { return x + 1; }
`);
fs.writeFileSync(path.join(root, "src", "main.ts"), `
import { helper } from "./util.js";
export function main() { return helper(1); }
`);
await buildIndex(root, { depth: "calls" });

// find_symbol
const fs1 = JSON.parse(await codebaseQueryTool.handler({
    operation: "find_symbol", name: "helper", path: root,
}));
console.log("find_symbol:", JSON.stringify(fs1));
if (fs1.success !== true || !fs1.matches?.some((m: { name: string }) => m.name === "helper")) {
    console.error("FAIL: find_symbol did not find helper");
    process.exit(1);
}

// find_usages
const fu = JSON.parse(await codebaseQueryTool.handler({
    operation: "find_usages", name: "helper", path: root,
}));
console.log("find_usages:", JSON.stringify(fu));
if (fu.success !== true || !fu.usages?.length) {
    console.error("FAIL: find_usages returned nothing");
    process.exit(1);
}

// describe_file
const df = JSON.parse(await codebaseQueryTool.handler({
    operation: "describe_file", file: "src/util.ts", path: root,
}));
if (df.success !== true || !df.symbols?.length) {
    console.error("FAIL: describe_file returned no symbols");
    process.exit(1);
}

// file_neighborhood
const fn = JSON.parse(await codebaseQueryTool.handler({
    operation: "file_neighborhood", file: "src/util.ts", depth: 1, path: root,
}));
if (fn.success !== true) {
    console.error("FAIL: file_neighborhood failure");
    process.exit(1);
}

// architecture_overview
const ao = JSON.parse(await codebaseQueryTool.handler({
    operation: "architecture_overview", path: root,
}));
console.log("ao keys:", Object.keys(ao).join(","));
if (ao.success !== true || !ao.mermaid || !ao.ascii) {
    console.error("FAIL: architecture_overview missing mermaid/ascii");
    process.exit(1);
}

// dependency_chain
const dc = JSON.parse(await codebaseQueryTool.handler({
    operation: "dependency_chain", from_file: "src/main.ts", to_file: "src/util.ts", path: root,
}));
if (dc.success !== true) {
    console.error("FAIL: dependency_chain failure");
    process.exit(1);
}

fs.rmSync(root, { recursive: true, force: true });
console.log("PASS: codebase_query 6 operations");
```

- [ ] **Step 2: Run smoke to verify it fails**

```bash
npx tsx /tmp/smoke-codebase-query.mts
```
Expected: `Cannot find module`.

- [ ] **Step 3: Create `src/tools/coding/codebase-query.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── codebase_query Tool ────────────────────────
// Six pure-SQL operations against the per-repo sidecar:
// find_symbol, find_usages, file_neighborhood, describe_file,
// architecture_overview (Mermaid + ASCII), dependency_chain.
// Fail-open: no sidecar → { success: false, error } with no throw.

import type { ToolDefinition } from "../get-current-time.js";
import path from "node:path";
import { openSidecar, hasSidecar } from "../../memory/codebase-sidecar.js";
import { resolveRepoRoot } from "../../memory/codebase-merkle.js";

interface SymbolMatch { name: string; kind: string; file: string; lineStart: number; exported: boolean }

function ensureIndex(root: string): { ok: true; db: ReturnType<typeof openSidecar>; repoRoot: string } | { ok: false; error: string } {
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
    return rows[0].values.map(r => ({
        name: r[0] as string, kind: r[1] as string, file: r[2] as string,
        lineStart: r[3] as number, exported: (r[4] as number) === 1,
    }));
}

function findUsages(db: ReturnType<typeof openSidecar>, name: string): Array<{ file: string; line: number; caller: string | null }> {
    const sql = `SELECT f.path, c.line, s.name
                 FROM calls c
                 JOIN symbols s ON s.id = c.from_symbol_id
                 JOIN files f ON f.id = s.file_id
                 WHERE c.callee_name = ?
                 ORDER BY f.path, c.line
                 LIMIT 200`;
    const rows = db.exec(sql, [name]);
    if (rows.length === 0) return [];
    return rows[0].values.map(r => ({ file: r[0] as string, line: r[1] as number, caller: r[2] as string }));
}

function describeFile(db: ReturnType<typeof openSidecar>, file: string): { path: string; lang: string; loc: number; symbols: SymbolMatch[]; imports: string[]; importers: string[] } | null {
    const fileRow = db.exec("SELECT id, lang, loc FROM files WHERE path = ?", [file]);
    if (fileRow.length === 0 || fileRow[0].values.length === 0) return null;
    const fileId = fileRow[0].values[0][0] as number;
    const lang = fileRow[0].values[0][1] as string;
    const loc = fileRow[0].values[0][2] as number;

    const symsRow = db.exec("SELECT name, kind, line_start, exported FROM symbols WHERE file_id = ? ORDER BY line_start", [fileId]);
    const symbols: SymbolMatch[] = symsRow.length > 0
        ? symsRow[0].values.map(r => ({
            name: r[0] as string, kind: r[1] as string, file, lineStart: r[2] as number,
            exported: (r[3] as number) === 1,
          }))
        : [];

    const impRow = db.exec("SELECT specifier FROM imports WHERE from_file_id = ?", [fileId]);
    const imports = impRow.length > 0 ? impRow[0].values.map(r => r[0] as string) : [];

    const impByRow = db.exec("SELECT f.path FROM imports i JOIN files f ON f.id = i.from_file_id WHERE i.to_file_id = ? ORDER BY f.path", [fileId]);
    const importers = impByRow.length > 0 ? impByRow[0].values.map(r => r[0] as string) : [];

    return { path: file, lang, loc, symbols, imports, importers };
}

function fileNeighborhood(db: ReturnType<typeof openSidecar>, file: string, depth: number): { center: string; imports: string[]; importers: string[]; depth: number } {
    const desc = describeFile(db, file);
    if (!desc) return { center: file, imports: [], importers: [], depth };
    return { center: file, imports: desc.imports, importers: desc.importers, depth };
}

function dependencyChain(db: ReturnType<typeof openSidecar>, fromFile: string, toFile: string): { path: string[] | null } {
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

function architectureOverview(db: ReturnType<typeof openSidecar>, repoRoot: string): { mermaid: string; ascii: string; groups: Array<{ dir: string; files: number; symbols: number }> } {
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
        const cnt = db.exec(
            "SELECT COUNT(*) FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path LIKE ?",
            [`${g.dir}/%`],
        );
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
        asciiLines.push(`${last ? "└── " : "├── "}${groups[i].dir} (${groups[i].files} files, ${groups[i].symbols} symbols)`);
    }
    const ascii = asciiLines.join("\n");
    return { mermaid, ascii, groups };
}

export const codebaseQueryTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "codebase_query",
            description: `Query the persistent codebase index. Six operations:
- find_symbol(name, kind?)             → matching symbol definitions with file:line
- find_usages(name)                    → call-sites of a symbol across the repo
- describe_file(file)                  → symbols, imports, importers for a file
- file_neighborhood(file, depth=1)     → imports + importers graph around a file
- architecture_overview()              → Mermaid + ASCII subsystem overview
- dependency_chain(from_file, to_file) → shortest import path between two files

Requires the index to exist. If not, returns { success: false } with a hint to run codebase_index build.`,
            parameters: {
                type: "object",
                properties: {
                    operation: { type: "string", enum: ["find_symbol", "find_usages", "file_neighborhood", "describe_file", "architecture_overview", "dependency_chain"] },
                    name: { type: "string", description: "Symbol name (find_symbol / find_usages)" },
                    kind: { type: "string", description: "Symbol kind filter (find_symbol)" },
                    file: { type: "string", description: "Repo-relative file path (describe_file / file_neighborhood)" },
                    from_file: { type: "string", description: "Starting file (dependency_chain)" },
                    to_file: { type: "string", description: "Target file (dependency_chain)" },
                    depth: { type: "number", description: "Neighborhood radius (file_neighborhood, default 1)" },
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
                if (!fromFile || !toFile) return JSON.stringify({ success: false, error: "from_file and to_file required" });
                return JSON.stringify({ success: true, ...dependencyChain(g.db, fromFile, toFile) });
            }
            return JSON.stringify({ success: false, error: `unknown operation: ${operation}` });
        } catch (err) {
            return JSON.stringify({ success: false, error: `codebase_query failed: ${(err as Error).message}` });
        }
    },
};
```

- [ ] **Step 4: Run smoke to verify pass**

```bash
npx tsx /tmp/smoke-codebase-query.mts
```
Expected: all 6 operations return `success: true`, `PASS: codebase_query 6 operations`.

- [ ] **Step 5: Lint + typecheck + build**

```bash
npx biome check --write --unsafe /Users/user/Desktop/ATLAS/src/tools/coding/codebase-query.ts
npm run typecheck
npm run build
```
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add src/tools/coding/codebase-query.ts
git commit -m "$(cat <<'EOF'
feat(codebase-query): add codebase_query tool with 6 operations

find_symbol, find_usages, describe_file, file_neighborhood,
architecture_overview (Mermaid + ASCII), dependency_chain via SQLite
recursive CTE. All sub-second, read-only. Fail-open when sidecar absent.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `code_change_summary` tool (read-only git)

**Files:**
- Create: `src/tools/coding/code-change-summary.ts`
- Test: `/tmp/smoke-code-change-summary.mts`

**Why:** Read-only git helpers for context — `recent_commits`, `hot_files`, `diff`, `blame`. Never mutates. Returns `{ success: false, note: "not a git repo" }` outside a repo.

- [ ] **Step 1: Write the failing smoke script**

`/tmp/smoke-code-change-summary.mts`:
```typescript
import { codeChangeSummaryTool } from "/Users/user/Desktop/ATLAS/src/tools/coding/code-change-summary.ts";

const recent = JSON.parse(await codeChangeSummaryTool.handler({
    operation: "recent_commits", n: 3, path: "/Users/user/Desktop/ATLAS",
}));
console.log("recent:", JSON.stringify(recent).slice(0, 200));
if (recent.success !== true || !Array.isArray(recent.commits)) {
    console.error("FAIL: recent_commits envelope wrong");
    process.exit(1);
}

const hot = JSON.parse(await codeChangeSummaryTool.handler({
    operation: "hot_files", days: 30, path: "/Users/user/Desktop/ATLAS",
}));
if (hot.success !== true || !Array.isArray(hot.files)) {
    console.error("FAIL: hot_files envelope wrong");
    process.exit(1);
}

const nogit = JSON.parse(await codeChangeSummaryTool.handler({
    operation: "recent_commits", n: 1, path: "/tmp",
}));
if (nogit.success !== false || !nogit.note?.includes("not a git repo")) {
    console.error("FAIL: non-git handling wrong");
    process.exit(1);
}

console.log("PASS: code_change_summary envelope + non-git handling");
```

- [ ] **Step 2: Run smoke to verify it fails**

```bash
npx tsx /tmp/smoke-code-change-summary.mts
```
Expected: `Cannot find module`.

- [ ] **Step 3: Create `src/tools/coding/code-change-summary.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── code_change_summary Tool ───────────────────
// Read-only git: recent_commits, hot_files, diff, blame. Never mutates.
// Runs synchronously via execFileSync with a timeout so the agent loop
// doesn't stall. Fail-open: non-git dir → success: false + note.

import type { ToolDefinition } from "../get-current-time.js";
import { execFileSync } from "node:child_process";
import { gitAvailable, resolveRepoRoot } from "../../memory/codebase-merkle.js";
import fs from "node:fs";
import path from "node:path";

function isGitRepo(dir: string): boolean {
    try {
        const root = resolveRepoRoot(dir);
        return fs.existsSync(path.join(root, ".git"));
    } catch {
        return false;
    }
}

function runGit(cwd: string, args: string[], timeoutMs = 4000): string {
    return execFileSync("git", args, {
        cwd,
        encoding: "utf-8",
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 4 * 1024 * 1024,
    });
}

export const codeChangeSummaryTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "code_change_summary",
            description: `Read-only git summaries for local repositories. Never mutates anything.
Operations:
- recent_commits(n=10)     → last N commits, oneline format
- hot_files(days=30)       → files touched most often in the window (requires 'uniq', 'sort')
- diff(base, target?)      → diff --stat + unified diff between two refs (default target: HEAD)
- blame(file, line)        → git blame for a single line

All operations are local. Not-a-git-repo → { success: false, note }.`,
            parameters: {
                type: "object",
                properties: {
                    operation: { type: "string", enum: ["recent_commits", "hot_files", "diff", "blame"] },
                    n: { type: "number", description: "Number of commits (recent_commits)" },
                    days: { type: "number", description: "Window length (hot_files)" },
                    base: { type: "string", description: "Diff base ref" },
                    target: { type: "string", description: "Diff target ref (default HEAD)" },
                    file: { type: "string", description: "File path (blame)" },
                    line: { type: "number", description: "Line number (blame)" },
                    path: { type: "string", description: "Repo root (default cwd)" },
                },
                required: ["operation"],
            },
        },
    },

    async handler(input: Record<string, unknown>): Promise<string> {
        const operation = String(input.operation ?? "");
        const root = typeof input.path === "string" && input.path ? input.path : process.cwd();

        if (!gitAvailable()) {
            return JSON.stringify({ success: false, note: "git not available on PATH" });
        }
        if (!isGitRepo(root)) {
            return JSON.stringify({ success: false, note: "not a git repo" });
        }

        try {
            if (operation === "recent_commits") {
                const n = typeof input.n === "number" && input.n > 0 ? Math.min(100, input.n) : 10;
                const out = runGit(root, ["log", `--oneline`, `-n`, String(n), "--no-color"]);
                const commits = out.split("\n").filter(Boolean).map(l => {
                    const [sha, ...rest] = l.split(" ");
                    return { sha, message: rest.join(" ") };
                });
                return JSON.stringify({ success: true, commits });
            }
            if (operation === "hot_files") {
                const days = typeof input.days === "number" && input.days > 0 ? Math.min(365, input.days) : 30;
                const out = runGit(root, ["log", "--name-only", "--pretty=format:", `--since=${days}d`]);
                const counts = new Map<string, number>();
                for (const l of out.split("\n")) {
                    const t = l.trim();
                    if (!t) continue;
                    counts.set(t, (counts.get(t) ?? 0) + 1);
                }
                const files = Array.from(counts.entries())
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 50)
                    .map(([file, count]) => ({ file, count }));
                return JSON.stringify({ success: true, files });
            }
            if (operation === "diff") {
                const base = typeof input.base === "string" && input.base ? input.base : "HEAD~1";
                const target = typeof input.target === "string" && input.target ? input.target : "HEAD";
                const stat = runGit(root, ["diff", "--stat", `${base}..${target}`]);
                const unified = runGit(root, ["diff", `${base}..${target}`], 6000).slice(0, 20_000);
                return JSON.stringify({ success: true, base, target, stat, diff: unified });
            }
            if (operation === "blame") {
                const file = String(input.file ?? "");
                const line = typeof input.line === "number" ? input.line : 1;
                if (!file) return JSON.stringify({ success: false, error: "file required" });
                const out = runGit(root, ["blame", "-L", `${line},${line}`, file]);
                return JSON.stringify({ success: true, file, line, blame: out.trim() });
            }
            return JSON.stringify({ success: false, error: `unknown operation: ${operation}` });
        } catch (err) {
            return JSON.stringify({ success: false, error: `code_change_summary failed: ${(err as Error).message}` });
        }
    },
};
```

- [ ] **Step 4: Run smoke to verify pass**

```bash
npx tsx /tmp/smoke-code-change-summary.mts
```
Expected: `PASS: code_change_summary envelope + non-git handling`.

- [ ] **Step 5: Lint + typecheck + build**

```bash
npx biome check --write --unsafe /Users/user/Desktop/ATLAS/src/tools/coding/code-change-summary.ts
npm run typecheck
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/tools/coding/code-change-summary.ts
git commit -m "$(cat <<'EOF'
feat(git-read): add code_change_summary read-only tool

Four local-git ops (recent_commits, hot_files, diff, blame) wrapped in
the standard envelope. Never mutates; non-git directories return a
plain note. Used for context during coding queries.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `agents_md_scaffold` tool — AGENTS.md + .atlas/agents/*.md

**Files:**
- Create: `src/tools/coding/agents-md-scaffold.ts`
- Test: `/tmp/smoke-agents-md-scaffold.mts`

**Why:** Generates (or refreshes the auto-zones of) `AGENTS.md` plus eight sub-docs: `architecture.md`, `conventions.md`, `workflows.md`, `quickref.md`, `gotchas.md`, `commands.md`, `recent.md`, `notes.md`. Detects stack from build files, reuses the sidecar's architecture overview, honours `<!-- @atlas:auto -->` markers for machine-owned zones, and refuses to overwrite files lacking the marker.

- [ ] **Step 1: Write the failing smoke script**

`/tmp/smoke-agents-md-scaffold.mts`:
```typescript
import { agentsMdScaffoldTool } from "/Users/user/Desktop/ATLAS/src/tools/coding/agents-md-scaffold.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-agmd-"));
fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "fake-pkg", version: "1.0.0", description: "A fake test package",
    scripts: { build: "tsc", test: "jest" }
}, null, 2));

// 1. Virgin repo: generate everything
const r1 = JSON.parse(await agentsMdScaffoldTool.handler({ path: root }));
console.log("virgin:", JSON.stringify({ created: r1.created?.length, refused: r1.refused?.length }));
if (r1.success !== true || !fs.existsSync(path.join(root, "AGENTS.md"))) {
    console.error("FAIL: AGENTS.md not created");
    process.exit(1);
}
for (const f of ["architecture.md", "conventions.md", "workflows.md", "quickref.md", "gotchas.md", "commands.md", "recent.md", "notes.md"]) {
    if (!fs.existsSync(path.join(root, ".atlas", "agents", f))) {
        console.error(`FAIL: ${f} not created`);
        process.exit(1);
    }
}

// 2. Re-run with only: ["recent.md"] — should only touch that file
const beforeArch = fs.readFileSync(path.join(root, ".atlas/agents/architecture.md"), "utf-8");
await agentsMdScaffoldTool.handler({ path: root, only: ["recent.md"] });
const afterArch = fs.readFileSync(path.join(root, ".atlas/agents/architecture.md"), "utf-8");
if (beforeArch !== afterArch) {
    console.error("FAIL: only:[recent.md] touched architecture.md");
    process.exit(1);
}

// 3. Modify a human-owned file (conventions.md has no auto marker) and re-scaffold — refused
const conventionsPath = path.join(root, ".atlas/agents/conventions.md");
fs.writeFileSync(conventionsPath, "# My hand-written conventions\n\nDo not touch.\n");
const r3 = JSON.parse(await agentsMdScaffoldTool.handler({ path: root }));
console.log("re-run:", JSON.stringify({ refused: r3.refused }));
if (!r3.refused?.some((p: string) => p.endsWith("conventions.md"))) {
    console.error("FAIL: human-owned conventions.md not refused");
    process.exit(1);
}
const kept = fs.readFileSync(conventionsPath, "utf-8");
if (!kept.startsWith("# My hand-written")) {
    console.error("FAIL: conventions.md overwritten");
    process.exit(1);
}

fs.rmSync(root, { recursive: true, force: true });
console.log("PASS: agents_md_scaffold virgin + only-scope + refuse-human-edit");
```

- [ ] **Step 2: Run smoke to verify it fails**

```bash
npx tsx /tmp/smoke-agents-md-scaffold.mts
```
Expected: `Cannot find module`.

- [ ] **Step 3: Create `src/tools/coding/agents-md-scaffold.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── agents_md_scaffold Tool ───────────────────
// Generates AGENTS.md + .atlas/agents/*.md (8 sub-docs). Human-owned
// files (no <!-- @atlas:auto --> marker at the top) are refused. Machine-
// owned files (marker present, or listed in AUTO_BY_DEFAULT) are
// regenerated. The root AGENTS.md has an auto-zone for stats + sub-doc
// index and a human-zone for the intro paragraph.

import type { ToolDefinition } from "../get-current-time.js";
import fs from "node:fs";
import path from "node:path";
import { resolveRepoRoot } from "../../memory/codebase-merkle.js";
import { hasSidecar, openSidecar } from "../../memory/codebase-sidecar.js";
import { isPathAllowed, isProtectedPath, getPathBlockedReason } from "../../security/allowlist.js";
import { auditLog } from "../../security/audit-log.js";

const AUTO_MARKER = "<!-- @atlas:auto -->";
const AUTO_END = "<!-- @atlas:auto:end -->";

// Files regenerated by default even without a marker (machine-owned by design).
const AUTO_BY_DEFAULT = new Set<string>(["recent.md", "notes.md"]);

const SUB_DOCS = [
    "architecture.md", "conventions.md", "workflows.md", "quickref.md",
    "gotchas.md", "commands.md", "recent.md", "notes.md",
] as const;

type SubDoc = typeof SUB_DOCS[number];

interface StackInfo {
    label: string;
    scripts: Record<string, string>;
    description: string;
}

function detectStack(root: string): StackInfo {
    const info: StackInfo = { label: "generic", scripts: {}, description: "" };
    try {
        const pkgPath = path.join(root, "package.json");
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { scripts?: Record<string, string>; description?: string };
            info.label = "node";
            info.scripts = pkg.scripts ?? {};
            info.description = pkg.description ?? "";
            return info;
        }
    } catch { /* */ }
    if (fs.existsSync(path.join(root, "Cargo.toml"))) { info.label = "rust"; return info; }
    if (fs.existsSync(path.join(root, "pyproject.toml")) || fs.existsSync(path.join(root, "requirements.txt"))) {
        info.label = "python"; return info;
    }
    if (fs.existsSync(path.join(root, "go.mod"))) { info.label = "go"; return info; }
    if (fs.existsSync(path.join(root, "Gemfile"))) { info.label = "ruby"; return info; }
    return info;
}

function readIfExists(p: string): string | null {
    try { return fs.readFileSync(p, "utf-8"); } catch { return null; }
}

function isHumanOwned(existing: string | null, filename: string): boolean {
    if (existing === null) return false;
    if (AUTO_BY_DEFAULT.has(filename)) return false;
    return !existing.trimStart().startsWith(AUTO_MARKER);
}

function stampAuto(content: string): string {
    return `${AUTO_MARKER}\n${content}\n${AUTO_END}\n`;
}

function safeWrite(filePath: string, content: string): { ok: true } | { ok: false; error: string } {
    if (!isPathAllowed(filePath)) {
        return { ok: false, error: getPathBlockedReason(filePath) ?? "path not allowed" };
    }
    if (isProtectedPath(filePath)) {
        return { ok: false, error: `protected path: ${filePath}` };
    }
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, "utf-8");
        auditLog("agents_md_scaffold.write", { path: filePath, bytes: content.length });
        return { ok: true };
    } catch (err) {
        return { ok: false, error: (err as Error).message };
    }
}

function renderRootAgentsMd(root: string, stack: StackInfo, stats: { fileCount: number; symbolCount: number; depth: string | null }): string {
    const intro = `# AGENTS.md — ${path.basename(root)}\n\nThis file is a portable manifest for AI coding agents.\nSee \`.atlas/agents/\` for detailed sub-docs.\n`;
    const auto = stampAuto(
        `## Stats\n\n- Stack: ${stack.label}\n- Files indexed: ${stats.fileCount}\n- Symbols: ${stats.symbolCount}\n- Depth: ${stats.depth ?? "(not indexed)"}\n\n## Sub-docs (\`.atlas/agents/\`)\n\n${SUB_DOCS.map(s => `- \`${s}\``).join("\n")}\n`,
    );
    return `${intro}\n${auto}`;
}

function renderArchitecture(root: string, ao: { mermaid: string; ascii: string; groups: Array<{ dir: string; files: number; symbols: number }> } | null): string {
    const header = "# Architecture\n\n";
    const auto = stampAuto(
        ao
            ? `## Stats\n\n${ao.groups.map(g => `- \`${g.dir}\`: ${g.files} files, ${g.symbols} symbols`).join("\n")}\n\n## Mermaid\n\n\`\`\`mermaid\n${ao.mermaid}\n\`\`\`\n\n## ASCII\n\n\`\`\`\n${ao.ascii}\n\`\`\`\n`
            : "No codebase index found — run `codebase_index build` first.\n",
    );
    return `${header}\n${auto}`;
}

function renderConventions(): string {
    return `# Conventions\n\nList codebase-specific rules the agent should follow. Fill in manually — this file is human-owned after first generation.\n\n- Import style:\n- File layout:\n- Error handling:\n- Return shapes:\n`;
}

function renderWorkflows(): string {
    return `# Workflows\n\nHow-to recipes for common tasks. Fill in manually.\n\n- Add a new module:\n- Modify a subsystem:\n- Ship a feature:\n`;
}

function renderQuickref(): string {
    return `# Quick reference\n\nKey files with line numbers. Fill in manually.\n\n| File | Purpose |\n|---|---|\n`;
}

function renderGotchas(): string {
    return `# Gotchas\n\nLandmines and non-obvious constraints. Fill in manually.\n\n- `;
}

function renderCommands(stack: StackInfo): string {
    const lines = ["# Commands", ""];
    if (Object.keys(stack.scripts).length > 0) {
        lines.push("## Scripts");
        for (const [k, v] of Object.entries(stack.scripts)) {
            lines.push(`- \`${k}\` — \`${v}\``);
        }
    }
    lines.push("", "## Env vars", "", "Fill in manually.", "");
    return lines.join("\n");
}

function renderRecent(): string {
    return stampAuto("# Recent activity\n\n(Populated on scaffold refresh — git log summary + hot files.)\n");
}

function renderNotes(): string {
    return stampAuto("# Notes\n\nSelf-updating notes from the agent — safe to edit.\n");
}

export interface ScaffoldResult {
    created: string[];
    updated: string[];
    refused: string[];
    errors: Array<{ path: string; error: string }>;
}

async function scaffold(root: string, only?: SubDoc[]): Promise<ScaffoldResult> {
    const repoRoot = resolveRepoRoot(root);
    const stack = detectStack(repoRoot);
    const result: ScaffoldResult = { created: [], updated: [], refused: [], errors: [] };

    let archOverview: { mermaid: string; ascii: string; groups: Array<{ dir: string; files: number; symbols: number }> } | null = null;
    let stats = { fileCount: 0, symbolCount: 0, depth: null as string | null };
    if (hasSidecar(repoRoot)) {
        const db = openSidecar(repoRoot);
        const meta = db.exec("SELECT depth, file_count, symbol_count FROM index_meta WHERE repo_root = ?", [repoRoot]);
        if (meta.length > 0 && meta[0].values.length > 0) {
            stats = {
                depth: meta[0].values[0][0] as string,
                fileCount: meta[0].values[0][1] as number,
                symbolCount: meta[0].values[0][2] as number,
            };
        }
        // Architecture overview — inline since we already hold db
        const rows = db.exec("SELECT path FROM files ORDER BY path");
        const group = new Map<string, { files: number }>();
        if (rows.length > 0) {
            for (const r of rows[0].values) {
                const p = r[0] as string;
                const segs = p.split("/");
                const key = segs.slice(0, Math.min(2, segs.length - 1)).join("/") || ".";
                const g = group.get(key) ?? { files: 0 };
                g.files++;
                group.set(key, g);
            }
        }
        const groups = Array.from(group.entries()).map(([dir, v]) => ({ dir, files: v.files, symbols: 0 }));
        for (const g of groups) {
            const cnt = db.exec("SELECT COUNT(*) FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path LIKE ?", [`${g.dir}/%`]);
            g.symbols = cnt.length > 0 ? (cnt[0].values[0][0] as number) : 0;
        }
        const mermaidLines = ["flowchart LR", `  root["${path.basename(repoRoot)}"]`];
        for (let i = 0; i < groups.length; i++) {
            mermaidLines.push(`  n${i}["${groups[i].dir}\\n${groups[i].files} files · ${groups[i].symbols} symbols"]`);
            mermaidLines.push(`  root --> n${i}`);
        }
        const asciiLines = [path.basename(repoRoot)];
        for (let i = 0; i < groups.length; i++) {
            const last = i === groups.length - 1;
            asciiLines.push(`${last ? "└── " : "├── "}${groups[i].dir} (${groups[i].files} files, ${groups[i].symbols} symbols)`);
        }
        archOverview = { mermaid: mermaidLines.join("\n"), ascii: asciiLines.join("\n"), groups };
    }

    const renderMap: Record<SubDoc, () => string> = {
        "architecture.md": () => renderArchitecture(repoRoot, archOverview),
        "conventions.md": renderConventions,
        "workflows.md": renderWorkflows,
        "quickref.md": renderQuickref,
        "gotchas.md": renderGotchas,
        "commands.md": () => renderCommands(stack),
        "recent.md": renderRecent,
        "notes.md": renderNotes,
    };

    const subdocDir = path.join(repoRoot, ".atlas", "agents");
    const targets: SubDoc[] = only && only.length > 0 ? only.filter(d => SUB_DOCS.includes(d)) : [...SUB_DOCS];

    for (const name of targets) {
        const p = path.join(subdocDir, name);
        const existing = readIfExists(p);
        if (isHumanOwned(existing, name)) {
            result.refused.push(p);
            continue;
        }
        const content = renderMap[name]();
        const wr = safeWrite(p, content);
        if (wr.ok) {
            if (existing === null) result.created.push(p); else result.updated.push(p);
        } else {
            result.errors.push({ path: p, error: wr.error });
        }
    }

    // Root AGENTS.md: always re-render, but preserve any human section above/below the auto block.
    const rootMdPath = path.join(repoRoot, "AGENTS.md");
    if (!only || only.length === 0) {
        const existing = readIfExists(rootMdPath);
        let newContent: string;
        if (existing) {
            // Replace (or append) just the auto block.
            const marker = existing.indexOf(AUTO_MARKER);
            const end = existing.indexOf(AUTO_END);
            const generatedAuto = stampAuto(
                `## Stats\n\n- Stack: ${stack.label}\n- Files indexed: ${stats.fileCount}\n- Symbols: ${stats.symbolCount}\n- Depth: ${stats.depth ?? "(not indexed)"}\n\n## Sub-docs (\`.atlas/agents/\`)\n\n${SUB_DOCS.map(s => `- \`${s}\``).join("\n")}\n`,
            );
            if (marker !== -1 && end !== -1 && end > marker) {
                newContent = existing.slice(0, marker) + generatedAuto + existing.slice(end + AUTO_END.length);
            } else {
                newContent = `${existing.trimEnd()}\n\n${generatedAuto}`;
            }
        } else {
            newContent = renderRootAgentsMd(repoRoot, stack, stats);
        }
        const wr = safeWrite(rootMdPath, newContent);
        if (wr.ok) {
            if (existing === null) result.created.push(rootMdPath); else result.updated.push(rootMdPath);
        } else {
            result.errors.push({ path: rootMdPath, error: wr.error });
        }
    }

    return result;
}

export const agentsMdScaffoldTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "agents_md_scaffold",
            description: `Generate or refresh AGENTS.md + .atlas/agents/*.md (8 sub-docs).

Behaviour:
- First run on a virgin repo: creates everything.
- Subsequent runs: regenerates only files with a <!-- @atlas:auto --> marker or the
  machine-owned-by-default files (recent.md, notes.md). Human-edited files are refused.
- \`only: ["recent.md"]\` restricts refresh to a single sub-doc for daily maintenance.

Root AGENTS.md has an auto-zone for stats + sub-doc index; human-written sections above/below are preserved.`,
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "Repo root (default cwd)" },
                    only: { type: "array", items: { type: "string" }, description: "Restrict to a subset of sub-doc filenames (e.g. [\"recent.md\"])." },
                },
            },
        },
    },

    async handler(input: Record<string, unknown>): Promise<string> {
        const root = typeof input.path === "string" && input.path ? input.path : process.cwd();
        const only = Array.isArray(input.only) ? (input.only as unknown[]).filter((x): x is SubDoc => typeof x === "string" && (SUB_DOCS as readonly string[]).includes(x)) : undefined;
        try {
            const r = await scaffold(root, only);
            return JSON.stringify({ success: true, ...r });
        } catch (err) {
            return JSON.stringify({ success: false, error: `agents_md_scaffold failed: ${(err as Error).message}` });
        }
    },
};
```

- [ ] **Step 4: Run smoke to verify pass**

```bash
npx tsx /tmp/smoke-agents-md-scaffold.mts
```
Expected: `PASS: agents_md_scaffold virgin + only-scope + refuse-human-edit`.

- [ ] **Step 5: Lint + typecheck + build**

```bash
npx biome check --write --unsafe /Users/user/Desktop/ATLAS/src/tools/coding/agents-md-scaffold.ts
npm run typecheck
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/tools/coding/agents-md-scaffold.ts
git commit -m "$(cat <<'EOF'
feat(agents-md): add agents_md_scaffold tool

Generates AGENTS.md + 8 .atlas/agents/*.md sub-docs. Honours
<!-- @atlas:auto --> markers for machine-owned zones; refuses to
overwrite human-owned files. recent.md and notes.md are always
machine-owned. Root AGENTS.md preserves human sections around the
auto stats+index block. Reuses sidecar for architecture overview.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Walk-up loader extension

**Files:**
- Modify: `src/memory/project-memory.ts`
- Test: `/tmp/smoke-project-memory-ext.mts`

**Why:** Today the walk-up loader only reads `ATLAS.md`, `.atlas/ATLAS.md`, `ATLAS.local.md`. Extend it to also read `AGENTS.md` + `.atlas/agents/*.md` with task-type-aware selection. Support `<!-- @atlas:section:X -->` markers so only named sub-sections get injected when a caller passes `sections`.

- [ ] **Step 1: Write the failing smoke script**

`/tmp/smoke-project-memory-ext.mts`:
```typescript
import { loadProjectMemoryFiles, getProjectMemorySnippet } from "/Users/user/Desktop/ATLAS/src/memory/project-memory.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-pm-"));
fs.mkdirSync(path.join(root, ".atlas", "agents"), { recursive: true });
fs.writeFileSync(path.join(root, "AGENTS.md"), "# ROOT AGENTS\n");
fs.writeFileSync(path.join(root, ".atlas/agents/architecture.md"),
    "# architecture\n<!-- @atlas:section:mermaid -->\nM\n<!-- @atlas:section:mermaid:end -->\n<!-- @atlas:section:prose -->\nP\n<!-- @atlas:section:prose:end -->\n");
fs.writeFileSync(path.join(root, ".atlas/agents/gotchas.md"), "# gotchas\ndon't force-push main\n");
fs.writeFileSync(path.join(root, ".atlas/agents/notes.md"), "# notes\n");
fs.writeFileSync(path.join(root, ".atlas/agents/conventions.md"), "# conv\n");

// Default task-type=coding: loads AGENTS.md, gotchas.md, notes.md, architecture.md, conventions.md
const files = loadProjectMemoryFiles(root, { taskType: "coding" });
const names = files.map(f => path.basename(f.path)).sort();
console.log("names:", names.join(","));
for (const expected of ["AGENTS.md", "gotchas.md", "notes.md", "architecture.md", "conventions.md"]) {
    if (!names.includes(expected)) {
        console.error(`FAIL: expected ${expected} in ${names.join(",")}`);
        process.exit(1);
    }
}

// Section filter
const snip = getProjectMemorySnippet(root, { taskType: "coding", sections: { "architecture.md": ["mermaid"] } });
if (!snip.includes("M") || snip.includes("P")) {
    console.error("FAIL: section filter should keep M, drop P");
    process.exit(1);
}

// Non-coding: only AGENTS.md, gotchas.md, notes.md — NOT architecture or conventions
const other = loadProjectMemoryFiles(root, { taskType: "other" });
const otherNames = other.map(f => path.basename(f.path));
if (otherNames.includes("architecture.md") || otherNames.includes("conventions.md")) {
    console.error("FAIL: non-coding leaked architecture/conventions");
    process.exit(1);
}

fs.rmSync(root, { recursive: true, force: true });
console.log("PASS: project-memory extension");
```

- [ ] **Step 2: Run smoke to verify it fails**

```bash
npx tsx /tmp/smoke-project-memory-ext.mts
```
Expected: TypeScript error on the extra argument to `loadProjectMemoryFiles` (signature is 1-arg today).

- [ ] **Step 3: Modify `src/memory/project-memory.ts`**

Replace the whole file with this content (keeps the original public names, extends the signatures and internals):

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Project Memory (walk-up loader) ────────────
// Walks from CWD up to $HOME, collecting AGENTS.md + .atlas/agents/*.md
// + ATLAS.md files. Selective by task type. Section markers let callers
// pull specific sub-zones out of sub-docs.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const MAX_TOTAL_BYTES = 16 * 1024;
const MAX_FILE_BYTES = 8 * 1024;
const MAX_DEPTH = 20;

// Root-level candidates (most-specific first — same-directory precedence).
const FILE_CANDIDATES = [
    "ATLAS.md",
    ".atlas/ATLAS.md",
    "ATLAS.local.md",
    "AGENTS.md",
];

// Sub-docs under .atlas/agents/ that are candidates for injection.
const SUBDOC_BASENAMES = [
    "architecture.md", "conventions.md", "workflows.md", "quickref.md",
    "gotchas.md", "commands.md", "recent.md", "notes.md",
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
        const startMarker = `<!-- @atlas:section:${name} -->`;
        const endMarker = `<!-- @atlas:section:${name}:end -->`;
        const si = content.indexOf(startMarker);
        if (si === -1) continue;
        const ei = content.indexOf(endMarker, si);
        if (ei === -1) continue;
        out.push(content.slice(si + startMarker.length, ei).trim());
    }
    return out.join("\n\n");
}

/**
 * Walk up from startDir collecting AGENTS.md + ATLAS.md + the task-type-relevant
 * sub-docs under .atlas/agents/. Stops at home or root. Caps total bytes at 16K.
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
        for (const name of FILE_CANDIDATES) {
            const p = path.join(dir, name);
            if (!existsSync(p)) continue;
            const content = readCapped(p);
            if (!content) continue;
            pushIfRoom({ path: p, depth, source: "project", content, subdoc: null });
        }
        // .atlas/agents/*.md sub-docs
        const subdir = path.join(dir, ".atlas", "agents");
        if (existsSync(subdir)) {
            let entries: string[] = [];
            try { entries = readdirSync(subdir); } catch { /* */ }
            for (const name of entries) {
                if (!SUBDOC_BASENAMES.includes(name)) continue;
                if (!wanted.has(name)) continue;
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
        const userPath = path.join(homedir(), ".atlas", "ATLAS.md");
        if (existsSync(userPath)) {
            const content = readCapped(userPath);
            if (content) pushIfRoom({ path: userPath, depth: MAX_DEPTH, source: "user", content, subdoc: null });
        }
    } catch { /* */ }

    return out;
}

/**
 * Assemble the <project_memory>…</project_memory> block. Returns empty
 * string when no files were found so callers can concatenate safely.
 */
export function getProjectMemorySnippet(startDir?: string, options: LoadOptions = {}): string {
    let files: LoadedMemoryFile[];
    try { files = loadProjectMemoryFiles(startDir, options); }
    catch { return ""; }
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
```

- [ ] **Step 4: Run smoke to verify pass**

```bash
npx tsx /tmp/smoke-project-memory-ext.mts
```
Expected: `PASS: project-memory extension`.

- [ ] **Step 5: Lint + typecheck + build**

```bash
npx biome check --write --unsafe /Users/user/Desktop/ATLAS/src/memory/project-memory.ts
npm run typecheck
npm run build
```
Expected: all clean. Note — this changes the exported signature; the existing call sites in `src/agent.ts` use `getProjectMemorySnippet()` with no args (second arg is optional and defaulted to `{}`), so they keep compiling.

- [ ] **Step 6: Commit**

```bash
git add src/memory/project-memory.ts
git commit -m "$(cat <<'EOF'
feat(project-memory): read AGENTS.md + .atlas/agents/*.md

Extends the walk-up loader to include AGENTS.md and task-type-relevant
sub-docs under .atlas/agents/. Adds an optional per-sub-doc section
filter via <!-- @atlas:section:X --> markers. Existing no-arg call-sites
still compile (options are defaulted).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Knowledge-graph opt-out for `code_*` categories

**Files:**
- Modify: `src/memory/self-evolving.ts`
- Test: `/tmp/smoke-prune-skip-code.mts`

**Why:** The spec requires pruning to skip memory categories prefixed `code_`. The current `synapticPrune` SQL pulls all rows from `memories` regardless of category; add a WHERE clause that excludes `category LIKE 'code_%'` plus a runtime filter so in-memory computations are also skipped.

- [ ] **Step 1: Write the failing smoke script**

`/tmp/smoke-prune-skip-code.mts`:
```typescript
import { initMemoryDB } from "/Users/user/Desktop/ATLAS/src/memory/sqlite.ts";
import { synapticPrune } from "/Users/user/Desktop/ATLAS/src/memory/self-evolving.ts";

const db = await initMemoryDB();

// Insert a very old, low-importance code_ref memory that would normally be pruned.
db.run(
    `INSERT INTO memories (content, embedding, importance, access_count, decay_score, category, created_at, accessed_at)
     VALUES (?, zeroblob(4), 1, 0, 0.05, 'code_ref', datetime('now', '-120 days'), datetime('now', '-120 days'))`,
    ["SMOKE code_ref should survive prune"],
);

const before = db.exec("SELECT COUNT(*) FROM memories WHERE content LIKE 'SMOKE code_ref%'")[0].values[0][0];
if (before !== 1) { console.error("FAIL: setup row missing"); process.exit(1); }

synapticPrune(db);

const after = db.exec("SELECT COUNT(*) FROM memories WHERE content LIKE 'SMOKE code_ref%'")[0].values[0][0];
console.log(`before=${before} after=${after}`);
if (after !== 1) {
    console.error("FAIL: code_ref memory was pruned");
    process.exit(1);
}

// Cleanup
db.run("DELETE FROM memories WHERE content LIKE 'SMOKE code_ref%'");
console.log("PASS: synapticPrune skips code_ categories");
```

- [ ] **Step 2: Run smoke to verify it fails**

```bash
npx tsx /tmp/smoke-prune-skip-code.mts
```
Expected: `FAIL: code_ref memory was pruned` — before the guard is added, the low-importance old entry gets deleted.

- [ ] **Step 3: Modify `src/memory/self-evolving.ts`**

Narrow the `SELECT` inside `synapticPrune` so code-category memories are excluded from the prune scan. Use Edit with:

`old_string`:
```
    const results = db.exec(
        `SELECT id, importance, access_count, decay_score,
                julianday('now') - julianday(COALESCE(accessed_at, created_at)) as days_since
         FROM memories
         WHERE consolidated_into IS NULL`
    );
```

`new_string`:
```
    const results = db.exec(
        `SELECT id, importance, access_count, decay_score,
                julianday('now') - julianday(COALESCE(accessed_at, created_at)) as days_since
         FROM memories
         WHERE consolidated_into IS NULL
           AND (category IS NULL OR category NOT LIKE 'code\_%' ESCAPE '\\')`
    );
```

Also extend `findDuplicates` similarly — add the same `AND (category IS NULL OR category NOT LIKE 'code\_%' ESCAPE '\\')` clause to any SELECT inside it that reads from `memories` (double-check by re-reading the file; today it's only a recent-200 scan).

- [ ] **Step 4: Run smoke to verify pass**

```bash
npx tsx /tmp/smoke-prune-skip-code.mts
```
Expected: `PASS: synapticPrune skips code_ categories`.

- [ ] **Step 5: Lint + typecheck + build**

```bash
npx biome check --write --unsafe /Users/user/Desktop/ATLAS/src/memory/self-evolving.ts
npm run typecheck
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/memory/self-evolving.ts
git commit -m "$(cat <<'EOF'
feat(memory): exclude code_* categories from synaptic prune

Spec Phase 4L requires cross-session code observations (code_ref,
code_discussed_in, code_touched_together) to survive decay. Narrow the
synapticPrune SELECT and the findDuplicates SELECT to skip any memory
whose category LIKE 'code\_%'.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: `src/agent.ts` first-iteration auto-trigger + `<architecture>` injection

**Files:**
- Modify: `src/agent.ts` (near line 942, inside the first-iteration injection block)
- Test: `/tmp/smoke-agent-architecture-injection.mts`

**Why:** On the first iteration of a coding task, fire a non-blocking build/refresh (block inline for ≤100 files, async otherwise) and inject `<architecture>` right after `<repo_map>`. Honor two kill-switches: `ATLAS_NO_CODEBASE_INDEX` disables both the build and the injection; `ATLAS_NO_ARCHITECTURE_INJECTION` keeps the build but skips the injection.

- [ ] **Step 1: Write the failing smoke script**

`/tmp/smoke-agent-architecture-injection.mts`:
```typescript
// Smoke: call the helper used by the agent injection path directly.
// (We don't boot the full agent in the smoke — we just verify the
// helper the agent uses renders an <architecture> block.)

import { getArchitectureSnippet } from "/Users/user/Desktop/ATLAS/src/memory/codebase-index.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-arch-"));
fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;");

// Before build: empty snippet (fail-open).
const before = await getArchitectureSnippet(root);
if (before !== "") {
    console.error("FAIL: pre-build snippet should be empty, got:", before);
    process.exit(1);
}

// After build: non-empty <architecture> block containing mermaid and ascii
const { buildIndex } = await import("/Users/user/Desktop/ATLAS/src/memory/codebase-index.ts");
await buildIndex(root);
const after = await getArchitectureSnippet(root);
console.log("snippet:", after.slice(0, 200));
if (!after.startsWith("<architecture>") || !after.includes("mermaid") || !after.includes("```")) {
    console.error("FAIL: post-build snippet missing structure");
    process.exit(1);
}

// Kill-switch: ATLAS_NO_ARCHITECTURE_INJECTION returns empty string even when sidecar exists.
process.env.ATLAS_NO_ARCHITECTURE_INJECTION = "true";
const killed = await getArchitectureSnippet(root);
delete process.env.ATLAS_NO_ARCHITECTURE_INJECTION;
if (killed !== "") {
    console.error("FAIL: kill-switch did not suppress injection");
    process.exit(1);
}

fs.rmSync(root, { recursive: true, force: true });
console.log("PASS: architecture snippet builds, respects kill-switch");
```

- [ ] **Step 2: Run smoke to verify it fails**

```bash
npx tsx /tmp/smoke-agent-architecture-injection.mts
```
Expected: `Cannot find name 'getArchitectureSnippet'` — it doesn't exist yet.

- [ ] **Step 3a: Add `getArchitectureSnippet` + `ensureIndexForCoding` to `src/memory/codebase-index.ts`**

Add at the bottom of `src/memory/codebase-index.ts` (append below `wipeIndex`):

```typescript
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
            else { void buildIndex(repoRoot).catch(err => console.warn("[codebase-index] bg build failed:", (err as Error).message)); }
        } else {
            if (timing === "block") await refreshIndex(repoRoot);
            else { void refreshIndex(repoRoot).catch(err => console.warn("[codebase-index] bg refresh failed:", (err as Error).message)); }
        }
    } catch (err) {
        console.warn("[codebase-index] ensureIndexForCoding failed (non-fatal):", (err as Error).message);
    }
}
```

- [ ] **Step 3b: Patch `src/agent.ts` around line 966**

Use Edit. `old_string`:
```
            try {
                if (detectTaskType(rawUserMessage) === "coding" && process.env.ATLAS_NO_REPO_MAP !== "true") {
                    const { generateRepoMap } = await import("./tools/repo-map.js");
                    const map = await generateRepoMap(process.cwd(), {
                        maxTokens: 1500,
                        maxFiles: 200,
                        maxSymbolsPerFile: 8,
                    });
                    if (map && !map.startsWith("[No source")) {
                        parts.push(`<repo_map>\n${map}\n</repo_map>`);
                    }
                }
            } catch (err) {
                console.warn("[AGENT] repo_map injection failed (non-fatal):", (err as Error).message);
            }
```

`new_string`:
```
            try {
                if (detectTaskType(rawUserMessage) === "coding" && process.env.ATLAS_NO_REPO_MAP !== "true") {
                    const { generateRepoMap } = await import("./tools/repo-map.js");
                    const map = await generateRepoMap(process.cwd(), {
                        maxTokens: 1500,
                        maxFiles: 200,
                        maxSymbolsPerFile: 8,
                    });
                    if (map && !map.startsWith("[No source")) {
                        parts.push(`<repo_map>\n${map}\n</repo_map>`);
                    }
                }
            } catch (err) {
                console.warn("[AGENT] repo_map injection failed (non-fatal):", (err as Error).message);
            }

            // ── Codebase index auto-trigger + architecture injection (Phase 4L) ──
            // On the first iteration of a coding task: ensure the sidecar exists
            // (block inline for tiny repos, async for anything larger) and inject
            // an <architecture> block if available. Both steps fail-open.
            try {
                if (iterations === 0 && detectTaskType(rawUserMessage) === "coding") {
                    const { ensureIndexForCoding, getArchitectureSnippet } = await import("./memory/codebase-index.js");
                    await ensureIndexForCoding(process.cwd());
                    const arch = await getArchitectureSnippet(process.cwd());
                    if (arch) parts.push(arch);
                }
            } catch (err) {
                console.warn("[AGENT] architecture injection failed (non-fatal):", (err as Error).message);
            }
```

- [ ] **Step 4: Run smoke to verify pass**

```bash
npx tsx /tmp/smoke-agent-architecture-injection.mts
```
Expected: `PASS: architecture snippet builds, respects kill-switch`.

- [ ] **Step 5: Lint + typecheck + build**

```bash
npx biome check --write --unsafe \
    /Users/user/Desktop/ATLAS/src/memory/codebase-index.ts \
    /Users/user/Desktop/ATLAS/src/agent.ts
npm run typecheck
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/memory/codebase-index.ts src/agent.ts
git commit -m "$(cat <<'EOF'
feat(agent): auto-trigger codebase index + inject architecture

First iteration of a coding task now calls ensureIndexForCoding (blocks
for ≤100 files, async otherwise) and injects an <architecture> block
with Mermaid + ASCII trees. Honours ATLAS_NO_CODEBASE_INDEX and
ATLAS_NO_ARCHITECTURE_INJECTION kill-switches. Fully fail-open.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: `git_op` tool — safety-railed mutations

**Files:**
- Create: `src/tools/coding/git-op.ts`
- Test: `/tmp/smoke-git-op-safety.mts`

**Why:** Write-side git via `execFileSync` with hard safety rails. Confirm tier returns a preview; destructive ops need `evidence_phrase`; `--no-verify` / `--no-gpg-sign` stripped; `add -A` / `-u` / `.` refused; force-push to main/master/production blocked; interactive flags blocked; every mutation audit-logged.

- [ ] **Step 1: Write the failing smoke script**

`/tmp/smoke-git-op-safety.mts`:
```typescript
import { gitOpTool } from "/Users/user/Desktop/ATLAS/src/tools/coding/git-op.ts";

// 1. add with '.' is refused
const r1 = JSON.parse(await gitOpTool.handler({
    operation: "add", paths: ["."], path: "/Users/user/Desktop/ATLAS",
}));
if (r1.success !== false || !String(r1.error ?? "").toLowerCase().includes("explicit path")) {
    console.error("FAIL: add . should be refused:", r1);
    process.exit(1);
}

// 2. add with -A is refused
const r2 = JSON.parse(await gitOpTool.handler({
    operation: "add", paths: ["-A"], path: "/Users/user/Desktop/ATLAS",
}));
if (r2.success !== false) {
    console.error("FAIL: add -A should be refused");
    process.exit(1);
}

// 3. push --force to main is blocked
const r3 = JSON.parse(await gitOpTool.handler({
    operation: "push", force: true, branch: "main",
    confirmed: true, evidence_phrase: "force push", path: "/Users/user/Desktop/ATLAS",
}));
if (r3.success !== false || !String(r3.error ?? "").toLowerCase().includes("main")) {
    console.error("FAIL: force push to main should be blocked:", r3);
    process.exit(1);
}

// 4. rebase -i is blocked
const r4 = JSON.parse(await gitOpTool.handler({
    operation: "rebase", onto: "main", interactive: true, confirmed: true,
    evidence_phrase: "rebase", path: "/Users/user/Desktop/ATLAS",
}));
if (r4.success !== false) {
    console.error("FAIL: interactive rebase should be blocked");
    process.exit(1);
}

// 5. reset --hard without evidence phrase refused
const r5 = JSON.parse(await gitOpTool.handler({
    operation: "reset", mode: "hard", to: "HEAD~1",
    confirmed: true, path: "/Users/user/Desktop/ATLAS",
}));
if (r5.success !== false || !String(r5.error ?? "").toLowerCase().includes("phrase")) {
    console.error("FAIL: reset --hard without evidence phrase should be refused:", r5);
    process.exit(1);
}

// 6. status is safe and runs
const r6 = JSON.parse(await gitOpTool.handler({
    operation: "status", path: "/Users/user/Desktop/ATLAS",
}));
if (r6.success !== true) {
    console.error("FAIL: status should succeed:", r6);
    process.exit(1);
}

console.log("PASS: git_op safety rails enforced");
```

- [ ] **Step 2: Run smoke to verify it fails**

```bash
npx tsx /tmp/smoke-git-op-safety.mts
```
Expected: `Cannot find module`.

- [ ] **Step 3: Create `src/tools/coding/git-op.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── git_op Tool ───────────────────────────────
// Write-side git with hard safety rails. Only invoked when the user
// explicitly asks for a git action. Destructive ops require an
// evidence_phrase that is a substring of the user's turn. Never
// --no-verify / --no-gpg-sign. Never force-push to main/master/production.

import type { ToolDefinition } from "../get-current-time.js";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { gitAvailable, resolveRepoRoot } from "../../memory/codebase-merkle.js";
import { auditLog } from "../../security/audit-log.js";

type Tier = "safe" | "confirm" | "destructive" | "blocked";

const PROTECTED_BRANCHES = new Set(["main", "master", "production"]);
const RELEASE_PREFIX = "release/";

// Flags we strip from every invocation regardless of what the agent asks.
const BANNED_FLAGS = new Set(["--no-verify", "--no-gpg-sign"]);

function classify(op: string, input: Record<string, unknown>): Tier {
    if (op === "status" || op === "branch_list" || op === "branch_create" || op === "switch"
        || op === "stash_push" || op === "stash_pop" || op === "stash_apply" || op === "stash_list"
        || op === "tag" || op === "add" || op === "commit") return "safe";
    if (op === "revert" || op === "cherry_pick" || op === "merge") return "confirm";
    if (op === "rebase") return (input.interactive === true) ? "blocked" : "confirm";
    if (op === "reset") return "destructive";
    if (op === "clean") return "destructive";
    if (op === "push") return "destructive";
    return "blocked";
}

function isGitRepo(dir: string): boolean {
    try { return fs.existsSync(path.join(resolveRepoRoot(dir), ".git")); }
    catch { return false; }
}

function runGit(cwd: string, args: string[], timeoutMs = 10_000): { stdout: string; stderr: string; code: number } {
    try {
        const out = execFileSync("git", args, {
            cwd, encoding: "utf-8", timeout: timeoutMs,
            stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024,
        });
        return { stdout: out, stderr: "", code: 0 };
    } catch (err) {
        const e = err as { stdout?: string; stderr?: string; status?: number };
        return { stdout: e.stdout ?? "", stderr: e.stderr ?? String(err), code: e.status ?? 1 };
    }
}

function stripBanned(args: string[]): string[] {
    return args.filter(a => !BANNED_FLAGS.has(a));
}

function requirePhrase(input: Record<string, unknown>, needle: string): string | null {
    const phrase = typeof input.evidence_phrase === "string" ? input.evidence_phrase.trim().toLowerCase() : "";
    if (!phrase) return `evidence_phrase required (must include substring: "${needle}")`;
    if (!phrase.includes(needle)) return `evidence_phrase must contain the substring "${needle}"`;
    return null;
}

export const gitOpTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "git_op",
            description: `Safety-railed git write-side tool. Only call when the user explicitly asks.

Operations: status, branch_list, branch_create, switch, stash_push/pop/apply/list,
add (explicit paths only — never '.', '-A', '-u'), commit, tag, revert, cherry_pick,
merge, rebase, reset, clean, push.

Confirm tier (revert/cherry_pick/merge/rebase): default-preview. Agent surfaces
the preview and the user must re-call with confirmed: true.
Destructive tier (reset/clean/push-force): requires confirmed: true AND
evidence_phrase that is a substring of the user's own message
("force push", "reset hard", "clean force").

Hard blocks: --no-verify, --no-gpg-sign, force push to main/master/production/release/*,
interactive rebase, add -A/-u/.`,
            parameters: {
                type: "object",
                properties: {
                    operation: { type: "string", enum: ["status", "branch_list", "branch_create", "switch", "stash_push", "stash_pop", "stash_apply", "stash_list", "add", "commit", "tag", "revert", "cherry_pick", "merge", "rebase", "reset", "clean", "push"] },
                    paths: { type: "array", items: { type: "string" }, description: "Explicit paths (add)." },
                    message: { type: "string", description: "Commit / tag message." },
                    name: { type: "string", description: "Branch / tag name." },
                    from: { type: "string", description: "Starting point for branch_create." },
                    branch: { type: "string", description: "Target branch for switch / push." },
                    create: { type: "boolean", description: "Create branch on switch." },
                    stash_first: { type: "boolean", description: "Auto-stash before switch." },
                    commit: { type: "string", description: "Commit SHA (revert / cherry_pick / tag)." },
                    onto: { type: "string", description: "rebase onto ref." },
                    interactive: { type: "boolean", description: "(Blocked) interactive rebase / edit." },
                    mode: { type: "string", enum: ["soft", "mixed", "hard"], description: "reset mode." },
                    to: { type: "string", description: "reset target ref." },
                    force: { type: "boolean", description: "push --force (blocked on main/master/production)." },
                    force_with_lease: { type: "boolean", description: "push --force-with-lease." },
                    set_upstream: { type: "boolean", description: "push -u." },
                    remote: { type: "string", description: "push remote (default origin)." },
                    dirs: { type: "boolean", description: "clean -d (dirs)." },
                    confirmed: { type: "boolean", description: "Required for Confirm + Destructive tiers." },
                    evidence_phrase: { type: "string", description: "Substring of the user's turn (destructive tier)." },
                    amend: { type: "boolean", description: "commit --amend (requires the user to have said 'amend')." },
                    path: { type: "string", description: "Repo root (default cwd)." },
                },
                required: ["operation"],
            },
        },
    },

    async handler(input: Record<string, unknown>): Promise<string> {
        const operation = String(input.operation ?? "");
        const root = typeof input.path === "string" && input.path ? input.path : process.cwd();

        if (!gitAvailable()) return JSON.stringify({ success: false, error: "git not available" });
        if (!isGitRepo(root)) return JSON.stringify({ success: false, error: "not a git repo" });

        const tier = classify(operation, input);
        if (tier === "blocked") {
            return JSON.stringify({ success: false, error: `operation blocked at tool layer: ${operation}` });
        }

        // Destructive / Confirm gating
        if (tier === "confirm" || tier === "destructive") {
            if (input.confirmed !== true) {
                return JSON.stringify({
                    success: true, preview: true,
                    would_run: operation,
                    effect_summary: `${operation} (awaiting confirmation)`,
                    note: "Agent must surface this preview and await explicit user approval before re-calling with confirmed: true.",
                });
            }
        }

        try {
            if (operation === "status") {
                const r = runGit(root, ["status", "--short", "--branch"]);
                return JSON.stringify({ success: r.code === 0, status: r.stdout, stderr: r.stderr });
            }
            if (operation === "branch_list") {
                const args = ["branch", "--color=never"];
                if (input.verbose === true) args.push("-vv");
                if (input.remote === true) args.push("-r");
                const r = runGit(root, args);
                return JSON.stringify({ success: r.code === 0, branches: r.stdout.split("\n").filter(Boolean) });
            }
            if (operation === "branch_create") {
                const name = String(input.name ?? "");
                if (!name) return JSON.stringify({ success: false, error: "name required" });
                const from = typeof input.from === "string" ? input.from : undefined;
                const args = ["branch", name];
                if (from) args.push(from);
                const r = runGit(root, args);
                auditLog("git_op.branch_create", { name, from, code: r.code });
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr });
            }
            if (operation === "switch") {
                const branch = String(input.branch ?? "");
                if (!branch) return JSON.stringify({ success: false, error: "branch required" });
                // Refuse dirty tree unless stash_first=true
                const status = runGit(root, ["status", "--porcelain"]);
                if (status.stdout.trim().length > 0 && input.stash_first !== true) {
                    return JSON.stringify({ success: false, error: "dirty working tree; pass stash_first: true to auto-stash" });
                }
                if (input.stash_first === true) runGit(root, ["stash", "push", "-u", "-m", "auto-stash before switch"]);
                const args = ["switch"];
                if (input.create === true) args.push("-c");
                args.push(branch);
                const r = runGit(root, args);
                auditLog("git_op.switch", { branch, created: input.create === true, code: r.code });
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr });
            }
            if (operation === "stash_push") {
                const r = runGit(root, ["stash", "push", "-u", "-m", "atlas-stash"]);
                auditLog("git_op.stash_push", { code: r.code });
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr });
            }
            if (operation === "stash_pop") {
                const r = runGit(root, ["stash", "pop"]);
                auditLog("git_op.stash_pop", { code: r.code });
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr });
            }
            if (operation === "stash_apply") {
                const r = runGit(root, ["stash", "apply"]);
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr });
            }
            if (operation === "stash_list") {
                const r = runGit(root, ["stash", "list"]);
                return JSON.stringify({ success: r.code === 0, stashes: r.stdout.split("\n").filter(Boolean) });
            }
            if (operation === "add") {
                const paths = Array.isArray(input.paths) ? (input.paths as unknown[]).map(String) : [];
                if (paths.length === 0) return JSON.stringify({ success: false, error: "paths required (explicit paths only)" });
                for (const p of paths) {
                    if (p === "." || p === "-A" || p === "-u" || p === "--all") {
                        return JSON.stringify({ success: false, error: `refused: add only accepts explicit paths (rejected: ${p})` });
                    }
                }
                const args = stripBanned(["add", "--", ...paths]);
                const r = runGit(root, args);
                auditLog("git_op.add", { paths, code: r.code });
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr });
            }
            if (operation === "commit") {
                const message = String(input.message ?? "");
                if (!message) return JSON.stringify({ success: false, error: "message required" });
                const args = ["commit", "-m", message];
                if (input.amend === true) {
                    const phraseErr = requirePhrase(input, "amend");
                    if (phraseErr) return JSON.stringify({ success: false, error: phraseErr });
                    args.push("--amend");
                }
                const r = runGit(root, stripBanned(args));
                auditLog("git_op.commit", { amend: input.amend === true, code: r.code });
                if (r.code !== 0) return JSON.stringify({ success: false, stderr: r.stderr, hook_failed: true });
                const sha = runGit(root, ["rev-parse", "HEAD"]).stdout.trim();
                return JSON.stringify({ success: true, commit_sha: sha, stdout: r.stdout });
            }
            if (operation === "tag") {
                const name = String(input.name ?? "");
                if (!name) return JSON.stringify({ success: false, error: "name required" });
                const args = ["tag", name];
                const message = typeof input.message === "string" ? input.message : undefined;
                if (message) { args.splice(1, 0, "-a", "-m", message); }
                if (typeof input.commit === "string" && input.commit) args.push(input.commit);
                const r = runGit(root, stripBanned(args));
                auditLog("git_op.tag", { name, code: r.code });
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr });
            }
            if (operation === "revert") {
                const commit = String(input.commit ?? "");
                if (!commit) return JSON.stringify({ success: false, error: "commit required" });
                const r = runGit(root, stripBanned(["revert", "--no-edit", commit]));
                auditLog("git_op.revert", { commit, code: r.code });
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr });
            }
            if (operation === "cherry_pick") {
                const commit = String(input.commit ?? "");
                if (!commit) return JSON.stringify({ success: false, error: "commit required" });
                const r = runGit(root, stripBanned(["cherry-pick", commit]));
                auditLog("git_op.cherry_pick", { commit, code: r.code });
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr });
            }
            if (operation === "merge") {
                const branch = String(input.branch ?? "");
                if (!branch) return JSON.stringify({ success: false, error: "branch required" });
                const args = ["merge"];
                if (input.no_ff === true) args.push("--no-ff");
                args.push(branch);
                const r = runGit(root, stripBanned(args));
                auditLog("git_op.merge", { branch, no_ff: input.no_ff === true, code: r.code });
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr });
            }
            if (operation === "rebase") {
                if (input.interactive === true) {
                    return JSON.stringify({ success: false, error: "interactive rebase blocked at tool layer" });
                }
                const onto = String(input.onto ?? "");
                if (!onto) return JSON.stringify({ success: false, error: "onto required" });
                const r = runGit(root, stripBanned(["rebase", onto]));
                auditLog("git_op.rebase", { onto, code: r.code });
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr });
            }
            if (operation === "reset") {
                const mode = (typeof input.mode === "string" ? input.mode : "mixed") as "soft" | "mixed" | "hard";
                const to = String(input.to ?? "HEAD");
                if (mode === "hard") {
                    const phraseErr = requirePhrase(input, "reset hard");
                    if (phraseErr) return JSON.stringify({ success: false, error: phraseErr });
                }
                const r = runGit(root, stripBanned(["reset", `--${mode}`, to]));
                auditLog("git_op.reset", { mode, to, code: r.code });
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr });
            }
            if (operation === "clean") {
                const phraseErr = requirePhrase(input, "clean force");
                if (phraseErr) return JSON.stringify({ success: false, error: phraseErr });
                const args = ["clean", "-f"];
                if (input.dirs === true) args.push("-d");
                const paths = Array.isArray(input.paths) ? (input.paths as unknown[]).map(String) : [];
                if (paths.length > 0) args.push("--", ...paths);
                const r = runGit(root, stripBanned(args));
                auditLog("git_op.clean", { paths, code: r.code });
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr });
            }
            if (operation === "push") {
                const remote = typeof input.remote === "string" && input.remote ? input.remote : "origin";
                const branch = typeof input.branch === "string" && input.branch ? input.branch
                    : runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
                const force = input.force === true;
                const forceLease = input.force_with_lease === true;
                const setUpstream = input.set_upstream === true;

                if (force && (PROTECTED_BRANCHES.has(branch) || branch.startsWith(RELEASE_PREFIX))) {
                    return JSON.stringify({ success: false, error: `force push to ${branch} is blocked at the tool layer` });
                }
                if (force) {
                    const phraseErr = requirePhrase(input, "force push");
                    if (phraseErr) return JSON.stringify({ success: false, error: phraseErr });
                }

                const args = ["push"];
                if (setUpstream) args.push("-u");
                if (forceLease && !force) args.push("--force-with-lease");
                if (force) args.push("--force");
                args.push(remote, branch);
                const r = runGit(root, stripBanned(args));
                auditLog("git_op.push", { remote, branch, force, force_with_lease: forceLease, code: r.code });
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr, stdout: r.stdout });
            }
            return JSON.stringify({ success: false, error: `unknown operation: ${operation}` });
        } catch (err) {
            return JSON.stringify({ success: false, error: `git_op failed: ${(err as Error).message}` });
        }
    },
};
```

- [ ] **Step 4: Run smoke to verify pass**

```bash
npx tsx /tmp/smoke-git-op-safety.mts
```
Expected: `PASS: git_op safety rails enforced`.

- [ ] **Step 5: Lint + typecheck + build**

```bash
npx biome check --write --unsafe /Users/user/Desktop/ATLAS/src/tools/coding/git-op.ts
npm run typecheck
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/tools/coding/git-op.ts
git commit -m "$(cat <<'EOF'
feat(git-op): add git_op write-side tool with safety rails

Wraps local git write ops (status, branch, switch, stash, add, commit,
tag, revert, cherry_pick, merge, rebase, reset, clean, push) with the
spec's hard safety rails: add-explicit-paths-only, force-push-to-main
blocked, interactive rebase blocked, --no-verify/--no-gpg-sign stripped,
destructive ops gated by evidence_phrase. Every mutation audit-logged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: `prompts/coding.md` — Codebase comprehension + Git operations sections

**Files:**
- Modify: `prompts/coding.md` (append two new sections near the end of the file, before the final "Verification before claiming completion" section)
- Test: `/tmp/smoke-coding-prompt-sections.mts`

**Why:** The agent needs prompt-level guidance on when and how to use the five new tools.

- [ ] **Step 1: Write the failing smoke script**

`/tmp/smoke-coding-prompt-sections.mts`:
```typescript
import fs from "node:fs";
const contents = fs.readFileSync("/Users/user/Desktop/ATLAS/prompts/coding.md", "utf-8");
for (const needle of [
    "## Codebase comprehension",
    "codebase_index",
    "codebase_query",
    "agents_md_scaffold",
    "code_change_summary",
    "## Git operations",
    "git_op",
    "force-push to main/master/production",
]) {
    if (!contents.includes(needle)) {
        console.error(`FAIL: coding.md missing "${needle}"`);
        process.exit(1);
    }
}
console.log("PASS: coding.md has codebase + git-op sections");
```

- [ ] **Step 2: Run smoke to verify it fails**

```bash
npx tsx /tmp/smoke-coding-prompt-sections.mts
```
Expected: `FAIL: coding.md missing "## Codebase comprehension"`.

- [ ] **Step 3: Append to `prompts/coding.md`**

Insert the block below immediately before the existing "## Verification before claiming completion" heading. Use Edit with a unique `old_string` just before that heading; `new_string` = that same text prefixed with these two new sections:

```markdown
## Codebase comprehension

On the first iteration of a coding task, the agent loop auto-triggers a codebase index and injects an `<architecture>` block if one is available. You also have five dedicated tools:

- `codebase_index` — build, refresh, inspect, or wipe the per-repo sidecar SQLite index. Use `build` only on a virgin repo or when `stats` shows the index is stale; otherwise prefer `refresh` (Merkle-based, skips unchanged files). `stats` is a cheap read.
- `codebase_query` — six pure-SQL operations: `find_symbol`, `find_usages`, `file_neighborhood`, `describe_file`, `architecture_overview`, `dependency_chain`. Prefer these over raw `grep` when you know the symbol or file name — the results are structured and include call-sites resolved across the repo.
- `code_change_summary` — read-only local git context (`recent_commits`, `hot_files`, `diff`, `blame`). Safe to call any time to understand recent activity; never mutates.
- `agents_md_scaffold` — generates or refreshes `AGENTS.md` + `.atlas/agents/*.md`. Refuses to overwrite human-edited files (those without a `<!-- @atlas:auto -->` marker). Use `only: ["recent.md"]` for a daily hot-files refresh without touching anything else.
- Prefer `codebase_query find_symbol` + `codebase_query find_usages` over `lsp`/`grep` when the index exists — cheaper and structured.

## Git operations

Read-side (`code_change_summary`) is free to call for context. Write-side (`git_op`) is only called when the user explicitly asks. Never auto-commit, never auto-push, never amend unless the user said "amend". For destructive ops, surface the preview and wait for explicit approval before confirming. Force-push to main/master/production is blocked at the tool layer — don't try to work around it.

```

(If the final "## Verification before claiming completion" heading is not the right anchor in a later version of the file, append the two sections at the end of the file before the last line.)

- [ ] **Step 4: Run smoke to verify pass**

```bash
npx tsx /tmp/smoke-coding-prompt-sections.mts
```
Expected: `PASS: coding.md has codebase + git-op sections`.

- [ ] **Step 5: Lint + typecheck + build**

```bash
npm run typecheck
npm run build
```
Markdown files are not part of the Biome config, but build must still pass because the prompt is read-at-boot.

- [ ] **Step 6: Commit**

```bash
git add prompts/coding.md
git commit -m "$(cat <<'EOF'
docs(coding): add codebase comprehension + git operations sections

Prompt-level guidance for the five Phase 4L tools (codebase_index,
codebase_query, code_change_summary, agents_md_scaffold, git_op). Read
vs. write git rules explicit. Force-push-to-main rule documented.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Router sync + sub-agent role + tools/index registration

**Files:**
- Modify: `src/tools/index.ts` (import + register the five new tools)
- Modify: `src/agents/sub-agent.ts` (`ROLE_TOOLS.coder`)
- Modify: `src/tool-router.ts` (`CATEGORIES.coding.tools`, new category `code_intelligence`, `KEYWORD_BOOSTS`)
- Test: `/tmp/smoke-tool-registration.mts`

**Why:** Wires the tools into the runtime surface: registered in the tool map, available to the `coder` sub-agent role, semantically selectable by the router.

- [ ] **Step 1: Write the failing smoke script**

`/tmp/smoke-tool-registration.mts`:
```typescript
import { getToolSchemas, executeTool } from "/Users/user/Desktop/ATLAS/src/tools/index.ts";

const schemas = await getToolSchemas();
const names = new Set(schemas.map(s => s.function.name));
for (const n of ["codebase_index", "codebase_query", "code_change_summary", "agents_md_scaffold", "git_op"]) {
    if (!names.has(n)) {
        console.error(`FAIL: ${n} not registered`);
        process.exit(1);
    }
}

// Basic invocation sanity — handler reachable
const out = await executeTool("codebase_index", { command: "stats" });
const parsed = JSON.parse(out);
if (typeof parsed.success !== "boolean") {
    console.error("FAIL: codebase_index stats invocation wrong:", out);
    process.exit(1);
}

console.log("PASS: five tools registered + reachable");
```

- [ ] **Step 2: Run smoke to verify it fails**

```bash
npx tsx /tmp/smoke-tool-registration.mts
```
Expected: `FAIL: codebase_index not registered`.

- [ ] **Step 3a: Modify `src/tools/index.ts`**

Add these imports alongside the other `./coding/` imports (near line 30):

```typescript
import { codebaseIndexTool } from "./coding/codebase-index.js";
import { codebaseQueryTool } from "./coding/codebase-query.js";
import { codeChangeSummaryTool } from "./coding/code-change-summary.js";
import { agentsMdScaffoldTool } from "./coding/agents-md-scaffold.js";
import { gitOpTool } from "./coding/git-op.js";
```

Add these registrations right below the existing `registry.set(repoMapTool.schema.function.name, repoMapTool);` line (line 392):

```typescript
// Phase 4L: codebase comprehension + git ops
registry.set(codebaseIndexTool.schema.function.name, codebaseIndexTool);
registry.set(codebaseQueryTool.schema.function.name, codebaseQueryTool);
registry.set(codeChangeSummaryTool.schema.function.name, codeChangeSummaryTool);
registry.set(agentsMdScaffoldTool.schema.function.name, agentsMdScaffoldTool);
registry.set(gitOpTool.schema.function.name, gitOpTool);
```

- [ ] **Step 3b: Modify `src/agents/sub-agent.ts`**

Edit the `coder:` entry in `ROLE_TOOLS` (line 61) to append the five new names. Exact `old_string`:

```
    coder: [
        "shell_exec", "shell_exec_background", "shell_check_process", "shell_wait_process", "shell_kill_process",
        "read", "edit", "write", "append_file", "grep", "glob", "notebook_edit",
        "list_directory", "delete_file", "get_current_time",
        "code_action", "code_execute", "repo_map", "lsp", "test_run", "fix_issue",
        "enter_plan_mode", "exit_plan_mode", "enter_spec_mode", "finalize_spec",
        // Browser verification for UI/frontend changes (Phase 4J)
        "browser_verify", "browser_navigate", "browser_scan", "browser_wait", "browser_run_js",
        // Web design toolkit (Phase 4K): asset search + download + scaffolding
        "stock_image_search", "icon_search", "web_asset_download", "scaffold_project",
    ],
```

Exact `new_string`:

```
    coder: [
        "shell_exec", "shell_exec_background", "shell_check_process", "shell_wait_process", "shell_kill_process",
        "read", "edit", "write", "append_file", "grep", "glob", "notebook_edit",
        "list_directory", "delete_file", "get_current_time",
        "code_action", "code_execute", "repo_map", "lsp", "test_run", "fix_issue",
        "enter_plan_mode", "exit_plan_mode", "enter_spec_mode", "finalize_spec",
        // Browser verification for UI/frontend changes (Phase 4J)
        "browser_verify", "browser_navigate", "browser_scan", "browser_wait", "browser_run_js",
        // Web design toolkit (Phase 4K): asset search + download + scaffolding
        "stock_image_search", "icon_search", "web_asset_download", "scaffold_project",
        // Codebase comprehension + git (Phase 4L)
        "codebase_index", "codebase_query", "code_change_summary", "agents_md_scaffold", "git_op",
    ],
```

- [ ] **Step 3c: Modify `src/tool-router.ts`**

Append to `CATEGORIES.coding.tools` array (around line 120). Exact `old_string`:

```
        tools: [
            "read", "edit", "write", "grep", "glob", "notebook_edit",
            "lsp", "test_run", "fix_issue", "shell_exec", "append_file", "repo_map",
            "enter_plan_mode", "exit_plan_mode", "enter_spec_mode", "finalize_spec",
            "code_action", "code_execute", "browser_verify",
            "stock_image_search", "icon_search", "web_asset_download", "scaffold_project",
            "shell_exec_background", "shell_check_process",
            "shell_wait_process", "shell_kill_process",
            "list_directory", "delete_file", "get_current_time",
        ],
    },
```

Exact `new_string`:

```
        tools: [
            "read", "edit", "write", "grep", "glob", "notebook_edit",
            "lsp", "test_run", "fix_issue", "shell_exec", "append_file", "repo_map",
            "enter_plan_mode", "exit_plan_mode", "enter_spec_mode", "finalize_spec",
            "code_action", "code_execute", "browser_verify",
            "stock_image_search", "icon_search", "web_asset_download", "scaffold_project",
            "shell_exec_background", "shell_check_process",
            "shell_wait_process", "shell_kill_process",
            "list_directory", "delete_file", "get_current_time",
            // Phase 4L: codebase comprehension + git
            "codebase_index", "codebase_query", "code_change_summary", "agents_md_scaffold", "git_op",
        ],
    },
```

Next, extend the existing `codebase` category description + tools block (around line 243) to include the new query/scaffold tools. Exact `old_string`:

```
    codebase: {
        description: "Understanding code repositories, mapping codebase structure, finding functions and classes in a project, getting an overview of a repository's architecture, listing symbols (functions, classes, interfaces, types) across files. Repository analysis and navigation.",
        tools: [
            "repo_map",
        ],
    },
```

Exact `new_string`:

```
    codebase: {
        description: "Understanding code repositories, mapping codebase structure, finding functions and classes in a project, getting an overview of a repository's architecture, listing symbols (functions, classes, interfaces, types) across files, tracing call-graphs, finding where a symbol is used, generating AGENTS.md + .atlas/agents/*.md onboarding docs, reading recent git activity (commits, hot files, diffs, blame) for context. Repository analysis, navigation, and onboarding.",
        tools: [
            "repo_map",
            "codebase_index", "codebase_query", "code_change_summary", "agents_md_scaffold",
        ],
    },
```

Finally, add the following entries at the END of the `KEYWORD_BOOSTS` array (just before the closing `];`, after the existing coding keyword boosts):

```typescript
    // Phase 4L: codebase comprehension
    { pattern: /\b(architecture.?overview|mindmap|subsystem.?map|project.?structure|codebase.?(map|overview|structure))\b/i, category: "codebase", minScore: 0.8 },
    { pattern: /\b(find.?usages|where.*(called|used)|call.?sites?|used.?by|callers?\s+of)\b/i, category: "codebase", minScore: 0.75 },
    { pattern: /\b(dependency.?chain|import.?path|how.*depends.*on)\b/i, category: "codebase", minScore: 0.75 },
    { pattern: /\b(agents\.?md|AGENTS\.?md|atlas.?agents?|project.?memory.?doc)\b/i, category: "codebase", minScore: 0.85 },
    { pattern: /\b(hot.?files?|recent.?commits?|what.*(changed|moved).*(recent|last))\b/i, category: "codebase", minScore: 0.7 },
    // Phase 4L: git write-side
    { pattern: /\b(git.?(commit|add|push|stash|merge|rebase|reset|revert|cherry.?pick|switch|branch|tag|clean))\b/i, category: "coding", minScore: 0.8 },
    { pattern: /\b(force.?push|reset.?hard|clean.?force|amend.*(commit|message))\b/i, category: "coding", minScore: 0.85 },
    { pattern: /\b(stage|unstage|cherry.?pick|conflict|merge.?conflict)\b/i, category: "coding", minScore: 0.7 },
```

- [ ] **Step 4: Run smoke to verify pass**

```bash
npx tsx /tmp/smoke-tool-registration.mts
```
Expected: `PASS: five tools registered + reachable`.

- [ ] **Step 5: Lint + typecheck + build**

```bash
npx biome check --write --unsafe \
    /Users/user/Desktop/ATLAS/src/tools/index.ts \
    /Users/user/Desktop/ATLAS/src/agents/sub-agent.ts \
    /Users/user/Desktop/ATLAS/src/tool-router.ts
npm run typecheck
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/tools/index.ts src/agents/sub-agent.ts src/tool-router.ts
git commit -m "$(cat <<'EOF'
feat(router): register Phase 4L tools + expand coding/codebase routing

Wires codebase_index, codebase_query, code_change_summary,
agents_md_scaffold, and git_op into the registry, the coder sub-agent
role, and the coding + codebase categories. Adds seven KEYWORD_BOOSTS
for architecture/usages/AGENTS.md/git phrasings.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Regression smoke matrix

**Files:**
- Create: `/tmp/smoke-phase-4l-regression.mts`

**Why:** One final check that verifies the full Phase 4L surface against the ATLAS repo and that no prior flow regressed.

- [ ] **Step 1: Write the regression script**

`/tmp/smoke-phase-4l-regression.mts`:
```typescript
// Full end-to-end Phase 4L regression. Assumes boot is not required —
// each tool is exercised via its exported handler.

import { codebaseIndexTool } from "/Users/user/Desktop/ATLAS/src/tools/coding/codebase-index.ts";
import { codebaseQueryTool } from "/Users/user/Desktop/ATLAS/src/tools/coding/codebase-query.ts";
import { codeChangeSummaryTool } from "/Users/user/Desktop/ATLAS/src/tools/coding/code-change-summary.ts";
import { agentsMdScaffoldTool } from "/Users/user/Desktop/ATLAS/src/tools/coding/agents-md-scaffold.ts";
import { gitOpTool } from "/Users/user/Desktop/ATLAS/src/tools/coding/git-op.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ATLAS = "/Users/user/Desktop/ATLAS";
const failures: string[] = [];
const ok = (name: string, cond: boolean, detail = "") => { if (!cond) failures.push(`${name}: ${detail}`); else console.log(`ok ${name}`); };

// 1. Build / refresh ATLAS itself
const build = JSON.parse(await codebaseIndexTool.handler({ command: "build", path: ATLAS }));
ok("build ATLAS", build.success === true && build.fileCount > 200, JSON.stringify(build).slice(0, 300));

// 2. Stats is plausible
const stats = JSON.parse(await codebaseIndexTool.handler({ command: "stats", path: ATLAS }));
ok("stats ATLAS", stats.success === true && stats.fileCount > 200 && stats.symbolCount > 500);

// 3. find_symbol runAgent -> hit in src/agent.ts
const sym = JSON.parse(await codebaseQueryTool.handler({ operation: "find_symbol", name: "runAgent", path: ATLAS }));
ok("find_symbol runAgent",
    sym.success === true && Array.isArray(sym.matches) && sym.matches.some((m: { file: string }) => m.file.endsWith("src/agent.ts")),
    JSON.stringify(sym).slice(0, 200),
);

// 4. find_usages runAgent -> multiple files
const usages = JSON.parse(await codebaseQueryTool.handler({ operation: "find_usages", name: "runAgent", path: ATLAS }));
ok("find_usages runAgent", usages.success === true && Array.isArray(usages.usages) && usages.usages.length >= 1);

// 5. architecture_overview -> mermaid + ascii present
const ao = JSON.parse(await codebaseQueryTool.handler({ operation: "architecture_overview", path: ATLAS }));
ok("architecture_overview",
    ao.success === true && typeof ao.mermaid === "string" && ao.mermaid.includes("flowchart") && typeof ao.ascii === "string" && ao.ascii.length > 0,
);

// 6. code_change_summary recent_commits -> at least 1 commit
const rc = JSON.parse(await codeChangeSummaryTool.handler({ operation: "recent_commits", n: 5, path: ATLAS }));
ok("recent_commits", rc.success === true && Array.isArray(rc.commits) && rc.commits.length >= 1);

// 7. agents_md_scaffold in a scratch dir — writes files
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-agmd-final-"));
fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "fake", scripts: { build: "tsc" } }));
const scaffold = JSON.parse(await agentsMdScaffoldTool.handler({ path: tmp }));
ok("agents_md_scaffold creates files",
    scaffold.success === true && fs.existsSync(path.join(tmp, "AGENTS.md")) && fs.existsSync(path.join(tmp, ".atlas/agents/architecture.md")),
);
fs.rmSync(tmp, { recursive: true, force: true });

// 8. git_op status works on ATLAS
const gs = JSON.parse(await gitOpTool.handler({ operation: "status", path: ATLAS }));
ok("git_op status", gs.success === true && typeof gs.status === "string");

// 9. git_op push --force to main is blocked
const gp = JSON.parse(await gitOpTool.handler({
    operation: "push", force: true, branch: "main",
    confirmed: true, evidence_phrase: "force push", path: ATLAS,
}));
ok("push-force-main blocked", gp.success === false && String(gp.error ?? "").includes("blocked"));

// 10. Non-coding query: kill-switch respected
process.env.ATLAS_NO_CODEBASE_INDEX = "true";
const killed = JSON.parse(await codebaseIndexTool.handler({ command: "build", path: ATLAS }));
delete process.env.ATLAS_NO_CODEBASE_INDEX;
ok("kill-switch honored", killed.success === false && String(killed.error ?? "").includes("disabled"));

if (failures.length > 0) {
    console.error("\nFAILURES:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
}
console.log("\nPASS: Phase 4L regression 10/10");
```

- [ ] **Step 2: Run the regression**

```bash
npx tsx /tmp/smoke-phase-4l-regression.mts
```
Expected final line: `PASS: Phase 4L regression 10/10`.

- [ ] **Step 3: Full build one more time**

```bash
npm run typecheck
npm run build
```
Expected: clean.

- [ ] **Step 4: Commit the smoke script (optional)**

If you want to keep the regression script in the tree for future runs:

```bash
mkdir -p /Users/user/Desktop/ATLAS/data/smoke
cp /tmp/smoke-phase-4l-regression.mts /Users/user/Desktop/ATLAS/data/smoke/phase-4l-regression.mts
git add data/smoke/phase-4l-regression.mts
git commit -m "$(cat <<'EOF'
test(codebase): add Phase 4L regression smoke

Single-file end-to-end regression exercising codebase_index, codebase_query,
code_change_summary, agents_md_scaffold, git_op, and the kill-switch path
against the ATLAS repo. Run with: npx tsx data/smoke/phase-4l-regression.mts

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

`data/` is gitignored in the main branch — if that blocks the commit, leave the file at `/tmp/` and skip this step.

---

## Spec coverage map

| Spec section | Implementing task(s) |
|---|---|
| Architecture diagram (lines 25–61) | Tasks 2, 3, 5, 6, 7, 12 |
| Sidecar SQLite schema | Task 3 (open + schema), Task 5 (upserts) |
| Knowledge-graph bridge (code_ref) | Task 11 (decay opt-out) |
| Per-repo keying (repo_hash) | Task 2 |
| Flow A — Auto-trigger | Task 12 |
| Flow B — build / refresh | Task 5 |
| Flow C — codebase_query ops (6) | Task 7 |
| Flow D — agents_md_scaffold | Task 9 |
| Flow E — code_change_summary | Task 8 |
| Flow F — git_op confirm semantics | Task 13 |
| Depth picker | Task 5 (`pickDepth`) |
| Timing picker | Task 5 (`pickTiming`) + Task 12 (uses it) |
| AGENTS.md split layout (8 sub-docs) | Task 9 |
| Walk-up loader rules | Task 10 |
| Section markers (`<!-- @atlas:section:X -->`) | Task 10 |
| Any-codebase generalization — language tiers | Task 4 (`code-parse/regex-extractors`) |
| Repo shapes (git / non-git / monorepo / worktrees / LFS) | Task 2 (git fallback) + Task 4 (LFS) + Task 5 (agent-worktrees skip) |
| Size tiers | Task 5 (pickers) |
| Build-tool detection breadth | Task 9 (`detectStack`) |
| Parser robustness (keyword skip, 100KB cap, quarantine) | Task 4 |
| Performance budgets | Tasks 3 (WAL), 5 (transaction batching) — validated in Task 16 |
| Git ops safety rails (all 9 rails in spec) | Task 13 |
| Evidence-phrase gating | Task 13 |
| Error handling table (all 13 rows) | Task 3 (corruption rebuild), Task 5 (partial rollback), Task 8 (non-git note), Task 9 (refuse human-owned), Task 12 (non-fatal warnings) |
| Kill-switches (4 env vars) | Task 5 (`ATLAS_INDEX_DEPTH`, `ATLAS_INDEX_ASYNC`), Task 6 (`ATLAS_NO_CODEBASE_INDEX`), Task 12 (`ATLAS_NO_ARCHITECTURE_INJECTION`) |
| Testing strategy (all listed smokes) | Tasks 4, 5, 7, 9, 13, 16 |
| Observability (entry/exit log + audit) | Task 5 (build log), Task 6 (audit-log), Task 9 (audit-log), Task 13 (audit-log) |
| Rollback plan | Task 12 kill-switch + sidecar files stay on disk |
| Prompt additions | Task 14 |
| Shipping order (11 steps in spec) | Tasks 1–15 |

---

## Post-implementation checklist

After all 16 tasks are landed, manually confirm:

1. `npm run build` and `npm run typecheck` — both clean.
2. `npx tsx /tmp/smoke-phase-4l-regression.mts` — 10/10 pass.
3. From a Telegram message: "Give me an architecture overview of this repo." → `<tool_log>` shows `codebase_query architecture_overview`, reply contains both Mermaid and ASCII.
4. From Telegram: "Where is `runAgent` called from?" → uses `codebase_query find_usages`, not raw grep.
5. From Telegram: "Commit the staged changes with message 'feat: test'" → `git_op commit` runs, new SHA returned.
6. From Telegram: "Force-push to main." → blocked, clear error.
7. From Telegram: "Reset --hard HEAD~1." → confirm preview; after user says "go ahead, reset hard", destructive branch runs and returns success.
8. `ATLAS_NO_CODEBASE_INDEX=true npm start` — boots, coding queries still work (no index, no injection, tool returns `{ success: false, error: "disabled" }`).
9. Regression matrix (non-coding flows) from prior phases: unchanged.

