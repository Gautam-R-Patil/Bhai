// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _clearProtectedPaths, registerProtectedPath } from "../../security/allowlist.js";
import { shellExecBackground, shellWaitProcess } from "../shell-monitor.js";

describe.skipIf(process.platform === "win32")("shell_exec_background args", () => {
    it("keeps each arg one literal: sh -c 'sleep …; echo …' runs as written", async () => {
        const started = JSON.parse(String(await shellExecBackground.handler({ command: "sh", args: ["-c", "sleep 0.2; echo build-done"] })));
        expect(started.success).toBe(true);
        const done = String(await shellWaitProcess.handler({ process_id: started.process_id, timeout_seconds: 5 }));
        expect(done).toContain("build-done");
        expect(done).not.toMatch(/usage: sleep/i);
    });
});

describe("shell_exec_background guards", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bhai-bg-protect-"));
    const file = path.join(repo, "a.ts");
    fs.writeFileSync(file, "x");
    beforeAll(() => registerProtectedPath(repo));
    afterAll(() => {
        _clearProtectedPaths();
        fs.rmSync(repo, { recursive: true, force: true });
    });

    it.each([
        { command: "git", args: ["config", "--get", "user.name"] },
        { command: "sed", args: ["-i", "", "s/x/y/", file] },
        { command: `echo pwned > ${file}` },
    ])("refuses what shell_exec refuses: $command", async (input) => {
        const out = JSON.parse(String(await shellExecBackground.handler(input)));
        expect(out.error).toMatch(/^Blocked/);
        expect(fs.readFileSync(file, "utf8")).toBe("x");
    });
});
