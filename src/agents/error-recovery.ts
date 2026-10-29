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

// ── Coding error enrichment helpers (Phase 4C) ────

const CODING_CATEGORIES = new Set<ErrorCategory>([
    ErrorCategory.SyntaxError,
    ErrorCategory.TypeError,
    ErrorCategory.TestFailure,
    ErrorCategory.LintError,
    ErrorCategory.BuildError,
    ErrorCategory.ImportError,
    ErrorCategory.RuntimeError,
]);

function isCodingErrorCategory(cat: ErrorCategory): boolean {
    return CODING_CATEGORIES.has(cat);
}

function categoryRecoveryHint(cat: ErrorCategory): string {
    switch (cat) {
        case ErrorCategory.TypeError:
            return "Hint: read the type definition for the mismatched value. Adjust either the call site or the declared type — not both.";
        case ErrorCategory.SyntaxError:
            return "Hint: parse error. Fix syntactically at the reported line — don't rewrite logic.";
        case ErrorCategory.TestFailure:
            return "Hint: read the failing assertion, understand what invariant broke, then edit the implementation (not the test unless the contract changed).";
        case ErrorCategory.LintError:
            return "Hint: run the linter with --fix first; if it doesn't auto-resolve, make the minimal change to satisfy the rule.";
        case ErrorCategory.BuildError:
            return "Hint: check for missing imports, unresolved paths, or misconfigured bundler entries before touching business logic.";
        case ErrorCategory.ImportError:
            return "Hint: verify the import path exists, the package is installed, and the exports match what's imported.";
        case ErrorCategory.RuntimeError:
            return "Hint: read the stack trace bottom-up — the innermost frame is where bad data entered a bad function.";
        default:
            return "Hint: localize first, read surrounding code, then make a minimal targeted edit.";
    }
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

    // Side effects (sends, clicks, edits) that already completed in any attempt.
    // A blind re-run would repeat them, so once any ran we only rephrase.
    const ran = new Set<string>();
    const run = async (t: SubAgentTask): Promise<SubAgentResult> => {
        const r = await runSubAgent(llm, t, onProgress);
        for (const m of r.mutatorsRan ?? []) ran.add(m);
        return { ...r, mutatorsRan: [...ran] };
    };
    const alreadyRanNote = (): string =>
        ran.size > 0
            ? `\n\n⚠️ These actions ALREADY RAN in an earlier attempt: ${[...ran].join(", ")}. Check their effects and do NOT repeat them — continue from where it stopped.`
            : "";

    // ── Level 0: Initial execution ──
    let result = await run(task);
    if (result.success) return result;

    const classified = classifyError(result.error || "unknown error", undefined, result.durationMs);

    // ── Self-Heal: Auto-fix missing dependencies before retrying ──
    if (classified.category === ErrorCategory.DependencyMissing) {
        console.log(`  🔧 Self-heal: detected dependency issue in step ${task.id}`);
        const heal = await attemptSelfHeal(result.error || "", classified.category);
        if (heal.fixed && ran.size === 0) {
            console.log(`  🔧 Self-heal: fix applied (${heal.action}) — retrying step`);
            attempts.push({ level: 0, action: "retry", reason: `Self-healed: ${heal.action}` });
            result = await run(task);
            if (result.success) return result;
            // If still failing after self-heal, continue to normal recovery
        }
    }

    // If not retryable at all, skip immediately
    if (!classified.retryable && classified.category !== ErrorCategory.ToolMissing) {
        console.warn(`  ⚠️ Recovery: step ${task.id} failed (non-retryable: ${classified.category})`);
        return result;
    }

    // ── Level 0: Retry with backoff (only when nothing with side effects ran) ──
    if (classified.retryable && ran.size > 0) {
        console.log(`  🔄 Recovery: step ${task.id} already ran ${[...ran].join(", ")} — skipping blind retry`);
    } else if (classified.retryable) {
        for (let attempt = 0; attempt < p.maxRetries; attempt++) {
            if (Date.now() - recoveryStart > p.budgetMs) break;

            const backoff = jitteredBackoff(p.backoffMs, attempt);
            console.log(`  🔄 Recovery: retrying step ${task.id} (attempt ${attempt + 1}/${p.maxRetries}, backoff ${backoff}ms)`);
            await sleep(backoff);

            attempts.push({ level: 0, action: "retry", reason: classified.message });
            result = await run(task);
            if (result.success) return result;
            if (ran.size > 0) break; // this attempt had side effects — no more blind retries
        }
    }

    // ── Level 1: Rephrase (append error context) ──
    if (p.enableRephrase && Date.now() - recoveryStart < p.budgetMs) {
        // Phase 4C: for coding-specific errors, enrich the rephrase with the
        // extracted location + category hint so the agent can localize and
        // read before editing, instead of guessing.
        let codingHint = "";
        if (isCodingErrorCategory(classified.category)) {
            const loc = classified.codeLocation;
            const locHint = loc?.file
                ? `Location: ${loc.file}${loc.line ? `:${loc.line}` : ""}${loc.column ? `:${loc.column}` : ""}. Read that file around the reported line before editing.`
                : "No file location extracted — use grep or the fix_issue tool to localize before editing.";
            const catHint = categoryRecoveryHint(classified.category);
            codingHint = `\n\n🔧 CODING ERROR CONTEXT\nCategory: ${classified.category}\n${locHint}\n${catHint}\nRun \`test_run\` after the edit to verify the fix.`;
        }
        const rephrasedDesc = `${task.description}\n\n⚠️ IMPORTANT: A previous attempt at this task failed with: "${result.error || "unknown error"}". Please try a DIFFERENT approach. Avoid the approach that failed.${codingHint}${alreadyRanNote()}`;

        console.log(`  🔄 Recovery: rephrasing step ${task.id}`);
        attempts.push({ level: 1, action: "rephrase", reason: "Previous attempt failed" });

        result = await run({
            ...task,
            description: rephrasedDesc,
        });
        if (result.success) return result;
    }

    // ── Level 2: Reroute (switch role) ──
    if (p.enableReroute && classified.category === ErrorCategory.ToolMissing && Date.now() - recoveryStart < p.budgetMs) {
        const alternatives = REROUTE_MAP[task.role] || ["general"];
        for (const altRole of alternatives) {
            if (Date.now() - recoveryStart > p.budgetMs) break;

            console.log(`  🔄 Recovery: rerouting step ${task.id} from ${task.role} → ${altRole}`);
            attempts.push({ level: 2, action: "reroute", reason: `Reroute to ${altRole}` });

            result = await run({
                ...task,
                description: task.description + alreadyRanNote(),
                role: altRole as AgentRole,
            });
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

// Full jitter decorrelates parallel sub-agent recoveries that would otherwise
// retry the same upstream fault in lockstep and re-collide.
export function jitteredBackoff(backoffMs: number, attempt: number): number {
    const base = backoffMs * 2 ** attempt;
    if (process.env.ATLAS_NO_RECOVERY_JITTER === "true") return base;
    return base + Math.random() * (base / 2);
}
