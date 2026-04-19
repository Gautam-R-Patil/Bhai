// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Mesh Workflow Engine ──────────────────────
// DAG-based executor: runs independent steps in parallel,
// dependent steps sequentially, with per-step timeouts.

import type { LLMClient } from "../llm.js";
import { runSubAgent, type SubAgentTask, type SubAgentResult, type AgentRole } from "./sub-agent.js";
import { executeWithRecovery } from "./error-recovery.js";
import { isWorktreeEnabled, setupAgentWorktree } from "./agent-worktree.js";
import { buildHandoff, serializeHandoff } from "./handoff.js";
import { shouldOverrideRole } from "./role-analyzer.js";
import { shouldSpeculate, executeSpeculatively } from "./speculative.js";
import { Blackboard } from "./blackboard.js";
import { requestHumanApproval } from "./human-interrupt.js";

// ── Types ─────────────────────────────────────

export interface MeshStep {
    id: string;
    role: AgentRole;
    description: string;
    depends_on: string[];       // IDs of steps that must complete first
    priority?: "critical" | "normal" | "low"; // Set by critical path analysis
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
        const { getRawDb } = require("../memory/sqlite.js") as { getRawDb: () => import("better-sqlite3").Database | null };
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
        const { getRawDb } = require("../memory/sqlite.js") as { getRawDb: () => import("better-sqlite3").Database | null };
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
        const { getRawDb } = require("../memory/sqlite.js") as { getRawDb: () => import("better-sqlite3").Database | null };
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

// ── Dangerous Step Detection (for human-in-the-loop) ──

const DANGEROUS_KEYWORDS = [
    "delete", "remove", "erase", "destroy", "drop",
    "send email", "send mail", "email to",
    "purchase", "buy", "payment", "checkout", "order",
    "deploy", "publish", "release", "push to prod",
    "format", "wipe", "reset",
    "transfer", "wire", "pay",
    "uninstall", "rm -rf", "rm -r",
];

function isDangerousStep(description: string): boolean {
    const lower = description.toLowerCase();
    return DANGEROUS_KEYWORDS.some(kw => lower.includes(kw));
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
): Promise<MeshResult> {
    const startTime = Date.now();
    const meshId = computeMeshId(steps);
    const taskDescription = steps.map(s => s.description.substring(0, 40)).join("; ");

    // ── Per-execution shared blackboard for cross-agent discovery sharing ──
    const blackboard = new Blackboard();

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

        // Run all ready steps in parallel
        const waveResults = await Promise.all(
            ready.map(async (step) => {
                // ── Human-in-the-loop check for dangerous steps ──
                if (isDangerousStep(step.description) && onProgress) {
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
                        if (approval.answer === "Skip" || (approval.timedOut && approval.answer === "Skip")) {
                            console.log(`  ⏭️ Step ${step.id} skipped by user (timedOut=${approval.timedOut})`);
                            return {
                                id: step.id,
                                role: step.role,
                                success: false,
                                output: `Skipped by user: ${step.description}`,
                                toolCalls: 0,
                                durationMs: 0,
                                estimatedCost: 0,
                                error: "Skipped by user approval",
                            } as SubAgentResult;
                        }
                    } catch {
                        // Approval mechanism failed — proceed anyway (fail-open)
                        console.warn(`  ⚠️ Human approval check failed for ${step.id}, proceeding`);
                    }
                }

                // Gather structured context from dependencies (#2)
                const depContext = step.depends_on
                    .map(depId => {
                        const depResult = results.get(depId);
                        const depStep = stepMap.get(depId);
                        if (!depResult || !depStep) return "";
                        const handoff = buildHandoff(depResult, depStep);
                        return serializeHandoff(handoff);
                    })
                    .filter(Boolean)
                    .join("\n\n");

                // Dynamic role assignment (#5)
                let effectiveRole = step.role;
                const roleOverride = shouldOverrideRole(step.role, step.description);
                if (roleOverride.override && roleOverride.newRole) {
                    console.log(`    🔀 Role override: ${step.id} ${step.role} → ${roleOverride.newRole} (${roleOverride.reason})`);
                    effectiveRole = roleOverride.newRole;
                }

                // ── Inject blackboard shared context ──
                const bbSummary = blackboard.getSummary();
                const fullContext = [depContext, bbSummary].filter(Boolean).join("\n\n") || undefined;

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
                if ((step.priority === "critical" && shouldSpeculate(0.35)) || coderBreadth) {
                    try {
                        console.log(`    🎯 Speculative execution for critical step ${step.id}`);
                        const specResult = await executeSpeculatively(llm, {
                            id: step.id,
                            role: effectiveRole,
                            description: step.description,
                            context: fullContext,
                            timeoutMs: stepTimeoutMs,
                            priority: step.priority,
                            workingDirectory,
                        }, progressFn);
                        result = specResult.result;
                    } catch (specErr) {
                        console.warn(`    ⚠️ Speculative execution failed for ${step.id}, falling back to normal:`, (specErr as Error).message);
                        result = await executeWithRecovery(llm, {
                            id: step.id,
                            role: effectiveRole,
                            description: step.description,
                            context: fullContext,
                            timeoutMs: stepTimeoutMs,
                            priority: step.priority,
                            workingDirectory,
                        }, progressFn);
                    }
                } else {
                    result = await executeWithRecovery(llm, {
                        id: step.id,
                        role: effectiveRole,
                        description: step.description,
                        context: fullContext,
                        timeoutMs: stepTimeoutMs,
                        priority: step.priority,
                        workingDirectory,
                    }, progressFn);
                }

                completedCount++;
                const stepDesc = step.description.substring(0, 80);
                const stepDuration = (result.durationMs / 1000).toFixed(1);
                console.log(`  ✅ Mesh step ${step.id} (${step.role}): ${result.success ? "success" : "FAILED"} (${result.toolCalls} tools, ${stepDuration}s)`);

                if (onProgress) {
                    const statusIcon = result.success ? "✅" : "❌";
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
        const stepResultsMap: Record<string, string> = {};
        for (const [id, r] of results) {
            stepResultsMap[id] = r.output.substring(0, 2000); // Cap stored output
        }
        const pending = steps.filter(s => !completed.has(s.id)).map(s => s.id);
        saveMeshCheckpoint({
            meshId,
            taskDescription,
            completedSteps: [...completed],
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
