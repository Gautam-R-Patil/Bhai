// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initForge, getForgeStats, listDynamicTools, isForgeReady } from "../orchestrator.js";
import { closeLibrary } from "../library.js";

describe("orchestrator boot", () => {
    let tmpDir: string;
    let originalEnv: string | undefined;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "forge-orch-"));
        originalEnv = process.env.BHAI_HOME;
        process.env.BHAI_HOME = join(tmpDir, ".bhai");
    });

    afterEach(() => {
        closeLibrary();
        rmSync(tmpDir, { recursive: true, force: true });
        if (originalEnv === undefined) delete process.env.BHAI_HOME;
        else process.env.BHAI_HOME = originalEnv;
    });

    it("initForge does nothing when BHAI_NO_FORGE=true", async () => {
        process.env.BHAI_NO_FORGE = "true";
        await initForge({ embedFn: async () => new Float32Array(384) });
        expect(isForgeReady()).toBe(false);
        delete process.env.BHAI_NO_FORGE;
    });

    it("initForge opens library and runs migration when enabled", async () => {
        delete process.env.BHAI_NO_FORGE;
        await initForge({ embedFn: async () => new Float32Array(384) });
        expect(isForgeReady()).toBe(true);
        const stats = getForgeStats();
        expect(stats.libraryRows).toBe(0);
    });

    it("initForge migrates legacy tools if present", async () => {
        const legacyDir = join(process.env.BHAI_HOME!, "dynamic-tools");
        mkdirSync(legacyDir, { recursive: true });
        writeFileSync(join(legacyDir, "foo.json"), JSON.stringify({
            name: "foo", description: "foo tool",
            parameters_schema: {}, handler_code: "return 1;",
            created_at: new Date().toISOString(),
        }));

        await initForge({ embedFn: async () => new Float32Array(384) });
        const tools = listDynamicTools();
        expect(tools.length).toBe(1);
        expect(tools[0].slug).toBe("foo");
    });

    it("initForge fails open: SQLite error logs but does not throw", async () => {
        // Force an open failure by putting a file where the data dir should be.
        // (A read-only chmod doesn't stop writes on Windows, or for root.)
        mkdirSync(process.env.BHAI_HOME!, { recursive: true });
        writeFileSync(join(process.env.BHAI_HOME!, "data"), "");

        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        await initForge({ embedFn: async () => new Float32Array(384) });
        expect(isForgeReady()).toBe(false);
        expect(consoleErrorSpy).toHaveBeenCalled();
        consoleErrorSpy.mockRestore();
    });
});
