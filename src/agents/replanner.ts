// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Replanner ────────────────────────────────
// Analyzes intermediate results after each mesh wave and decides whether
// the remaining plan should be revised. This is the "plan-and-execute with
// replanning" pattern — the #1 most validated multi-agent orchestration pattern.

import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";
import { selectForPlanning } from "../model-router.js";
import type { MeshStep } from "./mesh.js";
import type { SubAgentResult, AgentRole } from "./sub-agent.js";
import { extractJSON } from "../utils/json-extract.js";

// ── Types ────────────────────────────────────

export interface ReplanDecision {
    action: "continue" | "replan" | "abort";
    reason: string;
    revisedSteps?: MeshStep[];
}

// ── Heuristic: Should We Replan? ─────────────

/** Fast check (no LLM call) to decide if replanning is worth considering. */
export function shouldConsiderReplan(
    waveResults: SubAgentResult[],
    completedCount: number,
    totalSteps: number,
): boolean {
    // Any step failure in this wave
    if (waveResults.some(r => !r.success)) return true;

    // Step output contains signals suggesting plan invalidation
    const invalidationSignals = /\b(not found|doesn't exist|no longer|deprecated|404|moved|changed|unavailable)\b/i;
    if (waveResults.some(r => invalidationSignals.test(r.output))) return true;

    // More than half of total steps completed — good checkpoint to re-evaluate
    if (completedCount >= totalSteps * 0.5 && completedCount < totalSteps) return true;

    return false;
}

// ── LLM-Based Replanning ─────────────────────

/**
 * Ask the LLM whether to continue, revise, or abort the remaining plan.
 * Only called when shouldConsiderReplan returns true.
 */
export async function replan(
    llm: LLMClient,
    originalRequest: string,
    completedResults: Map<string, SubAgentResult>,
    remainingSteps: MeshStep[],
): Promise<ReplanDecision> {
    // Build compact summary of completed results
    const completedSummary = [...completedResults.entries()]
        .map(([id, r]) => {
            const status = r.success ? "SUCCESS" : "FAILED";
            const output = r.output.substring(0, 200);
            return `- ${id} (${r.role}): [${status}] ${output}`;
        })
        .join("\n");

    const remainingSummary = remainingSteps
        .map(s => `- ${s.id} (${s.role}): ${s.description} [deps: ${s.depends_on.join(", ") || "none"}]`)
        .join("\n");

    const prompt = `You are reviewing the progress of a multi-step task.

ORIGINAL REQUEST: "${originalRequest}"

COMPLETED STEPS:
${completedSummary}

REMAINING PLAN:
${remainingSummary}

Based on the completed results, decide:
1. "continue" — the remaining plan is still valid, proceed as-is
2. "replan" — some remaining steps need to be revised, added, or removed based on what we learned
3. "abort" — the task cannot be completed or is already done

If you choose "replan", provide revised remaining steps as JSON (same format: id, role, description, depends_on).
Only revise steps that need changing. Keep IDs consistent with the original plan.

Output ONLY valid JSON:
{"action": "continue"|"replan"|"abort", "reason": "...", "revisedSteps": [...]}`;

    try {
        const response = await llm.chat({
            messages: [{ role: "user", content: prompt }] as ChatCompletionMessageParam[],
            systemPrompt: "You are a task plan reviewer. Output valid JSON only.",
            modelOverride: selectForPlanning(originalRequest).modelId,
        });

        const text = response.choices?.[0]?.message?.content || "";
        const jsonStr = extractJSON(text);
        if (!jsonStr) return { action: "continue", reason: "Could not parse replan response" };

        const parsed = JSON.parse(jsonStr);
        const action = (["continue", "replan", "abort"] as const).includes(parsed.action)
            ? parsed.action
            : "continue";

        if (action === "replan" && Array.isArray(parsed.revisedSteps)) {
            const validRoles: AgentRole[] = ["researcher", "coder", "browser", "system", "general"];
            const revisedSteps: MeshStep[] = parsed.revisedSteps
                .filter((s: any) => s.id && s.description)
                .map((s: any) => ({
                    id: s.id,
                    role: validRoles.includes(s.role) ? s.role : "general",
                    description: s.description,
                    depends_on: Array.isArray(s.depends_on) ? s.depends_on : [],
                }));

            return {
                action: "replan",
                reason: parsed.reason || "Plan revised based on intermediate results",
                revisedSteps,
            };
        }

        return { action, reason: parsed.reason || "No reason provided" };
    } catch (err) {
        console.error("[REPLANNER] Failed:", (err as Error).message);
        return { action: "continue", reason: "Replan failed — continuing with original plan" };
    }
}
