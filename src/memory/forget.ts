// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// "Forget that" across every tier that can hold a fact: memories, traits,
// identity, episodes, feelings, task learnings, chat transcripts and sessions.
// A preview lists the matches and hands out a token; only the owner's own yes
// (security/consent.ts ownerApproved) turns the token into deletion. Nothing
// of the content is kept: the log says "forgot N items (reason)".

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../config/paths.js";
import { clearCache as clearResponseCache } from "../llm-cache.js";
import { ownerApproved } from "../security/consent.js";
import { clearCache as clearToolCache } from "../tools/tool-intelligence.js";
import { getFieldValue, getIdentityProfile, type UserProfile } from "./identity.js";
import { redactCurrentSession, redactSession, type SessionState } from "./session.js";
import { extractMsgText, forgetMemoryWithReason, getRawDb, restoreSuperseded } from "./sqlite.js";
import { deleteLearnings, getAllLearnings } from "./task-learnings.js";
import { getTemporalCache } from "./temporal-cache.js";
import { deleteTrait, getAllTraits } from "./traits.js";
import { getHNSWIndex } from "./vector-index.js";

export interface ForgetItem {
    tier: string;
    ref: string | number;
    date: string;
    snippet: string;
}

const FORGOTTEN = "[forgotten]";
const TOKEN_TTL_MS = 10 * 60_000;
const PREVIEW_LINES = 15;
const pending = new Map<string, { query: string; at: number }>();

// Letters keep their combining marks (Devanagari vowel signs) so words stay whole.
const words = (t: string) =>
    ` ${t
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
        .trim()} `;
export const forgetTerms = (query: string) => words(query).trim().split(" ").filter(Boolean);

/** True when `text` holds every term of `query` as a whole word (case-insensitive). */
export function forgetMatcher(query: string): (text: unknown) => boolean {
    const ts = forgetTerms(query);
    return (text) => {
        if (typeof text !== "string" || ts.length === 0) return false;
        const w = words(text);
        return ts.every((t) => w.includes(` ${t} `));
    };
}

function snippet(text: string, term: string): string {
    const flat = text.replace(/\s+/g, " ");
    const i = Math.max(0, flat.toLowerCase().indexOf(term) - 50);
    return (i > 0 ? "…" : "") + flat.slice(i, i + 120) + (flat.length > i + 120 ? "…" : "");
}

// JSON escapes newlines; unescape so a word right after one still matches.
const unescapeJson = (s: string) => s.replace(/\\[nrt]/g, " ");

function toolCalls(m: unknown): Array<{ function?: { arguments?: unknown } }> {
    const tcs = (m as { tool_calls?: unknown } | null)?.tool_calls;
    return Array.isArray(tcs) ? tcs : [];
}

/** The message's text, or failing that its tool-call arguments, when they match. */
function matchedText(m: unknown, hit: (text: unknown) => boolean): string | undefined {
    const text = extractMsgText(m);
    if (hit(text)) return text;
    for (const tc of toolCalls(m)) {
        const args = tc.function?.arguments;
        if (typeof args === "string" && hit(unescapeJson(args))) return args;
    }
}

/**
 * Redact matching messages in place: the content, and the arguments of matching
 * tool calls. Ids stay, so tool-call pairing survives.
 */
export function redactMessages(msgs: unknown[], hit: (text: unknown) => boolean): number {
    let n = 0;
    for (const m of msgs) {
        let changed = hit(extractMsgText(m));
        if (changed) (m as { content: unknown }).content = FORGOTTEN;
        for (const tc of toolCalls(m)) {
            if (tc.function && typeof tc.function.arguments === "string" && hit(unescapeJson(tc.function.arguments))) {
                tc.function.arguments = "{}";
                changed = true;
            }
        }
        if (changed) n++;
    }
    return n;
}

function identityEntries(p: UserProfile): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const k of ["name", "email", "location", "role", "company"] as const) {
        const v = getFieldValue(p[k]);
        if (v) out.push([k, v]);
    }
    if (p.current_location) out.push(["current_location", p.current_location]);
    for (const k of ["projects", "important_goals"] as const) {
        for (const [i, v] of (p[k] ?? []).entries()) out.push([`${k}.${i}`, v]);
    }
    for (const [k, v] of Object.entries(p.preferences ?? {})) out.push([`preferences.${k}`, `${k}: ${String(v)}`]);
    for (const [k, v] of Object.entries(p.extra ?? {})) out.push([`extra.${k}`, `${k}: ${JSON.stringify(v)}`]);
    return out;
}

type SessionRow = Pick<SessionState, "session_id" | "current_goal" | "short_summary" | "last_activity"> & {
    recent_turns_json: string;
    last_compression_summary: string | null;
};
function parseMsgs(json: string): unknown[] {
    try {
        const v = JSON.parse(json);
        return Array.isArray(v) ? v : [];
    } catch {
        return [];
    }
}

const toSession = (r: SessionRow) => ({
    ...r,
    recent_turns: JSON.parse(r.recent_turns_json || "[]") as SessionState["recent_turns"],
    lastCompressionSummary: r.last_compression_summary ?? "",
});

/** Everything that matches `query`, across every tier. */
export function findForgettable(query: string): ForgetItem[] {
    const raw = getRawDb();
    const ts = forgetTerms(query);
    if (!raw || ts.length === 0) return [];
    const hit = forgetMatcher(query);
    const first = ts[0];
    const items: ForgetItem[] = [];
    const add = (tier: string, ref: string | number, date: unknown, text: string) =>
        items.push({ tier, ref, date: String(date ?? "").slice(0, 10), snippet: snippet(text, first) });
    // SQLite lower() folds ASCII only, so a non-ASCII query pre-filters nothing
    // (instr(x, '') is 1) and hit() does the matching.
    const t = ts.find((w) => /^[a-z0-9]+$/.test(w)) ?? "";
    const rows = <T>(sql: string) => raw.prepare(sql).all({ t }) as T[];

    for (const r of rows<{ id: number; content: string; category: string; created_at: string }>(
        "SELECT id, content, category, created_at FROM memories WHERE instr(lower(content), @t) > 0",
    )) {
        if (hit(r.content)) add(`memory (${r.category})`, r.id, r.created_at, r.content);
    }
    for (const t of getAllTraits()) {
        const text = `${t.trait_key}: ${t.value}`;
        if (hit(text)) add("trait", t.trait_key, t.last_seen_ts, text);
    }
    const profile = getIdentityProfile();
    for (const [path, text] of identityEntries(profile)) {
        if (hit(text)) add("identity", path, profile.last_updated, text);
    }
    for (const r of rows<{ id: string; description: string; timestamp: string }>(
        "SELECT id, description, timestamp FROM episodic_memory WHERE instr(lower(description), @t) > 0",
    )) {
        if (hit(r.description)) add("episode", r.id, r.timestamp, r.description);
    }
    for (const r of rows<{ id: string; context: string; timestamp: string }>(
        "SELECT id, context, timestamp FROM emotional_memory WHERE instr(lower(context), @t) > 0",
    )) {
        if (hit(r.context)) add("feeling", r.id, r.timestamp, r.context);
    }
    for (const l of getAllLearnings()) {
        const text = [l.taskPattern, l.context, ...l.whatWorked, ...l.whatFailed, ...l.tips].join(" · ");
        if (hit(text)) add("task learning", l.id, l.lastSeen, text);
    }
    // conversation_messages is absent with ATLAS_NO_SESSION_SEARCH; goals and the graph come up at boot.
    if (hasTable("conversation_messages")) {
        for (const r of rows<{ id: number; content: string; created_at: string }>(
            "SELECT id, content, created_at FROM conversation_messages WHERE instr(lower(content), @t) > 0",
        )) {
            if (hit(r.content)) add("chat message", r.id, r.created_at, r.content);
        }
    }
    if (hasTable("goals")) {
        for (const r of rows<{ id: number; description: string; created_at: string }>(
            "SELECT id, description, created_at FROM goals WHERE instr(lower(description), @t) > 0",
        )) {
            if (hit(r.description)) add("goal", r.id, r.created_at, r.description);
        }
    }
    if (hasTable("entities")) {
        for (const r of rows<{ id: number; name: string; properties: string; updated_at: string }>(
            "SELECT id, name, properties, updated_at FROM entities WHERE instr(lower(name || ' ' || COALESCE(properties, '')), @t) > 0",
        )) {
            const text = `${r.name}: ${r.properties ?? ""}`;
            if (hit(text)) add("graph entity", r.id, r.updated_at, text);
        }
        for (const r of rows<{ id: number; type: string; properties: string; created_at: string }>(
            "SELECT id, type, properties, created_at FROM relationships WHERE instr(lower(type || ' ' || COALESCE(properties, '')), @t) > 0",
        )) {
            const text = `${r.type}: ${r.properties ?? ""}`;
            if (hit(text)) add("graph link", r.id, r.created_at, text);
        }
    }
    for (const r of rows<{ id: number; title: string; body: string; computed_at: string }>(
        "SELECT id, title, body, computed_at FROM memory_insights WHERE instr(lower(title || ' ' || body), @t) > 0",
    )) {
        const text = `${r.title}: ${r.body}`;
        if (hit(text)) add("insight", r.id, r.computed_at, text);
    }
    for (const r of rows<{ id: number; messages_json: string; summary: string | null; updated_at: string }>(
        "SELECT id, messages_json, summary, updated_at FROM conversations WHERE instr(lower(messages_json), @t) > 0 OR instr(lower(summary), @t) > 0",
    )) {
        const text = hit(r.summary)
            ? (r.summary as string)
            : parseMsgs(r.messages_json)
                  .map((m) => matchedText(m, hit))
                  .find(Boolean);
        if (text) add("chat log", r.id, r.updated_at, text);
    }
    for (const r of rows<SessionRow>(
        "SELECT session_id, current_goal, short_summary, last_activity, recent_turns_json, last_compression_summary FROM sessions WHERE instr(lower(COALESCE(short_summary, '') || COALESCE(current_goal, '') || COALESCE(recent_turns_json, '') || COALESCE(last_compression_summary, '')), @t) > 0",
    )) {
        const s = toSession(r);
        const text = [
            s.short_summary,
            s.current_goal,
            s.lastCompressionSummary,
            ...s.recent_turns.map((t) => t.content),
        ]
            .filter(Boolean)
            .find(hit);
        if (text) add("session", r.session_id, r.last_activity, text);
    }
    return items;
}

/** A forget preview awaits the owner's yes, so a "#N" this turn may mean its lines, not the digest's. */
export const forgetPreviewPending = (now = Date.now()) => [...pending.values()].some((p) => now - p.at <= TOKEN_TTL_MS);

/** Step 1: numbered preview + a token for step 2. */
export function previewForget(query: string): { token?: string; count: number; preview: string } {
    const items = findForgettable(query);
    if (items.length === 0) return { count: 0, preview: "Nothing matches." };
    const token = randomUUID().slice(0, 8);
    pending.set(token, { query, at: Date.now() });
    const byTier = new Map<string, number>();
    for (const it of items) byTier.set(it.tier, (byTier.get(it.tier) ?? 0) + 1);
    const total = `${items.length} items: ${[...byTier].map(([k, n]) => `${n} ${k}`).join(", ")}`;
    const lines = items.slice(0, PREVIEW_LINES).map((it, i) => `${i + 1}. [${it.tier} · ${it.date}] ${it.snippet}`);
    if (items.length > PREVIEW_LINES) lines.push(`…and ${items.length - PREVIEW_LINES} more`);
    return { token, count: items.length, preview: [total, ...lines].join("\n") };
}

function forgetItems(query: string, items: ForgetItem[]): void {
    const raw = getRawDb();
    if (!raw) throw new Error("Memory DB not initialized");
    const hit = forgetMatcher(query);
    const of = (tier: string) => items.filter((it) => it.tier === tier).map((it) => it.ref);
    const memoryIds = items.filter((it) => it.tier.startsWith("memory")).map((it) => it.ref as number);

    raw.transaction(() => {
        for (const id of memoryIds) {
            raw.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(id);
            raw.prepare("DELETE FROM memories WHERE id = ?").run(id);
        }
        for (const key of of("trait")) deleteTrait(key as string);
        if (of("identity").length > 0) {
            const p = getIdentityProfile() as unknown as Record<string, unknown>;
            // Highest index first, so splicing doesn't shift the ones still to go.
            const paths = of("identity") as string[];
            for (const path of paths.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
                const [k, sub] = path.split(".");
                const v = p[k];
                if (sub === undefined) delete p[k];
                else if (Array.isArray(v)) v.splice(Number(sub), 1);
                else if (v && typeof v === "object") delete (v as Record<string, unknown>)[sub];
            }
            raw.prepare(
                "UPDATE user_profiles SET profile_json = ?, updated_at = datetime('now') WHERE user_id = ?",
            ).run(JSON.stringify(p), p.user_id ?? "default");
        }
        for (const id of of("episode")) {
            raw.prepare("DELETE FROM episodic_memory WHERE id = ?").run(id);
            raw.prepare("DELETE FROM episodic_embeddings WHERE episode_id = ?").run(id);
        }
        for (const id of of("feeling")) raw.prepare("DELETE FROM emotional_memory WHERE id = ?").run(id);
        // The FTS mirrors follow through the conv_msg_ad trigger.
        for (const id of of("chat message")) raw.prepare("DELETE FROM conversation_messages WHERE id = ?").run(id);
        for (const id of of("goal")) raw.prepare("DELETE FROM goals WHERE id = ?").run(id);
        // foreign_keys is off, so the entity's links go by hand.
        for (const id of of("graph entity")) {
            raw.prepare("DELETE FROM relationships WHERE from_id = ? OR to_id = ?").run(id, id);
            raw.prepare("DELETE FROM entities WHERE id = ?").run(id);
        }
        for (const id of of("graph link")) raw.prepare("DELETE FROM relationships WHERE id = ?").run(id);
        for (const id of of("insight")) raw.prepare("DELETE FROM memory_insights WHERE id = ?").run(id);
        for (const id of of("chat log")) {
            const r = raw.prepare("SELECT messages_json, summary FROM conversations WHERE id = ?").get(id) as
                | { messages_json: string; summary: string | null }
                | undefined;
            if (!r) continue;
            const msgs = parseMsgs(r.messages_json);
            redactMessages(msgs, hit);
            const summaryHit = hit(r.summary);
            raw.prepare("UPDATE conversations SET messages_json = ?, summary = ? WHERE id = ?").run(
                JSON.stringify(msgs),
                summaryHit ? null : r.summary,
                id,
            );
            // The embedding was taken from the summary.
            if (summaryHit) raw.prepare("DELETE FROM conversation_embeddings WHERE conversation_id = ?").run(id);
        }
        for (const id of of("session")) {
            const r = raw
                .prepare(
                    "SELECT session_id, current_goal, short_summary, last_activity, recent_turns_json, last_compression_summary FROM sessions WHERE session_id = ?",
                )
                .get(id) as SessionRow | undefined;
            if (!r) continue;
            const s = toSession(r);
            redactSession(s, hit);
            raw.prepare(
                "UPDATE sessions SET current_goal = ?, short_summary = ?, recent_turns_json = ?, last_compression_summary = ? WHERE session_id = ?",
            ).run(s.current_goal, s.short_summary, JSON.stringify(s.recent_turns), s.lastCompressionSummary, id);
        }
    })();

    deleteLearnings(new Set(of("task learning") as string[]));
    redactCurrentSession(hit);
    try {
        const index = getHNSWIndex();
        for (const id of memoryIds) index.removeVector(id);
        if (memoryIds.length > 0) index.persist();
    } catch {
        /* the boot rebuild drops vectors whose memory is gone */
    }
    // Plaintext copies in the value-gate log, and in the audit log's memory lines
    // only (memory tools before they logged keys only, signed memory_* entries):
    // the rest of the audit trail is the owner's security record and stays whole.
    for (const file of ["audit.jsonl", "memory-gate.jsonl"]) {
        const ours = file === "audit.jsonl" ? memoryAuditLine : () => true;
        for (const f of [join(getDataDir(), file), join(getDataDir(), `${file}.1`)]) {
            try {
                const lines = readFileSync(f, "utf8").split("\n");
                // ponytail: read-then-rewrite can drop an audit append that lands in between; rare (legacy lines only).
                const kept = lines.filter((l) => !(ours(l) && hit(unescapeJson(l))));
                if (kept.length < lines.length) writeFileSync(f, kept.join("\n"));
            } catch {
                /* no log yet */
            }
        }
    }
    dropCaches();
}

function memoryAuditLine(line: string): boolean {
    try {
        const e = JSON.parse(line) as { tool?: unknown; action?: unknown };
        return /^(memory|identity|trait)_/.test(String(e.tool ?? "")) || String(e.action ?? "").startsWith("memory_");
    } catch {
        return false;
    }
}

function hasTable(name: string): boolean {
    return !!getRawDb()?.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function dropCaches(): void {
    getTemporalCache().clearCache();
    clearResponseCache();
    clearToolCache(); // memory_search/memory_list/trait_list/identity_view results
}

/**
 * Step 2: the owner confirmed. `live` holds the in-memory chats, redacted too so the
 * next reflection can't write the fact back. Re-runs the preview's query, so
 * echoes of the fact made since (the preview itself) go as well.
 */
export function executeForget(
    token: string,
    userQuote: string,
    reason: string,
    live: unknown[][] = [],
): { forgotten: number } | { error: string } {
    const p = pending.get(token);
    if (!p || Date.now() - p.at > TOKEN_TTL_MS) {
        pending.delete(token);
        return { error: "Unknown or expired token. Run the preview again." };
    }
    if (!ownerApproved(userQuote, p.at)) {
        return {
            error: "user_quote must be the owner's own words from a message sent after the preview, saying yes. Show the preview and ask first.",
        };
    }
    pending.delete(token);
    const items = findForgettable(p.query);
    forgetItems(p.query, items);
    for (const h of live) redactMessages(h, forgetMatcher(p.query));
    logForget(items.length, reason);
    return { forgotten: items.length };
}

function logForget(n: number, reason: string): void {
    const why = reason.trim() || "unspecified";
    getRawDb()
        ?.prepare("INSERT INTO memory_forget_log (kind, original_id, reason, source) VALUES ('forget', ?, ?, 'user')")
        .run(`${n} items`, why);
    console.log(`[MEMORY] forgot ${n} items (${why})`);
}

/** One memory, gone now. For the owner's own taps (undo, digest prune): no quote needed. */
export function forgetMemoryById(id: number, reason = "undo"): boolean {
    const exists = getRawDb()?.prepare("SELECT 1 FROM memories WHERE id = ?").get(id);
    if (!exists || !forgetMemoryWithReason(id, reason, "user")) return false;
    dropCaches();
    return true;
}

const UNDO_TTL_MS = 10 * 60_000;

/** Button data for "Forget that" under the reply to a turn that stored memory `id` at `at` (ms). */
export const memoryUndoAction = (u: { id: number; at: number }) => `mem:forget:${u.id}:${Math.floor(u.at / 1000)}`;

/** The owner tapped "Forget that": the short answer, or undefined when `data` is not that button. */
export function undoMemoryTap(data: string, now = Date.now()): string | undefined {
    const m = /^mem:forget:(\d+):(\d+)$/.exec(data);
    if (!m) return undefined;
    if (now - Number(m[2]) * 1000 > UNDO_TTL_MS) return "Too late for the button, ask me to forget it.";
    if (!forgetMemoryById(Number(m[1]))) return "Already gone.";
    restoreSuperseded(Number(m[1]));
    return "Forgotten.";
}

const DIGEST_TTL_MS = 7 * 86_400_000;

/** Button data for "Forget #n" under the weekly digest sent at `at` (ms): memory `id`. */
export const digestPruneAction = (id: number, at: number) => `mem:digest:${id}:${Math.floor(at / 1000)}`;

/** The owner tapped a digest prune button: the short answer, or undefined when `data` is not one. */
export function pruneDigestTap(data: string, now = Date.now()): string | undefined {
    const m = /^mem:digest:(\d+):(\d+)$/.exec(data);
    if (!m) return undefined;
    if (now - Number(m[2]) * 1000 > DIGEST_TTL_MS) return "Too late for the button, ask me to forget it.";
    return forgetMemoryById(Number(m[1]), "digest") ? "Forgotten." : "Already gone.";
}

/** @internal — tests only. */
export function _resetForget(): void {
    pending.clear();
}
