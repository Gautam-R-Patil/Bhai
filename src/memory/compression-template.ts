// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Structured conversation-compression template ─────────────
 * Replaces the one-line "summarize concisely" prompt with a structured,
 * section-based template so a pruned summary preserves the load-bearing state
 * (active task verbatim, numbered completed actions, exact errors, decisions,
 * pending asks, files). Pure string builders + a parse helper — no LLM, no I/O.
 * The prune call that consumes these is unchanged (same single call, same model).
 */

export const END_OF_CONTEXT_MARKER = "--- END OF CONTEXT SUMMARY ---";

export const COMPRESSION_SYSTEM_PROMPT =
    "You are a precise context compressor for a long-running agent. Produce a STRUCTURED summary that another agent will rely on to continue the work with NO access to the original transcript. " +
    "Preserve load-bearing detail; drop chatter. Never invent facts. Use EXACTLY the section headers given, in order. Keep error text and the active task VERBATIM.";

// The 13-section template the model is asked to fill. Headers are fixed so the
// next iterative pass can parse + extend (e.g. continue numbering Completed Actions).
const SECTIONS = [
    "## Active Task (verbatim)",
    "## Goal",
    "## Completed Actions (numbered, with tool names)",
    "## In-Progress",
    "## Active State (cwd / branch / modified files / test status)",
    "## Blocked (exact error text, verbatim)",
    "## Key Decisions",
    "## Pending User Asks",
    "## Relevant Files",
    "## Remaining Work",
];

export function buildCompressionUserPrompt(
    transcript: string,
    priorSummary: string | null = null,
    focusTopic?: string,
): string {
    const parts: string[] = [];
    if (priorSummary) {
        parts.push(
            "A PRIOR structured summary of earlier context follows. CONTINUE it: keep its numbered Completed Actions and append new ones, migrate finished In-Progress items into Completed Actions, and update each section — do not restart numbering or drop prior facts.\n\n" +
                priorSummary,
        );
    }
    if (focusTopic) {
        parts.push(
            `FOCUS: weight detail toward "${focusTopic}", but never drop the Active Task, Blocked errors, or Pending User Asks.`,
        );
    }
    parts.push(
        `Compress the conversation below into EXACTLY these sections (omit a section's body only if genuinely empty, but keep the header):\n${SECTIONS.join("\n")}\n\nEnd your output with the line: ${END_OF_CONTEXT_MARKER}`,
    );
    parts.push(`\nCONVERSATION:\n${transcript}`);
    return parts.join("\n\n");
}

// Highest N in the numbered "Completed Actions" list, so the next pass can
// continue the numbering instead of cold-restarting. 0 when none found.
export function extractLastCompletedIndex(summary: string): number {
    if (!summary) return 0;
    const section = summary.split(/^##\s+/m).find((s) => /^Completed Actions/i.test(s));
    if (!section) return 0;
    let max = 0;
    for (const m of section.matchAll(/^\s*(\d+)[.)]\s/gm)) {
        const n = Number.parseInt(m[1], 10);
        if (Number.isFinite(n) && n > max) max = n;
    }
    return max;
}
