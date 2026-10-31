// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Speculative Parallel Execution ───────────
// For steps that might fail or take a long time, run 2 parallel
// sub-agents with different approaches. First successful result wins.
// Only activates for steps with historically high failure rates.

import type { LLMClient } from "../llm.js";
import { runSubAgent, type SubAgentTask, type SubAgentResult } from "./sub-agent.js";

// ── Configuration ────────────────────────────

const FAILURE_RATE_THRESHOLD = 0.3; // Only speculate when >30% historical failure
const ALTERNATIVE_APPROACH_HINTS: Record<string, string> = {
    browser: "If direct web interaction fails, try using web_search to find the information instead.",
    researcher: "If web search doesn't find what you need, try checking memory or reading local files.",
    coder: "Take the TEST-FIRST path: write a failing test that captures the requirement, then make it pass. Do NOT implement before the test exists.",
    system: "If AppleScript/automation fails, try using shell commands as an alternative.",
    general: "If your first approach doesn't work, try a completely different method.",
};

// Phase 4F: coder work is worth speculating on when the task description
// signals breadth (refactor, multi-file, architectural) even without historical
// failure data. The test-first alternative above is then raced against the
// primary (direct-patch) approach; first successful wins.
const CODER_SPECULATE_PATTERNS: RegExp[] = [
    /\brefactor\b/i,
    /\bmigrate\b/i,
    /\bacross\s+(?:multiple|several|many)\s+files?\b/i,
    /\bdesign\s+(?:a\s+)?(?:new\s+)?(?:module|system|architecture)\b/i,
    /\bport\s+.*\s+to\b/i,
    /\brewrite\b/i,
    /\bnew\s+feature\b/i,
    /\bimplement\s+.*\s+(?:from\s+scratch|end.to.end)\b/i,
];

// ── Types ────────────────────────────────────

export interface SpeculativeResult {
    result: SubAgentResult;
    approach: "primary" | "alternative";
    otherCancelled: boolean;
}

// ── Speculative Executor ─────────────────────

/**
 * Determine if a step should be executed speculatively.
 * Phase 4F: also speculate on coder steps with refactor/multi-file intent
 * regardless of historical failure rate, since the cost of a second coder
 * run is low relative to the upside of catching a wrong-approach early.
 */
export function shouldSpeculate(
    historicalFailureRate: number,
    threshold = FAILURE_RATE_THRESHOLD,
    roleHint?: string,
    descriptionHint?: string,
): boolean {
    if (historicalFailureRate > threshold) return true;
    if (roleHint === "coder" && descriptionHint && process.env.BHAI_NO_CODER_SPECULATION !== "true") {
        return CODER_SPECULATE_PATTERNS.some((p) => p.test(descriptionHint));
    }
    return false;
}

/**
 * Execute a task speculatively: run the primary and an alternative approach
 * in parallel. First successful result wins.
 */
export async function executeSpeculatively(
    llm: LLMClient,
    task: SubAgentTask,
    onProgress?: (stepId: string, msg: string) => Promise<void>,
): Promise<SpeculativeResult> {
    // Build alternative task with a different approach hint
    const hint = ALTERNATIVE_APPROACH_HINTS[task.role] || ALTERNATIVE_APPROACH_HINTS.general;
    const alternativeTask: SubAgentTask = {
        ...task,
        id: `${task.id}_alt`,
        description: `${task.description}\n\nIMPORTANT: ${hint}`,
    };

    // Create abort controllers for cancellation
    let primaryDone = false;
    let altDone = false;

    // Race the two approaches
    const primaryPromise = runSubAgent(llm, task, onProgress)
        .then(result => {
            primaryDone = true;
            return { result, approach: "primary" as const };
        });

    const altPromise = runSubAgent(llm, alternativeTask, onProgress)
        .then(result => {
            altDone = true;
            return { result, approach: "alternative" as const };
        });

    // Wait for both to complete (we can't truly cancel LLM calls,
    // but we pick the first success)
    const results = await Promise.allSettled([primaryPromise, altPromise]);

    // Find first successful result
    const successes: { result: SubAgentResult; approach: "primary" | "alternative" }[] = [];
    for (const r of results) {
        if (r.status === "fulfilled" && r.value.result.success) {
            successes.push(r.value);
        }
    }

    if (successes.length > 0) {
        // Pick the successful result (prefer primary if both succeeded)
        const winner = successes.find(s => s.approach === "primary") || successes[0];
        console.log(`[SPECULATIVE] ${task.id}: ${winner.approach} approach won (${successes.length} succeeded)`);
        return {
            result: { ...winner.result, id: task.id }, // Normalize ID back
            approach: winner.approach,
            otherCancelled: true,
        };
    }

    // Both failed — return the primary result
    const primaryFulfilled = results[0].status === "fulfilled" ? results[0] : null;
    const primaryResult = primaryFulfilled
        ? primaryFulfilled.value.result
        : { id: task.id, role: task.role, success: false as const, output: "", toolCalls: 0, durationMs: 0, estimatedCost: 0, error: "Both speculative approaches failed" };

    console.log(`[SPECULATIVE] ${task.id}: both approaches failed`);
    return {
        result: { ...primaryResult, id: task.id },
        approach: "primary",
        otherCancelled: false,
    };
}
