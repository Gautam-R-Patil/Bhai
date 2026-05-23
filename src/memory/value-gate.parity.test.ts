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
