// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.BHAI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bhai-session-continuity-"));

let sqlite: typeof import("./sqlite.js");
let raw: NonNullable<ReturnType<typeof sqlite.getRawDb>>;
let session: typeof import("./session.js");

beforeAll(async () => {
    sqlite = await import("./sqlite.js");
    session = await import("./session.js");
    await sqlite.initMemoryDB();
    raw = sqlite.getRawDb() as typeof raw;
    const old = new Date(Date.now() - 3 * 3600_000).toISOString();
    raw.prepare(
        "INSERT INTO sessions (session_id, current_goal, started_at, last_activity, turn_count, short_summary, recent_turns_json) VALUES (?, ?, ?, ?, ?, ?, '[]')",
    ).run("old", "on it — fix the invoice export", old, old, 20, `HEAD-MARK ${"x".repeat(600)} Z-tail.`);
    raw.prepare("INSERT INTO conversations (session_id, messages_json, summary) VALUES ('old', '[]', ?)").run(
        "LLM summary: fixed the invoice export",
    );
});

describe("previous-session continuity", () => {
    it("carries the last session over after it expired, preferring the LLM summary", () => {
        const s = session.getSessionSummary();
        expect(s).toContain("PREVIOUS SESSION");
        expect(s).toContain("LLM summary: fixed the invoice export");
        expect(s).toContain("Previous task: on it — fix the invoice export");
    });

    it("shows it on the first turns of a new session, from the newest end of the rolling summary", () => {
        raw.prepare("DELETE FROM conversations").run();
        session.startSession();
        const s = session.getSessionSummary();
        expect(s).toContain("ACTIVE SESSION");
        expect(s).toContain("Z-tail");
        expect(s).not.toContain("HEAD-MARK");
    });
});
