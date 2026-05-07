// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { isTriviallyDirectExecutable } from "./swarm-gate.js";

describe("isTriviallyDirectExecutable — swarm direct-execute gate", () => {
    describe("rejects (direct-execute)", () => {
        it.each([
            "play the weeknd",
            "fix the typo in readme",
            "check my calendar",
            "open chrome",
            "set dark mode",
            "what's the weather",
            "send dad a message",
            "install node",
        ])("`%s` → direct-execute", (task) => {
            expect(isTriviallyDirectExecutable(task)).toBe(true);
        });
    });

    describe("allows swarm (complex)", () => {
        it.each([
            "research the topic and also write a script for it",
            "meanwhile play music and set my laptop to dark mode",
            "check calendar, write a summary email, and schedule the follow-up",
            "Search for recent news about the climate summit, summarize the key findings, and write a brief report based on what you find",
            "additionally, archive all unread emails",
        ])("`%s` → allow swarm", (task) => {
            expect(isTriviallyDirectExecutable(task)).toBe(false);
        });
    });

    it("returns false for empty string (safe: don't rewrite empty as direct)", () => {
        expect(isTriviallyDirectExecutable("")).toBe(false);
    });

    it("multi-clause 'and also' bypasses word-count limit", () => {
        // only 8 words with 'and also'
        expect(isTriviallyDirectExecutable("fix typo and also bump version")).toBe(false);
    });

    it("long single-verb task (>=8 words) is NOT direct-execute", () => {
        // Long + single-verb: agent likely needs real reasoning, not swarm but not trivial gate either
        expect(isTriviallyDirectExecutable("write me a detailed essay about climate change impacts")).toBe(false);
    });
});
