// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Process Reward Model ─────────────────────────
 * Step-level verification using BiRM bidirectional scoring.
 * Inspired by ThinkPRM (2025) and Skywork-o1-Open-PRM-1.5B.
 *
 * Scores each reasoning step on two dimensions:
 *   - Correctness (backward): Is this step logically sound?
 *   - Progress (forward): Does it advance toward the goal?
 *
 * Integration: Used by MCTS planner, evaluator, and metacognition.
 */

import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";

// ── Types ─────────────────────────────────────

export interface StepScore {
    stepIndex: number;
    correctness: number;  // 0-1
    progress: number;     // 0-1
    composite: number;    // BiRM combined
    isAccepted: boolean;
}

export interface TrajectoryVerdict {
    stepScores: StepScore[];
    overallReward: number;
    isValid: boolean;
    bottleneckStep: number;
    recommendation: "continue" | "backtrack" | "escalate";
}

// ── Score Steps with LLM ──────────────────────

/**
 * Score a list of reasoning steps using LLM-as-PRM.
 * Returns per-step scores (0-1).
 * Used by MCTS planner for node expansion scoring.
 */
export async function scoreStepsWithLLM(
    llm: LLMClient,
    taskDescription: string,
    steps: string[],
): Promise<number[]> {
    if (steps.length === 0) return [];

    const messages: ChatCompletionMessageParam[] = [
        {
            role: "user",
            content: `Task: ${taskDescription}

Evaluate each proposed step on a scale of 0-10 for quality (correctness + progress toward goal):

${steps.map((s, i) => `Step ${i + 1}: ${s}`).join("\n")}

Respond with ONLY the scores, one per line, as numbers 0-10:`,
        },
    ];

    try {
        const response = await llm.chat({
            messages,
            systemPrompt: "You are a Process Reward Model. Score each reasoning step 0-10. Output only numbers, one per line.",
            modelOverride: "openai/gpt-5-mini",
        });

        const content = response.choices?.[0]?.message?.content || "";
        const scores = content
            .split("\n")
            .map(line => parseFloat(line.trim()))
            .filter(n => !isNaN(n))
            .map(n => Math.min(10, Math.max(0, n)) / 10); // Normalize to 0-1

        // Pad with 0.5 if not enough scores
        while (scores.length < steps.length) scores.push(0.5);
        return scores.slice(0, steps.length);
    } catch {
        return steps.map(() => 0.5);
    }
}

/**
 * Full trajectory verification with BiRM scoring.
 * Evaluates a complete sequence of steps.
 */
export async function verifyTrajectory(
    llm: LLMClient,
    taskDescription: string,
    steps: string[],
): Promise<TrajectoryVerdict> {
    const native = loadNative();

    // Get per-step scores
    const correctnessScores = await scoreStepsWithLLM(llm, taskDescription, steps);
    const progressScores = await estimateProgress(steps);

    // Use native BiRM scoring if available
    if (native) {
        const result = native.scoreTrajectory(correctnessScores, progressScores, 0.6);

        const stepScores: StepScore[] = steps.map((_, i) => ({
            stepIndex: i,
            correctness: correctnessScores[i] || 0.5,
            progress: progressScores[i] || 0.5,
            composite: result.step_scores[i] || 0.5,
            isAccepted: (result.step_scores[i] || 0) >= 0.6,
        }));

        const verdict = native.stepVerdict(
            result.min_step_score,
            result.bottleneck_step,
            steps.length,
            0, // consecutive_low_scores
            false // already_backtracked
        );

        return {
            stepScores,
            overallReward: result.trajectory_reward,
            isValid: result.is_trajectory_valid,
            bottleneckStep: result.bottleneck_step,
            recommendation: verdict.should_escalate ? "escalate"
                : verdict.should_backtrack ? "backtrack"
                : "continue",
        };
    }

    // JS fallback
    const stepScores: StepScore[] = steps.map((_, i) => {
        const c = correctnessScores[i] || 0.5;
        const p = progressScores[i] || 0.5;
        const composite = 0.6 * c + 0.4 * p;
        return { stepIndex: i, correctness: c, progress: p, composite, isAccepted: composite >= 0.6 };
    });

    const overallReward = stepScores.reduce((sum, s) => sum + s.composite, 0) / stepScores.length;
    const minScore = Math.min(...stepScores.map(s => s.composite));
    const bottleneck = stepScores.findIndex(s => s.composite === minScore);

    return {
        stepScores,
        overallReward,
        isValid: stepScores.every(s => s.isAccepted),
        bottleneckStep: bottleneck,
        recommendation: minScore < 0.3 ? "escalate" : minScore < 0.6 ? "backtrack" : "continue",
    };
}

// ── Progress Estimation ───────────────────────

async function estimateProgress(steps: string[]): Promise<number[]> {
    // Simple heuristic: later steps in a plan are closer to completion
    return steps.map((_, i) => {
        const positionProgress = (i + 1) / steps.length;
        return 0.3 + positionProgress * 0.4; // Range 0.3-0.7
    });
}

// ── Native Module ─────────────────────────────

let _native: any = null;
let _nativeLoaded = false;

function loadNative(): any {
    if (_nativeLoaded) return _native;
    _nativeLoaded = true;
    try {
        const { createRequire } = require("node:module");
        const nativeRequire = createRequire(import.meta.url);
        const path = require("node:path");
        _native = nativeRequire(path.join(process.cwd(), "native", "index.js"));
        return _native;
    } catch { return null; }
}
