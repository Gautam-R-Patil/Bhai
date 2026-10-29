// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLibrary, closeLibrary, insertTool, searchByFTS, getLibrary } from "../library.js";

function seed(slug: string, description: string, schemaProps: string[] = []) {
    insertTool({
        slug,
        description,
        schemaJson: JSON.stringify({
            type: "object",
            properties: Object.fromEntries(schemaProps.map((k) => [k, {}])),
        }),
        handlerHash: slug,
        embedding: new Float32Array(384),
        source: "synchronous",
        createdAt: Date.now(),
    });
}

describe("library FTS search", () => {
    let tmpDir: string;
    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "forge-fts-"));
        openLibrary(join(tmpDir, "lib.db"));
    });
    afterEach(() => {
        closeLibrary();
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns matching tools ordered by BM25", () => {
        seed("extract_pdf_tables", "Extract tables from a PDF invoice", ["path", "page_range"]);
        seed("extract_pdf_text", "Extract plain text from a PDF document", ["path"]);
        seed("send_email", "Send an email through SMTP", ["to", "subject", "body"]);

        const results = searchByFTS("extract PDF table", 10);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].slug).toBe("extract_pdf_tables");
        // BM25 score is negative-magnitude; smaller (more negative) = better in SQLite FTS5
        expect(results[0].bm25Score).toBeLessThan(0);
    });

    it("returns empty array when nothing matches", () => {
        seed("a", "totally unrelated tool", []);
        const results = searchByFTS("synthesize quantum chromodynamics", 10);
        expect(results).toEqual([]);
    });

    it("respects the limit parameter", () => {
        for (let i = 0; i < 30; i++) seed(`tool_${i}`, "extract pdf data");
        const results = searchByFTS("pdf", 10);
        expect(results).toHaveLength(10);
    });

    it("includes schema_keys in search", () => {
        seed("foo", "a foo tool", ["very_specific_param_name"]);
        seed("bar", "a bar tool", []);
        const results = searchByFTS("very_specific_param_name", 10);
        expect(results[0]?.slug).toBe("foo");
    });

    it("excludes archived tools from search", () => {
        seed("a", "extract pdf");
        seed("b", "extract pdf");
        getLibrary().prepare(`UPDATE tools SET archived_at = ? WHERE slug = ?`).run(Date.now(), "a");

        const results = searchByFTS("extract pdf", 10);
        expect(results.map((r) => r.slug)).toEqual(["b"]);
    });

    it("does not crash on FTS5 reserved keywords (AND/OR/NOT)", () => {
        seed("a", "find and replace text");
        // "find AND replace" — AND is FTS5 reserved
        expect(() => searchByFTS("find AND replace", 10)).not.toThrow();
        expect(() => searchByFTS("OR", 10)).not.toThrow();
        expect(() => searchByFTS("NOT", 10)).not.toThrow();
        expect(() => searchByFTS("NEAR", 10)).not.toThrow();
        // Verify the function returns results (or empty), not throws
        const r = searchByFTS("find AND replace", 10);
        expect(Array.isArray(r)).toBe(true);
    });

    it("does not crash on FTS5-meaningful punctuation", () => {
        seed("a", "test file");
        expect(() => searchByFTS("test!bar", 10)).not.toThrow();
        expect(() => searchByFTS("~~~", 10)).not.toThrow();
        expect(() => searchByFTS("!@#$%", 10)).not.toThrow();
        expect(() => searchByFTS("user@example.com", 10)).not.toThrow();
        expect(() => searchByFTS("foo;bar,baz", 10)).not.toThrow();
        // None of these should match the seeded "test file" but should return safely
        const r = searchByFTS("~~~", 10);
        expect(Array.isArray(r)).toBe(true);
    });

    it("matches by token prefix (so 'table' finds 'tables')", () => {
        seed("a", "extract tables from a pdf");
        const r = searchByFTS("table", 10);
        expect(r.length).toBeGreaterThan(0);
        expect(r[0]?.slug).toBe("a");
    });

    it("does not crash on single-char input", () => {
        seed("a", "alpha");
        expect(() => searchByFTS("a", 10)).not.toThrow();
        const r = searchByFTS("a", 10);
        expect(Array.isArray(r)).toBe(true);
    });
});
