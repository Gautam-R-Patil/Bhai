// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Mesh Workflow Engine ──────────────────────
// DAG-based executor: runs independent steps in parallel,
// dependent steps sequentially, with per-step timeouts.

import { getRawDb } from "../memory/sqlite.js";
import type { LLMClient } from "../llm.js";
import { runSubAgent, type SubAgentTask, type SubAgentResult, type AgentRole } from "./sub-agent.js";
import { executeWithRecovery } from "./error-recovery.js";
import { isWorktreeEnabled, setupAgentWorktree } from "./agent-worktree.js";
import { buildHandoff, serializeHandoff } from "./handoff.js";
import { shouldOverrideRole } from "./role-analyzer.js";
import { shouldSpeculate, executeSpeculatively } from "./speculative.js";
import { requestHumanApproval } from "./human-interrupt.js";
import { getActiveChannel } from "../tools/channel-send.js";
import { currentSwarmRun, isPaymentHold, runWideGrant, withSwarmStep } from "./swarm-context.js";

// ── Types ─────────────────────────────────────

export interface MeshStep {
    id: string;
    role: AgentRole;
    description: string;
    depends_on: string[];       // IDs of steps that must complete first
    priority?: "critical" | "normal" | "low"; // Set by critical path analysis
    replaces?: string[]; // Replan: earlier step ids this one takes over under a new id
}

export interface MeshResult {
    results: Map<string, SubAgentResult>;
    totalDurationMs: number;
    parallelGroups: number;     // How many parallel waves were executed
    totalEstimatedCost: number; // Sum of all step costs (#16)
}

// ── Checkpoint Types ─────────────────────────

export interface MeshCheckpoint {
    meshId: string;
    taskDescription: string;
    completedSteps: string[];       // step IDs that finished
    stepResults: Record<string, string>;  // stepId -> result output
    pendingSteps: string[];
    createdAt: number;
    updatedAt: number;
}

// ── Checkpoint Persistence (SQLite-backed) ───

/** Save or update a mesh checkpoint. */
function saveMeshCheckpoint(checkpoint: MeshCheckpoint): void {
    try {
        const raw = getRawDb();
        if (!raw) return;
        const stmt = raw.prepare(`
            INSERT OR REPLACE INTO mesh_checkpoints
            (mesh_id, task_description, completed_steps, step_results, pending_steps, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
            checkpoint.meshId,
            checkpoint.taskDescription,
            JSON.stringify(checkpoint.completedSteps),
            JSON.stringify(checkpoint.stepResults),
            JSON.stringify(checkpoint.pendingSteps),
            checkpoint.createdAt,
            checkpoint.updatedAt,
        );
    } catch (err) {
        console.warn("[MESH] Failed to save checkpoint:", (err as Error).message);
    }
}

/** Load an existing checkpoint for a mesh ID. Returns null if none exists. */
function loadMeshCheckpoint(meshId: string): MeshCheckpoint | null {
    try {
        const raw = getRawDb();
        if (!raw) return null;
        const stmt = raw.prepare("SELECT * FROM mesh_checkpoints WHERE mesh_id = ?");
        const row = stmt.get(meshId) as Record<string, unknown> | undefined;
        if (!row) return null;
        return {
            meshId: row.mesh_id as string,
            taskDescription: row.task_description as string,
            completedSteps: JSON.parse(row.completed_steps as string),
            stepResults: JSON.parse(row.step_results as string),
            pendingSteps: JSON.parse(row.pending_steps as string),
            createdAt: row.created_at as number,
            updatedAt: row.updated_at as number,
        };
    } catch (err) {
        console.warn("[MESH] Failed to load checkpoint:", (err as Error).message);
        return null;
    }
}

/** Delete a checkpoint after successful completion. */
function deleteMeshCheckpoint(meshId: string): void {
    try {
        const raw = getRawDb();
        if (!raw) return;
        const stmt = raw.prepare("DELETE FROM mesh_checkpoints WHERE mesh_id = ?");
        stmt.run(meshId);
    } catch (err) {
        console.warn("[MESH] Failed to delete checkpoint:", (err as Error).message);
    }
}

/** Generate a stable mesh ID from the steps for checkpoint matching. */
function computeMeshId(steps: MeshStep[]): string {
    // Hash based on step IDs and descriptions for stable identification
    const content = steps.map(s => `${s.id}:${s.description.substring(0, 50)}`).join("|");
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
        const ch = content.charCodeAt(i);
        hash = ((hash << 5) - hash) + ch;
        hash |= 0; // Convert to 32-bit int
    }
    return `mesh_${Math.abs(hash).toString(36)}`;
}

// ── Telegram early ask (not the safety boundary) ──

// The boundary is the tool gate (swarm-context.ts): inside a swarm, external
// side effects run only with the owner's consent for the run or this step.
// On Telegram only, a step whose text mentions an irreversible verb also gets
// Approve/Skip buttons BEFORE it runs, so the owner can OK it up front.
// Recall-first: a false positive costs one tap. Off Telegram this is never consulted.
const ASK_FIRST_RE =
    /\b(?:delet\w*|remov\w*|eras\w*|wip(?:e|es|ed|ing)|destroy\w*|purg\w*|trash\w*|shred\w*|rm|drop\w*|uninstall\w*|reset\w*|format\w*|send\w*|sent|e-?mail\w*|messag\w*|text\w*|dm|whatsapp\w*|repl(?:y|ies|ied|ying)|forward\w*|post\w*|publish\w*|tweet\w*|buy\w*|bought|purchas\w*|order\w*|checkout|check\s+out|pay|pays|paid|paying|payments?|transfer\w*|wir(?:e|es|ed|ing)|deploy\w*|push\w*|prod)\b|\bbranch\s+-D\b/i;

export function shouldAskFirst(description: string): boolean {
    return ASK_FIRST_RE.test(description);
}

/** Only Telegram renders approval buttons (resolveInterrupt). */
function canAskOwner(): boolean {
    return getActiveChannel() === "telegram";
}

function needsApprovalResult(step: MeshStep, tried: string[], why?: string): SubAgentResult {
    const msg =
        `NOT done: this step needs the owner's OK${why ? ` (${why})` : ""}. ` +
        (tried.length
            ? `It tried: ${[...new Set(tried)].join("; ")}. That was NOT run. `
            : `Nothing was run for it. It would have: ${step.description}. `) +
        "If the owner says yes, call swarm_task again with the SAME task text and confirmed: true " +
        "(that runs only the held steps, with the owner's OK; finished steps are not repeated).";
    return {
        id: step.id,
        role: step.role,
        success: false,
        output: msg,
        toolCalls: 0,
        durationMs: 0,
        estimatedCost: 0,
        error: msg,
        needsApproval: true,
    };
}

// ── Mesh Executor ─────────────────────────────

/**
 * Execute a plan as a DAG workflow.
 * Steps without dependencies run in parallel.
 * Steps with dependencies wait for their predecessors.
 */
export async function executeMesh(
    llm: LLMClient,
    steps: MeshStep[],
    onProgress?: (msg: string) => Promise<void>,
    stepTimeoutMs = 300000, // 5 minutes per step
    /** Earlier waves (swarm replan): their successful steps satisfy deps here. */
    prior?: { results: Map<string, SubAgentResult>; steps: MeshStep[] },
): Promise<MeshResult> {
    const startTime = Date.now();
    const meshId = computeMeshId(steps);
    const taskDescription = steps.map(s => s.description.substring(0, 40)).join("; ");

    // Deps outside this plan: a prior wave's successful step satisfies them;
    // a removed, failed or hallucinated step is dropped instead of throwing.
    const ids = new Set(steps.map((s) => s.id));
    const externalDeps = new Map<string, string[]>();
    for (const s of steps) {
        const external = s.depends_on.filter((d) => !ids.has(d));
        if (external.length === 0) continue;
        const satisfied = external.filter((d) => prior?.results.get(d)?.success);
        const dropped = external.filter((d) => !satisfied.includes(d));
        if (dropped.length > 0) {
            console.warn(`[MESH] Step ${s.id}: dropping deps on unknown/failed steps [${dropped.join(", ")}]`);
        }
        externalDeps.set(s.id, satisfied);
        s.depends_on = s.depends_on.filter((d) => ids.has(d));
    }
    const priorStepMap = new Map((prior?.steps ?? []).map((s) => [s.id, s]));

    // ── Validate: detect cycles ──
    validateDAG(steps);

    // ── Critical Path Prioritization (#4) ──
    // Try to assign priorities using native Rust module; fall back silently
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const native: any = await import("../../native/index.js");
        if (typeof native.get_step_priorities === "function") {
            const priorities = native.get_step_priorities(steps.map(s => ({
                id: s.id,
                role: s.role,
                description: s.description,
                depends_on: s.depends_on,
            })));
            for (const p of priorities) {
                const step = steps.find(s => s.id === p.step_id);
                if (step) step.priority = p.priority as "critical" | "normal" | "low";
            }
        }
    } catch {
        // Native module unavailable — proceed without priority scheduling
    }

    const results = new Map<string, SubAgentResult>();
    const stepMap = new Map(steps.map(s => [s.id, s]));
    const completed = new Set<string>();
    let parallelGroups = 0;

    const totalSteps = steps.length;
    let completedCount = 0;

    // ── Checkpoint Restoration ──
    // Check if we have a saved checkpoint for this mesh and resume from it
    const existingCheckpoint = loadMeshCheckpoint(meshId);
    if (existingCheckpoint && existingCheckpoint.completedSteps.length > 0) {
        console.log(`  ♻️ Resuming mesh ${meshId} from checkpoint (${existingCheckpoint.completedSteps.length}/${totalSteps} steps done)`);
        if (onProgress) {
            await onProgress(`♻️ Resuming from checkpoint — ${existingCheckpoint.completedSteps.length} steps already done`).catch(() => { });
        }

        // Restore completed steps and their results
        for (const stepId of existingCheckpoint.completedSteps) {
            if (!stepMap.has(stepId)) continue;
            completed.add(stepId);
            completedCount++;
            const cachedOutput = existingCheckpoint.stepResults[stepId] || "(restored from checkpoint)";
            const step = stepMap.get(stepId);
            results.set(stepId, {
                id: stepId,
                role: step?.role || "general",
                success: true,
                output: cachedOutput,
                toolCalls: 0,
                durationMs: 0,
                estimatedCost: 0,
            });
        }
    }

    // ── Execute in waves ──
    let meshFailed = false;
    while (completed.size < steps.length) {
        // Find all steps whose dependencies are met
        const ready = steps.filter(s =>
            !completed.has(s.id) &&
            s.depends_on.every(dep => completed.has(dep))
        );

        if (ready.length === 0) {
            // Should not happen if DAG validation passed
            console.error("[MESH] Deadlock detected — no steps are ready");
            meshFailed = true;
            break;
        }

        parallelGroups++;
        const wave = parallelGroups;
        const waveIds = ready.map(s => s.id).join(", ");
        console.log(`  🔀 Mesh wave ${wave}: running [${waveIds}] in parallel`);

        if (onProgress) {
            const stepNames = ready.map(s => s.role).join(" + ");
            await onProgress(`⚡ running ${ready.length} step${ready.length > 1 ? "s" : ""}: ${stepNames}`).catch(() => { });
        }

        // ── Phase 4G: worktree isolation for parallel coder steps ──
        // Opt-in via ATLAS_AGENT_WORKTREE=true. Allocates one throwaway
        // git worktree per coder step in the wave when >= 2 coder steps
        // run in parallel, so each agent operates on its own checkout
        // without file conflicts. Worktrees are torn down at end of wave.
        const coderStepsInWave = ready.filter((s) => s.role === "coder");
        const worktreeAssignments = new Map<string, string>();
        const activeWorktreeHandles: { cleanup(): void }[] = [];
        if (coderStepsInWave.length >= 2 && isWorktreeEnabled()) {
            for (const s of coderStepsInWave) {
                const wt = setupAgentWorktree(s.id);
                if (wt) {
                    worktreeAssignments.set(s.id, wt.path);
                    activeWorktreeHandles.push(wt);
                    console.log(`    🌳 Worktree ${wt.path} allocated for step ${s.id}`);
                }
            }
        }

        // Cap the number of steps in this wave that may speculate (Phase 4F
        // safety). Without a cap, three concurrent coder steps would fork
        // to 6 parallel LLM conversations, doubling rate-limit pressure for
        // marginal quality gains. Configurable via ATLAS_WAVE_SPECULATION_CAP
        // (default 1; set to "off" to disable speculation entirely or a
        // larger number for more aggressive racing).
        const rawCap = process.env.ATLAS_WAVE_SPECULATION_CAP ?? "1";
        const waveSpeculationCap = rawCap === "off" ? 0 : Math.max(0, Number.parseInt(rawCap, 10) || 1);
        const speculationBudget = { remaining: waveSpeculationCap };

        // Run all ready steps in parallel
        const waveResults = await Promise.all(
            ready.map(async (step) => {
                // Dynamic role assignment (#5)
                let effectiveRole = step.role;
                const roleOverride = shouldOverrideRole(step.role, step.description);
                if (roleOverride.override && roleOverride.newRole) {
                    console.log(`    🔀 Role override: ${step.id} ${step.role} → ${roleOverride.newRole} (${roleOverride.reason})`);
                    effectiveRole = roleOverride.newRole;
                }

                // ── Telegram: ask before a step that sounds irreversible ──
                // Approve lets this step's side effects through the tool gate;
                // Skip marks it declined. Everywhere else the gate alone decides.
                // A step the owner already approved (a confirmed re-run) isn't asked again.
                const run = currentSwarmRun();
                // The grant is used up as the step runs: a replanned step that
                // reuses this id is gated again.
                let stepApproved = !!run?.approvedSteps?.delete(step.id) || runWideGrant(run);
                if (!stepApproved && onProgress && canAskOwner() && shouldAskFirst(step.description)) {
                    try {
                        const approval = await requestHumanApproval(
                            {
                                question: `Step "${step.id}" wants to: ${step.description}\n\nProceed?`,
                                options: ["Approve", "Skip"],
                                timeout: 300000, // 5 min
                                defaultAction: "Skip",
                            },
                            onProgress,
                        );
                        if (approval.timedOut) {
                            return needsApprovalResult(step, [], "you didn't answer within 5 minutes");
                        }
                        if (approval.answer !== "Approve") {
                            console.log(`  ⏭️ Step ${step.id} skipped by user`);
                            const msg = `NOT run: you declined "${step.description}".`;
                            return {
                                id: step.id,
                                role: step.role,
                                success: false,
                                output: msg,
                                toolCalls: 0,
                                durationMs: 0,
                                estimatedCost: 0,
                                error: msg,
                                declined: true,
                            } as SubAgentResult;
                        }
                        stepApproved = true;
                    } catch {
                        return needsApprovalResult(step, [], "the approval request failed");
                    }
                }
                const inStep = <T>(fn: () => Promise<T>): Promise<T> =>
                    withSwarmStep({ stepId: step.id, stepApproved }, fn);
                const blockedBefore = run?.blocked.length ?? 0;

                // Gather structured context from dependencies (#2)
                const depContext = [...(externalDeps.get(step.id) ?? []), ...step.depends_on]
                    .map((depId) => {
                        const depResult = results.get(depId) ?? prior?.results.get(depId);
                        const depStep = stepMap.get(depId) ?? priorStepMap.get(depId);
                        if (!depResult || !depStep) return "";
                        const handoff = buildHandoff(depResult, depStep);
                        return serializeHandoff(handoff);
                    })
                    .filter(Boolean)
                    .join("\n\n");
                const fullContext = depContext || undefined;

                // Use recovery wrapper for resilient execution (#1)
                const progressFn = onProgress ? async (stepId: string, msg: string) => {
                    await onProgress(`[${stepId}] ${msg}`).catch(() => { });
                } : undefined;

                let result: SubAgentResult;

                // ── Speculative execution for critical steps ──
                // Phase 4F: coder steps with refactor/multi-file intent also
                // speculate even when priority isn't marked critical, since
                // the test-first alt_B approach is cheap to race.
                const coderBreadth = effectiveRole === "coder" && shouldSpeculate(0, 0.35, "coder", step.description);
                const workingDirectory = worktreeAssignments.get(step.id);
                const wantsSpeculation = (step.priority === "critical" && shouldSpeculate(0.35)) || coderBreadth;
                let allowSpeculation = false;
                if (wantsSpeculation && speculationBudget.remaining > 0) {
                    speculationBudget.remaining--;
                    allowSpeculation = true;
                } else if (wantsSpeculation) {
                    console.log(`    🎯 Speculation suppressed for ${step.id} (wave cap reached)`);
                }
                const task = {
                    id: step.id,
                    role: effectiveRole,
                    description: step.description,
                    context: fullContext,
                    timeoutMs: stepTimeoutMs,
                    priority: step.priority,
                    workingDirectory,
                };
                if (allowSpeculation) {
                    try {
                        console.log(`    🎯 Speculative execution for critical step ${step.id}`);
                        result = (await inStep(() => executeSpeculatively(llm, task, progressFn))).result;
                    } catch (specErr) {
                        console.warn(`    ⚠️ Speculative execution failed for ${step.id}, falling back to normal:`, (specErr as Error).message);
                        result = await inStep(() => executeWithRecovery(llm, task, progressFn));
                    }
                } else {
                    result = await inStep(() => executeWithRecovery(llm, task, progressFn));
                }

                // A side effect the gate held back: the step is NOT done, whatever its sub-agent said.
                const stepBlocks = (run?.blocked.slice(blockedBefore) ?? []).filter((b) => b.step === step.id);
                // A refused payment is not held for a confirmed re-run (that would refuse it
                // again and loop): the step fails and swarm_task hands the payment to the main agent.
                const blocked = stepBlocks.filter((b) => !isPaymentHold(b));
                const payments = stepBlocks.filter(isPaymentHold);
                if (payments.length > 0 && blocked.length === 0) {
                    result = {
                        ...result,
                        success: false,
                        output: `NOT done: the payment was NOT made (${[...new Set(payments.map((b) => b.summary))].join("; ")}). The main agent must make it itself after the owner's OK.`,
                    };
                }
                if (blocked.length > 0) {
                    const tried = blocked.map((b) => b.summary);
                    result = {
                        ...needsApprovalResult(step, tried),
                        toolCalls: result.toolCalls,
                        durationMs: result.durationMs,
                        estimatedCost: result.estimatedCost,
                        mutatorsRan: result.mutatorsRan,
                    };
                }

                completedCount++;
                const stepDesc = step.description.substring(0, 80);
                const stepDuration = (result.durationMs / 1000).toFixed(1);
                console.log(`  ${result.success ? "✅" : "❌"} Mesh step ${step.id} (${step.role}): ${result.success ? "success" : "FAILED"} (${result.toolCalls} tools, ${stepDuration}s)`);

                if (onProgress) {
                    const statusIcon = result.needsApproval ? "✋" : result.success ? "✅" : "❌";
                    const eta = completedCount < totalSteps
                        ? ` (~${Math.round(((Date.now() - startTime) / completedCount) * (totalSteps - completedCount) / 1000)}s remaining)`
                        : "";
                    await onProgress(`${statusIcon} [${completedCount}/${totalSteps}] ${stepDesc}${eta}`).catch(() => { });
                }

                return result;
            })
        );

        // ── Phase 4G: cleanup worktrees after the wave ──
        // Best-effort; SIGINT/exit handlers in agent-worktree.ts will also
        // sweep these if the process dies mid-wave.
        if (activeWorktreeHandles.length > 0) {
            for (const h of activeWorktreeHandles) {
                try { h.cleanup(); } catch { /* */ }
            }
            console.log(`    🌳 Cleaned up ${activeWorktreeHandles.length} worktree(s)`);
        }

        // Record results and checkpoint after each wave
        for (const result of waveResults) {
            results.set(result.id, result);
            completed.add(result.id);
        }

        // ── Save checkpoint after each wave ──
        // Only successful steps count as done: a resume must re-run failed ones.
        const succeeded = [...completed].filter((id) => results.get(id)?.success);
        const stepResultsMap: Record<string, string> = {};
        for (const id of succeeded) {
            stepResultsMap[id] = (results.get(id)?.output ?? "").substring(0, 2000); // Cap stored output
        }
        const pending = steps.filter((s) => !succeeded.includes(s.id)).map((s) => s.id);
        saveMeshCheckpoint({
            meshId,
            taskDescription,
            completedSteps: succeeded,
            stepResults: stepResultsMap,
            pendingSteps: pending,
            createdAt: existingCheckpoint?.createdAt || startTime,
            updatedAt: Date.now(),
        });
    }

    // ── Cleanup checkpoint on success ──
    if (!meshFailed) {
        deleteMeshCheckpoint(meshId);
    }

    // Compute total estimated cost (#16)
    let totalEstimatedCost = 0;
    for (const r of results.values()) {
        totalEstimatedCost += r.estimatedCost || 0;
    }

    return {
        results,
        totalDurationMs: Date.now() - startTime,
        parallelGroups,
        totalEstimatedCost,
    };
}

// ── DAG Validation ────────────────────────────

function validateDAG(steps: MeshStep[]): void {
    const ids = new Set(steps.map(s => s.id));

    // Check all dependencies reference existing steps
    for (const step of steps) {
        for (const dep of step.depends_on) {
            if (!ids.has(dep)) {
                throw new Error(`Mesh step "${step.id}" depends on unknown step "${dep}"`);
            }
        }
    }

    // Topological sort to detect cycles (Kahn's algorithm)
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const step of steps) {
        inDegree.set(step.id, step.depends_on.length);
        for (const dep of step.depends_on) {
            const adj = adjacency.get(dep) || [];
            adj.push(step.id);
            adjacency.set(dep, adj);
        }
    }

    const queue = steps.filter(s => s.depends_on.length === 0).map(s => s.id);
    let visited = 0;

    while (queue.length > 0) {
        const current = queue.shift()!;
        visited++;

        for (const next of (adjacency.get(current) || [])) {
            const newDegree = (inDegree.get(next) || 1) - 1;
            inDegree.set(next, newDegree);
            if (newDegree === 0) queue.push(next);
        }
    }

    if (visited !== steps.length) {
        throw new Error(`Mesh plan contains a cycle — ${steps.length - visited} steps are unreachable`);
    }
}
