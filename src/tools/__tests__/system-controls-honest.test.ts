// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// A failed Wi-Fi join or a volume change Windows can't make isn't reported as done,
// and a network name can't run PowerShell.
import { beforeEach, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ win: false, ps: [] as string[], psFails: false }));
let joinSays = "";

vi.mock("node:child_process", () => ({
    execFile: (_cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, r: object) => void) => {
        const stdout = args[0] === "-setairportnetwork" ? joinSays : "Hardware Port: Wi-Fi\nDevice: en0\n";
        cb(null, { stdout, stderr: "" });
    },
}));
vi.mock("../platform.js", async (orig) => ({
    ...(await orig<object>()),
    get IS_WIN() {
        return platform.win;
    },
    get IS_MAC() {
        return !platform.win;
    },
    IS_LINUX: false,
    runPowerShellInline: async (cmd: string) => {
        platform.ps.push(cmd);
        if (platform.psFails && cmd.includes("nircmd")) throw new Error("nircmd.exe not recognized");
        return "";
    },
}));

const { wifiControl, setVolume } = await import("../system-controls.js");

beforeEach(() => {
    platform.ps.length = 0;
    platform.psFails = false;
});

it("macOS: a join networksetup reports as failed is a failure", async () => {
    platform.win = false;
    joinSays = "Failed to join network Cafe.\nError: -3900  The operation couldn't be completed.";
    const out = JSON.parse(await wifiControl.handler({ action: "connect", ssid: "Cafe", password: "x" }));
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/Failed to join/);
    joinSays = "";
    expect(JSON.parse(await wifiControl.handler({ action: "connect", ssid: "Cafe" })).success).toBe(true);
});

it("Windows: a network name stays a literal in PowerShell", async () => {
    platform.win = true;
    await wifiControl.handler({ action: "connect", ssid: `x"; Remove-Item C:\\ -Recurse; "` });
    expect(platform.ps.at(-1)).toBe(`netsh wlan connect name='x"; Remove-Item C:\\ -Recurse; "'`);
});

it("Windows without nircmd: a level is set with the volume keys, mute is refused", async () => {
    platform.win = true;
    platform.psFails = true;
    const set = JSON.parse(await setVolume.handler({ level: 40 }));
    expect(set).toMatchObject({ success: true, volume: 40 });
    expect(platform.ps.at(-1)).toContain("1..20");
    const muted = JSON.parse(await setVolume.handler({ mute: true }));
    expect(muted.success).toBe(false);
    expect(platform.ps.some((c) => c.includes("[char]173"))).toBe(false); // never the toggle key
});
