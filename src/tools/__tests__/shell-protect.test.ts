// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _clearProtectedPaths, registerProtectedPath } from "../../security/allowlist.js";
import { shellExec, shellWriteTargetsProtected } from "../shell.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bhai-protect-"));
const repo = path.join(root, "bot");
const other = path.join(root, "work");
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
fs.mkdirSync(other);
fs.writeFileSync(path.join(repo, "src", "a.ts"), "x");

beforeAll(() => registerProtectedPath(repo));
afterAll(() => {
    _clearProtectedPaths();
    fs.rmSync(root, { recursive: true, force: true });
});

describe("shell_exec codebase write protection", () => {
    it.each([
        `sed -i 's/a/b/' ${repo}/src/a.ts`,
        `sed -Ei.bak 's/a/b/' ${repo}/src/a.ts`,
        `echo pwned > ${repo}/src/a.ts`,
        `echo pwned >> "${repo}/src/a.ts"`,
        `cat /etc/hosts | tee ${repo}/src/a.ts`,
        `truncate -s 0 ${repo}/src/a.ts`,
        `git -C ${repo} clean -fdx`,
        `cd /tmp && git -C ${repo} checkout -- .`,
        `mv ${other}/x ${repo}/src/a.ts`,
        `cp ${other}/x ${repo}/src/a.ts`,
        `dd if=/dev/zero of=${repo}/src/a.ts`,
        `find ${repo} -name '*.ts' -delete`,
        `sudo rm -rf ${repo}`,
    ])("blocks %s", (line) => {
        expect(shellWriteTargetsProtected(line, other)).not.toBeNull();
    });

    it("blocks relative writes when the cwd is the codebase", () => {
        expect(shellWriteTargetsProtected("git reset --hard", repo)).not.toBeNull();
        expect(shellWriteTargetsProtected("echo x > src/a.ts", repo)).not.toBeNull();
    });

    it.each([
        `cat ${repo}/src/a.ts`,
        `grep -rn "cp" ${repo}/src`,
        `sed -n 1,5p ${repo}/src/a.ts`,
        `git -C ${repo} status`,
        `ls ${repo} 2>&1 > /dev/null`,
        `cp ${repo}/src/a.ts ${other}/a.ts`.replace("cp", "diff"),
        `echo hi > ${other}/out.txt`,
    ])("allows %s", (line) => {
        expect(shellWriteTargetsProtected(line, other)).toBeNull();
    });

    it("allows read-only commands run inside the codebase", () => {
        expect(shellWriteTargetsProtected("git status && cat src/a.ts", repo)).toBeNull();
    });
});

describe("shell_exec failure output", () => {
    it.skipIf(process.platform === "win32")("keeps stdout and stderr of a failing command", async () => {
        const res = JSON.parse(
            String(await shellExec.handler({ command: "echo OUT; echo ERR >&2; exit 1", cwd: other })),
        );
        expect(res).toMatchObject({ success: false, code: 1, stdout: "OUT\n", stderr: "ERR\n" });
        expect(res.error).toBe("Command failed: echo OUT; echo ERR >&2; exit 1");
    });
});
