// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Long-Running Task Executor ────────────────
// Persistent task runner for multi-hour workflows.
// Breaks large tasks into phases, checkpoints after each,
// and can resume from the last checkpoint if interrupted.

import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";
import { selectForPlanning } from "../model-router.js";
import { runSubAgent, type AgentRole } from "./sub-agent.js";
import { withTurnSignal } from "../tools/index.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { extractJSON } from "../utils/json-extract.js";
import { getMemoryInformedContext } from "../memory/memory-informed-planning.js";
import { maybeCreateSkill, type ToolCallRecord } from "../skills/auto-skill-creator.js";

// ── Inter-Phase Replanning (#10) ─────────────
// After each phase, check if remaining phases should be revised.

const MAX_PHASE_REPLANS = 3;

/** Fast check: should we consider replanning phases? */
function shouldReplanPhases(
    phaseOutput: string,
    phaseFailed: boolean,
    completedCount: number,
    totalPhases: number,
): boolean {
    if (phaseFailed) return true;
    if (/\b(not needed|already done|skip|no longer|unnecessary)\b/i.test(phaseOutput)) return true;
    if (completedCount > 0 && completedCount >= totalPhases * 0.5) return true;
    return false;
}

/** Ask LLM whether remaining phases should be revised. */
async function replanPhases(
    llm: LLMClient,
    task: { description: string; phases: { id: string; role: AgentRole; description: string; depends_on: string[] }[]; checkpointData: Record<string, string> },
    completedPhaseIdx: number,
): Promise<{ action: "continue" | "replan" | "complete_early"; revisedPhases?: typeof task.phases; reason: string }> {
    const completedSummary = task.phases.slice(0, completedPhaseIdx + 1)
        .map(p => `- ${p.id}: ${task.checkpointData[p.id]?.substring(0, 150) || "no output"}`)
        .join("\n");

    const remainingPhases = task.phases.slice(completedPhaseIdx + 1)
        .map(p => `- ${p.id} [${p.role}]: ${p.description}`)
        .join("\n");

    const prompt = `A multi-phase task is in progress.

TASK: "${task.description}"

COMPLETED PHASES:
${completedSummary}

REMAINING PHASES:
${remainingPhases}

Should we:
1. "continue" — remaining phases are still valid
2. "replan" — revise remaining phases based on what we learned
3. "complete_early" — the task is essentially done, no more phases needed

Output JSON: {"action": "continue"|"replan"|"complete_early", "reason": "...", "revisedPhases": [...]}`;

    try {
        const response = await llm.chat({
            messages: [{ role: "user", content: prompt }] as ChatCompletionMessageParam[],
            systemPrompt: "You review task progress. Output valid JSON only.",
            modelOverride: selectForPlanning(task.description).modelId,
        });

        const text = response.choices?.[0]?.message?.content || "";
        const jsonStr = extractJSON(text);
        if (!jsonStr) return { action: "continue", reason: "Could not parse replan response" };

        const parsed = JSON.parse(jsonStr);
        return {
            action: (["continue", "replan", "complete_early"] as const).includes(parsed.action) ? parsed.action : "continue",
            reason: parsed.reason || "",
            revisedPhases: parsed.revisedPhases,
        };
    } catch {
        return { action: "continue", reason: "Replan check failed" };
    }
}

/** A phase is done only if it ran and didn't fail; failed phases re-run on resume. */
export function phaseSucceeded(task: Pick<LongTask, "checkpointData">, phaseId: string): boolean {
    const out = task.checkpointData[phaseId];
    return !!out && !out.startsWith("PHASE FAILED:") && !out.startsWith("PHASE ERROR:");
}

/**
 * Before a resume: a phase that ran on a failed phase's output is stale, so
 * its checkpoint is dropped and it re-runs after the failed phase does.
 */
export function invalidateStaleDependents(task: Pick<LongTask, "phases" | "checkpointData">): void {
    const rerun = new Set(task.phases.filter((p) => !phaseSucceeded(task, p.id)).map((p) => p.id));
    let changed = true;
    while (changed) {
        changed = false;
        for (const p of task.phases) {
            if (rerun.has(p.id) || !p.depends_on.some((d) => rerun.has(d))) continue;
            delete task.checkpointData[p.id];
            rerun.add(p.id);
            changed = true;
        }
    }
}

// ── Types ─────────────────────────────────────

export interface TaskPhase {
    id: string;
    role: AgentRole;
    description: string;
    depends_on: string[];       // Phase IDs that must complete first
    maxIterations?: number;     // Override per-phase (default 100)
    timeoutMs?: number;         // Override per-phase (default 600000 = 10 min)
}

export interface LongTask {
    id: string;
    description: string;
    phases: TaskPhase[];
    status: "planning" | "running" | "paused" | "completed" | "failed" | "cancelled";
    currentPhase: number;
    startedAt: string;
    updatedAt: string;
    checkpointData: Record<string, string>;  // phaseId → output
    error?: string;
    totalDurationMs: number;
}

export interface LongTaskProgress {
    taskId: string;
    phasesTotal: number;
    phasesCompleted: number;
    currentPhaseId: string;
    currentPhaseDescription: string;
    status: LongTask["status"];
    elapsedMs: number;
    estimatedRemainingMs?: number; // ETA based on average phase duration
}

// ── Constants ─────────────────────────────────

const DATA_DIR = join(process.env.ATLAS_DATA_DIR || join(process.cwd(), "data"), "long-tasks");
const MAX_PHASES = 20;           // Hard cap — most tasks need 2-8 phases
const DEFAULT_PHASE_ITERATIONS = 50;    // Sub-agents rarely need >30 iterations
const DEFAULT_PHASE_TIMEOUT = 600_000;  // 10 minutes per phase
const PROGRESS_INTERVAL_MS = 30_000;    // Progress update every 30s
const HEARTBEAT_CHECKPOINT_MS = 60_000; // Heartbeat checkpoint every 60s during execution

// ── In-Memory Store ───────────────────────────

const activeTasks = new Map<string, LongTask>();
const taskAbortControllers = new Map<string, AbortController>();
let taskCounter = 0;

// ── Memory Leak Prevention: periodic cleanup of completed/failed/cancelled tasks ──
const TASK_CLEANUP_AGE_MS = 60 * 60 * 1000; // 1 hour

function cleanupStaleTasks(): void {
    const now = Date.now();
    for (const [id, task] of activeTasks) {
        if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
            const updatedAt = new Date(task.updatedAt).getTime();
            if (now - updatedAt > TASK_CLEANUP_AGE_MS) {
                activeTasks.delete(id);
                taskAbortControllers.delete(id);
                console.log(`[LONG-TASK] 🧹 Cleaned up stale task: ${id} (${task.status})`);
            }
        }
    }
}

// Run cleanup every 30 minutes
const _taskCleanupInterval = setInterval(cleanupStaleTasks, 30 * 60 * 1000);
_taskCleanupInterval.unref(); // Don't prevent process exit

// ── Ensure data directory ─────────────────────

async function ensureDataDir(): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });
}

// ── Checkpoint Persistence ────────────────────

async function saveCheckpoint(task: LongTask): Promise<void> {
    await ensureDataDir();
    const filePath = join(DATA_DIR, `${task.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(task, null, 2));
}

async function loadCheckpoint(taskId: string): Promise<LongTask | null> {
    try {
        const filePath = join(DATA_DIR, `${taskId}.json`);
        const data = await fs.readFile(filePath, "utf-8");
        return JSON.parse(data) as LongTask;
    } catch {
        return null;
    }
}

async function listSavedTasks(): Promise<string[]> {
    try {
        await ensureDataDir();
        const files = await fs.readdir(DATA_DIR);
        return files.filter(f => f.endsWith(".json")).map(f => f.replace(".json", ""));
    } catch {
        return [];
    }
}

// ── Plan Generation ───────────────────────────

async function planLongTask(
    llm: LLMClient,
    description: string,
): Promise<TaskPhase[]> {
    // ── Gather memory-informed context for better planning ──
    let memoryContext = "";
    try {
        const planningCtx = await getMemoryInformedContext(description, 5, 3);
        if (planningCtx.contextSummary) {
            memoryContext = `\n\nRELEVANT CONTEXT FROM PAST EXPERIENCE:\n${planningCtx.contextSummary}\n\nUse this context to inform your phase planning — avoid repeating past mistakes and leverage known strategies.`;
            console.log(`[LONG-TASK] 🧠 Memory context: ${planningCtx.relevantMemories.length} memories, ${planningCtx.taskLearnings.length} learnings, ${planningCtx.relevantEntities.length} entities`);
        }
    } catch (memErr) {
        console.warn(`[LONG-TASK] Memory-informed planning failed (non-fatal):`, (memErr as Error).message);
    }

    const prompt = `You are a task planner for long-running, complex tasks. Break down the following task into sequential phases.

Each phase will be executed by a specialized agent. Phases run one at a time (sequentially), with each phase receiving the output of previous phases as context.

Available agent roles:
- "researcher": Can search the web, search memory, read files. Use for information gathering.
- "coder": Can run shell commands, read/write files. Use for coding and file operations.
- "browser": Can navigate websites, click, type, extract data. Use for web automation.
- "system": Can run AppleScript, shell commands, take screenshots. Use for macOS automation.
- "general": Can use all tools. Use when a task doesn't fit other roles.

Rules:
- Maximum ${MAX_PHASES} phases, but use the MINIMUM needed. Most tasks need 2-5 phases. More than 8 is extremely rare.
- Phase count guidelines (IMPORTANT):
  * Content creation (documents, presentations, scripts): 2-4 phases max (e.g., research+create, polish, verify)
  * Software install/setup: 3-5 phases
  * Multi-step workflows: 5-8 phases max
  * NEVER exceed 8 phases unless genuinely required
  * Fewer phases is ALWAYS better — combine related work into one phase
- Each phase has: id (e.g. "p1"), role, description, depends_on (list of phase IDs)
- Give each phase a VERY detailed description — the agent executing it needs full context
- For researcher phases: specify EXACT topics in the description. Do NOT write vague descriptions like "Research best practices". Example: "Research AGI: (1) definition vs narrow AI, (2) timeline estimates, (3) key challenges. Use deep_research with profile='quick'."
- For content creation, prefer combining research into the creation phase. If research is separate, use profile="quick".
- For tasks that involve waiting (downloads, builds), wrap them in a single phase with clear instructions to monitor and wait
- Consider error recovery: if a download might fail, include retry logic in the description
- Output ONLY valid JSON array of phases, no markdown, no explanation

Example output:
[
    {"id": "p1", "role": "researcher", "description": "Search for the download URL of XYZ software from the official website", "depends_on": []},
    {"id": "p2", "role": "coder", "description": "Download the file using curl/wget and verify the checksum. If download fails, retry up to 3 times.", "depends_on": ["p1"]},
    {"id": "p3", "role": "coder", "description": "Install the software and verify it works by running the version command", "depends_on": ["p2"]}
]

Task: ${description}${memoryContext}`;

    try {
        const response = await llm.chat({
            messages: [{ role: "user", content: prompt }] as ChatCompletionMessageParam[],
            systemPrompt: "You are a JSON-only task planner. Output valid JSON only — a JSON array of phase objects.",
            modelOverride: selectForPlanning(description).modelId,
        });

        const text = response.choices?.[0]?.message?.content || "";
        const jsonStr = extractJSON(text);
        if (!jsonStr) {
            // Fallback: single phase
            return [{
                id: "p1",
                role: "general" as AgentRole,
                description,
                depends_on: [],
            }];
        }

        const parsed = JSON.parse(jsonStr) as Array<{
            id: string;
            role: string;
            description: string;
            depends_on?: string[];
            maxIterations?: number;
            timeoutMs?: number;
        }>;

        const validRoles: AgentRole[] = ["researcher", "coder", "browser", "system", "general"];
        return parsed.slice(0, MAX_PHASES).map(p => ({
            id: p.id || `p${parsed.indexOf(p) + 1}`,
            role: (validRoles.includes(p.role as AgentRole) ? p.role : "general") as AgentRole,
            description: p.description,
            depends_on: Array.isArray(p.depends_on) ? p.depends_on : [],
            maxIterations: p.maxIterations,
            timeoutMs: p.timeoutMs,
        }));
    } catch (err) {
        console.error("[LONG-TASK] Planning failed:", (err as Error).message);
        // Fallback: single phase
        return [{
            id: "p1",
            role: "general" as AgentRole,
            description,
            depends_on: [],
        }];
    }
}

// ── Execute Long Task ─────────────────────────

export async function startLongTask(
    llm: LLMClient,
    description: string,
    onProgress?: (progress: LongTaskProgress) => Promise<void>,
): Promise<LongTask> {
    const id = `lt_${++taskCounter}_${Date.now()}`;
    const abortController = new AbortController();

    console.log(`[LONG-TASK] 🚀 Starting long task: ${id}`);
    console.log(`[LONG-TASK] Description: ${description}`);

    // Plan the task
    const phases = await planLongTask(llm, description);
    console.log(`[LONG-TASK] 📋 Planned ${phases.length} phases`);

    const task: LongTask = {
        id,
        description,
        phases,
        status: "running",
        currentPhase: 0,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        checkpointData: {},
        totalDurationMs: 0,
    };

    activeTasks.set(id, task);
    taskAbortControllers.set(id, abortController);
    await saveCheckpoint(task);

    // Execute phases asynchronously (fire and forget — this runs in the background)
    // Cancelling the task (not the turn that started it) ends a wait on the owner inside it.
    withTurnSignal(abortController.signal, () => executePhases(llm, task, abortController.signal, onProgress)).catch(err => {
        console.error(`[LONG-TASK] Fatal error in task ${id}:`, err);
        task.status = "failed";
        task.error = (err as Error).message;
        task.updatedAt = new Date().toISOString();
        saveCheckpoint(task).catch(() => { });
    });

    return task;
}

async function executePhases(
    llm: LLMClient,
    task: LongTask,
    signal: AbortSignal,
    onProgress?: (progress: LongTaskProgress) => Promise<void>,
): Promise<void> {
    const startTime = Date.now();
    let lastHeartbeatCheckpoint = Date.now();

    for (let i = task.currentPhase; i < task.phases.length; i++) {
        if (signal.aborted) {
            task.status = "cancelled";
            task.updatedAt = new Date().toISOString();
            await saveCheckpoint(task);
            console.log(`[LONG-TASK] ❌ Task ${task.id} cancelled at phase ${i + 1}/${task.phases.length}`);
            return;
        }

        const phase = task.phases[i];
        if (phaseSucceeded(task, phase.id)) continue; // resumed: already done
        const phaseStartTime = Date.now();
        task.currentPhase = i;
        task.updatedAt = new Date().toISOString();

        // Log with duration estimate for long tasks
        const elapsedHrs = ((Date.now() - startTime) / 3600000).toFixed(1);
        console.log(`[LONG-TASK] ▶ Phase ${i + 1}/${task.phases.length}: ${phase.id} [${phase.role}] (task running ${elapsedHrs}h)`);
        console.log(`[LONG-TASK]   └ ${phase.description.substring(0, 120)}`);

        // Send progress with ETA estimate
        if (onProgress) {
            const elapsed = Date.now() - startTime;
            const avgPhaseMs = i > 0 ? elapsed / i : undefined;
            const remaining = avgPhaseMs ? Math.round(avgPhaseMs * (task.phases.length - i)) : undefined;

            await onProgress({
                taskId: task.id,
                phasesTotal: task.phases.length,
                phasesCompleted: i,
                currentPhaseId: phase.id,
                currentPhaseDescription: phase.description,
                status: task.status,
                elapsedMs: elapsed,
                estimatedRemainingMs: remaining,
            }).catch(() => { });
        }

        // Gather context from dependency phases
        const depContext = phase.depends_on
            .map(depId => {
                const output = task.checkpointData[depId];
                if (!output) return "";
                return `### Result from phase ${depId}:\n${output}`;
            })
            .filter(Boolean)
            .join("\n\n");

        // Set up periodic progress + heartbeat checkpoint
        let progressTimer: ReturnType<typeof setInterval> | null = null;
        if (onProgress) {
            progressTimer = setInterval(async () => {
                const now = Date.now();

                // Progress notification
                await onProgress({
                    taskId: task.id,
                    phasesTotal: task.phases.length,
                    phasesCompleted: i,
                    currentPhaseId: phase.id,
                    currentPhaseDescription: phase.description,
                    status: task.status,
                    elapsedMs: now - startTime,
                }).catch(() => { });

                // Heartbeat checkpoint (saves task state mid-phase for crash recovery)
                if (now - lastHeartbeatCheckpoint >= HEARTBEAT_CHECKPOINT_MS) {
                    task.totalDurationMs = now - startTime;
                    task.updatedAt = new Date().toISOString();
                    await saveCheckpoint(task).catch(err =>
                        console.warn(`[LONG-TASK] Heartbeat checkpoint failed:`, err)
                    );
                    lastHeartbeatCheckpoint = now;
                }
            }, PROGRESS_INTERVAL_MS);
        }

        try {
            const result = await runSubAgent(llm, {
                id: phase.id,
                role: phase.role,
                description: phase.description,
                context: depContext || undefined,
                maxIterations: phase.maxIterations || DEFAULT_PHASE_ITERATIONS,
                timeoutMs: phase.timeoutMs || DEFAULT_PHASE_TIMEOUT,
                signal,
            });

            if (signal.aborted) {
                // Cancelled mid-phase: record nothing as done; cancelLongTask set the status.
                task.status = "cancelled";
                task.updatedAt = new Date().toISOString();
                await saveCheckpoint(task);
                console.log(`[LONG-TASK] ❌ Task ${task.id} cancelled during phase ${phase.id}`);
                return;
            }

            const phaseDurationSec = ((Date.now() - phaseStartTime) / 1000).toFixed(1);

            // Store result
            task.checkpointData[phase.id] = result.output;
            task.totalDurationMs = Date.now() - startTime;
            task.updatedAt = new Date().toISOString();

            if (!result.success) {
                console.warn(`[LONG-TASK] ⚠ Phase ${phase.id} failed after ${phaseDurationSec}s: ${result.error}`);
                // Don't fail the whole task — log the error and continue
                // (downstream phases will see the error in their context)
                task.checkpointData[phase.id] = `PHASE FAILED: ${result.error}\nPartial output: ${result.output}`;
            } else {
                console.log(`[LONG-TASK] ✅ Phase ${phase.id} completed (${result.toolCalls} tools, ${phaseDurationSec}s)`);
            }

            // Checkpoint after each phase
            await saveCheckpoint(task);

            // ── Inter-Phase Replanning (#10) ──
            const phaseFailed = !result.success;
            const completedCount = i + 1;
            if (completedCount < task.phases.length && shouldReplanPhases(result.output, phaseFailed, completedCount, task.phases.length)) {
                try {
                    // Track replan count to avoid infinite replanning
                    const replanKey = `__replan_count_${task.id}`;
                    const currentReplans = (task.checkpointData[replanKey] ? parseInt(task.checkpointData[replanKey]) : 0);

                    if (currentReplans < MAX_PHASE_REPLANS) {
                        const decision = await replanPhases(llm, task, i);
                        console.log(`[LONG-TASK] 🔄 Phase replan check: ${decision.action} — ${decision.reason}`);

                        if (decision.action === "complete_early") {
                            console.log(`[LONG-TASK] ⏩ Completing early: ${decision.reason}`);
                            break; // Exit phase loop
                        } else if (decision.action === "replan" && Array.isArray(decision.revisedPhases)) {
                            const validRoles: AgentRole[] = ["researcher", "coder", "browser", "system", "general"];
                            const newPhases = decision.revisedPhases
                                .filter((p: any) => p.id && p.description)
                                .map((p: any) => ({
                                    id: p.id,
                                    role: validRoles.includes(p.role) ? p.role : "general" as AgentRole,
                                    description: p.description,
                                    depends_on: Array.isArray(p.depends_on) ? p.depends_on : [],
                                }));

                            if (newPhases.length > 0) {
                                // Replace remaining phases; a reused id from an earlier run must run again.
                                const keptIds = new Set(task.phases.slice(0, i + 1).map((p) => p.id));
                                for (const p of newPhases) if (!keptIds.has(p.id)) delete task.checkpointData[p.id];
                                task.phases = [...task.phases.slice(0, i + 1), ...newPhases];
                                task.checkpointData[replanKey] = String(currentReplans + 1);
                                await saveCheckpoint(task);
                                console.log(`[LONG-TASK] 📋 Revised plan: ${newPhases.length} remaining phases`);
                            }
                        }
                    }
                } catch (replanErr) {
                    console.warn(`[LONG-TASK] Phase replan failed:`, (replanErr as Error).message);
                }
            }

        } catch (err) {
            const phaseDurationSec = ((Date.now() - phaseStartTime) / 1000).toFixed(1);
            console.error(`[LONG-TASK] Phase ${phase.id} threw after ${phaseDurationSec}s:`, (err as Error).message);
            task.checkpointData[phase.id] = `PHASE ERROR: ${(err as Error).message}`;
            task.updatedAt = new Date().toISOString();
            await saveCheckpoint(task);
        } finally {
            // Guarantee progressTimer is always cleared — prevents leaked intervals
            if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
        }
    }

    // Clean up completed/stale tasks from memory
    cleanupStaleTasks();

    // All phases done — run quality review before notifying the user
    task.totalDurationMs = Date.now() - startTime;
    task.updatedAt = new Date().toISOString();

    const totalHrs = (task.totalDurationMs / 3600000).toFixed(2);
    console.log(`[LONG-TASK] 📋 Task ${task.id} phases done (${totalHrs}h) — running quality review...`);

    // Collect all phase outputs for review
    const phaseOutputs = task.phases
        .map(p => {
            const out = task.checkpointData[p.id] || "(no output)";
            return `### Phase ${p.id} [${p.role}]: ${p.description.substring(0, 80)}\n${out.substring(0, 500)}`;
        })
        .join("\n\n");

    const failedPhases = task.phases.filter((p) => task.checkpointData[p.id] && !phaseSucceeded(task, p.id));

    // ── Quality Review Sub-Agent ──────────────────
    // Run a review agent that checks if the task was actually completed correctly,
    // verifies deliverables, and provides a user-friendly summary.
    let qualityReport = "";
    try {
        if (onProgress) {
            await onProgress({
                taskId: task.id,
                phasesTotal: task.phases.length,
                phasesCompleted: task.phases.length,
                currentPhaseId: "quality_review",
                currentPhaseDescription: "Reviewing work quality...",
                status: "running",
                elapsedMs: task.totalDurationMs,
            }).catch(() => { });
        }

        const reviewResult = await runSubAgent(llm, {
            id: `review_${task.id}`,
            role: "general",
            description: `You are reviewing a completed background task. Your job is to:
1. VERIFY the task was actually completed — check if any files/outputs that were supposed to be created actually exist (use list_directory, read, grep, shell_exec to check)
2. Assess QUALITY — does the output match what was requested?
3. Write a BRIEF user-facing summary (2-4 sentences) of what was done and where to find the results
4. If something is clearly broken or missing, try to FIX IT quickly (1-2 tool calls max)

ORIGINAL TASK: ${task.description.substring(0, 500)}

PHASE RESULTS:
${phaseOutputs.substring(0, 3000)}

${failedPhases.length > 0 ? `⚠️ ${failedPhases.length} phase(s) FAILED — check if the deliverable is still usable despite failures.` : ""}

Output format: Start with a one-line verdict (✅ DONE / ⚠️ PARTIAL / ❌ FAILED), then 2-4 sentences explaining what was accomplished and where to find the result.`,
            maxIterations: 15,
            timeoutMs: 120_000, // 2 min max for review
            signal,
        });
        if (signal.aborted) return; // cancelled during review — keep "cancelled"

        qualityReport = reviewResult.output || "";
        task.checkpointData["__quality_review"] = qualityReport;
        console.log(`[LONG-TASK] ✅ Quality review complete for ${task.id}: ${qualityReport.substring(0, 100)}...`);
    } catch (reviewErr) {
        console.warn(`[LONG-TASK] ⚠ Quality review failed: ${(reviewErr as Error).message}`);
        // Fall back to basic summary
        const lastPhaseId = task.phases[task.phases.length - 1]?.id;
        const lastOutput = lastPhaseId ? (task.checkpointData[lastPhaseId] || "") : "";
        qualityReport = failedPhases.length > 0
            ? `⚠️ PARTIAL — Task completed with ${failedPhases.length} failed phase(s). Last output: ${lastOutput.substring(0, 200)}`
            : `✅ DONE — All ${task.phases.length} phases completed. Last output: ${lastOutput.substring(0, 200)}`;
    }

    task.status = "completed";
    task.updatedAt = new Date().toISOString();
    await saveCheckpoint(task);

    console.log(`[LONG-TASK] 🎉 Task ${task.id} fully completed! ${task.phases.length} phases + review in ${totalHrs}h`);

    // ── Auto-Skill Creation ─────────────────────────
    // After complex long-tasks complete, try to extract a reusable skill
    try {
        const toolCallRecords: ToolCallRecord[] = task.phases.map(p => ({
            name: `phase_${p.role}`,
            args: { description: p.description },
            result: (task.checkpointData[p.id] || "").substring(0, 300),
        }));
        const taskOutcome = failedPhases.length === 0 ? "success" as const
            : failedPhases.length < task.phases.length ? "partial" as const
            : "failure" as const;
        maybeCreateSkill(llm, task.description, toolCallRecords, taskOutcome).catch(err =>
            console.warn("[LONG-TASK] Auto-skill creation failed (non-fatal):", (err as Error).message)
        );
    } catch (skillErr) {
        console.warn("[LONG-TASK] Auto-skill creation failed (non-fatal):", (skillErr as Error).message);
    }

    // ── Notify user with reviewed result ──────────
    if (onProgress) {
        const totalSec = (task.totalDurationMs / 1000).toFixed(0);
        await onProgress({
            taskId: task.id,
            phasesTotal: task.phases.length,
            phasesCompleted: task.phases.length,
            currentPhaseId: "done",
            currentPhaseDescription: qualityReport || `All ${task.phases.length} phases completed in ${totalSec}s.`,
            status: "completed",
            elapsedMs: task.totalDurationMs,
        }).catch(() => { });
    }
}

// ── Resume from Checkpoint ────────────────────

export async function resumeLongTask(
    llm: LLMClient,
    taskId: string,
    onProgress?: (progress: LongTaskProgress) => Promise<void>,
): Promise<LongTask | null> {
    const task = await loadCheckpoint(taskId);
    if (!task) return null;

    if (task.status === "completed") {
        console.log(`[LONG-TASK] Task ${taskId} already completed.`);
        return task;
    }

    // Resume from the first phase that didn't succeed (failed ones re-run)
    invalidateStaleDependents(task);
    const nextPhase = task.phases.findIndex((p) => !phaseSucceeded(task, p.id));
    if (nextPhase === -1) {
        task.status = "completed";
        await saveCheckpoint(task);
        return task;
    }

    task.currentPhase = nextPhase;
    task.status = "running";
    task.updatedAt = new Date().toISOString();

    const abortController = new AbortController();
    activeTasks.set(taskId, task);
    taskAbortControllers.set(taskId, abortController);

    console.log(`[LONG-TASK] 🔄 Resuming task ${taskId} from phase ${nextPhase + 1}/${task.phases.length}`);

    // Cancelling the task (not the turn that started it) ends a wait on the owner inside it.
    withTurnSignal(abortController.signal, () => executePhases(llm, task, abortController.signal, onProgress)).catch(err => {
        console.error(`[LONG-TASK] Fatal error resuming task ${taskId}:`, err);
        task.status = "failed";
        task.error = (err as Error).message;
        saveCheckpoint(task).catch(() => { });
    });

    return task;
}

// ── Query / Cancel ────────────────────────────

export function getLongTaskStatus(taskId: string): LongTask | null {
    return activeTasks.get(taskId) || null;
}

export function cancelLongTask(taskId: string): boolean {
    const controller = taskAbortControllers.get(taskId);
    if (controller) {
        controller.abort();
        taskAbortControllers.delete(taskId);
        const task = activeTasks.get(taskId);
        if (task) {
            task.status = "cancelled";
            task.updatedAt = new Date().toISOString();
            saveCheckpoint(task).catch(() => { });
        }
        return true;
    }
    return false;
}

export function listActiveLongTasks(): LongTask[] {
    return Array.from(activeTasks.values());
}

export { listSavedTasks, loadCheckpoint };

// ── Auto-Resume Interrupted Tasks ──────────────
// Call this on boot to resume any tasks that were running when the process died

export async function autoResumeInterruptedTasks(
    llm: LLMClient,
    onProgress?: (progress: LongTaskProgress) => Promise<void>,
): Promise<{ resumed: string[]; skipped: string[] }> {
    const resumed: string[] = [];
    const skipped: string[] = [];

    try {
        const savedIds = await listSavedTasks();
        for (const taskId of savedIds) {
            const task = await loadCheckpoint(taskId);
            if (!task) continue;

            // Only resume tasks that were running (not completed/cancelled/failed)
            if (task.status === "running" || task.status === "paused") {
                console.log(`[LONG-TASK] 🔄 Auto-resuming interrupted task: ${taskId}`);
                const nextPhase = task.phases.findIndex((p) => !phaseSucceeded(task, p.id));
                if (nextPhase >= 0) {
                    await resumeLongTask(llm, taskId, onProgress);
                    resumed.push(taskId);
                } else {
                    // All phases actually done, just mark complete
                    task.status = "completed";
                    task.updatedAt = new Date().toISOString();
                    await saveCheckpoint(task);
                    skipped.push(taskId);
                }
            } else {
                skipped.push(taskId);
            }
        }
    } catch (err) {
        console.error("[LONG-TASK] Auto-resume failed:", (err as Error).message);
    }

    if (resumed.length > 0) {
        console.log(`[LONG-TASK] ✅ Auto-resumed ${resumed.length} interrupted task(s)`);
    }

    return { resumed, skipped };
}
