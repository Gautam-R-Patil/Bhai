// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import type { Readable as ReadableType } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");
vi.mock("node:child_process");
vi.mock("../../../config/paths.js", () => ({
    getDataDir: () => "/fake/data",
}));

import { _resetEnvState, ensurePythonEnv, runPython } from "../python-sidecar.js";

const MARKER = "/fake/data/video-studio/venv/.atlas-ready";

describe("ensurePythonEnv", () => {
    beforeEach(() => {
        _resetEnvState();
        vi.clearAllMocks();
    });

    afterEach(() => {
        _resetEnvState();
    });

    it("skips install when venv marker file exists", async () => {
        vi.mocked(fs.existsSync).mockImplementation((p) => String(p) === MARKER);
        const cp = await import("node:child_process");
        const execFileSpy = vi.spyOn(cp, "execFile");
        await ensurePythonEnv();
        expect(execFileSpy).not.toHaveBeenCalled();
    });

    it("is idempotent — second call is a no-op", async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        const cp = await import("node:child_process");
        const execFileSpy = vi.spyOn(cp, "execFile");
        await ensurePythonEnv();
        await ensurePythonEnv();
        expect(execFileSpy).not.toHaveBeenCalled();
    });
});

describe("runPython", () => {
    it("resolves stdout on exit code 0", async () => {
        const { EventEmitter } = await import("node:events");
        const { Readable } = await import("node:stream");
        const cp = await import("node:child_process");

        const fakeChild = new EventEmitter() as unknown as {
            stdout: ReadableType;
            stderr: ReadableType;
            emit: (ev: string, ...a: unknown[]) => boolean;
        };
        fakeChild.stdout = new Readable({ read() {} });
        fakeChild.stderr = new Readable({ read() {} });
        vi.spyOn(cp, "spawn").mockReturnValue(fakeChild as unknown as ReturnType<typeof cp.spawn>);

        const promise = runPython("/fake/script.py", ["arg1", "arg2"]);

        fakeChild.stdout.push("hello\n");
        fakeChild.stdout.push(null);
        fakeChild.stderr.push(null);
        await new Promise((r) => setImmediate(r));
        fakeChild.emit("close", 0);

        const result = await promise;
        expect(result).toBe("hello\n");
    });

    it("rejects with stderr on non-zero exit", async () => {
        const { EventEmitter } = await import("node:events");
        const { Readable } = await import("node:stream");
        const cp = await import("node:child_process");

        const fakeChild = new EventEmitter() as unknown as {
            stdout: ReadableType;
            stderr: ReadableType;
            emit: (ev: string, ...a: unknown[]) => boolean;
        };
        fakeChild.stdout = new Readable({ read() {} });
        fakeChild.stderr = new Readable({ read() {} });
        vi.spyOn(cp, "spawn").mockReturnValue(fakeChild as unknown as ReturnType<typeof cp.spawn>);

        const promise = runPython("/fake/script.py", []);

        fakeChild.stdout.push(null);
        fakeChild.stderr.push("ModuleNotFoundError\n");
        fakeChild.stderr.push(null);
        fakeChild.emit("close", 1);

        await expect(promise).rejects.toThrow("exited 1");
    });
});

describe("runPython — timeout & abort", () => {
    it("rejects with timeout error when timeoutMs exceeded", async () => {
        const { EventEmitter } = await import("node:events");
        const { Readable } = await import("node:stream");
        const cp = await import("node:child_process");

        const fakeChild = new EventEmitter() as unknown as {
            stdout: ReadableType;
            stderr: ReadableType;
            kill: (sig: string) => void;
            emit: (ev: string, ...a: unknown[]) => boolean;
        };
        fakeChild.stdout = new Readable({ read() {} });
        fakeChild.stderr = new Readable({ read() {} });
        fakeChild.kill = vi.fn();
        vi.spyOn(cp, "spawn").mockReturnValue(fakeChild as unknown as ReturnType<typeof cp.spawn>);

        const promise = runPython("/fake/slow.py", [], { timeoutMs: 20 });

        await expect(promise).rejects.toThrow(/timed out after 20ms/);
        expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("rejects with abort error when AbortSignal fires", async () => {
        const { EventEmitter } = await import("node:events");
        const { Readable } = await import("node:stream");
        const cp = await import("node:child_process");

        const fakeChild = new EventEmitter() as unknown as {
            stdout: ReadableType;
            stderr: ReadableType;
            kill: (sig: string) => void;
            emit: (ev: string, ...a: unknown[]) => boolean;
        };
        fakeChild.stdout = new Readable({ read() {} });
        fakeChild.stderr = new Readable({ read() {} });
        fakeChild.kill = vi.fn();
        vi.spyOn(cp, "spawn").mockReturnValue(fakeChild as unknown as ReturnType<typeof cp.spawn>);

        const controller = new AbortController();
        const promise = runPython("/fake/slow.py", [], { signal: controller.signal });
        controller.abort();

        await expect(promise).rejects.toThrow(/aborted/);
        expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
    });
});
