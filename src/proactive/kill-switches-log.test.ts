// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetProactiveLogPruneTimerForTests, debugProactive } from "./kill-switches.js";

const originalEnv = { ...process.env };

function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

describe("proactive log rotation", () => {
    let dir: string;
    let logsDir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "atlas-log-"));
        logsDir = join(dir, "logs");
        process.env.ATLAS_DATA_DIR = dir;
        delete process.env.ATLAS_PROACTIVE_DEBUG;
        _resetProactiveLogPruneTimerForTests();
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
        process.env = { ...originalEnv };
    });

    it("appends a JSON line to today's file", () => {
        debugProactive("test_event", { id: "x", ok: true });
        const expected = join(logsDir, `proactive-${todayStr()}.log`);
        expect(existsSync(expected)).toBe(true);
        const content = readFileSync(expected, "utf8");
        const lines = content.trim().split("\n");
        expect(lines.length).toBe(1);
        const parsed = JSON.parse(lines[0]);
        expect(parsed.event).toBe("test_event");
        expect(parsed.id).toBe("x");
        expect(parsed.ok).toBe(true);
        expect(typeof parsed.ts).toBe("number");
    });

    it("multiple calls append multiple lines", () => {
        debugProactive("a", { n: 1 });
        debugProactive("b", { n: 2 });
        debugProactive("c", { n: 3 });
        const expected = join(logsDir, `proactive-${todayStr()}.log`);
        const content = readFileSync(expected, "utf8");
        expect(content.trim().split("\n").length).toBe(3);
    });

    it("creates logs directory if missing", () => {
        expect(existsSync(logsDir)).toBe(false);
        debugProactive("test", {});
        expect(existsSync(logsDir)).toBe(true);
    });

    it("silenced by ATLAS_PROACTIVE_DEBUG=false", () => {
        process.env.ATLAS_PROACTIVE_DEBUG = "false";
        debugProactive("test", {});
        const expected = join(logsDir, `proactive-${todayStr()}.log`);
        expect(existsSync(expected)).toBe(false);
    });

    it("prunes files older than 7 days", () => {
        // Create the logs dir first
        process.env.ATLAS_DATA_DIR = dir;
        debugProactive("seed", {}); // triggers mkdirSync
        _resetProactiveLogPruneTimerForTests();

        // Place a synthetic old file and an equally-old new file
        const old = join(logsDir, `proactive-2024-01-01.log`);
        writeFileSync(old, "ancient data\n");
        // Set mtime to 14 days ago
        const old_ts = (Date.now() - 14 * 86_400_000) / 1000;
        utimesSync(old, old_ts, old_ts);

        const recent = join(logsDir, `proactive-2026-04-15.log`);
        writeFileSync(recent, "fresh data\n");
        const recent_ts = (Date.now() - 3 * 86_400_000) / 1000;
        utimesSync(recent, recent_ts, recent_ts);

        // Trigger prune
        debugProactive("trigger", {});

        expect(existsSync(old)).toBe(false); // pruned
        expect(existsSync(recent)).toBe(true); // kept
    });

    it("prune is rate-limited (does not run on every call)", () => {
        process.env.ATLAS_DATA_DIR = dir;
        debugProactive("first", {}); // triggers mkdir + first prune

        // Place an ancient file AFTER the first prune has run
        const old = join(logsDir, `proactive-2020-01-01.log`);
        writeFileSync(old, "x\n");
        const old_ts = (Date.now() - 30 * 86_400_000) / 1000;
        utimesSync(old, old_ts, old_ts);

        // debugProactive again within the 1h window — should NOT prune
        debugProactive("second", {});

        // Still there because rate-limited
        expect(existsSync(old)).toBe(true);
    });

    it("non-matching filenames in the logs dir are ignored by prune", () => {
        process.env.ATLAS_DATA_DIR = dir;
        debugProactive("seed", {});
        _resetProactiveLogPruneTimerForTests();

        const unrelated = join(logsDir, "agent-crash.log");
        writeFileSync(unrelated, "crash data\n");
        const old_ts = (Date.now() - 30 * 86_400_000) / 1000;
        utimesSync(unrelated, old_ts, old_ts);

        debugProactive("trigger", {});
        expect(existsSync(unrelated)).toBe(true); // left alone — not our log
    });

    it("handles special characters in ctx values", () => {
        debugProactive("e", { text: 'hello "world"\nline 2', n: 42 });
        const expected = join(logsDir, `proactive-${todayStr()}.log`);
        const content = readFileSync(expected, "utf8").trim();
        const parsed = JSON.parse(content);
        expect(parsed.text).toBe('hello "world"\nline 2');
        expect(parsed.n).toBe(42);
    });
});
