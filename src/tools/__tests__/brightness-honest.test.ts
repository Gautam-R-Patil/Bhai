// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The brightness CLI exits 0 when it can't drive the display (Apple Silicon's built-in
// panel): that isn't reported as a brightness change.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const ran: string[] = [];
let cliSays = "";
vi.mock("node:child_process", async (orig) => ({
    ...(await orig<object>()),
    execFile: (cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, r: object) => void) => {
        ran.push(cmd);
        cb(null, cmd === "brightness" ? { stdout: "", stderr: cliSays } : { stdout: "", stderr: "" });
    },
}));

await import("../index.js"); // load the registry first, as the app does (macos.ts is in an import cycle with it)
const { setBrightness } = await import("../macos.js");

// The handler checks the platform when it runs (faking it at import loads the macOS tool set).
const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
beforeEach(() => {
    ran.length = 0;
    Object.defineProperty(process, "platform", { value: "darwin" });
});
afterEach(() => Object.defineProperty(process, "platform", platform));

it("a CLI that says it failed falls through to the brightness keys", async () => {
    cliSays = "brightness: failed to set brightness of display 0x1 (error -536870201)\n";
    const out = JSON.parse(await setBrightness.handler({ level: 50 }));
    expect(out).toMatchObject({ success: true, method: "key-simulation" });
    expect(ran).toEqual(["brightness", "osascript"]);
});

it("a CLI that worked is the answer", async () => {
    cliSays = "";
    expect(JSON.parse(await setBrightness.handler({ level: 50 })).method).toBe("brightness-cli");
    expect(ran).toEqual(["brightness"]);
});
