// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { afterAll, beforeAll, expect, it, vi } from "vitest";

// $PID is PowerShell's read-only automatic variable (the host's own pid): assigning
// it fails and Get-Process -Id $pid reports "powershell" as the focused app.
const scripts: string[] = [];
const record = vi.fn(async (script: string) => {
    scripts.push(script);
    return "notepad|||Untitled";
});
vi.mock("../platform.js", () => ({
    IS_WIN: true,
    IS_MAC: false,
    IS_LINUX: false,
    captureScreenshot: vi.fn(),
    clipboardRead: vi.fn(),
    clipboardWrite: vi.fn(),
    getFrontmostApp: vi.fn(),
    getScreenResolution: vi.fn(async () => ({ width: 1920, height: 1080 })),
    nativeOpen: vi.fn(),
    runPowerShellInline: record,
    runPowerShell: record,
}));

const { getActiveWindow } = await import("../platform-bridge.js");
const { winOsContext } = await import("../windows.js");
const realPlatform = process.platform;
beforeAll(() => Object.defineProperty(process, "platform", { value: "win32" }));
afterAll(() => Object.defineProperty(process, "platform", { value: realPlatform }));

it.each([
    ["getActiveWindow", () => getActiveWindow()],
    ["os_context", () => winOsContext.handler({})],
])("%s never uses PowerShell's read-only $PID", async (_name, run) => {
    scripts.length = 0;
    await run();
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).not.toMatch(/\$pid\b/i);
    expect(scripts[0]).toContain("[ref]$procId");
    expect(scripts[0]).toContain("Get-Process -Id $procId");
});

it("getActiveWindow reports the foreground app", async () => {
    expect(await getActiveWindow()).toEqual({ app: "notepad", title: "Untitled" });
});
