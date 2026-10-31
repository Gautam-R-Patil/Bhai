// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    clearClickMemory,
    clickMemoryStats,
    closeClickMemory,
    listClickSitesForWindow,
    normalizeWindowTitle,
    recallClickSite,
    recordClickMiss,
    recordClickSuccess,
} from "../click-memory.js";

describe("normalizeWindowTitle", () => {
    it("strips notification counts and leading unsaved markers, collapses space", () => {
        expect(normalizeWindowTitle("Inbox (5) - Gmail")).toBe("Inbox - Gmail");
        expect(normalizeWindowTitle("Inbox (12) - Gmail")).toBe("Inbox - Gmail");
        expect(normalizeWindowTitle("WhatsApp (99+)")).toBe("WhatsApp");
        expect(normalizeWindowTitle("● Report - Word")).toBe("Report - Word");
    });
    it("does not collapse genuinely different windows (4-digit years stay)", () => {
        expect(normalizeWindowTitle("Report (2023)")).not.toBe(normalizeWindowTitle("Report (2024)"));
    });
});

const TEST_DB = join(tmpdir(), `bhai_click_test_${Date.now()}.db`);
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

    it("recalls across a changing notification count (same normalized window)", () => {
        // Learn on "Chat (3)", recall on "Chat (17)" — same window, different badge.
        recordClickSuccess({ app: "Chat", windowTitle: "Chat (3)", elementLabel: "Send" }, 100, 200, 1000, 1000, TEST_OPTS);
        const r = recallClickSite({ app: "Chat", windowTitle: "Chat (17)", elementLabel: "Send" }, TEST_OPTS);
        expect(r).not.toBeNull();
        expect(r?.xNorm).toBe(0.1);
        expect(r?.yNorm).toBe(0.2);
        // and a second success under yet another count bumps the SAME entry, not a new one
        recordClickSuccess({ app: "Chat", windowTitle: "Chat (1)", elementLabel: "Send" }, 100, 200, 1000, 1000, TEST_OPTS);
        expect(recallClickSite({ app: "Chat", windowTitle: "Chat", elementLabel: "Send" }, TEST_OPTS)?.successCount).toBe(2);
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

    it("recordClickMiss is atomic — update+delete in same transaction", () => {
        // Record once, then two consecutive misses. The first decrements to 0
        // and the DELETE in the same transaction must remove the row in one step.
        recordClickSuccess(SITE, 100, 200, 1000, 1000, TEST_OPTS);
        recordClickMiss(SITE, TEST_OPTS); // 1 → 0 → DELETE
        expect(recallClickSite(SITE, TEST_OPTS)).toBeNull();
        // Second miss on missing row is a no-op (no negative count).
        recordClickMiss(SITE, TEST_OPTS);
        expect(clickMemoryStats(TEST_OPTS).totalSites).toBe(0);
    });

    it("BHAI_NO_CLICK_MEMORY kill-switch makes everything a no-op", () => {
        const orig = process.env.BHAI_NO_CLICK_MEMORY;
        try {
            process.env.BHAI_NO_CLICK_MEMORY = "true";
            recordClickSuccess(SITE, 100, 200, 1000, 1000, TEST_OPTS);
            expect(recallClickSite(SITE, TEST_OPTS)).toBeNull();
            // recordClickMiss is also a no-op under the kill switch.
            recordClickMiss(SITE, TEST_OPTS);
            // Pre-populated entries should be unreadable under the kill-switch.
            process.env.BHAI_NO_CLICK_MEMORY = "false";
            recordClickSuccess(SITE, 100, 200, 1000, 1000, TEST_OPTS);
            process.env.BHAI_NO_CLICK_MEMORY = "true";
            expect(recallClickSite(SITE, TEST_OPTS)).toBeNull();
        } finally {
            if (orig === undefined) delete process.env.BHAI_NO_CLICK_MEMORY;
            else process.env.BHAI_NO_CLICK_MEMORY = orig;
        }
    });
});
