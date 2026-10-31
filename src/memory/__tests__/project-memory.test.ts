// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProjectMemoryFiles } from "../project-memory.js";

let repo: string;
let home: string;
const write = (rel: string, body: string, root = repo) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
};
const names = () => loadProjectMemoryFiles(repo, { taskType: "coding" }).map((f) => path.relative(repo, f.path));

describe("project memory: BHAI names first, pre-rename ATLAS names as fallback", () => {
    beforeEach(() => {
        repo = mkdtempSync(path.join(tmpdir(), "pm-repo-"));
        home = mkdtempSync(path.join(tmpdir(), "pm-home-"));
        process.env.BHAI_HOME = home;
    });
    afterEach(() => {
        delete process.env.BHAI_HOME;
        rmSync(repo, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
    });

    it("reads ATLAS.md / .atlas/ATLAS.md / ATLAS.local.md only when the BHAI one is absent", () => {
        write("ATLAS.md", "old root");
        write(".atlas/ATLAS.md", "old dot");
        write("BHAI.local.md", "new local");
        write("ATLAS.local.md", "old local");
        expect(names().filter((n) => !n.startsWith(".."))).toEqual(["ATLAS.md", ".atlas/ATLAS.md", "BHAI.local.md"]);
        write("BHAI.md", "new root");
        expect(names()).toContain("BHAI.md");
        expect(names()).not.toContain("ATLAS.md");
    });

    it("merges .bhai/agents and .atlas/agents, preferring .bhai per basename", () => {
        write(".bhai/agents/gotchas.md", "new gotchas");
        write(".atlas/agents/gotchas.md", "old gotchas");
        write(".atlas/agents/notes.md", "old notes");
        const subs = loadProjectMemoryFiles(repo, { taskType: "other" }).filter((f) => f.subdoc);
        expect(subs.map((f) => [f.subdoc, f.content])).toEqual([
            ["gotchas.md", "new gotchas"],
            ["notes.md", "old notes"],
        ]);
    });

    it("section filters match @bhai:section and the old @atlas:section markers", () => {
        write(".atlas/agents/notes.md", "x <!-- @atlas:section:a -->old a<!-- @atlas:section:a:end -->");
        write(".bhai/agents/gotchas.md", "<!-- @bhai:section:a -->new a<!-- @bhai:section:a:end -->");
        const sections = { "notes.md": ["a"], "gotchas.md": ["a"] };
        const got = loadProjectMemoryFiles(repo, { taskType: "other", sections }).filter((f) => f.subdoc);
        expect(got.map((f) => f.content).sort()).toEqual(["new a", "old a"]);
    });

    it("user-level memory: BHAI.md in Bhai's home, else the migrated ATLAS.md", () => {
        write("ATLAS.md", "old user", home);
        const user = () => loadProjectMemoryFiles(repo).find((f) => f.source === "user")?.content;
        expect(user()).toBe("old user");
        write("BHAI.md", "new user", home);
        expect(user()).toBe("new user");
    });
});
