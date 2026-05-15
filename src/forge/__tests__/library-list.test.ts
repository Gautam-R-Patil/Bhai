// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLibrary, closeLibrary, insertTool, listTools, countTools, getLibrary } from "../library.js";

function seedTool(slug: string, source: "synchronous" | "dream_replay" = "synchronous") {
    insertTool({
        slug, description: `description of ${slug}`,
        schemaJson: "{}", handlerHash: slug, embedding: new Float32Array(384),
        source, createdAt: Date.now(),
    });
}

describe("library listing", () => {
    let tmpDir: string;
    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "forge-test-"));
        openLibrary(join(tmpDir, "lib.db"));
    });
    afterEach(() => { closeLibrary(); rmSync(tmpDir, { recursive: true, force: true }); });

    it("listTools returns empty list when empty", () => {
        expect(listTools()).toEqual([]);
    });

    it("listTools returns all tools in slug order", () => {
        seedTool("b"); seedTool("a"); seedTool("c");
        const tools = listTools();
        expect(tools.map(t => t.slug)).toEqual(["a", "b", "c"]);
    });

    it("listTools({ source }) filters by source", () => {
        seedTool("a", "synchronous"); seedTool("b", "dream_replay"); seedTool("c", "synchronous");
        const tools = listTools({ source: "dream_replay" });
        expect(tools.map(t => t.slug)).toEqual(["b"]);
    });

    it("listTools({ includeArchived: false }) excludes archived", () => {
        seedTool("a"); seedTool("b");
        // Use the imported getLibrary, not require(...). The project is ESM.
        getLibrary().prepare(`UPDATE tools SET archived_at = ? WHERE slug = ?`).run(Date.now(), "b");
        const tools = listTools({ includeArchived: false });
        expect(tools.map(t => t.slug)).toEqual(["a"]);
    });

    it("countTools returns total + per-state counts", () => {
        seedTool("a"); seedTool("b"); seedTool("c");
        const counts = countTools();
        expect(counts.total).toBe(3);
        expect(counts.active).toBe(3);
        expect(counts.archived).toBe(0);
        expect(counts.graduated).toBe(0);
    });

    it("countTools returns zeros on empty library", () => {
        const counts = countTools();
        expect(counts).toEqual({ total: 0, active: 0, archived: 0, graduated: 0, published: 0 });
    });
});
