// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLibrary, closeLibrary, insertTool, getToolBySlug, getLibrary } from "../library.js";

describe("library insertion", () => {
    let tmpDir: string;
    let dbPath: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "forge-test-"));
        dbPath = join(tmpDir, "lib.db");
        openLibrary(dbPath);
    });

    afterEach(() => {
        closeLibrary();
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("inserts a tool and reads it back", () => {
        const now = Date.now();
        insertTool({
            slug: "extract_pdf",
            description: "Extract text from a PDF file",
            schemaJson: JSON.stringify({ type: "object", properties: { path: { type: "string" } }, required: ["path"] }),
            handlerHash: "abc123",
            embedding: new Float32Array(384),
            source: "synchronous",
            originIntent: "user asked to extract PDF",
            createdAt: now,
        });

        const tool = getToolBySlug("extract_pdf");
        expect(tool).not.toBeNull();
        expect(tool!.slug).toBe("extract_pdf");
        expect(tool!.description).toBe("Extract text from a PDF file");
        expect(tool!.source).toBe("synchronous");
        expect(tool!.createdAt).toBe(now);
        expect(tool!.updatedAt).toBe(now);
        expect(tool!.archivedAt).toBeNull();
    });

    it("inserting duplicate slug throws", async () => {
        const insert = () => insertTool({
            slug: "foo",
            description: "foo",
            schemaJson: "{}",
            handlerHash: "x",
            embedding: new Float32Array(384),
            source: "synchronous",
            createdAt: Date.now(),
        });
        insert();
        expect(insert).toThrow();
        // Verify atomicity: failed second insert did not orphan an FTS row
        const { getLibrary } = await import("../library.js");
        const db = getLibrary();
        const ftsCount = db.prepare(`SELECT COUNT(*) AS n FROM tools_fts`).get() as { n: number };
        expect(ftsCount.n).toBe(1);
    });

    it("getToolBySlug returns null for missing slug", () => {
        expect(getToolBySlug("does-not-exist")).toBeNull();
    });

    it("FTS5 index is populated", () => {
        insertTool({
            slug: "extract_pdf",
            description: "Extract text from a PDF file with great accuracy",
            schemaJson: JSON.stringify({ properties: { path: {}, options: {} } }),
            handlerHash: "x",
            embedding: new Float32Array(384),
            source: "synchronous",
            createdAt: Date.now(),
        });

        // FTS5 search should find by description tokens
        const db = getLibrary();
        const row = db.prepare(`SELECT rowid FROM tools_fts WHERE tools_fts MATCH ? LIMIT 1`).get("accuracy") as { rowid: number } | undefined;
        expect(row?.rowid).toBeDefined();
        expect(row?.rowid).toBeGreaterThan(0);
    });
});
