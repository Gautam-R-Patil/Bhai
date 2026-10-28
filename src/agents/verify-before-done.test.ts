// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { isVerifier, newVerifyGateState, recordToolCall, shouldForceVerify } from "./verify-before-done.js";

describe("isVerifier", () => {
    it("counts os_visual_verify only with something the tool can check", () => {
        expect(isVerifier("os_visual_verify", { expect_text: "Saved" })).toBe(true);
        expect(isVerifier("os_visual_verify", { expect_gone: "Sending…" })).toBe(true);
        expect(isVerifier("os_visual_verify", { expected_text: "Saved" })).toBe(true); // alias the tool accepts
        expect(isVerifier("os_visual_verify", { expected_element: "Save button" })).toBe(false); // the tool can't check this
        expect(isVerifier("os_visual_verify", {})).toBe(false);
    });

    it("a look after the last action covers it; an action after a check needs a new one", () => {
        const g = newVerifyGateState();
        recordToolCall(g, "os_type", { text: "128*46" });
        recordToolCall(g, "os_screenshot", {});
        expect(shouldForceVerify(g)).toBe(false);
        recordToolCall(g, "os_smart_click", { instruction: "Send" });
        expect(shouldForceVerify(g)).toBe(true);
        recordToolCall(g, "os_screenshot", {}, true); // failed capture doesn't count
        expect(shouldForceVerify(g)).toBe(true);
    });
});
