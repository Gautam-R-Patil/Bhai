// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeLibrary, getToolBySlug, insertTool, openLibrary, setLifecycleState } from "../library.js";

describe("setLifecycleState", () => {
    let tmpDir: string;
    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "forge-lifecycle-"));
        openLibrary(join(tmpDir, "test.db"));
        const embedding = new Float32Array(384);
        for (let i = 0; i < 384; i++) embedding[i] = Math.sin(i * 0.01);
        insertTool({
            slug: "lc_test",
            description: "lifecycle test tool",
            schemaJson: "{}",
            handlerHash: "abc123",
            embedding,
            source: "synchronous",
            createdAt: Date.now(),
        });
    });
    afterEach(() => {
        closeLibrary();
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("default lifecycleState after insert is 'active'", () => {
        const tool = getToolBySlug("lc_test");
        expect(tool?.lifecycleState).toBe("active");
    });

    it("setLifecycleState('awaiting_approval') updates row", () => {
        setLifecycleState("lc_test", "awaiting_approval");
        const tool = getToolBySlug("lc_test");
        expect(tool?.lifecycleState).toBe("awaiting_approval");
    });

    it("setLifecycleState('archived') sets archived_at", () => {
        setLifecycleState("lc_test", "archived");
        const tool = getToolBySlug("lc_test");
        expect(tool?.lifecycleState).toBe("archived");
        expect(tool?.archivedAt).not.toBeNull();
    });

    it("setLifecycleState('active') from awaiting_approval clears approval state", () => {
        setLifecycleState("lc_test", "awaiting_approval");
        setLifecycleState("lc_test", "active");
        const tool = getToolBySlug("lc_test");
        expect(tool?.lifecycleState).toBe("active");
    });

    it("setLifecycleState throws on unknown slug", () => {
        expect(() => setLifecycleState("does_not_exist", "active")).toThrow(/unknown slug/);
    });

    it("setLifecycleState('active') from prior graduated+archived returns 'active'", () => {
        setLifecycleState("lc_test", "graduated");
        setLifecycleState("lc_test", "archived");
        setLifecycleState("lc_test", "active");
        const tool = getToolBySlug("lc_test");
        expect(tool?.lifecycleState).toBe("active");
    });

    it("setLifecycleState('graduated') from published demotes correctly", () => {
        setLifecycleState("lc_test", "published");
        setLifecycleState("lc_test", "graduated");
        const tool = getToolBySlug("lc_test");
        expect(tool?.lifecycleState).toBe("graduated");
    });
});
