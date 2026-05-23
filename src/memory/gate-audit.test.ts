// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    __setAuditPathForTesting,
    __setRotationThresholdForTesting,
    logGateDecision,
} from "./gate-audit.js";

describe("gate-audit", () => {
    let tmpDir: string;
    let auditPath: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "atlas-gate-audit-"));
        auditPath = join(tmpDir, "memory-gate.jsonl");
        __setAuditPathForTesting(auditPath);
    });

    afterEach(() => {
        __setAuditPathForTesting(null);
        __setRotationThresholdForTesting(null);
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("writes one JSON line per call", () => {
        logGateDecision({
            decision: "reject",
            reason: "binary_blob",
            source: "tool",
            category: "auto_flush",
            content: `{"screenshot_base64":"..."}`,
        });
        logGateDecision({
            decision: "allow",
            reason: "curated_category",
            source: "user",
            category: "identity",
            content: "User name is Dheeraj",
        });

        const lines = readFileSync(auditPath, "utf8").trim().split("\n");
        expect(lines).toHaveLength(2);
        const first = JSON.parse(lines[0]);
        expect(first.decision).toBe("reject");
        expect(first.reason).toBe("binary_blob");
        expect(first.source).toBe("tool");
        expect(first.content_preview).toMatch(/^\{"screenshot_base64/);
        expect(first.content_preview.length).toBeLessThanOrEqual(100);
        expect(first.sha).toMatch(/^[0-9a-f]{16}$/);
        expect(typeof first.ts).toBe("string");
    });

    it("truncates content_preview to 100 chars", () => {
        const long = "x".repeat(500);
        logGateDecision({
            decision: "allow",
            reason: "high_importance",
            source: "user",
            category: "general",
            content: long,
        });
        const line = readFileSync(auditPath, "utf8").trim();
        const obj = JSON.parse(line);
        expect(obj.content_preview).toHaveLength(100);
    });

    it("rotates at threshold by renaming to .1", () => {
        const threshold = 500;
        __setRotationThresholdForTesting(threshold);

        const bigLine = "x".repeat(100);
        for (let i = 0; i < 10; i++) {
            logGateDecision({
                decision: "allow",
                reason: "test",
                source: "user",
                category: "general",
                content: bigLine,
            });
        }

        const rolled = `${auditPath}.1`;
        expect(existsSync(rolled)).toBe(true);
        expect(statSync(rolled).size).toBeGreaterThan(0);
        const activeSize = statSync(auditPath).size;
        const rolledSize = statSync(rolled).size;
        expect(activeSize + rolledSize).toBeGreaterThan(threshold);
    });

    it("never throws on write failure (swallowed)", () => {
        __setAuditPathForTesting("/nonexistent/dir/that/cannot/be/created/log.jsonl");
        expect(() => {
            logGateDecision({
                decision: "allow",
                reason: "test",
                source: "user",
                category: "general",
                content: "x",
            });
        }).not.toThrow();
    });
});
