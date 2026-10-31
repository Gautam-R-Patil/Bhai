// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentsMdScaffoldTool } from "./agents-md-scaffold.js";

let repo: string;
const run = async () => JSON.parse(await agentsMdScaffoldTool.handler({ path: repo }));

describe("agents_md_scaffold: pre-rename @atlas markers and .atlas/agents", () => {
    beforeEach(() => {
        repo = mkdtempSync(join(homedir(), "scaffold-repo-"));
    });
    afterEach(() => rmSync(repo, { recursive: true, force: true }));

    it("a fresh repo gets .bhai/agents and @bhai:auto markers", async () => {
        const r = await run();
        expect(r.success).toBe(true);
        expect(existsSync(join(repo, ".bhai", "agents", "notes.md"))).toBe(true);
        const root = readFileSync(join(repo, "AGENTS.md"), "utf-8");
        expect(root).toContain("<!-- @bhai:auto -->");
        expect(root).toContain(".bhai/agents/");
    });

    it("keeps writing into an existing .atlas/agents, treats @atlas:auto as machine-owned, swaps the marker", async () => {
        const old = join(repo, ".atlas", "agents");
        mkdirSync(old, { recursive: true });
        writeFileSync(join(old, "gotchas.md"), "<!-- @atlas:auto -->\nold\n<!-- @atlas:auto:end -->\n");
        writeFileSync(join(old, "conventions.md"), "# Mine, hand-written\n");
        writeFileSync(join(repo, "AGENTS.md"), "# Intro\n\n<!-- @atlas:auto -->\nstale\n<!-- @atlas:auto:end -->\n\n## Human tail\n");

        const r = await run();
        expect(r.success).toBe(true);
        expect(existsSync(join(repo, ".bhai"))).toBe(false);
        expect(r.updated).toContain(join(old, "gotchas.md"));
        expect(r.refused).toContain(join(old, "conventions.md"));
        const root = readFileSync(join(repo, "AGENTS.md"), "utf-8");
        expect(root).not.toContain("@atlas:auto");
        expect(root).not.toContain("stale");
        expect(root).toMatch(/^# Intro\n\n<!-- @bhai:auto -->[\s\S]*\.atlas\/agents\/[\s\S]*<!-- @bhai:auto:end -->\n+## Human tail\n$/);
    });
});
