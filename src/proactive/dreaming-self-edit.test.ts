// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Regression test: self-edit proposal must NOT surface to the user ──
// Screenshot 2026-05-03 showed ATLAS telling the user "Suggested instruction
// edit: …" as part of the morning briefing. The user's directive: the agent
// should improve ITSELF, not ask the user to apply suggestions. This test
// guards the fix so the regression can't creep back.

import { describe, expect, it } from "vitest";
import {
    _recordSelfEditActuation,
    _selfEditIsUserFacing,
    _formatSelfEditForAudit,
} from "./dreaming-self-edit.js";

describe("self-edit actuation", () => {
    it("_selfEditIsUserFacing — 'Self-improvement proposal' task labels are NOT user-facing", () => {
        // The specific label the screenshot showed
        expect(_selfEditIsUserFacing("Self-improvement proposal")).toBe(false);
    });

    it("_selfEditIsUserFacing — 'Suggested instruction edit' content is NOT user-facing", () => {
        expect(
            _selfEditIsUserFacing("anything", "Suggested instruction edit: foo"),
        ).toBe(false);
    });

    it("_selfEditIsUserFacing — real actuated tasks ARE user-facing", () => {
        expect(_selfEditIsUserFacing("Memory consolidation")).toBe(true);
        expect(_selfEditIsUserFacing("Goal proposals")).toBe(true);
    });

    it("_formatSelfEditForAudit — produces a timestamped line for the audit log", () => {
        const line = _formatSelfEditForAudit({
            targetFile: "convex://system_prompts/rules",
            originalSnippet: "old rule",
            editedSnippet: "new rule",
            reason: "avoids hallucinated tool calls",
            applied: false,
        });
        expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
        expect(line).toContain("convex://system_prompts/rules");
        expect(line).toContain("avoids hallucinated tool calls");
        expect(line).toContain("applied=false");
    });

    it("_formatSelfEditForAudit — escapes CR so attacker can't forge a new log row with \\r", () => {
        const line = _formatSelfEditForAudit({
            targetFile: "x\rinjected=true",
            originalSnippet: "a",
            editedSnippet: "b",
            reason: "r",
            applied: false,
        });
        expect(line).not.toContain("\r");
        expect(line).toContain("\\r");
    });

    it("_formatSelfEditForAudit — escapes backslash BEFORE other chars so \\n in input stays \\\\n", () => {
        const line = _formatSelfEditForAudit({
            targetFile: "x",
            originalSnippet: "a",
            editedSnippet: "b",
            reason: "raw backslash-n then newline: \\n\nafter",
            applied: false,
        });
        // The literal backslash in input must NOT be merged with the
        // subsequent escape of the newline into a single "\n" substring
        // that decodes back to a newline on read.
        // Expect the literal '\' to become '\\' and then the real \n → '\n'.
        expect(line).toContain("\\\\n\\nafter");
    });

    it("_formatSelfEditForAudit — stays under PIPE_BUF=512 (macOS) even on pathological inputs", () => {
        // Worst case for the escape expansion: a field full of `\r` chars
        // (1 byte → 2 bytes after escape) or `\\` (1 byte → 2 bytes for
        // the backslash-double, ×2 again if it contains another escape).
        const pathological = "\r".repeat(10_000);
        const line = _formatSelfEditForAudit({
            targetFile: pathological,
            originalSnippet: pathological,
            editedSnippet: pathological,
            reason: pathological,
            applied: false,
        });
        // macOS guarantees atomicity up to PIPE_BUF=512.
        expect(line.length).toBeLessThan(512);
        expect(line).toContain("…[truncated]");
    });

    it("_formatSelfEditForAudit — single-line (no embedded newlines) so the log is grep-friendly", () => {
        const line = _formatSelfEditForAudit({
            targetFile: "x",
            originalSnippet: "a\nb\nc",
            editedSnippet: "d\ne",
            reason: "multi\nline\nreason",
            applied: true,
        });
        expect(line.split("\n").length).toBe(1);
    });

    it("_recordSelfEditActuation — returns a self-lesson memory content string", () => {
        const content = _recordSelfEditActuation({
            targetFile: "convex://system_prompts/rules",
            originalSnippet: "NEVER GIVE UP",
            editedSnippet: "when a command fails, diagnose before retrying",
            reason: "prevents retry loops on permanent failures",
            applied: false,
        });
        // The stored memory must be useful as a prompt anchor — the NEXT
        // turn's recall injects this and the agent sees the lesson.
        expect(content).toContain("lesson");
        expect(content).toContain("prevents retry loops");
        expect(content).toContain("when a command fails, diagnose");
        // Must NOT read like a user-directed suggestion
        expect(content.toLowerCase()).not.toContain("you should");
        expect(content.toLowerCase()).not.toContain("suggested");
    });
});
