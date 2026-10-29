// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gitOpTool } from "./git-op.js";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gitop-"));
execFileSync("git", ["init", "-q", "-b", "main", repo]);
execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], {
    cwd: repo,
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

const run = async (input: Record<string, unknown>) =>
    JSON.parse(await gitOpTool.handler({ path: repo, confirmed: true, ...input })) as {
        success: boolean;
        error?: string;
    };

describe("git_op refspec gate", () => {
    it.each(["+main", ":main", "HEAD:main", "--force", "-f"])("refuses push branch %s", async (branch) => {
        const r = await run({ operation: "push", branch });
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/refused/);
    });

    it("blocks force push to a protected branch spelled as a full ref or HEAD", async () => {
        for (const branch of ["refs/heads/main", "heads/main", "HEAD"]) {
            const r = await run({ operation: "push", branch, force: true, evidence_phrase: "force push" });
            expect(r.error).toMatch(/blocked at the tool layer/);
        }
    });
});
