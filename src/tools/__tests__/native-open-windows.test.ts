// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// On Windows, `cmd /c start "" <target>` parses & | < > ^ in the target: a URL with
// "?a=1&b=2" was cut at the & and the rest run as a second command.

import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => {
    Object.defineProperty(process, "platform", { value: "win32" });
    return [] as { cmd: string; args: string[] }[];
});

vi.mock("node:child_process", async (orig) => ({
    ...(await orig<typeof import("node:child_process")>()),
    execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: null, r: { stdout: string }) => void) => {
        calls.push({ cmd, args });
        cb(null, { stdout: "" });
    },
}));

const { nativeOpen, psQuote } = await import("../platform.js");

describe("nativeOpen on Windows", () => {
    it("opens a plain path through cmd start", async () => {
        calls.length = 0;
        await nativeOpen("C:\\Users\\me\\report.pdf");
        expect(calls[0]).toEqual({ cmd: "cmd.exe", args: ["/c", "start", "", "C:\\Users\\me\\report.pdf"] });
    });

    it("sends a target with cmd metacharacters through Start-Process, quoted", async () => {
        calls.length = 0;
        await nativeOpen("https://maps.example/?a=1&calc.exe");
        expect(calls[0].cmd).toBe("powershell.exe");
        expect(calls[0].args.at(-1)).toBe("Start-Process -FilePath 'https://maps.example/?a=1&calc.exe'");
    });

    it("psQuote doubles single quotes, smart quotes included", () => {
        expect(psQuote("it's")).toBe("'it''s'");
        expect(psQuote("it\u2019s")).toBe("'it''s'");
    });
});
