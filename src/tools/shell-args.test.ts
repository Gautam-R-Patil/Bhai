// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Each shell_exec arg is one literal argument. Joined unquoted, `bash -c "set -e; …"` ran a
// bare `set` and dumped the whole environment into the tool result (seen live).
import { describe, expect, it } from "vitest";
import { shellExec } from "./shell.js";

describe.skipIf(process.platform === "win32")("shell_exec args", () => {
    it("keeps a multi-word argument together", async () => {
        const out = JSON.parse(
            await shellExec.handler({ command: "bash", args: ["-c", "set -e; echo one two; echo three"] }),
        );
        expect(out.stdout).toBe("one two\nthree\n");
        expect(out.stdout).not.toMatch(/^PATH=|HOME=/m); // no environment dump
    });

    it("passes quotes and spaces literally, and keeps shell syntax in command working", async () => {
        const quoted = JSON.parse(await shellExec.handler({ command: "printf", args: ["%s|", "it's a test", "$HOME"] }));
        expect(quoted.stdout).toBe("it's a test|$HOME|");
        const piped = JSON.parse(await shellExec.handler({ command: "echo hello | tr a-z A-Z" }));
        expect(piped.stdout).toBe("HELLO\n");
    });
});

describe.skipIf(process.platform === "win32")("shell_exec environment", () => {
    it("children don't see Bhai's own credentials, but keep the owner's tool tokens and PATH", async () => {
        process.env.TELEGRAM_BOT_TOKEN = "123:abc";
        process.env.BHAI_RUNTIME_KEY = "rk";
        process.env.BHAI_DEVICE_SECRET = "ds";
        process.env.ATLAS_RUNTIME_KEY = "old-rk"; // pre-rename names from the owner's shell
        process.env.ATLAS_DEVICE_SECRET = "old-ds";
        process.env.EMAIL_PASSWORD = "pw";
        process.env.GITHUB_TOKEN = "ghp_owner";
        try {
            const out = JSON.parse(await shellExec.handler({ command: "env" })).stdout as string;
            expect(out).not.toMatch(/TELEGRAM_BOT_TOKEN|(BHAI|ATLAS)_RUNTIME_KEY|(BHAI|ATLAS)_DEVICE_SECRET|EMAIL_PASSWORD/);
            expect(out).toMatch(/^PATH=/m);
            // Still there for gh/git (the output sanitizer hides its value from the model anyway).
            const gh = JSON.parse(await shellExec.handler({ command: 'test -n "$GITHUB_TOKEN" && echo has-token' }));
            expect(gh.stdout).toBe("has-token\n");
        } finally {
            for (const k of ["TELEGRAM_BOT_TOKEN", "BHAI_RUNTIME_KEY", "BHAI_DEVICE_SECRET", "ATLAS_RUNTIME_KEY", "ATLAS_DEVICE_SECRET", "EMAIL_PASSWORD", "GITHUB_TOKEN"])
                delete process.env[k];
        }
    });
});
