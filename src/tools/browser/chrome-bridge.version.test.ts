// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//
// An extension older than the copy shipped with Bhai is asked to reload: the
// comparison is numeric per part, so 1.0.10 is newer than 1.0.9.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../overlay/overlay-chat.js", () => ({ getOverlayLocalToken: () => "t" }));

const { isNewerVersion, nativeHostLauncher } = await import("./chrome-bridge.js");

describe("isNewerVersion", () => {
    it("compares dotted versions part by part", () => {
        expect(isNewerVersion("1.0.5", "1.0.4")).toBe(true);
        expect(isNewerVersion("1.0.10", "1.0.9")).toBe(true);
        expect(isNewerVersion("1.1", "1.0.9")).toBe(true);
        expect(isNewerVersion("1.0.4", "1.0.4")).toBe(false);
        expect(isNewerVersion("1.0.4", "1.0.5")).toBe(false);
        expect(isNewerVersion("1.0", "1.0.0")).toBe(false);
    });
});

describe.skipIf(process.platform === "win32")("native host launcher", () => {
    // Chrome may start the host mid-reinstall; the half-copied app must not be run.
    it("runs the host only when the app's Electron runtime is all there", () => {
        const app = fs.mkdtempSync(path.join(os.tmpdir(), "bhai-launcher-"));
        const exe = path.join(app, "Bhai's.app", "Contents", "MacOS", "Bhai");
        const fw = path.join(app, "Bhai's.app", "Contents", "Frameworks", "Electron Framework.framework");
        fs.mkdirSync(path.dirname(exe), { recursive: true });
        fs.writeFileSync(exe, '#!/bin/sh\necho "ran $ELECTRON_RUN_AS_NODE $1"\n', { mode: 0o755 });
        const host = path.join(app, "host.js");
        fs.writeFileSync(host, "");
        const launcher = path.join(app, "launcher");
        fs.writeFileSync(launcher, nativeHostLauncher(exe, host), { mode: 0o755 });
        const run = () => {
            try {
                return execFileSync(launcher, { encoding: "utf8" });
            } catch (e) {
                return `exit ${(e as { status: number }).status}`;
            }
        };

        expect(run()).toBe("exit 1"); // framework missing
        fs.mkdirSync(path.join(fw, "Resources"), { recursive: true });
        fs.writeFileSync(path.join(fw, "Electron Framework"), "");
        expect(run()).toBe("exit 1"); // ICU data still missing
        fs.writeFileSync(path.join(fw, "Resources", "icudtl.dat"), "");
        expect(run()).toBe(`ran 1 ${host}\n`);
        fs.rmSync(app, { recursive: true, force: true });
    });
});
