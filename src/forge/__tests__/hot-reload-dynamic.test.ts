// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hotReloadItem, hotUnloadItem } from "../../store/hot-reload.js";
import type { StoreItem } from "../../store/types.js";

function makeItem(slug: string, type: "dynamic" | "unknown"): StoreItem {
    return {
        _id: `id_${slug}`,
        slug,
        type: type as any,
        name: slug,
        description: "test",
        developerId: "dev",
        version: "1.0.0",
        contentFileId: "file",
        category: "utilities",
        tags: [],
        permissions: [],
        pricing: "free",
        installCount: 0,
        rating: 0,
        ratingCount: 0,
        weeklyInstalls: 0,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        publishedAt: Date.now(),
    };
}

describe("hot-reload supports dynamic items", () => {
    let tmpDir: string;
    let originalEnv: string | undefined;
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "forge-hr-"));
        originalEnv = process.env.BHAI_HOME;
        process.env.BHAI_HOME = join(tmpDir, ".bhai");
        consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        consoleLogSpy.mockRestore();
        consoleWarnSpy.mockRestore();
        rmSync(tmpDir, { recursive: true, force: true });
        if (originalEnv === undefined) delete process.env.BHAI_HOME;
        else process.env.BHAI_HOME = originalEnv;
    });

    it("hotReloadItem accepts type='dynamic' without throwing", async () => {
        const dynDir = join(process.env.BHAI_HOME!, "store", "dynamic", "demo");
        mkdirSync(dynDir, { recursive: true });
        writeFileSync(join(dynDir, "handler.js"), "module.exports = async () => 'ok';");
        writeFileSync(join(dynDir, "schema.json"), JSON.stringify({ type: "object", properties: {} }));

        // Phase 1: this should accept type=dynamic without throwing.
        // Actual registration into the agent's tool registry comes in phase 2.
        await expect(hotReloadItem(makeItem("demo", "dynamic"))).resolves.not.toThrow();
    });

    it("hotUnloadItem accepts type='dynamic' without throwing", async () => {
        await expect(hotUnloadItem(makeItem("demo", "dynamic"))).resolves.not.toThrow();
    });

    it("hotReloadItem warns on unknown types", async () => {
        await hotReloadItem(makeItem("x", "unknown"));
        expect(consoleWarnSpy).toHaveBeenCalled();
    });
});
