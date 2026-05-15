// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initForgeTelemetry, emitForgeEvent, getForgeEventCount } from "../telemetry.js";

describe("forge telemetry", () => {
    let tmpDir: string;
    let logPath: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "forge-tele-"));
        logPath = join(tmpDir, "forge-telemetry.jsonl");
        initForgeTelemetry(logPath);
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("writes one event per line to jsonl", () => {
        emitForgeEvent({ event: "forge_boot", ts: 1000, libraryRows: 5, manifestEntries: 5, bootMs: 42 });
        emitForgeEvent({ event: "lookup_attempted", ts: 2000, description: "x", matchSimilarity: null, source: "miss" });
        const content = readFileSync(logPath, "utf-8").trim().split("\n");
        expect(content).toHaveLength(2);
        expect(JSON.parse(content[0]).event).toBe("forge_boot");
        expect(JSON.parse(content[1]).event).toBe("lookup_attempted");
    });

    it("getForgeEventCount returns count", () => {
        emitForgeEvent({ event: "forge_boot", ts: 1000, libraryRows: 0, manifestEntries: 0, bootMs: 1 });
        expect(getForgeEventCount()).toBe(1);
    });

    it("creates the log file directory if missing", () => {
        const deep = join(tmpDir, "deep", "nested", "tele.jsonl");
        initForgeTelemetry(deep);
        emitForgeEvent({ event: "forge_boot", ts: 1000, libraryRows: 0, manifestEntries: 0, bootMs: 1 });
        expect(existsSync(deep)).toBe(true);
    });
});
