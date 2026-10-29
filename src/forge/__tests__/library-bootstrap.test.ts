// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLibrary, closeLibrary, getLibrarySchemaVersion, getLibrary } from "../library.js";

describe("library bootstrap", () => {
    let tmpDir: string;
    let dbPath: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "forge-test-"));
        dbPath = join(tmpDir, "skill-library.db");
    });

    afterEach(() => {
        closeLibrary();
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("creates db file on first open", () => {
        const db = openLibrary(dbPath);
        expect(db).toBeDefined();
        const version = getLibrarySchemaVersion();
        expect(version).toBe(1);
    });

    it("reopens existing db without re-running schema", () => {
        openLibrary(dbPath);
        closeLibrary();
        const db = openLibrary(dbPath);
        const version = getLibrarySchemaVersion();
        expect(version).toBe(1);
    });

    it("has tools, tests, executions, tool_aliases tables", () => {
        const db = openLibrary(dbPath);
        const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[];
        const names = tables.map(t => t.name);
        expect(names).toContain("tools");
        expect(names).toContain("tests");
        expect(names).toContain("executions");
        expect(names).toContain("tool_aliases");
        expect(names).toContain("dedup_log");
        expect(names).toContain("library_meta");
    });

    it("has tools_fts virtual table", () => {
        const db = openLibrary(dbPath);
        const fts = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='tools_fts'`).get();
        expect(fts).toBeDefined();
    });

    it("uses WAL journaling", () => {
        const db = openLibrary(dbPath);
        const mode = db.prepare(`PRAGMA journal_mode`).get() as { journal_mode: string };
        expect(mode.journal_mode).toBe("wal");
    });

    it("getLibrary throws when nothing is open", async () => {
        const { closeLibrary: close, getLibrary: get, getLibrarySchemaVersion: getVersion } = await import("../library.js");
        close(); // belt-and-braces: ensure closed
        expect(() => get()).toThrow("library not open");
        expect(() => getVersion()).toThrow("library not open");
    });
});
