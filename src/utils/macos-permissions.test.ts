// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

let osascriptStderr = "";
vi.mock("node:child_process", () => ({
    execFile: (cmd: string, _args: string[], _opts: unknown, cb: (err: unknown, out?: unknown) => void) => {
        if (cmd === "osascript") cb(Object.assign(new Error("Command failed: osascript"), { stderr: osascriptStderr }));
        else cb(null, { stdout: "" });
    },
}));
vi.mock("node:fs", () => ({ promises: { stat: async () => ({ size: 500_000 }), unlink: async () => {} } }));

const { probeAndLogMacPermissions } = await import("./macos-permissions.js");

describe("##BHAI_PERMS## marker", () => {
    const platform = process.platform;
    let log: MockInstance<typeof console.log>;
    beforeEach(() => {
        Object.defineProperty(process, "platform", { value: "darwin" });
        log = vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
        Object.defineProperty(process, "platform", { value: platform });
        vi.restoreAllMocks();
    });
    const marker = () => log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("##BHAI_PERMS##"));

    it("stays quiet on an Apple Events (Automation) denial", async () => {
        osascriptStderr = "execution error: Not authorized to send Apple events to System Events. (-1743)";
        const state = await probeAndLogMacPermissions();
        expect(state.appleScript.reason).toBe("tcc_denied_apple_events");
        expect(marker()).toBeUndefined();
    });

    it("stays quiet when System Events is just slow", async () => {
        osascriptStderr = "";
        await probeAndLogMacPermissions();
        expect(marker()).toBeUndefined();
    });

    it("reports an assistive-access denial as Accessibility", async () => {
        osascriptStderr = "execution error: osascript is not allowed assistive access. (1002)";
        await probeAndLogMacPermissions();
        expect(marker()).toBe('##BHAI_PERMS##{"accessibility":false,"screen":true}');
    });
});
