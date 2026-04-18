// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Layered Error Recovery for Mesh Steps ────
// Multi-level recovery chain for failed sub-agent executions.
// Level 0: Retry (same params, exponential backoff)
// Level 1: Rephrase (append error context to description)
// Level 2: Reroute (switch to different role if tool mismatch)
// Level 3: Skip (mark failed, propagate error context downstream)

import type { LLMClient } from "../llm.js";
import { runSubAgent, type SubAgentResult, type SubAgentTask, type AgentRole } from "./sub-agent.js";
import { classifyError, ErrorCategory, type ClassifiedError } from "./error-types.js";
import { attemptSelfHeal } from "./self-heal.js";

// ── Configuration ────────────────────────────

export interface RecoveryPolicy {
    /** Maximum retry attempts at Level 0 (same params). Default: 2 */
    maxRetries: number;
    /** Base backoff in ms (doubles each retry). Default: 2000 */
    backoffMs: number;
    /** Total budget in ms for all recovery attempts. Default: 120000 (2 min) */
    budgetMs: number;
    /** Whether to attempt rephrase (Level 1). Default: true */
    enableRephrase: boolean;
    /** Whether to attempt reroute (Level 2). Default: true */
    enableReroute: boolean;
}

const DEFAULT_POLICY: RecoveryPolicy = {
    maxRetries: 2,
    backoffMs: 2000,
    budgetMs: 120000,
    enableRephrase: true,
    enableReroute: true,
};

// ── Recovery Actions ─────────────────────────

interface RecoveryAttempt {
    level: 0 | 1 | 2 | 3;
    action: "retry" | "rephrase" | "reroute" | "skip";
    reason: string;
    modifiedTask?: Partial<SubAgentTask>;
}

// ── Role Reroute Suggestions ─────────────────

const REROUTE_MAP: Partial<Record<AgentRole, AgentRole[]>> = {
    researcher: ["general", "browser"],
    coder: ["general"],
    browser: ["general", "system"],
    system: ["general", "coder"],
};

// ── Recovery Executor ────────────────────────

/**
 * Execute a sub-agent task with multi-level error recovery.
 * Falls back through retry → rephrase → reroute → skip.
 */
export async function executeWithRecovery(
    llm: LLMClient,
    task: SubAgentTask,
    onProgress?: (stepId: string, msg: string) => Promise<void>,
    policy: Partial<RecoveryPolicy> = {},
): Promise<SubAgentResult> {
    const p = { ...DEFAULT_POLICY, ...policy };
    const recoveryStart = Date.now();
    const attempts: RecoveryAttempt[] = [];

    // ── Reflexion: Check past recovery lessons before starting ──
    try {
        const { recall } = await import("../memory/sqlite.js");
        const pastLessons = await recall(`recovery failure ${task.role} ${task.description.substring(0, 50)}`, 2);
        if (pastLessons.length > 0) {
            const lessonText = pastLessons.map(m => m.content).join("\n");
            task = { ...task, description: task.description + `\n\n[PAST RECOVERY LESSON]: ${lessonText}` };
        }
    } catch { /* non-fatal — memory may not be initialized */ }

    // ── Level 0: Initial execution ──
    let result = await runSubAgent(llm, task, onProgress);
    if (result.success) return result;

    const classified = classifyError(result.error || "unknown error", undefined, result.durationMs);

    // ── Self-Heal: Auto-fix missing dependencies before retrying ──
    if (classified.category === ErrorCategory.DependencyMissing) {
        console.log(`  🔧 Self-heal: detected dependency issue in step ${task.id}`);
        const heal = await attemptSelfHeal(result.error || "", classified.category);
        if (heal.fixed) {
            console.log(`  🔧 Self-heal: fix applied (${heal.action}) — retrying step`);
            attempts.push({ level: 0, action: "retry", reason: `Self-healed: ${heal.action}` });
            result = await runSubAgent(llm, task, onProgress);
            if (result.success) return result;
            // If still failing after self-heal, continue to normal recovery
        }
    }

    // If not retryable at all, skip immediately
    if (!classified.retryable && classified.category !== ErrorCategory.ToolMissing) {
        console.warn(`  ⚠️ Recovery: step ${task.id} failed (non-retryable: ${classified.category})`);
        return result;
    }

    // ── Level 0: Retry with backoff ──
    if (classified.retryable) {
        for (let attempt = 0; attempt < p.maxRetries; attempt++) {
            if (Date.now() - recoveryStart > p.budgetMs) break;

            const backoff = p.backoffMs * Math.pow(2, attempt);
            console.log(`  🔄 Recovery: retrying step ${task.id} (attempt ${attempt + 1}/${p.maxRetries}, backoff ${backoff}ms)`);
            await sleep(backoff);

            attempts.push({ level: 0, action: "retry", reason: classified.message });
            result = await runSubAgent(llm, task, onProgress);
            if (result.success) return result;
        }
    }

    // ── Level 1: Rephrase (append error context) ──
    if (p.enableRephrase && Date.now() - recoveryStart < p.budgetMs) {
        const rephrasedDesc = `${task.description}\n\n⚠️ IMPORTANT: A previous attempt at this task failed with: "${result.error || "unknown error"}". Please try a DIFFERENT approach. Avoid the approach that failed.`;

        console.log(`  🔄 Recovery: rephrasing step ${task.id}`);
        attempts.push({ level: 1, action: "rephrase", reason: "Previous attempt failed" });

        result = await runSubAgent(llm, {
            ...task,
            description: rephrasedDesc,
        }, onProgress);
        if (result.success) return result;
    }

    // ── Level 2: Reroute (switch role) ──
    if (p.enableReroute && classified.category === ErrorCategory.ToolMissing && Date.now() - recoveryStart < p.budgetMs) {
        const alternatives = REROUTE_MAP[task.role] || ["general"];
        for (const altRole of alternatives) {
            if (Date.now() - recoveryStart > p.budgetMs) break;

            console.log(`  🔄 Recovery: rerouting step ${task.id} from ${task.role} → ${altRole}`);
            attempts.push({ level: 2, action: "reroute", reason: `Reroute to ${altRole}` });

            result = await runSubAgent(llm, {
                ...task,
                role: altRole as AgentRole,
            }, onProgress);
            if (result.success) return result;
        }
    }

    // ── Level 3: Skip (return failure with enriched context) ──
    console.warn(`  ❌ Recovery: step ${task.id} exhausted all recovery options (${attempts.length} attempts)`);

    // ── Reflexion: Store recovery reflection for future learning ──
    try {
        const { remember } = await import("../memory/sqlite.js");
        const reflection = `Tool ${task.id} (role: ${task.role}) failed after ${attempts.length} recovery attempts. ` +
            `Levels tried: ${attempts.map(a => a.action).join(" → ")}. ` +
            `Final error: ${(result.error || "unknown").substring(0, 200)}. ` +
            `Lesson: This approach did not work — try a fundamentally different strategy next time.`;
        remember(reflection, "recovery_reflection", `error,${task.role},recovery`, 7, "reflection");
    } catch { /* non-fatal — memory may not be initialized */ }

    return {
        ...result,
        error: `[RECOVERY EXHAUSTED after ${attempts.length} attempts] ${result.error || "unknown error"}. Levels tried: ${attempts.map(a => a.action).join(" → ")}`,
    };
}

// ── Helpers ──────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
