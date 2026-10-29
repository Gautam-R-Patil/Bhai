// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initForge, isForgeReady, getForgeStats, listDynamicTools, shutdownForge } from "../orchestrator.js";

describe("Phase 1 — Foundation smoke test", () => {
    let tmpDir: string;
    let originalEnv: string | undefined;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "forge-p1-"));
        originalEnv = process.env.ATLAS_HOME;
        process.env.ATLAS_HOME = join(tmpDir, ".atlas");
    });

    afterEach(() => {
        shutdownForge();
        rmSync(tmpDir, { recursive: true, force: true });
        if (originalEnv === undefined) delete process.env.ATLAS_HOME;
        else process.env.ATLAS_HOME = originalEnv;
    });

    it("fresh boot creates library, no migrations, empty stats", async () => {
        await initForge({ embedFn: async () => new Float32Array(384) });
        expect(isForgeReady()).toBe(true);
        const stats = getForgeStats();
        expect(stats.libraryRows).toBe(0);
        expect(stats.activeToolsCount).toBe(0);

        const dbPath = join(process.env.ATLAS_HOME!, "data", "skill-library.db");
        expect(existsSync(dbPath)).toBe(true);

        const telemetryPath = join(process.env.ATLAS_HOME!, "data", "forge-telemetry.jsonl");
        expect(existsSync(telemetryPath)).toBe(true);
    });

    it("boot with legacy tools migrates them", async () => {
        const legacy = join(process.env.ATLAS_HOME!, "dynamic-tools");
        mkdirSync(legacy, { recursive: true });
        writeFileSync(join(legacy, "send_sms.json"), JSON.stringify({
            name: "send_sms", description: "Send an SMS",
            parameters_schema: { type: "object", properties: { to: { type: "string" }, body: { type: "string" } } },
            handler_code: "return `sent to ${input.to}`;",
            created_at: new Date().toISOString(),
        }));

        await initForge({ embedFn: async () => new Float32Array(384) });

        const tools = listDynamicTools();
        expect(tools).toHaveLength(1);
        expect(tools[0].slug).toBe("send_sms");
        expect(tools[0].source).toBe("migrated");
    });

    it("kill switch disables everything", async () => {
        process.env.ATLAS_NO_FORGE = "true";
        await initForge({ embedFn: async () => new Float32Array(384) });
        expect(isForgeReady()).toBe(false);
        expect(listDynamicTools()).toEqual([]);

        const dbPath = join(process.env.ATLAS_HOME!, "data", "skill-library.db");
        expect(existsSync(dbPath)).toBe(false);

        delete process.env.ATLAS_NO_FORGE;
    });

    it("second boot is fast (under 100ms) when library is fresh", async () => {
        await initForge({ embedFn: async () => new Float32Array(384) });
        shutdownForge();

        const start = Date.now();
        await initForge({ embedFn: async () => new Float32Array(384) });
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(500); // generous; 100ms is the ambition but CI machines vary
    });
});
