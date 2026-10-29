// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
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

    it("single-quotes command + args so shell metacharacters stay inert", () => {
        const { command, args } = wrapForShell(gitBash, "ls", ["-la", "/tmp"]);
        expect(command).toEqual(gitBash.path);
        expect(args).toEqual(["-c", "'ls' '-la' '/tmp'"]);
    });

    it("escapes embedded single quotes using the POSIX '\\'' dance", () => {
        const { args } = wrapForShell(gitBash, "echo", ["it's fine"]);
        expect(args[1]).toEqual("'echo' 'it'\\''s fine'");
    });

    it("neutralises shell metacharacters inside args", () => {
        const { args } = wrapForShell(gitBash, "echo", ["; rm -rf ~"]);
        expect(args[1]).toEqual("'echo' '; rm -rf ~'");
    });

    it("bare command with no args is still single-quoted", () => {
        const { args } = wrapForShell(gitBash, "pwd", []);
        expect(args).toEqual(["-c", "'pwd'"]);
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
        // `& 'ls'` is the PowerShell call operator invoking the quoted path.
        expect(script.endsWith("\n& 'ls'")).toBe(true);
    });

    it("quotes each arg with single quotes and uses the `&` call operator", () => {
        const { args } = wrapForShell(ps7, "Get-Item", ["foo.txt", "bar.txt"]);
        expect(args[5].endsWith("\n& 'Get-Item' 'foo.txt' 'bar.txt'")).toBe(true);
    });

    it("doubles a literal single quote inside an arg (PowerShell escape)", () => {
        const { args } = wrapForShell(ps7, "echo", ["it's"]);
        expect(args[5].endsWith("\n& 'echo' 'it''s'")).toBe(true);
    });

    it("neutralises PowerShell statement separators inside args", () => {
        const { args } = wrapForShell(ps7, "echo", ["; Invoke-Expression rm"]);
        expect(args[5].endsWith("\n& 'echo' '; Invoke-Expression rm'")).toBe(true);
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

    it("no shimBlock → script is just the quoted call with no shim prefix", () => {
        const noShim: ResolvedShell = {
            type: "powershell7",
            path: "pwsh.exe",
        };
        const { args } = wrapForShell(noShim, "Get-Date", []);
        expect(args[5]).toEqual("& 'Get-Date'");
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
