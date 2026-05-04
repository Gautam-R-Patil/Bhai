// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { wrapForShell, type ResolvedShell } from "./win-shell.js";

// wrapForShell is a pure function — exercise all branches without touching
// any filesystem, registry, or child processes.

describe("wrapForShell — gitbash branch", () => {
    const gitBash: ResolvedShell = {
        type: "gitbash",
        path: "C:\\Program Files\\Git\\bin\\bash.exe",
    };

    it("wraps a simple command+args into bash -c 'cmd \"arg1\" \"arg2\"'", () => {
        const { command, args } = wrapForShell(gitBash, "ls", ["-la", "/tmp"]);
        expect(command).toEqual(gitBash.path);
        expect(args).toEqual(["-c", 'ls "-la" "/tmp"']);
    });

    it("handles args containing double-quotes (escapes them)", () => {
        const { args } = wrapForShell(gitBash, "echo", ['he said "hi"']);
        expect(args[1]).toEqual('echo "he said \\"hi\\""');
    });

    it("bare command with no args gets no quoting wrapper", () => {
        const { args } = wrapForShell(gitBash, "pwd", []);
        expect(args).toEqual(["-c", "pwd"]);
    });
});

describe("wrapForShell — powershell branches", () => {
    const ps7: ResolvedShell = {
        type: "powershell7",
        path: "pwsh.exe",
        shimBlock: "function ls { Get-ChildItem @args }",
    };
    const ps5: ResolvedShell = {
        type: "powershell5",
        path: "powershell.exe",
        shimBlock: "function ls { Get-ChildItem @args }",
    };

    it("passes NoProfile/NonInteractive/Bypass/-Command flags", () => {
        const { args } = wrapForShell(ps7, "Get-Process", []);
        expect(args.slice(0, 4)).toEqual([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
        ]);
        expect(args[4]).toEqual("-Command");
    });

    it("prepends the shim block to the script", () => {
        const { args } = wrapForShell(ps7, "ls", []);
        const script = args[5];
        expect(script.startsWith("function ls { Get-ChildItem @args }")).toBe(true);
        expect(script.endsWith("\nls")).toBe(true);
    });

    it("joins args with spaces (no quoting in powershell branch)", () => {
        const { args } = wrapForShell(ps7, "Get-Item", ["foo.txt", "bar.txt"]);
        expect(args[5].endsWith("\nGet-Item foo.txt bar.txt")).toBe(true);
    });

    it("works identically for powershell5 (same code path)", () => {
        const { command, args } = wrapForShell(ps5, "pwd", []);
        expect(command).toEqual("powershell.exe");
        expect(args.slice(0, 4)).toEqual([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
        ]);
    });

    it("no shimBlock → script is just the raw command (no leading shim + newline)", () => {
        const noShim: ResolvedShell = {
            type: "powershell7",
            path: "pwsh.exe",
        };
        const { args } = wrapForShell(noShim, "Get-Date", []);
        expect(args[5]).toEqual("Get-Date");
    });
});

describe("wrapForShell — cmd branch (pass-through)", () => {
    const cmd: ResolvedShell = { type: "cmd", path: "cmd.exe" };

    it("returns command and args unchanged", () => {
        const { command, args } = wrapForShell(cmd, "dir", ["/b", "/s"]);
        expect(command).toEqual("dir");
        expect(args).toEqual(["/b", "/s"]);
    });

    it("empty args list round-trips as empty", () => {
        const { command, args } = wrapForShell(cmd, "cls", []);
        expect(command).toEqual("cls");
        expect(args).toEqual([]);
    });
});
