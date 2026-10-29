// © 2024-2026 TRUSCOR Private Limited. All rights reserved.

// ── One-time scrub of conversation text saved before at-rest masking ──
// Until cce1975 the conversation archive (conversations + conversation_messages and its
// two search indexes) and the session buffer kept the owner's raw text: a card number,
// OTP or "my password is …" typed in chat sat on disk. New writes are masked
// (protectForDisk); this masks what is already there, once, and records that it ran.

import type BetterSqlite3 from "better-sqlite3";
import { protect, protectForDisk } from "../security/pii-vault.js";

const NAME = "secrets_at_rest_v1";
const mask = (t: string | null): string | null => (t ? protect(t, { credentials: true }) : t);

/** Returns the number of rows changed per table, or null when it already ran. */
export function scrubSecretsAtRest(db: BetterSqlite3.Database): Record<string, number> | null {
    db.exec("CREATE TABLE IF NOT EXISTS scrub_state (name TEXT PRIMARY KEY, done_at TEXT NOT NULL)");
    if (db.prepare("SELECT 1 FROM scrub_state WHERE name = ?").get(NAME)) return null;
    const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(t);
    const n = { conversations: 0, conversation_messages: 0, sessions: 0 };

    db.transaction(() => {
        if (has("conversations")) {
            for (const r of db.prepare("SELECT id, messages_json, summary FROM conversations").all() as Array<{
                id: number;
                messages_json: string;
                summary: string | null;
            }>) {
                let msgs: unknown;
                try {
                    msgs = JSON.parse(r.messages_json);
                } catch {
                    continue;
                }
                const json = Array.isArray(msgs) ? JSON.stringify(protectForDisk(msgs as never[])) : r.messages_json;
                const summary = mask(r.summary);
                if (json === r.messages_json && summary === r.summary) continue;
                n.conversations++;
                db.prepare("UPDATE conversations SET messages_json = ?, summary = ? WHERE id = ?").run(
                    json,
                    summary,
                    r.id,
                );
            }
        }
        if (has("conversation_messages")) {
            const indexes = ["conversations_fts", "conversations_fts_trigram"].filter(has);
            for (const r of db
                .prepare("SELECT id, role, session_id, content FROM conversation_messages")
                .all() as Array<{
                id: number;
                role: string;
                session_id: string;
                content: string;
            }>) {
                const content = mask(r.content);
                if (content === r.content) continue;
                n.conversation_messages++;
                db.prepare("UPDATE conversation_messages SET content = ? WHERE id = ?").run(content, r.id);
                // The search indexes keep their own copy and have no update trigger.
                for (const fts of indexes) {
                    db.prepare(`DELETE FROM ${fts} WHERE rowid = ?`).run(r.id);
                    db.prepare(`INSERT INTO ${fts}(rowid, content, role, session_id) VALUES (?, ?, ?, ?)`).run(
                        r.id,
                        content,
                        r.role,
                        r.session_id,
                    );
                }
            }
        }
        if (has("sessions")) {
            for (const r of db
                .prepare(
                    "SELECT session_id, current_goal, short_summary, recent_turns_json, last_compression_summary FROM sessions",
                )
                .all() as Array<Record<string, string | null>>) {
                let turns: Array<{ content?: string }> = [];
                try {
                    turns = JSON.parse(r.recent_turns_json || "[]");
                } catch {
                    continue;
                }
                const turnsJson = JSON.stringify(turns.map((t) => ({ ...t, content: mask(t?.content ?? "") })));
                const next = [mask(r.current_goal), mask(r.short_summary), turnsJson, mask(r.last_compression_summary)];
                if (
                    next[0] === r.current_goal &&
                    next[1] === r.short_summary &&
                    turnsJson === JSON.stringify(turns) &&
                    next[3] === r.last_compression_summary
                )
                    continue;
                n.sessions++;
                db.prepare(
                    "UPDATE sessions SET current_goal = ?, short_summary = ?, recent_turns_json = ?, last_compression_summary = ? WHERE session_id = ?",
                ).run(...next, r.session_id);
            }
        }
        db.prepare("INSERT INTO scrub_state (name, done_at) VALUES (?, datetime('now'))").run(NAME);
    })();
    return n;
}
