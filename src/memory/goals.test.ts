// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { initGoalEngine, saveGoal } from "../proactive/goal-engine.js";
import { createGoal, detectGoalFromMessage, getGoalsSnippet, initGoals } from "./goals.js";
import { wrapDatabase } from "./sqlite.js";

describe("memory goals vs proactive goal-engine", () => {
    it("moves a goal-engine-shaped `goals` table aside so both modules work", () => {
        const raw = new BetterSqlite3(":memory:");
        // goal-engine's old schema, from when it shared the `goals` name
        raw.exec(`CREATE TABLE goals (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
            source TEXT, priority REAL, status TEXT DEFAULT 'proposed', parent_goal_id INTEGER, evidence TEXT,
            progress REAL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`);
        raw.exec("INSERT INTO goals (title) VALUES ('old engine goal')");
        const db = wrapDatabase(raw);
        initGoals(db);
        initGoalEngine(db);

        expect(createGoal("ship the beta by friday")).toBeGreaterThan(0);
        expect(createGoal("Ship the beta by Friday")).toBe(-1);
        expect(getGoalsSnippet()).toBe("ACTIVE GOALS:\n- ship the beta by friday");
        expect(
            saveGoal({ title: "t", description: "d", source: "pattern_observed", evidence: "e", priority: 0.5 }),
        ).not.toBeNull();
        expect(raw.prepare("SELECT COUNT(*) AS n FROM proactive_goals").get()).toEqual({ n: 2 });
    });

    it("hides goals untouched for 30 days and ignores 'remind me to'", () => {
        const raw = new BetterSqlite3(":memory:");
        initGoals(wrapDatabase(raw));
        createGoal("learn rust");
        raw.exec("UPDATE goals SET updated_at = datetime('now', '-31 days')");
        expect(getGoalsSnippet()).toBe("");
        expect(detectGoalFromMessage("remind me to call mom tonight")).toBeNull();
    });
});
