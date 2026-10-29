// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

// Local SQLite buffer for bot-authored self-improvement drafts. Throughout
// the day the agent calls self_improvement_draft and the entries accumulate
// here. At night, the dream-replay synthesis pass merges all drafts for
// each slug, posts the result to the server (user_prompt_addenda), and
// deletes the local rows. This keeps draft churn off the server while still
// honoring "no prompts on the user's filesystem long-term" — drafts live a
// single day at most.

import type { Database } from "./sqlite.js";

let _db: Database | null = null;

export interface DraftRow {
    id: number;
    kind: "personality" | "skill" | "memory";
    slug: string;
    content: string;
    reason: string;
    createdAt: number;
}

export function initSelfImprovementDrafts(db: Database): void {
    _db = db;
    db.run(`
        CREATE TABLE IF NOT EXISTS self_improvement_drafts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            slug TEXT NOT NULL,
            content TEXT NOT NULL,
            reason TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )
    `);
    db.run("CREATE INDEX IF NOT EXISTS idx_drafts_slug ON self_improvement_drafts(slug)");
}

// Reserved system slugs the bot must not be able to draft into via the local
// buffer (server would reject them anyway, but stop them upstream so they
// don't churn forever as poison-pill drafts).
const RESERVED_SLUG_PREFIXES = ["identity", "rules", "browsing", "coding", "thinking", "spec", "orchestrator"];
const USER_OWNED_SLUGS = new Set(["user-personality"]);
const SLUG_RE = /^[a-z0-9-]+$/;

export function addDraft(args: {
    kind: "personality" | "skill" | "memory";
    slug: string;
    content: string;
    reason: string;
}): { id: number } {
    if (!_db) throw new Error("Self-improvement drafts DB not initialized");
    if (!args.slug || !args.content || !args.reason) {
        throw new Error("kind, slug, content, reason are required");
    }
    // Slug format must match what the server accepts — fail fast locally so
    // mismatched drafts don't accumulate and burn synthesis calls.
    if (args.slug.length < 3 || args.slug.length > 64) {
        throw new Error("slug must be 3-64 chars");
    }
    if (!SLUG_RE.test(args.slug)) {
        throw new Error("slug must be kebab-case (lowercase letters, digits, dashes)");
    }
    if (USER_OWNED_SLUGS.has(args.slug)) {
        throw new Error(`slug '${args.slug}' is reserved for user-controlled settings — bot cannot draft to it`);
    }
    if (RESERVED_SLUG_PREFIXES.some((p) => args.slug === p || args.slug.startsWith(p + "-"))) {
        throw new Error(`slug '${args.slug}' collides with a core system slug`);
    }
    // Kind-prefix enforcement so synthesis can rely on slug→kind homogeneity.
    if (args.kind === "skill" && !args.slug.startsWith("skill-")) {
        throw new Error("skill drafts must use slug prefix 'skill-'");
    }
    if (args.kind === "memory" && !args.slug.startsWith("memory-")) {
        throw new Error("memory drafts must use slug prefix 'memory-'");
    }
    if (args.content.length > 50_000) {
        throw new Error("draft content exceeds 50KB");
    }
    // Enforce kind homogeneity within a slug: all drafts for the same slug
    // must declare the same kind. Different kind on the same slug rejects.
    const existing = _db.exec(
        "SELECT kind FROM self_improvement_drafts WHERE slug = ? LIMIT 1",
        [args.slug],
    );
    if (existing.length > 0 && existing[0].values.length > 0) {
        const existingKind = existing[0].values[0][0] as string;
        if (existingKind !== args.kind) {
            throw new Error(`slug '${args.slug}' already has drafts of kind '${existingKind}' — cannot mix with '${args.kind}'`);
        }
    }
    _db.run(
        "INSERT INTO self_improvement_drafts (kind, slug, content, reason, created_at) VALUES (?, ?, ?, ?, ?)",
        [args.kind, args.slug, args.content, args.reason, Date.now()],
    );
    const r = _db.exec("SELECT last_insert_rowid() as id");
    const id = (r[0]?.values[0]?.[0] as number) || 0;
    return { id };
}

// Drop drafts older than the given age cutoff. Used by synthesis to evict
// poison-pill drafts that keep failing upload night after night.
export function discardStaleDrafts(maxAgeMs: number): number {
    if (!_db) return 0;
    const cutoff = Date.now() - maxAgeMs;
    const before = _db.exec("SELECT COUNT(*) FROM self_improvement_drafts WHERE created_at < ?", [cutoff]);
    const count = (before[0]?.values[0]?.[0] as number) || 0;
    _db.run("DELETE FROM self_improvement_drafts WHERE created_at < ?", [cutoff]);
    return count;
}

export function listDrafts(slug?: string): DraftRow[] {
    if (!_db) return [];
    const rows = slug
        ? _db.exec("SELECT id, kind, slug, content, reason, created_at FROM self_improvement_drafts WHERE slug = ? ORDER BY created_at ASC", [slug])
        : _db.exec("SELECT id, kind, slug, content, reason, created_at FROM self_improvement_drafts ORDER BY slug, created_at ASC");
    if (rows.length === 0 || rows[0].values.length === 0) return [];
    return rows[0].values.map((v: unknown[]) => ({
        id: v[0] as number,
        kind: v[1] as "personality" | "skill" | "memory",
        slug: v[2] as string,
        content: v[3] as string,
        reason: v[4] as string,
        createdAt: v[5] as number,
    }));
}

export function discardDraft(id: number): boolean {
    if (!_db) return false;
    _db.run("DELETE FROM self_improvement_drafts WHERE id = ?", [id]);
    return true;
}

export function discardDraftsBySlug(slug: string, maxId?: number): number {
    if (!_db) return 0;
    // When `maxId` is provided, only delete rows with id ≤ maxId. This is the
    // race-safe path: synthesis captures the highest id it merged, and any
    // drafts inserted after that point survive to the next synthesis cycle.
    if (typeof maxId === "number") {
        const before = _db.exec("SELECT COUNT(*) FROM self_improvement_drafts WHERE slug = ? AND id <= ?", [slug, maxId]);
        const count = (before[0]?.values[0]?.[0] as number) || 0;
        _db.run("DELETE FROM self_improvement_drafts WHERE slug = ? AND id <= ?", [slug, maxId]);
        return count;
    }
    const before = _db.exec("SELECT COUNT(*) FROM self_improvement_drafts WHERE slug = ?", [slug]);
    const count = (before[0]?.values[0]?.[0] as number) || 0;
    _db.run("DELETE FROM self_improvement_drafts WHERE slug = ?", [slug]);
    return count;
}

export function getDraftSlugs(): string[] {
    if (!_db) return [];
    const rows = _db.exec("SELECT DISTINCT slug FROM self_improvement_drafts ORDER BY slug");
    if (rows.length === 0 || rows[0].values.length === 0) return [];
    return rows[0].values.map((v: unknown[]) => v[0] as string);
}
