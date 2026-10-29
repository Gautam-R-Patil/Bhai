// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Evaluator-Optimizer Loop ─────────────────
// Verifies output quality before returning swarm results.
// Uses a cheap, fast model (different from generator) to score
// synthesis on completeness, accuracy, coherence, and actionability.

import { AsyncLocalStorage } from "node:async_hooks";
import { type ChatCompletionMessageParam, type LLMClient, MODELS } from "../llm.js";
import { claudeTier, selectForSynthesis } from "../model-router.js";
import type { SubAgentResult } from "./sub-agent.js";
import type { SwarmPlan } from "./swarm.js";
import { extractJSON } from "../utils/json-extract.js";
import { textGradRefine } from "./textgrad-refiner.js";
import { getDimensionValue } from "../harness/registry.js";
import { recordEvaluationScore } from "../harness/trace-store.js";

// Per-async-context trace ID — safe across concurrent channel handlers
const _evalTraceStorage = new AsyncLocalStorage<string | null>();

/** Run fn inside an async context where evaluator.ts sees traceId. */
export function runWithEvalTraceId<T>(traceId: string | null, fn: () => T): T {
    return _evalTraceStorage.run(traceId, fn);
}
function getActiveEvalTraceId(): string | null {
    return _evalTraceStorage.getStore() ?? null;
}

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

// ── Constants (tunable via Meta-Harness registry) ────────────────────────

const ACCEPT_THRESHOLD_DEFAULT = 70;
const RETRY_THRESHOLD_DEFAULT = 40;
const MAX_RETRIES_DEFAULT = 2;

function getAcceptThreshold(): number { return getDimensionValue<number>("evaluator.acceptThreshold") ?? ACCEPT_THRESHOLD_DEFAULT; }
function getRetryThreshold(): number { return getDimensionValue<number>("evaluator.retryThreshold") ?? RETRY_THRESHOLD_DEFAULT; }
function getMaxRetries(): number { return getDimensionValue<number>("evaluator.maxRetries") ?? MAX_RETRIES_DEFAULT; }

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

    const ACCEPT_THRESHOLD = getAcceptThreshold();
    const RETRY_THRESHOLD = getRetryThreshold();

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
            // Judge on a different tier than the synthesizer to avoid self-confirmation bias
            modelOverride: claudeTier(selectForSynthesis(userRequest).modelId) === "haiku" ? MODELS.SONNET : MODELS.HAIKU,
            responseFormat: "json_object",
        });

        const text = response.choices?.[0]?.message?.content || "";
        const jsonStr = extractJSON(text);
        if (!jsonStr) {
            return defaultAccept(synthesis);
        }

        const parsed = JSON.parse(jsonStr);

        // Coerce explicitly: `x || 70` turns a legitimate 0 into 70 and a
        // non-numeric string (e.g. "excellent") into NaN. Default to 70 only
        // when the value isn't a finite number.
        const rubric: EvaluationRubric = {
            completeness: clampScore(parsed.completeness),
            accuracy: clampScore(parsed.accuracy),
            coherence: clampScore(parsed.coherence),
            actionability: clampScore(parsed.actionability),
        };

        const score = Math.round(
            (rubric.completeness + rubric.accuracy + rubric.coherence + rubric.actionability) / 4
        );

        // The score sets a floor the model cannot soften (no self-confirming a low
        // score), but the model may ESCALATE on a flaw the numbers miss. Take the
        // more conservative of the two (accept < retry < replan).
        const scoreVerdict: "accept" | "retry" | "replan" =
            score >= ACCEPT_THRESHOLD ? "accept" : score >= RETRY_THRESHOLD ? "retry" : "replan";
        const RANK = { accept: 0, retry: 1, replan: 2 } as const;
        const modelVerdict = (["accept", "retry", "replan"] as const).includes(parsed.verdict)
            ? (parsed.verdict as "accept" | "retry" | "replan")
            : scoreVerdict;
        const verdict = RANK[modelVerdict] > RANK[scoreVerdict] ? modelVerdict : scoreVerdict;

        // Record to harness trace store — uses per-async-context storage (safe for concurrent channels)
        const activeTrace = getActiveEvalTraceId();
        if (activeTrace) {
            try { recordEvaluationScore(activeTrace, score); } catch { /* non-fatal */ }
        }

        // Derive the verdict from the computed score only — do NOT trust the
        // model's self-reported `verdict` field. The whole point of a separate
        // evaluator is to avoid self-confirmation; a model that scores 10/10/10/10
        // but claims "accept" must still be sent back for retry/replan.
        return {
            verdict,
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
    const MAX_RETRIES = getMaxRetries();

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

/** Coerce a rubric dimension to a 0-100 score, defaulting to 70 only when it isn't a finite number. */
export function clampScore(value: unknown): number {
    // null / undefined / "" mean the model omitted the dimension → default 70;
    // a numeric string still coerces; anything non-finite → 70.
    if (value === null || value === undefined || value === "") return 70;
    const n = Number(value);
    return clamp(Number.isFinite(n) ? n : 70, 0, 100);
}

function defaultAccept(synthesis: string): EvaluationResult {
    return {
        verdict: "accept",
        score: 70,
        rubric: { completeness: 70, accuracy: 70, coherence: 70, actionability: 70 },
        feedback: "",
    };
}

/** Same as clampScore (the name an earlier change used). */
export const rubricScore = clampScore;
