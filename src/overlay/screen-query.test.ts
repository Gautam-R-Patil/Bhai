// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { _isScreenQueryForTest as isScreenQuery } from "./overlay-chat.js";

describe("isScreenQuery", () => {
    it("captures the screen for questions about it or what the user is doing", () => {
        for (const q of ["what's on my screen", "explain this", "fix it", "summarize", "what now", "what should I do?", "what's wrong?", "how do I fix", "translate to hindi"]) {
            expect(isScreenQuery(q), q).toBe(true);
        }
    });
    it("leaves plain questions alone", () => {
        for (const q of ["What's 17 times 23?", "what's the capital of France?", "how are you doing today?", "Write a haiku about monsoon rain.", "what do you think about pizza"]) {
            expect(isScreenQuery(q), q).toBe(false);
        }
    });    it("leaves a stuck report's handoff replies to the agent", () => {
        for (const q of ["retry it", "Skip it.", "I'll take over", "I’ll take over!"]) {
            expect(isScreenQuery(q), q).toBe(false);
        }
    });
});
