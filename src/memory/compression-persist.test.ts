// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCompressionUserPrompt } from "./compression-template.js";
import {
    endSession,
    getLastCompressionSummary,
    setLastCompressionSummary,
    startSession,
} from "./session.js";

const ORIG_NO_CONTINUITY = process.env.ATLAS_NO_PRUNE_CONTINUITY;

beforeEach(() => {
    delete process.env.ATLAS_NO_PRUNE_CONTINUITY;
    endSession();
});

afterEach(() => {
    if (ORIG_NO_CONTINUITY === undefined) delete process.env.ATLAS_NO_PRUNE_CONTINUITY;
    else process.env.ATLAS_NO_PRUNE_CONTINUITY = ORIG_NO_CONTINUITY;
    endSession();
});

// These tests exercise the in-memory currentSession path only. getRawDb() is null
// outside initMemoryDB, so persistSession()'s null-guard makes the SQLite write a
// safe no-op — matching how the module behaves uninitialized.
describe("structured compression summary — session round-trip", () => {
    it("set then get returns the stored summary (default ON)", () => {
        startSession();
        const summary = "## Completed Actions\n1. read file\n2. ran tests";
        setLastCompressionSummary(summary);
        expect(getLastCompressionSummary()).toBe(summary);
    });

    it("returns null on a fresh session (cold start)", () => {
        startSession();
        expect(getLastCompressionSummary()).toBeNull();
    });

    it("ignores an empty-string write (stays null)", () => {
        startSession();
        setLastCompressionSummary("");
        expect(getLastCompressionSummary()).toBeNull();
    });

    it("overwrites the prior summary on a subsequent set", () => {
        startSession();
        setLastCompressionSummary("first");
        setLastCompressionSummary("second");
        expect(getLastCompressionSummary()).toBe("second");
    });
});

describe("structured compression summary — fail-open", () => {
    it("returns null with no active session and set() does not throw", () => {
        endSession();
        expect(getLastCompressionSummary()).toBeNull();
        expect(() => setLastCompressionSummary("orphan")).not.toThrow();
        expect(getLastCompressionSummary()).toBeNull();
    });

    it("kill-switch: get returns null and set no-ops even after a set", () => {
        startSession();
        process.env.ATLAS_NO_PRUNE_CONTINUITY = "true";
        setLastCompressionSummary("should not persist");
        expect(getLastCompressionSummary()).toBeNull();
        // With the switch off again, the in-memory value confirms the set was a no-op.
        delete process.env.ATLAS_NO_PRUNE_CONTINUITY;
        expect(getLastCompressionSummary()).toBeNull();
    });
});

describe("structured compression summary — wired continuity", () => {
    it("threads the stored prior summary into buildCompressionUserPrompt", () => {
        startSession();
        setLastCompressionSummary("## Completed Actions\n1. a\n2. b");
        const prompt = buildCompressionUserPrompt("user: keep going", getLastCompressionSummary());
        expect(prompt).toContain("CONTINUE it");
        expect(prompt).toContain("2. b");
    });

    it("emits no continuation block when there is no prior summary", () => {
        startSession();
        const prompt = buildCompressionUserPrompt("user: first prune", getLastCompressionSummary());
        expect(prompt).not.toContain("CONTINUE it");
    });
});

// Mirrors the sessions DDL from sqlite.ts so we can assert the additive migration
// adds the column without dropping existing rows and round-trips through SQLite.
const SESSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    current_goal TEXT DEFAULT '',
    started_at TEXT NOT NULL,
    last_activity TEXT NOT NULL,
    turn_count INTEGER DEFAULT 0,
    short_summary TEXT DEFAULT '',
    recent_turns_json TEXT DEFAULT '[]'
  )`;

describe("sessions migration — last_compression_summary column", () => {
    it("ALTER TABLE adds the column without dropping existing session rows", () => {
        const raw = new BetterSqlite3(":memory:");
        raw.exec(SESSIONS_DDL);

        // Pre-existing row written before the migration ran.
        raw.prepare(
            `INSERT INTO sessions (session_id, current_goal, started_at, last_activity, turn_count, short_summary, recent_turns_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run("legacy", "ship it", "2026-06-01T00:00:00Z", "2026-06-01T00:05:00Z", 7, "old context", "[]");

        // The exact migration statement from sqlite.ts (idempotent: throws if re-run).
        raw.exec("ALTER TABLE sessions ADD COLUMN last_compression_summary TEXT DEFAULT ''");

        // Existing row survives; new column defaults to '' for it.
        const legacy = raw
            .prepare("SELECT turn_count, short_summary, last_compression_summary FROM sessions WHERE session_id = ?")
            .get("legacy") as { turn_count: number; short_summary: string; last_compression_summary: string };
        expect(legacy.turn_count).toBe(7);
        expect(legacy.short_summary).toBe("old context");
        expect(legacy.last_compression_summary).toBe("");

        // A new row round-trips the structured summary through the migrated column.
        const structured = "## Completed Actions\n1. did the thing";
        raw.prepare(
            `INSERT INTO sessions (session_id, current_goal, started_at, last_activity, turn_count, short_summary, recent_turns_json, last_compression_summary)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run("fresh", "", "2026-06-02T00:00:00Z", "2026-06-02T00:01:00Z", 1, "", "[]", structured);

        const fresh = raw
            .prepare("SELECT last_compression_summary FROM sessions WHERE session_id = ?")
            .get("fresh") as { last_compression_summary: string };
        expect(fresh.last_compression_summary).toBe(structured);

        raw.close();
    });

    it("the ALTER is rejected when the column already exists (idempotency guard)", () => {
        const raw = new BetterSqlite3(":memory:");
        raw.exec(SESSIONS_DDL);
        raw.exec("ALTER TABLE sessions ADD COLUMN last_compression_summary TEXT DEFAULT ''");
        // Re-running throws — which is why sqlite.ts wraps the migration in try/catch.
        expect(() => raw.exec("ALTER TABLE sessions ADD COLUMN last_compression_summary TEXT DEFAULT ''")).toThrow();
        raw.close();
    });
});
