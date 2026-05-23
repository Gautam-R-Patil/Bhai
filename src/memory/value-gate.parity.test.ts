// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { hardReject } from "./value-gate.js";

describe("value-gate hardReject", () => {
    it("rejects screenshot base64 blobs", () => {
        const content = `[tool result] {"success":true,"screenshot_base64":"/9j/4AAQSkZJRg..."}`;
        const result = hardReject(content, "tool", 5, "auto_flush");
        expect(result.reject).toBe(true);
        expect(result.reason).toBe("tool_result_prefix");
    });

    it("rejects content containing screenshot_base64 key even without prefix", () => {
        const content = `{"screenshot_base64":"/9j/4AAQ..."}`;
        const result = hardReject(content, "user", 5, "general");
        expect(result.reject).toBe(true);
        expect(result.reason).toBe("binary_blob");
    });

    it("rejects content containing image_base64 key", () => {
        const content = `something with "image_base64":"abc..." embedded`;
        const result = hardReject(content, "user", 5, "general");
        expect(result.reject).toBe(true);
        expect(result.reason).toBe("binary_blob");
    });

    it("rejects WM-Spill markers", () => {
        const content = `[WM-Spill] tool_result: [os_type] {"success":true}`;
        const result = hardReject(content, "user", 4, "working_memory");
        expect(result.reject).toBe(true);
        expect(result.reason).toBe("wm_spill_marker");
    });

    it("rejects pure JSON objects", () => {
        const content = `{"foo": "bar", "n": 42}`;
        const result = hardReject(content, "tool", 5, "general");
        expect(result.reject).toBe(true);
        expect(result.reason).toBe("pure_json");
    });

    it("rejects pure JSON arrays", () => {
        const content = `[{"id":1},{"id":2}]`;
        const result = hardReject(content, "tool", 5, "general");
        expect(result.reject).toBe(true);
        expect(result.reason).toBe("pure_json");
    });

    it("rejects content longer than 2000 chars", () => {
        const content = "x".repeat(2001);
        const result = hardReject(content, "user", 5, "general");
        expect(result.reject).toBe(true);
        expect(result.reason).toBe("oversize");
    });

    it("does not reject content of exactly 2000 chars", () => {
        const content = "x".repeat(2000);
        const result = hardReject(content, "user", 5, "general");
        expect(result.reject).toBe(false);
    });

    it("does not reject short user prose", () => {
        const content = "User prefers dark mode in the desktop overlay.";
        const result = hardReject(content, "user", 5, "general");
        expect(result.reject).toBe(false);
    });

    it("does not reject malformed JSON-looking text", () => {
        const content = "{not actually json}";
        const result = hardReject(content, "user", 5, "general");
        expect(result.reject).toBe(false);
    });

    it("tool_result prefix only triggers when source is tool", () => {
        const content = "[tool result] {...}";
        const userResult = hardReject(content, "user", 5, "general");
        const toolResult = hardReject(content, "tool", 5, "general");
        expect(userResult.reject).toBe(false);
        expect(toolResult.reject).toBe(true);
    });
});

import { hardAllow } from "./value-gate.js";

describe("value-gate hardAllow", () => {
    it("allows source=reflection", () => {
        const result = hardAllow("anything", "reflection", 5, "general");
        expect(result.allow).toBe(true);
        expect(result.reason).toBe("source_reflection");
    });

    it("allows source=consolidation", () => {
        const result = hardAllow("anything", "consolidation", 5, "general");
        expect(result.allow).toBe(true);
        expect(result.reason).toBe("source_consolidation");
    });

    it("allows importance >= 8 regardless of source", () => {
        const result = hardAllow("anything", "user", 8, "general");
        expect(result.allow).toBe(true);
        expect(result.reason).toBe("high_importance");
    });

    it("allows curated category 'identity'", () => {
        const result = hardAllow("any", "user", 5, "identity");
        expect(result.allow).toBe(true);
        expect(result.reason).toBe("curated_category");
    });

    it("allows curated category 'person'", () => {
        const result = hardAllow("any", "user", 5, "person");
        expect(result.allow).toBe(true);
    });

    it("allows curated category 'session_summary'", () => {
        const result = hardAllow("any", "user", 5, "session_summary");
        expect(result.allow).toBe(true);
    });

    it("allows curated category 'knowledge_crystal'", () => {
        const result = hardAllow("any", "user", 5, "knowledge_crystal");
        expect(result.allow).toBe(true);
    });

    it("allows curated category 'recovery_reflection'", () => {
        const result = hardAllow("any", "user", 5, "recovery_reflection");
        expect(result.allow).toBe(true);
    });

    it("allows curated category 'voice'", () => {
        const result = hardAllow("any", "user", 5, "voice");
        expect(result.allow).toBe(true);
    });

    it("does not allow uncurated category with low importance", () => {
        const result = hardAllow("any", "user", 5, "general");
        expect(result.allow).toBe(false);
    });

    it("does not allow source=tool at importance 5", () => {
        const result = hardAllow("any", "tool", 5, "general");
        expect(result.allow).toBe(false);
    });
});
