// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Swarm Orchestrator ────────────────────────
// Decomposes complex tasks into sub-agent steps, executes them via
// the Mesh engine, and synthesizes results into a final answer.

import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";
import { selectForPlanning, selectForSynthesis } from "../model-router.js";
import { executeMesh, type MeshStep } from "./mesh.js";
import type { AgentRole, SubAgentResult } from "./sub-agent.js";
import { shouldConsiderReplan, replan } from "./replanner.js";
import { evaluateAndOptimize } from "./evaluator.js";
import { getTaskLearningsContext } from "../memory/task-learnings.js";
import { extractJSON } from "../utils/json-extract.js";
import { generateCounterfactual } from "../memory/counterfactual.js";
import { classifyComplexity } from "./complexity-classifier.js";
import { runMCTSPlanning } from "../planning/mcts-planner.js";
import { shouldUseMoA, synthesizeWithMoA } from "./mixture.js";
import { findTemplates, saveTemplate, formatTemplateHint } from "./decomposition-library.js";
import { runMultiCriticDebate } from "./multi-critic.js";
import { verifyReasoning } from "../planning/logic-verifier.js";
import { createHierarchicalPlan } from "../planning/hierarchical-planner.js";
import { getMemoryInformedContext } from "../memory/memory-informed-planning.js";
import { maybeCreateSkill, type ToolCallRecord } from "../skills/auto-skill-creator.js";

// ── Types ─────────────────────────────────────

export interface SwarmPlan {
    steps: MeshStep[];
    reasoning: string;          // Why this decomposition was chosen
}

export interface SwarmResult {
    plan: SwarmPlan;
    synthesis: string;          // Final synthesized answer
    totalDurationMs: number;
    stepsCompleted: number;
    stepsFailed: number;
    evaluationScore?: number;   // Quality score from evaluator (#7)
    replanned?: boolean;        // Whether the plan was revised mid-execution (#6)
    totalEstimatedCost?: number; // Total estimated cost (#16)
}

// ── Constants ─────────────────────────────────

const MAX_STEPS = 20;
const STEP_TIMEOUT_MS = 300000; // 5 minutes per step

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
): Promise<SwarmResult> {
    const startTime = Date.now();

    console.log("[SWARM] 🐝 Starting swarm decomposition...");
    if (onProgress) await onProgress("🐝 planning task breakdown…").catch(() => { });

    // ── Step 1: Decompose (with hierarchical planning for highly complex tasks) ──
    let plan: SwarmPlan | null = null;

    // For high-complexity tasks, use hierarchical planning
    try {
        const complexity = classifyComplexity(userRequest);
        if (complexity.score > 0.7) {
            console.log(`[SWARM] 🏗️ High complexity (${complexity.score.toFixed(2)}) — using hierarchical planner`);
            const hierPlan = await createHierarchicalPlan(llm, userRequest);
            if (hierPlan.abstractGoals.length > 0) {
                // Convert hierarchical plan into flat MeshSteps
                const flatSteps: MeshStep[] = [];
                for (const goal of hierPlan.abstractGoals) {
                    for (const step of goal.subGoals) {
                        const role = goal.skillType === "search" ? "researcher"
                            : goal.skillType === "code" ? "coder"
                            : goal.skillType === "browse" ? "browser"
                            : goal.skillType === "communicate" ? "general"
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
                    console.log(`[SWARM] 🏗️ Hierarchical plan: ${hierPlan.abstractGoals.length} goals → ${flatSteps.length} steps`);
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
    try {
        const stepDescriptions = plan.steps.map(s => `${s.id} [${s.role}]: ${s.description}`);
        const conclusion = `Task "${userRequest}" will be completed via ${plan.steps.length} steps`;
        const verification = await verifyReasoning(llm, stepDescriptions, conclusion);
        if (!verification.isConsistent) {
            console.warn(`[SWARM] ⚠️ Logic verifier found inconsistencies (soundness: ${verification.soundnessScore.toFixed(2)}):`);
            for (const issue of verification.issues.slice(0, 3)) {
                console.warn(`  - ${issue}`);
            }
            // Optionally re-decompose if soundness is critically low
            if (verification.soundnessScore < 0.3) {
                console.log(`[SWARM] 🔄 Soundness critically low — re-decomposing...`);
                const revisedPlan = await decompose(llm, `${userRequest}\n\nIMPORTANT: A previous plan had logical issues: ${verification.issues.slice(0, 2).join("; ")}. Avoid these.`);
                if (revisedPlan && revisedPlan.steps.length > 0) {
                    plan.steps = revisedPlan.steps;
                    plan.reasoning = revisedPlan.reasoning + " (revised after logic verification)";
                }
            }
        } else {
            console.log(`[SWARM] ✅ Logic verification passed (soundness: ${verification.soundnessScore.toFixed(2)})`);
        }
    } catch (lvErr) {
        console.warn("[SWARM] Logic verification failed (non-fatal):", (lvErr as Error).message);
    }

    if (onProgress) {
        await onProgress(`📋 plan: ${plan.steps.length} steps`).catch(() => { });
    }

    // ── Step 2: Execute via Mesh (with replanning) (#6) ──
    let replanned = false;
    let replanCount = 0;
    const MAX_REPLANS = 3;

    // Execute mesh — replanning happens internally via the replan callback
    const meshResult = await executeMesh(llm, plan.steps, onProgress, STEP_TIMEOUT_MS);

    // Post-execution replan check: if there were failures, ask if we should revise
    const waveResults = [...meshResult.results.values()];
    const stepsCompleted = waveResults.filter(r => r.success).length;
    const stepsFailed = waveResults.filter(r => !r.success).length;

    if (stepsFailed > 0 && replanCount < MAX_REPLANS && shouldConsiderReplan(waveResults, stepsCompleted, plan.steps.length)) {
        try {
            const decision = await replan(llm, userRequest, meshResult.results, []);
            if (decision.action === "abort") {
                console.log(`[SWARM] 🛑 Replanner recommends abort: ${decision.reason}`);
            } else {
                console.log(`[SWARM] 🔄 Replanner: ${decision.action} — ${decision.reason}`);
            }
            replanned = decision.action === "replan";
        } catch {
            // Replan failed — continue with what we have
        }
    }

    console.log(`[SWARM] 📊 Mesh complete: ${stepsCompleted} succeeded, ${stepsFailed} failed, ${meshResult.parallelGroups} waves, ${(meshResult.totalDurationMs / 1000).toFixed(1)}s`);

    // ── Step 3: Synthesize with evaluation (#7) ──
    if (onProgress) await onProgress("🧩 synthesizing results…").catch(() => { });

    let { synthesis, evaluationScore } = await evaluateAndOptimize(
        llm,
        userRequest,
        async (feedback?: string) => {
            return synthesize(llm, userRequest, plan, meshResult.results, feedback);
        },
        meshResult.results,
    );

    // ── Multi-Critic Debate: identify specific weaknesses if evaluation score is low ──
    if (evaluationScore < 60) {
        try {
            console.log(`[SWARM] 🎭 Evaluation score ${evaluationScore} < 60 — running multi-critic debate...`);
            const debate = await runMultiCriticDebate(llm, userRequest, synthesis);
            if (debate.key_issues.length > 0) {
                console.log(`[SWARM] 🎭 Multi-critic found ${debate.key_issues.length} issues (consensus score: ${debate.overall_score.toFixed(1)})`);
                // Re-synthesize with critic feedback
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
    if (shouldUseMoA(stepsCompleted, stepsFailed) && evaluationScore < 70) {
        try {
            console.log(`[SWARM] 🔀 Evaluation score ${evaluationScore} < 70 — re-synthesizing via MoA...`);
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

    console.log(`[SWARM] ✅ Swarm complete in ${((Date.now() - startTime) / 1000).toFixed(1)}s (quality: ${evaluationScore}/100)`);

    // ── Save decomposition template for future reuse ──
    try {
        saveTemplate(userRequest, plan.steps, evaluationScore / 100);
    } catch (saveErr) {
        console.warn("[SWARM] Failed to save decomposition template (non-fatal):", (saveErr as Error).message);
    }

    // ── Counterfactual Reflection (async, non-blocking) ──
    // Generate a "what could have been done differently" reflection for learning
    const choiceDescription = `Decomposed into ${plan.steps.length} steps: ${plan.reasoning}`;
    const outcomeDescription = stepsFailed > 0
        ? `Partial success: ${stepsCompleted}/${plan.steps.length} steps completed, ${stepsFailed} failed. Quality: ${evaluationScore}/100.`
        : `Success: all ${stepsCompleted} steps completed. Quality: ${evaluationScore}/100.`;

    generateCounterfactual(llm, userRequest, choiceDescription, outcomeDescription).catch(err =>
        console.warn("[SWARM] Counterfactual generation failed (non-fatal):", err)
    );

    // ── Auto-Skill Creation ─────────────────────────
    // After complex swarm tasks complete, try to extract a reusable skill
    try {
        const totalToolCalls = waveResults.reduce((sum, r) => sum + r.toolCalls, 0);
        if (totalToolCalls >= 5) {
            const toolCallRecords: ToolCallRecord[] = plan.steps.map(step => {
                const result = meshResult.results.get(step.id);
                return {
                    name: `step_${step.role}_${step.id}`,
                    args: { description: step.description },
                    result: (result?.output || "").substring(0, 300),
                };
            });
            const swarmOutcome = stepsFailed === 0 ? "success" as const
                : stepsFailed < plan.steps.length ? "partial" as const
                : "failure" as const;
            maybeCreateSkill(llm, userRequest, toolCallRecords, swarmOutcome).catch(err =>
                console.warn("[SWARM] Auto-skill creation failed (non-fatal):", (err as Error).message)
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
    };
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
            console.log(`[SWARM] 🧠 Memory-informed context: ${memCtx.relevantMemories.length} memories, ${memCtx.taskLearnings.length} learnings, ${memCtx.relevantEntities.length} entities`);
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
            console.log(`[SWARM] 📚 Found decomposition template (similarity: ${templateMatches[0].similarity.toFixed(2)}, success: ${(templateMatches[0].template.averageSuccessRate * 100).toFixed(0)}%)`);
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
            const role = validRoles.includes(s.role) ? s.role as AgentRole : "general";
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
        if (steps.length > 5) {
            try {
                const complexity = classifyComplexity(userRequest);
                if (complexity.score >= 0.4) {
                    console.log(`[SWARM] 🌳 Running MCTS refinement (${steps.length} steps, complexity: ${complexity.score.toFixed(2)})`);
                    const mctsContext = steps.map(s => `${s.id} [${s.role}]: ${s.description}`).join("\n");
                    const mctsResult = await runMCTSPlanning(llm, userRequest, mctsContext, {
                        maxSimulations: 10,    // Lighter pass — just validating
                        maxDepth: steps.length,
                        branchingFactor: 2,
                    });

                    if (mctsResult.bestPlan.length > 0 && mctsResult.confidence > 0.5) {
                        console.log(`[SWARM] 🌳 MCTS confidence: ${mctsResult.confidence.toFixed(2)}, nodes explored: ${mctsResult.nodesExplored}`);
                        // MCTS found a high-confidence path — enrich step descriptions with MCTS insights
                        for (let i = 0; i < Math.min(mctsResult.bestPlan.length, steps.length); i++) {
                            const mctsAction = mctsResult.bestPlan[i];
                            // Only enrich if the MCTS suggestion is substantively different
                            if (mctsAction && mctsAction.length > 10 && !steps[i].description.includes(mctsAction.substring(0, 20))) {
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

// ── Synthesis (Result Merging) ────────────────

async function synthesize(
    llm: LLMClient,
    userRequest: string,
    plan: SwarmPlan,
    results: Map<string, SubAgentResult>,
    evaluatorFeedback?: string,
): Promise<string> {
    // Build a summary of all step results
    const resultSummary = plan.steps.map(step => {
        const result = results.get(step.id);
        if (!result) return `### Step ${step.id} (${step.role}): NOT EXECUTED`;
        if (!result.success) return `### Step ${step.id} (${step.role}): FAILED\nError: ${result.error || "unknown"}`;
        return `### Step ${step.id} (${step.role}): ${step.description}\n${result.output}`;
    }).join("\n\n");

    const feedbackNote = evaluatorFeedback
        ? `\n\nIMPORTANT — A quality review found these issues with a previous response. Fix them:\n${evaluatorFeedback}\n`
        : "";

    const prompt = `The user asked: "${userRequest}"

I broke this into ${plan.steps.length} sub-tasks and executed them. Here are the results:

${resultSummary}
${feedbackNote}
Now synthesize these results into a single, coherent response for the user. Be concise and natural — don't mention the steps or the decomposition process. Just answer as if you did it all yourself.`;

    try {
        const response = await llm.chat({
            messages: [{ role: "user", content: prompt }] as ChatCompletionMessageParam[],
            systemPrompt: "You synthesize multi-step results into natural, coherent responses. Write casually and concisely.",
            modelOverride: selectForSynthesis(userRequest).modelId,
        });

        return response.choices?.[0]?.message?.content || "(synthesis failed)";
    } catch (err) {
        console.error("[SWARM] Synthesis failed:", (err as Error).message);

        // Fallback: concatenate results directly
        return plan.steps
            .map(s => {
                const r = results.get(s.id);
                return r?.output || "";
            })
            .filter(Boolean)
            .join("\n\n");
    }
}
