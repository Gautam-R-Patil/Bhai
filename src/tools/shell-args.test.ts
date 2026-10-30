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
