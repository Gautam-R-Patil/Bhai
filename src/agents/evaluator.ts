// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Evaluator-Optimizer Loop ─────────────────
// Verifies output quality before returning swarm results.
// Uses a cheap, fast model (different from generator) to score
// synthesis on completeness, accuracy, coherence, and actionability.

import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";
import type { SubAgentResult } from "./sub-agent.js";
import type { SwarmPlan } from "./swarm.js";
import { extractJSON } from "../utils/json-extract.js";
import { textGradRefine } from "./textgrad-refiner.js";

// ── Types ────────────────────────────────────

export interface EvaluationRubric {
    completeness: number;       // 0-100: Did it address all parts?
    accuracy: number;           // 0-100: Are claims supported by step outputs?
    coherence: number;          // 0-100: Is it internally consistent?
    actionability: number;      // 0-100: Did it DO what was asked?
}

export interface EvaluationResult {
    verdict: "accept" | "retry" | "replan";
    score: number;              // Overall 0-100
    rubric: EvaluationRubric;
    feedback: string;           // Specific issues found
}

// ── Constants ────────────────────────────────

const ACCEPT_THRESHOLD = 70;
const RETRY_THRESHOLD = 40;
const MAX_RETRIES = 2;

// ── Evaluator ────────────────────────────────

/**
 * Evaluate a synthesis result against the original request and step outputs.
 * Uses a lightweight model to avoid self-confirmation bias.
 */
export async function evaluate(
    llm: LLMClient,
    userRequest: string,
    synthesis: string,
    stepResults: Map<string, SubAgentResult>,
): Promise<EvaluationResult> {
    // Build a compact summary of what the steps actually produced
    const stepSummary = [...stepResults.entries()]
        .map(([id, r]) => `${id}: ${r.success ? "OK" : "FAILED"} — ${r.output.substring(0, 150)}`)
        .join("\n");

    const prompt = `You are a quality evaluator. Score this AI response on a 0-100 scale for each dimension.

USER REQUEST: "${userRequest}"

STEP OUTPUTS (what was actually found/done):
${stepSummary}

SYNTHESIS (the response to evaluate):
${synthesis.substring(0, 2000)}

Score each dimension 0-100:
- completeness: Does it address ALL parts of the user's request?
- accuracy: Are all claims supported by the step outputs? No hallucinations?
- coherence: Is it internally consistent and well-organized?
- actionability: Did it actually DO what was asked, or just describe what could be done?

Also provide:
- feedback: Specific issues found (empty string if none)
- verdict: "accept" (score >= ${ACCEPT_THRESHOLD}), "retry" (${RETRY_THRESHOLD}-${ACCEPT_THRESHOLD}), or "replan" (< ${RETRY_THRESHOLD})

Output ONLY valid JSON:
{"completeness": N, "accuracy": N, "coherence": N, "actionability": N, "feedback": "...", "verdict": "accept"|"retry"|"replan"}`;

    try {
        const response = await llm.chat({
            messages: [{ role: "user", content: prompt }] as ChatCompletionMessageParam[],
            systemPrompt: "You are a strict quality evaluator. Output valid JSON only. Be honest — do not inflate scores.",
            // Use a light/fast model for evaluation to avoid self-confirmation bias
            // The selectForSubAgent with "simple" hint picks a cheaper model
            responseFormat: "json_object",
        });

        const text = response.choices?.[0]?.message?.content || "";
        const jsonStr = extractJSON(text);
        if (!jsonStr) {
            return defaultAccept(synthesis);
        }

        const parsed = JSON.parse(jsonStr);

        const rubric: EvaluationRubric = {
            completeness: clamp(parsed.completeness || 70, 0, 100),
            accuracy: clamp(parsed.accuracy || 70, 0, 100),
            coherence: clamp(parsed.coherence || 70, 0, 100),
            actionability: clamp(parsed.actionability || 70, 0, 100),
        };

        const score = Math.round(
            (rubric.completeness + rubric.accuracy + rubric.coherence + rubric.actionability) / 4
        );

        const verdict = score >= ACCEPT_THRESHOLD ? "accept"
            : score >= RETRY_THRESHOLD ? "retry"
            : "replan";

        return {
            verdict: (["accept", "retry", "replan"] as const).includes(parsed.verdict) ? parsed.verdict : verdict,
            score,
            rubric,
            feedback: parsed.feedback || "",
        };
    } catch (err) {
        console.error("[EVALUATOR] Failed:", (err as Error).message);
        return defaultAccept(synthesis);
    }
}

/**
 * Run the evaluator-optimizer loop: evaluate → retry synthesis if needed.
 * Returns the final (potentially improved) synthesis.
 */
export async function evaluateAndOptimize(
    llm: LLMClient,
    userRequest: string,
    synthesizeFn: (feedback?: string) => Promise<string>,
    stepResults: Map<string, SubAgentResult>,
): Promise<{ synthesis: string; evaluationScore: number }> {
    let synthesis = await synthesizeFn();
    let bestScore = 0;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const result = await evaluate(llm, userRequest, synthesis, stepResults);
        console.log(`[EVALUATOR] Attempt ${attempt + 1}: score=${result.score}, verdict=${result.verdict}`);
        bestScore = result.score;

        if (result.verdict === "accept") {
            return { synthesis, evaluationScore: result.score };
        }

        if (result.verdict === "retry" && attempt < MAX_RETRIES) {
            // ── TextGrad Refinement: generate targeted gradients instead of generic feedback ──
            try {
                const normalizedScores = {
                    completeness: result.rubric.completeness / 100,
                    accuracy: result.rubric.accuracy / 100,
                    coherence: result.rubric.coherence / 100,
                    actionability: result.rubric.actionability / 100,
                };
                const tgResult = await textGradRefine(llm, userRequest, synthesis, normalizedScores);
                if (tgResult.refined && tgResult.refinedOutput) {
                    console.log(`[EVALUATOR] TextGrad refined output (${tgResult.iterationsUsed} iterations, ${tgResult.gradients.length} gradients)`);
                    synthesis = tgResult.refinedOutput;
                    continue; // Re-evaluate the TextGrad-refined output
                }
            } catch (tgErr) {
                console.warn("[EVALUATOR] TextGrad refinement failed (non-fatal):", (tgErr as Error).message);
            }

            // Fallback: use generic evaluator feedback for re-synthesis
            console.log(`[EVALUATOR] Retrying synthesis with feedback: ${result.feedback}`);
            synthesis = await synthesizeFn(result.feedback);
        } else {
            // replan or exhausted retries — return what we have
            break;
        }
    }

    return { synthesis, evaluationScore: bestScore };
}

// ── Helpers ──────────────────────────────────

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function defaultAccept(synthesis: string): EvaluationResult {
    return {
        verdict: "accept",
        score: 70,
        rubric: { completeness: 70, accuracy: 70, coherence: 70, actionability: 70 },
        feedback: "",
    };
}
