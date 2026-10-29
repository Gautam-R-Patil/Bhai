// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Swarm Orchestrator ────────────────────────
// Decomposes complex tasks into sub-agent steps, executes them via
// the Mesh engine, and synthesizes results into a final answer.

import { getDimensionValue } from "../harness/registry.js";
import type { ChatCompletionMessageParam, LLMClient } from "../llm.js";
import { generateCounterfactual } from "../memory/counterfactual.js";
import { getMemoryInformedContext } from "../memory/memory-informed-planning.js";
import { getTaskLearningsContext } from "../memory/task-learnings.js";
import { selectForPlanning, selectForSynthesis } from "../model-router.js";
import { createHierarchicalPlan } from "../planning/hierarchical-planner.js";
import { verifyReasoning } from "../planning/logic-verifier.js";
import { runMCTSPlanning } from "../planning/mcts-planner.js";
import { checkConsent } from "../security/consent.js";
import { maybeCreateSkill, type ToolCallRecord } from "../skills/auto-skill-creator.js";
import { extractJSON } from "../utils/json-extract.js";
import { runCodeCriticIfCoder } from "./code-critic.js";
import { classifyComplexity } from "./complexity-classifier.js";
import { findTemplates, formatTemplateHint, saveTemplate } from "./decomposition-library.js";
import { evaluateAndOptimize } from "./evaluator.js";
import { executeMesh, type MeshResult, type MeshStep } from "./mesh.js";
import { shouldUseMoA, synthesizeWithMoA } from "./mixture.js";
import { runMultiCriticDebate } from "./multi-critic.js";
import { replan, shouldConsiderReplan } from "./replanner.js";
import type { AgentRole, SubAgentResult } from "./sub-agent.js";
import {
    currentSwarmRun,
    currentSwarmStep,
    isPaymentHold,
    runWideGrant,
    type SwarmRunContext,
    swarmConsentKey,
    withSwarmRun,
} from "./swarm-context.js";

// ── Types ─────────────────────────────────────

export interface SwarmPlan {
    steps: MeshStep[];
    reasoning: string; // Why this decomposition was chosen
}

export interface SwarmResult {
    plan: SwarmPlan;
    synthesis: string; // Final synthesized answer
    totalDurationMs: number;
    stepsCompleted: number;
    stepsFailed: number;
    evaluationScore?: number; // Quality score from evaluator (#7)
    replanned?: boolean; // Whether the plan was revised mid-execution (#6)
    totalEstimatedCost?: number; // Total estimated cost (#16)
    /** Steps that are NOT done because they need the owner's approval. */
    needsApproval?: string[];
    /** Side-effecting tool calls the swarm's tool gate did not run (tool + target). */
    blocked?: string[];
    /** Payments a sub-agent tried: never made in a swarm; the main agent makes them after the owner's OK. */
    paymentsNotMade?: string[];
    /** Every step's result (a held-back run is resumed from these). */
    stepResults?: Map<string, SubAgentResult>;
}

// ── Constants ─────────────────────────────────

const MAX_STEPS = 20;
const STEP_TIMEOUT_MS = 300000; // 5 minutes per step
const MAX_SYNTH_STEP_CHARS = 4000; // per-step output cap in the synthesis prompt

/**
 * Hierarchical planning, logic verification and MCTS refinement cost ~25 LLM
 * calls before any step runs and only add hint text. Opt-in.
 */
function deepPlanningEnabled(): boolean {
    return process.env.ATLAS_SWARM_DEEP_PLANNING === "true";
}

/** Head + tail cap so one huge step output can't blow up the synthesis prompt. */
export function capStepOutput(output: string, max = MAX_SYNTH_STEP_CHARS): string {
    if (output.length <= max) return output;
    const half = Math.floor(max / 2);
    return `${output.slice(0, half)}\n…[${output.length - 2 * half} chars omitted]…\n${output.slice(-half)}`;
}

// ── Main Entry Point ─────────────────────────

/**
 * Run the full swarm pipeline:
 * 1. Decompose the task into a plan (using PRO model)
 * 2. Execute the plan via the Mesh engine
 * 3. Synthesize all results into a final answer
 */
export async function runSwarm(
    llm: LLMClient,
    userRequest: string,
    onProgress?: (msg: string) => Promise<void>,
    /** swarm_task's `confirmed`: the owner said yes to this exact task (checked by security/consent.ts). */
    confirmed = false,
): Promise<SwarmResult> {
    // The run context the tool gate reads (swarm-context.ts). Consent is checked
    // once, now, while the owner's yes is still their latest message; a grant is
    // consumed. It resumes the run that asked: only the steps held back for the
    // owner (and the steps built on them) run again, with the owner's OK, so
    // nothing that already ran is repeated. A swarm started inside a swarm step
    // inherits that step's approval and hands its blocked calls up to it.
    const outer = currentSwarmRun();
    const outerStep = currentSwarmStep();
    const consentKey = outer?.consentKey ?? swarmConsentKey(userRequest);
    let run: SwarmRunContext;
    let resume: HeldRun | undefined;
    if (outer) {
        run = {
            consentKey,
            consentGranted: !!outerStep?.stepApproved || runWideGrant(outer),
            blocked: [],
        };
    } else {
        const granted = confirmed && checkConsent(consentKey, true) === "granted";
        const held = heldRuns.get(consentKey);
        // A confirmed call without the owner's new yes runs nothing: re-running from
        // scratch would repeat every finished step and end at the same hold.
        if (confirmed && !granted && held) {
            console.log("[SWARM] ✋ confirmed re-run without the owner's yes — nothing run");
            return {
                plan: held.plan,
                synthesis:
                    "Nothing was run: the owner has not said yes in a new message since being asked. The steps that need approval are still not done.",
                totalDurationMs: 0,
                stepsCompleted: [...held.results.values()].filter((r) => r.success).length,
                stepsFailed: 0,
                needsApproval: held.plan.steps
                    .filter((s) => held.results.get(s.id)?.needsApproval)
                    .map((s) => s.description),
                stepResults: held.results,
            };
        }
        resume = granted ? held : undefined;
        const approvedSteps = new Set(
            resume ? [...resume.results].filter(([, r]) => r.needsApproval).map(([id]) => id) : [],
        );
        run = { consentKey, consentGranted: granted, blocked: [], approvedSteps };
    }
    const result = await withSwarmRun(run, () => runSwarmSteps(llm, userRequest, onProgress, resume));
    if (outer) {
        for (const b of run.blocked) outer.blocked.push({ ...b, step: outerStep?.stepId });
    } else {
        heldRuns.delete(consentKey);
        if (result.needsApproval?.length && result.stepResults) {
            if (heldRuns.size >= 50) heldRuns.delete(heldRuns.keys().next().value as string);
            heldRuns.set(consentKey, { plan: result.plan, results: result.stepResults });
        }
        // Ask the owner once, now that swarm_task is about to tell them what was
        // held (gate holds and Telegram asks that timed out alike). Only a yes
        // sent after this grants the confirmed re-run, never one sent mid-run.
        // A refused payment isn't asked for here: the main agent asks for it itself.
        if (result.needsApproval?.length || run.blocked.some((b) => !isPaymentHold(b))) checkConsent(consentKey, false);
    }
    const summaries = (payments: boolean) => [
        ...new Set(run.blocked.filter((b) => isPaymentHold(b) === payments).map((b) => b.summary)),
    ];
    const blocked = summaries(false);
    const paymentsNotMade = summaries(true);
    return {
        ...result,
        ...(blocked.length > 0 ? { blocked } : {}),
        ...(paymentsNotMade.length > 0 ? { paymentsNotMade } : {}),
    };
}

interface HeldRun {
    plan: SwarmPlan;
    results: Map<string, SubAgentResult>;
}
// Runs that ended with steps held for the owner, by consent key: the confirmed
// re-run resumes them instead of planning and running everything again.
// ponytail: in memory; after a restart the consent ask is gone too (security/consent.ts).
const heldRuns = new Map<string, HeldRun>();

/** @internal — tests only. */
export function _resetHeldRuns(): void {
    heldRuns.clear();
}

/**
 * The steps a confirmed re-run runs again: the held ones, ones that failed or
 * never ran, and ones built on any of those, except steps the owner declined
 * and steps that already had side effects (a re-run would repeat them).
 */
export function stepsToResume(steps: MeshStep[], results: Map<string, SubAgentResult>): MeshStep[] {
    const clean = (id: string) => !results.get(id)?.declined && !results.get(id)?.mutatorsRan?.length;
    const rerun = new Set(
        steps
            .filter((s) => {
                const r = results.get(s.id);
                return r?.needsApproval || (!r?.success && clean(s.id));
            })
            .map((s) => s.id),
    );
    let changed = true;
    while (changed) {
        changed = false;
        for (const s of steps) {
            if (rerun.has(s.id) || !clean(s.id) || !s.depends_on.some((d) => rerun.has(d))) continue;
            rerun.add(s.id);
            changed = true;
        }
    }
    return steps.filter((s) => rerun.has(s.id));
}

async function runSwarmSteps(
    llm: LLMClient,
    userRequest: string,
    onProgress?: (msg: string) => Promise<void>,
    resume?: HeldRun,
): Promise<SwarmResult> {
    const startTime = Date.now();

    // ── Step 1: Decompose (with hierarchical planning for highly complex tasks) ──
    // A resumed run keeps the plan the owner was told about.
    let plan: SwarmPlan | null = resume
        ? { ...resume.plan, steps: resume.plan.steps.map((st) => ({ ...st, depends_on: [...st.depends_on] })) }
        : null;
    if (resume) console.log("[SWARM] ▶️ Resuming the steps held for the owner's OK");
    else {
        console.log("[SWARM] 🐝 Starting swarm decomposition...");
        if (onProgress) await onProgress("🐝 planning task breakdown…").catch(() => {});
    }

    // For high-complexity tasks, use hierarchical planning
    try {
        const complexity = classifyComplexity(userRequest);
        if (!plan && deepPlanningEnabled() && complexity.score > 0.7) {
            console.log(`[SWARM] 🏗️ High complexity (${complexity.score.toFixed(2)}) — using hierarchical planner`);
            const hierPlan = await createHierarchicalPlan(llm, userRequest);
            if (hierPlan.abstractGoals.length > 0) {
                // Convert hierarchical plan into flat MeshSteps
                const flatSteps: MeshStep[] = [];
                for (const goal of hierPlan.abstractGoals) {
                    for (const step of goal.subGoals) {
                        const role =
                            goal.skillType === "search"
                                ? "researcher"
                                : goal.skillType === "code"
                                  ? "coder"
                                  : goal.skillType === "browse"
                                    ? "browser"
                                    : goal.skillType === "communicate"
                                      ? "general"
                                      : "general";
                        flatSteps.push({
                            id: step.id,
                            role: role as AgentRole,
                            description: `[${goal.description}] ${step.description}`,
                            depends_on: step.dependsOn,
                        });
                    }
                }
                if (flatSteps.length > 0) {
                    plan = {
                        steps: flatSteps.slice(0, MAX_STEPS),
                        reasoning: `Hierarchical plan: ${hierPlan.abstractGoals.length} goals, ${hierPlan.totalSteps} steps (complexity: ${hierPlan.estimatedComplexity}/10)`,
                    };
                    console.log(
                        `[SWARM] 🏗️ Hierarchical plan: ${hierPlan.abstractGoals.length} goals → ${flatSteps.length} steps`,
                    );
                }
            }
        }
    } catch (hpErr) {
        console.warn("[SWARM] Hierarchical planner failed (non-fatal):", (hpErr as Error).message);
    }

    // Fall back to standard decomposition
    if (!plan) {
        plan = await decompose(llm, userRequest);
    }

    if (!plan || plan.steps.length === 0) {
        return {
            plan: { steps: [], reasoning: "Task too simple for swarm — will be handled directly." },
            synthesis: "",
            totalDurationMs: Date.now() - startTime,
            stepsCompleted: 0,
            stepsFailed: 0,
        };
    }

    console.log(`[SWARM] 📋 Plan: ${plan.steps.length} steps — ${plan.reasoning}`);
    for (const step of plan.steps) {
        const deps = step.depends_on.length > 0 ? ` (after: ${step.depends_on.join(", ")})` : " (no deps)";
        console.log(`  → ${step.id} [${step.role}]: ${step.description}${deps}`);
    }

    // ── Logic Verification: check plan consistency before execution ──
    if (!resume && deepPlanningEnabled()) {
        try {
            const stepDescriptions = plan.steps.map((s) => `${s.id} [${s.role}]: ${s.description}`);
            const conclusion = `Task "${userRequest}" will be completed via ${plan.steps.length} steps`;
            const verification = await verifyReasoning(llm, stepDescriptions, conclusion);
            if (!verification.isConsistent) {
                console.warn(
                    `[SWARM] ⚠️ Logic verifier found inconsistencies (soundness: ${verification.soundnessScore.toFixed(2)}):`,
                );
                for (const issue of verification.issues.slice(0, 3)) {
                    console.warn(`  - ${issue}`);
                }
                // Optionally re-decompose if soundness is critically low
                if (verification.soundnessScore < 0.3) {
                    console.log(`[SWARM] 🔄 Soundness critically low — re-decomposing...`);
                    const revisedPlan = await decompose(
                        llm,
                        `${userRequest}\n\nIMPORTANT: A previous plan had logical issues: ${verification.issues.slice(0, 2).join("; ")}. Avoid these.`,
                    );
                    if (revisedPlan && revisedPlan.steps.length > 0) {
                        plan.steps = revisedPlan.steps;
                        plan.reasoning = revisedPlan.reasoning + " (revised after logic verification)";
                    }
                }
            } else {
                console.log(
                    `[SWARM] ✅ Logic verification passed (soundness: ${verification.soundnessScore.toFixed(2)})`,
                );
            }
        } catch (lvErr) {
            console.warn("[SWARM] Logic verification failed (non-fatal):", (lvErr as Error).message);
        }
    }

    if (onProgress) {
        await onProgress(`📋 plan: ${plan.steps.length} steps`).catch(() => {});
    }

    // ── Step 2: Execute via Mesh (with replanning) (#6) ──
    let replanned = false;
    let replanCount = 0;
    const MAX_REPLANS = 3;

    // Execute mesh — replanning happens internally via the replan callback
    const meshResult = resume
        ? await resumeMesh(llm, plan.steps, resume.results, onProgress)
        : await executeMesh(llm, plan.steps, onProgress, STEP_TIMEOUT_MS);
    // The owner's OK covered the held steps of this wave only: a held step that
    // didn't get to run, or a replanned step reusing its id, is gated again.
    currentSwarmRun()?.approvedSteps?.clear();

    // Post-execution replan loop: on failures, ask the LLM whether to revise.
    // If it returns revisedSteps, run another mesh wave on those and merge
    // results back. Capped at MAX_REPLANS to bound cost.
    // Results of the steps currently in the plan (replaced steps drop out).
    const planResults = (): SubAgentResult[] =>
        plan.steps.map((s) => meshResult.results.get(s.id)).filter((r): r is SubAgentResult => !!r);
    // Steps the replanner already saw and left alone are reported, not replanned again.
    const settled = new Set<string>();
    while (replanCount < MAX_REPLANS) {
        // Steps the owner declined or must approve are reported, never replanned.
        const waveResults = planResults().filter((r) => !notRunByOwner(r) && !settled.has(r.id));
        const stepsCompleted = waveResults.filter((r) => r.success).length;
        const stepsFailed = waveResults.filter((r) => !r.success).length;
        if (stepsFailed === 0) break;
        if (!shouldConsiderReplan(waveResults, stepsCompleted, plan.steps.length)) break;

        // What still needs doing: steps that failed or never ran.
        const remaining = plan.steps.filter((s) => {
            const r = meshResult.results.get(s.id);
            return !r?.success && !notRunByOwner(r) && !settled.has(s.id);
        });
        if (remaining.length === 0) break;
        let decision;
        try {
            decision = await replan(llm, userRequest, meshResult.results, remaining);
        } catch {
            break; // Replanner itself failed — stop retrying
        }

        if (decision.action === "abort") {
            console.log(`[SWARM] 🛑 Replanner recommends abort: ${decision.reason}`);
            break;
        }
        const ownerBlocked = new Set(
            plan.steps.filter((s) => notRunByOwner(meshResult.results.get(s.id))).map((s) => s.id),
        );
        const revisedSteps = (decision.revisedSteps ?? []).filter((s) => !ownerBlocked.has(s.id));
        if (decision.action === "continue" || revisedSteps.length === 0) {
            console.log(`[SWARM] 🔄 Replanner: ${decision.action} — ${decision.reason}`);
            break;
        }

        replanCount++;
        replanned = true;
        console.log(`[SWARM] 🔄 Replan #${replanCount}: ${revisedSteps.length} revised step(s) — ${decision.reason}`);
        if (onProgress) {
            await onProgress(`🔄 replanning: ${revisedSteps.length} new step(s)`).catch(() => {});
        }

        const priorSteps = plan.steps;
        const next = planAfterReplan(priorSteps, meshResult.results, remaining, revisedSteps);
        plan.steps = next.steps;
        for (const id of next.settled) settled.add(id);

        try {
            const revisedResult = await executeMesh(llm, next.wave, onProgress, STEP_TIMEOUT_MS, {
                results: meshResult.results,
                steps: priorSteps,
            });
            // Merge: revised wave results override any same-id earlier results,
            // new IDs are added. meshResult.totalDurationMs / parallelGroups
            // accumulate across waves.
            for (const [id, r] of revisedResult.results) meshResult.results.set(id, r);
            meshResult.totalDurationMs += revisedResult.totalDurationMs;
            meshResult.parallelGroups += revisedResult.parallelGroups;
        } catch (meshErr) {
            console.warn(`[SWARM] Replanned mesh execution failed (non-fatal): ${(meshErr as Error).message}`);
            break;
        }
    }

    const finalWaveResults = planResults();
    const stepsCompleted = finalWaveResults.filter((r) => r.success).length;
    const stepsFailed = finalWaveResults.filter((r) => !r.success).length;
    console.log(
        `[SWARM] 📊 Mesh complete: ${stepsCompleted} succeeded, ${stepsFailed} failed, ${meshResult.parallelGroups} waves, ${(meshResult.totalDurationMs / 1000).toFixed(1)}s${replanCount > 0 ? `, ${replanCount} replan(s)` : ""}`,
    );

    // ── Step 3: Synthesize with evaluation (#7) ──
    if (onProgress) await onProgress("🧩 synthesizing results…").catch(() => {});

    let { synthesis, evaluationScore } = await evaluateAndOptimize(
        llm,
        userRequest,
        async (feedback?: string) => {
            return synthesize(llm, userRequest, plan, meshResult.results, feedback);
        },
        meshResult.results,
    );

    // Wall-clock budget for the optional post-synthesis polish stages
    // (code-critic, multi-critic, MoA). Each stage checks remaining time
    // and is skipped if the budget is exhausted. Keeps total swarm
    // latency bounded when any individual stage goes slow.
    const POST_SYNTHESIS_BUDGET_MS = Math.max(5000, Number(process.env.ATLAS_POST_SYNTHESIS_BUDGET_MS) || 90_000);
    const postSynthesisDeadline = Date.now() + POST_SYNTHESIS_BUDGET_MS;
    const budgetLeft = (): boolean => Date.now() < postSynthesisDeadline;

    // ── Code-Aware Critic: deterministic compile/lint/test checks when plan includes coder steps ──
    // Runs in parallel before the LLM multi-critic so cheap, objective signals fire first.
    // Returns null (skip) when no coder steps exist or ATLAS_NO_CODE_CRITIC=true.
    if (budgetLeft()) {
        if (onProgress) await onProgress("🧪 code critic…").catch(() => {});
        try {
            const planRoles = plan.steps.map((s) => s.role);
            const codeReflection = await runCodeCriticIfCoder(planRoles, userRequest);
            if (codeReflection && codeReflection.key_issues.length > 0) {
                console.log(
                    `[SWARM] 🧪 Code critic: score ${codeReflection.overall_score}, ${codeReflection.key_issues.length} issues`,
                );
                if (codeReflection.should_retry && codeReflection.consensus_suggestions.length > 0 && budgetLeft()) {
                    const codeFeedback = `Compile/test/lint checks flagged issues: ${codeReflection.key_issues.slice(0, 3).join("; ")}. ${codeReflection.consensus_suggestions.join(" ")}`;
                    synthesis = await synthesize(llm, userRequest, plan, meshResult.results, codeFeedback);
                    evaluationScore = Math.min(evaluationScore, codeReflection.overall_score);
                }
            }
        } catch (ccErr) {
            console.warn("[SWARM] Code critic failed (non-fatal):", (ccErr as Error).message);
        }
    } else {
        console.log(`[SWARM] ⏱️ Post-synthesis budget exhausted before code critic — skipping`);
    }

    // ── Multi-Critic Debate: identify specific weaknesses if evaluation score is low ──
    const multiCriticThreshold = getDimensionValue<number>("swarm.multiCriticThreshold") ?? 60;
    if (evaluationScore < multiCriticThreshold && budgetLeft()) {
        if (onProgress) await onProgress("🎭 multi-critic…").catch(() => {});
        try {
            console.log(
                `[SWARM] 🎭 Evaluation score ${evaluationScore} < ${multiCriticThreshold} — running multi-critic debate...`,
            );
            const debate = await runMultiCriticDebate(llm, userRequest, synthesis);
            if (debate.key_issues.length > 0 && budgetLeft()) {
                console.log(
                    `[SWARM] 🎭 Multi-critic found ${debate.key_issues.length} issues (consensus score: ${debate.overall_score.toFixed(1)})`,
                );
                const criticFeedback = debate.consensus_suggestions.join("; ");
                if (criticFeedback) {
                    synthesis = await synthesize(llm, userRequest, plan, meshResult.results, criticFeedback);
                }
            }
        } catch (mcErr) {
            console.warn("[SWARM] Multi-critic debate failed (non-fatal):", (mcErr as Error).message);
        }
    }

    // ── MoA fallback: re-synthesize via Mixture of Agents if quality is low ──
    const moaThreshold = getDimensionValue<number>("swarm.moaThreshold") ?? 70;
    if (shouldUseMoA(stepsCompleted, stepsFailed) && evaluationScore < moaThreshold && budgetLeft()) {
        if (onProgress) await onProgress("🔀 MoA…").catch(() => {});
        try {
            console.log(
                `[SWARM] 🔀 Evaluation score ${evaluationScore} < ${moaThreshold} — re-synthesizing via MoA...`,
            );
            const moaSynthesis = await synthesizeWithMoA(llm, userRequest, plan, meshResult.results);
            if (moaSynthesis && moaSynthesis.length > 0) {
                synthesis = moaSynthesis;
                console.log(`[SWARM] 🔀 MoA re-synthesis complete`);
            }
        } catch (moaErr) {
            console.warn("[SWARM] MoA re-synthesis failed (non-fatal):", (moaErr as Error).message);
            // Keep original synthesis
        }
    }

    console.log(
        `[SWARM] ✅ Swarm complete in ${((Date.now() - startTime) / 1000).toFixed(1)}s (quality: ${evaluationScore}/100)`,
    );

    // ── Save decomposition template for future reuse ──
    try {
        saveTemplate(userRequest, plan.steps, evaluationScore / 100);
    } catch (saveErr) {
        console.warn("[SWARM] Failed to save decomposition template (non-fatal):", (saveErr as Error).message);
    }

    // ── Counterfactual Reflection (async, non-blocking) ──
    // Generate a "what could have been done differently" reflection for learning
    const choiceDescription = `Decomposed into ${plan.steps.length} steps: ${plan.reasoning}`;
    const outcomeDescription =
        stepsFailed > 0
            ? `Partial success: ${stepsCompleted}/${plan.steps.length} steps completed, ${stepsFailed} failed. Quality: ${evaluationScore}/100.`
            : `Success: all ${stepsCompleted} steps completed. Quality: ${evaluationScore}/100.`;

    generateCounterfactual(llm, userRequest, choiceDescription, outcomeDescription).catch((err) =>
        console.warn("[SWARM] Counterfactual generation failed (non-fatal):", err),
    );

    // ── Auto-Skill Creation ─────────────────────────
    // After complex swarm tasks complete, try to extract a reusable skill
    try {
        const totalToolCalls = finalWaveResults.reduce((sum, r) => sum + r.toolCalls, 0);
        if (totalToolCalls >= 5) {
            const toolCallRecords: ToolCallRecord[] = plan.steps.map((step) => {
                const result = meshResult.results.get(step.id);
                return {
                    name: `step_${step.role}_${step.id}`,
                    args: { description: step.description },
                    result: (result?.output || "").substring(0, 300),
                };
            });
            const swarmOutcome =
                stepsFailed === 0
                    ? ("success" as const)
                    : stepsFailed < plan.steps.length
                      ? ("partial" as const)
                      : ("failure" as const);
            maybeCreateSkill(llm, userRequest, toolCallRecords, swarmOutcome).catch((err) =>
                console.warn("[SWARM] Auto-skill creation failed (non-fatal):", (err as Error).message),
            );
        }
    } catch (skillErr) {
        console.warn("[SWARM] Auto-skill creation failed (non-fatal):", (skillErr as Error).message);
    }

    return {
        plan,
        synthesis,
        totalDurationMs: Date.now() - startTime,
        stepsCompleted,
        stepsFailed,
        evaluationScore,
        replanned,
        totalEstimatedCost: meshResult.totalEstimatedCost,
        needsApproval: plan.steps.filter((s) => meshResult.results.get(s.id)?.needsApproval).map((s) => s.description),
        stepResults: meshResult.results,
    };
}

/** Run the steps of a held-back run that need running again; keep every other result. */
async function resumeMesh(
    llm: LLMClient,
    steps: MeshStep[],
    prior: Map<string, SubAgentResult>,
    onProgress?: (msg: string) => Promise<void>,
): Promise<MeshResult> {
    const wave = stepsToResume(steps, prior).map((st) => {
        const did = prior.get(st.id)?.mutatorsRan;
        const note = did?.length
            ? `\n\n(Resumed after the owner's OK. The earlier attempt already ran: ${[...new Set(did)].join(", ")}. Don't repeat what is done.)`
            : "";
        return { ...st, description: st.description + note, depends_on: [...st.depends_on] };
    });
    const res = await executeMesh(llm, wave, onProgress, STEP_TIMEOUT_MS, { results: prior, steps });
    const results = new Map(prior);
    for (const [id, r] of res.results) results.set(id, r);
    return { ...res, results };
}

// ── Decomposition (Plan Generation) ──────────

async function decompose(llm: LLMClient, userRequest: string): Promise<SwarmPlan | null> {
    // Query task learnings for similar past tasks (#18)
    let learningsHint = "";
    try {
        const learnings = getTaskLearningsContext(userRequest);
        if (learnings) {
            learningsHint = `\n\nPAST EXPERIENCE (use these to improve your plan):\n${learnings}\n`;
        }
    } catch {
        // Task learnings not initialized — continue without
    }

    // ── Memory-Informed Planning: inject relevant past context ──
    let memoryHint = "";
    try {
        const memCtx = await getMemoryInformedContext(userRequest);
        if (memCtx.contextSummary) {
            memoryHint = `\n\nMEMORY CONTEXT (relevant past experiences and entities):\n${memCtx.contextSummary}\n`;
            console.log(
                `[SWARM] 🧠 Memory-informed context: ${memCtx.relevantMemories.length} memories, ${memCtx.taskLearnings.length} learnings`,
            );
        }
    } catch {
        // Memory-informed planning not available — continue without
    }

    // ── Query decomposition template library for similar past tasks ──
    let templateHint = "";
    try {
        const templateMatches = findTemplates(userRequest);
        if (templateMatches.length > 0) {
            templateHint = formatTemplateHint(templateMatches[0]);
            console.log(
                `[SWARM] 📚 Found decomposition template (similarity: ${templateMatches[0].similarity.toFixed(2)}, success: ${(templateMatches[0].template.averageSuccessRate * 100).toFixed(0)}%)`,
            );
        }
    } catch {
        // Template library not available — continue without
    }

    const prompt = `You are a task planner. Break down the following user request into independent steps that can be executed by specialized agents.

Available agent roles:
- "researcher": Can search the web, search memory, and read files. Use for information gathering.
- "coder": Can run shell commands, read/write files. Use for coding and file operations.
- "browser": Can navigate websites, click, type, extract data. Use for web automation.
- "system": Can run AppleScript, shell commands, take screenshots. Use for macOS automation.
- "general": Can use all tools. Use when a task doesn't fit other roles.

Rules:
- Maximum ${MAX_STEPS} steps
- Each step has: id (short like "s1", "s2"), role, description, depends_on (array of step IDs)
- Steps with no dependencies will run IN PARALLEL — use this for independent tasks
- Steps with dependencies run AFTER those steps complete and receive their results
- If the request is simple enough for ONE agent, return {"steps":[], "reasoning":"..."}
- Only decompose when there are genuinely independent sub-tasks or different expertise needed
- Output ONLY valid JSON, no markdown, no explanation

Example output:
{
  "steps": [
    {"id": "s1", "role": "researcher", "description": "Search for the top 3 AI frameworks in 2025", "depends_on": []},
    {"id": "s2", "role": "researcher", "description": "Find pricing and features for each framework", "depends_on": ["s1"]},
    {"id": "s3", "role": "coder", "description": "Create a comparison table in markdown and save to comparison.md", "depends_on": ["s2"]}
  ],
  "reasoning": "Research phase can be split from writing. s2 depends on s1 for the framework names."
}

User request: ${userRequest}${learningsHint}${memoryHint}${templateHint}`;

    try {
        const response = await llm.chat({
            messages: [{ role: "user", content: prompt }] as ChatCompletionMessageParam[],
            systemPrompt: "You are a JSON-only task planner. Output valid JSON only.",
            modelOverride: selectForPlanning(userRequest).modelId,
        });

        const text = response.choices?.[0]?.message?.content || "";
        const jsonStr = extractJSON(text);
        if (!jsonStr) return null;

        const parsed = JSON.parse(jsonStr);

        // Validate
        if (!Array.isArray(parsed.steps)) return null;

        const steps: MeshStep[] = [];
        for (const s of parsed.steps.slice(0, MAX_STEPS)) {
            if (!s.id || !s.role || !s.description) continue;
            const validRoles: AgentRole[] = ["researcher", "coder", "browser", "system", "general"];
            const role = validRoles.includes(s.role) ? (s.role as AgentRole) : "general";
            steps.push({
                id: s.id,
                role,
                description: s.description,
                depends_on: Array.isArray(s.depends_on) ? s.depends_on : [],
            });
        }

        const initialPlan: SwarmPlan = {
            steps,
            reasoning: parsed.reasoning || "No reasoning provided",
        };

        // ── MCTS Refinement Pass ──
        // For complex tasks (> 5 steps), use MCTS to validate/refine the plan.
        // This is optional — falls back to the LLM-generated plan if MCTS fails.
        if (deepPlanningEnabled() && steps.length > 5) {
            try {
                const complexity = classifyComplexity(userRequest);
                if (complexity.score >= 0.4) {
                    console.log(
                        `[SWARM] 🌳 Running MCTS refinement (${steps.length} steps, complexity: ${complexity.score.toFixed(2)})`,
                    );
                    const mctsContext = steps.map((s) => `${s.id} [${s.role}]: ${s.description}`).join("\n");
                    const mctsResult = await runMCTSPlanning(llm, userRequest, mctsContext, {
                        maxSimulations: 10, // Lighter pass — just validating
                        maxDepth: steps.length,
                        branchingFactor: 2,
                    });

                    if (mctsResult.bestPlan.length > 0 && mctsResult.confidence > 0.5) {
                        console.log(
                            `[SWARM] 🌳 MCTS confidence: ${mctsResult.confidence.toFixed(2)}, nodes explored: ${mctsResult.nodesExplored}`,
                        );
                        // MCTS found a high-confidence path — enrich step descriptions with MCTS insights
                        for (let i = 0; i < Math.min(mctsResult.bestPlan.length, steps.length); i++) {
                            const mctsAction = mctsResult.bestPlan[i];
                            // Only enrich if the MCTS suggestion is substantively different
                            if (
                                mctsAction &&
                                mctsAction.length > 10 &&
                                !steps[i].description.includes(mctsAction.substring(0, 20))
                            ) {
                                steps[i].description = `${steps[i].description} [MCTS hint: ${mctsAction}]`;
                            }
                        }
                        initialPlan.reasoning += ` (MCTS-refined, confidence: ${mctsResult.confidence.toFixed(2)})`;
                    }
                }
            } catch (mctsErr) {
                console.warn("[SWARM] MCTS refinement failed (non-fatal):", (mctsErr as Error).message);
                // Fall through — use original LLM plan
            }
        }

        return initialPlan;
    } catch (err) {
        console.error("[SWARM] Decomposition failed:", (err as Error).message);
        return null;
    }
}

/**
 * Fold a replan into the plan. Revised steps replace same-id steps and the
 * remaining steps they name in `replaces`; every other step stays so its
 * failure is still counted and reported. Unrevised remaining steps that never
 * ran, or that ran on a step revised now, run again in the next wave (unless
 * they already had side effects); the rest are settled: the replanner saw
 * them and left them alone.
 */
export function planAfterReplan(
    steps: MeshStep[],
    results: Map<string, SubAgentResult>,
    remaining: MeshStep[],
    revised: MeshStep[],
): { steps: MeshStep[]; wave: MeshStep[]; settled: string[] } {
    // Old id → the step that now does its work (itself, or a new id that replaces it).
    const remainingIds = new Set(remaining.map((s) => s.id));
    const now = new Map<string, string>();
    for (const r of revised) {
        now.set(r.id, r.id);
        for (const old of r.replaces ?? []) if (remainingIds.has(old) && !now.has(old)) now.set(old, r.id);
    }
    const rerun: MeshStep[] = [];
    const settled: string[] = [];
    for (const s of remaining) {
        if (now.has(s.id)) continue;
        const r = results.get(s.id);
        if (!r || (s.depends_on.some((d) => now.has(d)) && !r.mutatorsRan?.length)) {
            rerun.push({ ...s, depends_on: [...new Set(s.depends_on.map((d) => now.get(d) ?? d))] });
        } else {
            settled.push(s.id);
        }
    }
    return {
        steps: [...steps.filter((s) => !now.has(s.id)), ...revised],
        wave: [...revised, ...rerun],
        settled,
    };
}

// ── Synthesis (Result Merging) ────────────────

/** The owner declined it, or it needs an approval nobody could give: not a failure to replan. */
function notRunByOwner(r: SubAgentResult | undefined): boolean {
    return !!r && (!!r.needsApproval || !!r.declined);
}

async function synthesize(
    llm: LLMClient,
    userRequest: string,
    plan: SwarmPlan,
    results: Map<string, SubAgentResult>,
    evaluatorFeedback?: string,
): Promise<string> {
    // Build a summary of all step results
    const resultSummary = plan.steps
        .map((step) => {
            const result = results.get(step.id);
            if (!result) return `### Step ${step.id} (${step.role}): NOT EXECUTED`;
            if (notRunByOwner(result)) {
                return `### Step ${step.id} (${step.role}): NOT RUN — ${result.declined ? "the user declined it" : "needs the user's approval"}\n${result.output}`;
            }
            if (!result.success) {
                // Keep what a failed step got done (sub-agents return partial output).
                const partial = result.output?.trim()
                    ? `\nPartial output (incomplete):\n${capStepOutput(result.output)}`
                    : "";
                return `### Step ${step.id} (${step.role}): FAILED\nError: ${result.error || "unknown"}${partial}`;
            }
            return `### Step ${step.id} (${step.role}): ${step.description}\n${capStepOutput(result.output)}`;
        })
        .join("\n\n");

    const feedbackNote = evaluatorFeedback
        ? `\n\nIMPORTANT — A quality review found these issues with a previous response. Fix them:\n${evaluatorFeedback}\n`
        : "";

    const prompt = `The user asked: "${userRequest}"

I broke this into ${plan.steps.length} sub-tasks and executed them. Here are the results:

${resultSummary}
${feedbackNote}
Now synthesize these results into a single, coherent response for the user. Be concise and natural — don't mention the steps or the decomposition process. Just answer as if you did it all yourself. If a step FAILED, say plainly what didn't get done; use its partial output, but never present it as finished. If a step was NOT RUN, say so plainly: for one that needs approval, tell the user it was not done, what it would have done, and ask whether to go ahead.`;

    try {
        const response = await llm.chat({
            messages: [{ role: "user", content: prompt }] as ChatCompletionMessageParam[],
            systemPrompt:
                "You synthesize multi-step results into natural, coherent responses. Write casually and concisely.",
            modelOverride: selectForSynthesis(userRequest).modelId,
        });

        return response.choices?.[0]?.message?.content || "(synthesis failed)";
    } catch (err) {
        console.error("[SWARM] Synthesis failed:", (err as Error).message);

        // Fallback: concatenate results directly
        return plan.steps
            .map((s) => {
                const r = results.get(s.id);
                return r?.output || "";
            })
            .filter(Boolean)
            .join("\n\n");
    }
}
