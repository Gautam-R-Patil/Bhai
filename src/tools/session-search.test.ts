// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Hermetic: point the memory DB at a throwaway temp dir BEFORE importing the
// sqlite module (its DATA_DIR const reads process.env.ATLAS_DATA_DIR at load).
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-session-search-"));
process.env.ATLAS_DATA_DIR = TMP_DIR;
process.env.ATLAS_MEMORY_GATE_SHADOW = "true";

type SqliteModule = typeof import("../memory/sqlite.js");
type ToolModule = typeof import("./session-search.js");

let sqlite: SqliteModule;
let tool: ToolModule;

function msg(role: string, content: unknown) {
    return { role, content };
}

beforeAll(async () => {
    sqlite = await import("../memory/sqlite.js");
    tool = await import("./session-search.js");
    await sqlite.initMemoryDB();

    const raw = sqlite.getRawDb();
    if (!raw) throw new Error("raw DB unavailable");

    // Insert two conversation rows, then decompose them into per-message rows
    // exactly as reflection.ts would (via the exported helper).
    const insertConv = raw.prepare(
        "INSERT INTO conversations (session_id, messages_json, summary, created_at) VALUES (?, ?, ?, ?)",
    );

    const convA = [
        msg("user", "How do I configure the postgres database connection?"),
        msg("assistant", "Set the DATABASE_URL env var to your postgres instance."),
        // Multimodal content-part array — extractor should join the text parts.
        msg("user", [
            { type: "text", text: "Thanks, the postgres setup worked." },
            { type: "image_url", image_url: { url: "data:..." } },
        ]),
        // Tool-call-only assistant message (null content) — must be skipped.
        { role: "assistant", content: null, tool_calls: [{ function: { name: "noop" } }] },
    ];
    const convB = [msg("user", "残業について教えてください"), msg("assistant", "残業は事前に申請してください。")];

    insertConv.run("session-A", JSON.stringify(convA), "postgres setup", "2026-01-01T10:00:00Z");
    const idA = raw.prepare("SELECT last_insert_rowid() AS id").get() as { id: number };
    insertConv.run("session-B", JSON.stringify(convB), "overtime", "2026-02-01T10:00:00Z");
    const idB = raw.prepare("SELECT last_insert_rowid() AS id").get() as { id: number };

    sqlite.indexConversationMessages(idA.id, "session-A", convA, "2026-01-01T10:00:00Z");
    sqlite.indexConversationMessages(idB.id, "session-B", convB, "2026-02-01T10:00:00Z");
});

afterAll(() => {
    try {
        fs.rmSync(TMP_DIR, { recursive: true, force: true });
    } catch {
        /* best effort */
    }
});

describe("extractMsgText", () => {
    it("passes through string content", () => {
        expect(sqlite.extractMsgText({ role: "user", content: "hello" })).toBe("hello");
    });

    it("joins text parts of an array content and ignores non-text parts", () => {
        const out = sqlite.extractMsgText({
            role: "user",
            content: [
                { type: "text", text: "part one" },
                { type: "image_url", image_url: { url: "x" } },
                { type: "text", text: "part two" },
            ],
        });
        expect(out).toBe("part one\npart two");
    });

    it("returns empty string for null / tool-call-only / non-object", () => {
        expect(sqlite.extractMsgText({ role: "assistant", content: null })).toBe("");
        expect(sqlite.extractMsgText({ role: "assistant", content: [{ type: "tool_use" }] })).toBe("");
        expect(sqlite.extractMsgText(null)).toBe("");
        expect(sqlite.extractMsgText("not an object")).toBe("");
    });
});

describe("searchSessionMessages (discovery)", () => {
    it("finds a keyword and returns the ACTUAL stored message text + a snippet", () => {
        const hits = sqlite.searchSessionMessages("postgres", 10);
        expect(hits.length).toBeGreaterThan(0);
        // Returns the literal stored content.
        expect(hits.some((h) => h.content.includes("postgres"))).toBe(true);
        // Snippet carries the «»-highlight markers.
        expect(hits.some((h) => h.snippet.includes("«") && h.snippet.includes("»"))).toBe(true);
        // The skipped tool-call-only message must not appear.
        expect(hits.every((h) => h.content.length > 0)).toBe(true);
    });

    it("indexed the multimodal text-part message", () => {
        const hits = sqlite.searchSessionMessages("worked", 10);
        expect(hits.some((h) => h.content.includes("postgres setup worked"))).toBe(true);
    });

    it("routes a CJK query to the trigram table and matches a multi-char phrase", () => {
        // SQLite's FTS5 trigram tokenizer needs >=3 chars to emit any trigram,
        // so a 2-char CJK query matches nothing (same as keywordSearch, which
        // reuses buildTrigramQuery). Use a >=3-char phrase, which is what real
        // transcript recall queries look like.
        const hits = sqlite.searchSessionMessages("残業について", 10);
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.some((h) => h.content.includes("残業"))).toBe(true);
    });

    it("returns [] for a query with no matches (fail-soft, not throw)", () => {
        expect(sqlite.searchSessionMessages("zzzznotacorpusword", 10)).toEqual([]);
    });
});

describe("browseRecentMessages (recent)", () => {
    it("returns messages in reverse-chronological order", () => {
        const rows = sqlite.browseRecentMessages(20);
        expect(rows.length).toBeGreaterThan(0);
        // session-B is newer (2026-02) than session-A (2026-01), so it ranks first.
        expect(rows[0].created_at).toBe("2026-02-01T10:00:00Z");
        for (let i = 1; i < rows.length; i++) {
            const prev = rows[i - 1].created_at ?? "";
            const cur = rows[i].created_at ?? "";
            expect(prev >= cur).toBe(true);
        }
    });
});

describe("session_search tool handler (arg-inferred op)", () => {
    it("query present → discovery op with results", async () => {
        const out = JSON.parse(await tool.sessionSearch.handler({ query: "postgres" }));
        expect(out.op).toBe("discovery");
        expect(out.count).toBeGreaterThan(0);
        expect(out.results[0].content).toContain("postgres");
    });

    it("query omitted → recent browse op", async () => {
        const out = JSON.parse(await tool.sessionSearch.handler({}));
        expect(out.op).toBe("recent");
        expect(out.count).toBeGreaterThan(0);
    });

    it("no-match discovery returns friendly empty note, never throws", async () => {
        const out = JSON.parse(await tool.sessionSearch.handler({ query: "zzzznotacorpusword" }));
        expect(out.op).toBe("discovery");
        expect(out.count).toBe(0);
        expect(out.results).toEqual([]);
        expect(typeof out.note).toBe("string");
    });
});

describe("indexConversationMessages (append-only)", () => {
    it("re-indexing a pruned-then-extended history adds only the new messages", () => {
        const raw = sqlite.getRawDb();
        if (!raw) throw new Error("raw DB unavailable");
        const conv = 9001;
        const first = [msg("user", "plan the lisbon trip"), msg("assistant", "Lisbon in May works well.")];
        expect(sqlite.indexConversationMessages(conv, "session-C", first, "2025-01-01T00:00:00Z")).toBe(2);
        // Pruned: the first message is gone, so every position shifted.
        const later = [first[1], msg("user", "book the lisbon hotel"), msg("assistant", "Booked the Alfama hotel.")];
        expect(sqlite.indexConversationMessages(conv, "session-C", later, "2025-01-01T00:00:00Z")).toBe(2);
        const rows = raw
            .prepare(
                "SELECT msg_index, content FROM conversation_messages WHERE conversation_id = ? ORDER BY msg_index",
            )
            .all(conv) as Array<{ msg_index: number; content: string }>;
        expect(rows.map((r) => r.msg_index)).toEqual([0, 1, 2, 3]);
        expect(rows[3].content).toBe("Booked the Alfama hotel.");
    });
});

describe("fail-open when the FTS table is missing", () => {
    it("searchSessionMessages returns [] and the handler returns a friendly note", async () => {
        const raw = sqlite.getRawDb();
        if (!raw) throw new Error("raw DB unavailable");
        // Drop the FTS mirror to simulate an un-indexed / unsupported DB.
        raw.exec("DROP TABLE IF EXISTS conversations_fts");
        expect(sqlite.searchSessionMessages("postgres", 10)).toEqual([]);

        const out = JSON.parse(await tool.sessionSearch.handler({ query: "postgres" }));
        expect(out.count).toBe(0);
        expect(typeof out.note).toBe("string");
    });
});
