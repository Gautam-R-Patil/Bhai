// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    clearClickMemory,
    clickMemoryStats,
    closeClickMemory,
    listClickSitesForWindow,
    recallClickSite,
    recordClickMiss,
    recordClickSuccess,
} from "../click-memory.js";

const TEST_DB = join(tmpdir(), `atlas_click_test_${Date.now()}.db`);
const TEST_OPTS = { dbPath: TEST_DB };

const SITE = { app: "Test", windowTitle: "Main", elementLabel: "Save" };

describe("click memory", () => {
    beforeEach(() => {
        closeClickMemory();
        try {
            if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
        } catch {
            /* ignore */
        }
    });

    afterEach(() => {
        closeClickMemory();
        try {
            if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
        } catch {
            /* ignore */
        }
    });

    it("returns null on cold lookup", () => {
        const result = recallClickSite(SITE, TEST_OPTS);
        expect(result).toBeNull();
    });

    it("records and recalls a successful click", () => {
        recordClickSuccess(SITE, 720, 450, 1440, 900, TEST_OPTS);
        const result = recallClickSite(SITE, TEST_OPTS);
        expect(result).not.toBeNull();
        expect(result?.xNorm).toBe(0.5);
        expect(result?.yNorm).toBe(0.5);
        expect(result?.successCount).toBe(1);
        expect(result?.confidence).toBe(0.75); // 0.7 + 1*0.05
    });

    it("increments success_count on repeated success", () => {
        recordClickSuccess(SITE, 100, 200, 1000, 1000, TEST_OPTS);
        recordClickSuccess(SITE, 100, 200, 1000, 1000, TEST_OPTS);
        recordClickSuccess(SITE, 100, 200, 1000, 1000, TEST_OPTS);
        const result = recallClickSite(SITE, TEST_OPTS);
        expect(result?.successCount).toBe(3);
        expect(result?.confidence).toBe(0.85); // 0.7 + 3*0.05
    });

    it("caps confidence at 0.95", () => {
        for (let i = 0; i < 20; i++) recordClickSuccess(SITE, 100, 200, 1000, 1000, TEST_OPTS);
        const result = recallClickSite(SITE, TEST_OPTS);
        expect(result?.confidence).toBe(0.95);
    });

    it("decrements on miss, drops at 0", () => {
        recordClickSuccess(SITE, 100, 200, 1000, 1000, TEST_OPTS);
        recordClickMiss(SITE, TEST_OPTS);
        const after = recallClickSite(SITE, TEST_OPTS);
        expect(after).toBeNull();
    });

    it("rejects unnormalizable input (screen=0)", () => {
        recordClickSuccess(SITE, 100, 200, 0, 0, TEST_OPTS);
        const result = recallClickSite(SITE, TEST_OPTS);
        expect(result).toBeNull();
    });

    it("listClickSitesForWindow returns matching sites", () => {
        recordClickSuccess({ app: "A", windowTitle: "W1", elementLabel: "x" }, 100, 100, 1000, 1000, TEST_OPTS);
        recordClickSuccess({ app: "A", windowTitle: "W1", elementLabel: "y" }, 200, 200, 1000, 1000, TEST_OPTS);
        recordClickSuccess({ app: "A", windowTitle: "W2", elementLabel: "z" }, 300, 300, 1000, 1000, TEST_OPTS);
        const w1 = listClickSitesForWindow("A", "W1", TEST_OPTS);
        expect(w1.length).toBe(2);
    });

    it("stats counts sites and apps", () => {
        recordClickSuccess({ app: "A", windowTitle: "W1", elementLabel: "x" }, 100, 100, 1000, 1000, TEST_OPTS);
        recordClickSuccess({ app: "B", windowTitle: "W1", elementLabel: "x" }, 100, 100, 1000, 1000, TEST_OPTS);
        const stats = clickMemoryStats(TEST_OPTS);
        expect(stats.totalSites).toBe(2);
        expect(stats.totalApps).toBe(2);
    });

    it("clearClickMemory drops all", () => {
        recordClickSuccess(SITE, 100, 200, 1000, 1000, TEST_OPTS);
        clearClickMemory(TEST_OPTS);
        const stats = clickMemoryStats(TEST_OPTS);
        expect(stats.totalSites).toBe(0);
    });
});
