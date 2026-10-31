// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// $PID is PowerShell's read-only automatic variable: a -Pid parameter makes the whole script fail.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("the Windows UIA dump takes -TargetPid, never a $Pid parameter", () => {
    const ps1 = readFileSync(new URL("../../../scripts/dump_uia.ps1", import.meta.url), "utf8");
    const params = (/param\(([\s\S]*?)\)\s*\n/i.exec(ps1)?.[1] ?? "").replace(/#.*$/gm, ""); // code, not comments
    expect(params).toMatch(/\[int\]\$TargetPid\b/);
    expect(params).not.toMatch(/\$Pid\b/);
    const caller = readFileSync(new URL("../ax-dump.ts", import.meta.url), "utf8");
    expect(caller).toContain('"-TargetPid"');
    expect(caller).not.toContain('"-Pid"');
});
