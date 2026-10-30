// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { walkthroughTool } from "./walkthrough.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bhai-walk-"));
process.env.ATLAS_WORKSPACE = root;
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("generate_walkthrough", () => {
    it("describes uncommitted work by default, not past commits", async () => {
        const repo = path.join(root, "repo");
        fs.mkdirSync(repo);
        const git = (...a: string[]) =>
            execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: repo });
        git("init", "-q");
        fs.writeFileSync(path.join(repo, "old.txt"), "a\n");
        fs.writeFileSync(path.join(repo, "edited.txt"), "a\n");
        git("add", ".");
        git("commit", "-qm", "unrelated old commit");
        fs.writeFileSync(path.join(repo, "edited.txt"), "b\n");
        fs.writeFileSync(path.join(repo, "new.txt"), "c\n");

        const res = JSON.parse(String(await walkthroughTool.handler({ task: "add new", repo_root: repo })));
        expect(res).toMatchObject({ success: true, commits_included: 0, files_touched: 2 });
        const md = fs.readFileSync(res.path, "utf-8");
        expect(md).toContain("`edited.txt`");
        expect(md).toContain("`new.txt`");
        expect(md).not.toContain("old.txt");
    });

    it("requires repo_root", async () => {
        const res = JSON.parse(String(await walkthroughTool.handler({ task: "x" })));
        expect(res.success).toBe(false);
    });
});
