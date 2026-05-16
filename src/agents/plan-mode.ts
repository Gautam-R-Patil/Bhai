// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Plan Mode ─────────────────────────────────
// A Claude-Code-style plan/act split. When plan mode is active:
//   • The agent can only call read-only tools (read, grep, glob, web_search, etc.)
//   • Every mutation tool (edit, write, shell_exec, memory_store, etc.) is
//     stripped from the tool schema before it reaches the LLM.
//   • A <system-reminder> reminds the model it's in planning mode.
// Exit is triggered by calling `exit_plan_mode` (with a plan body), which
// flips the state back to "act" and returns the plan to the UI for display.
//
// ATLAS is single-user per-process, so state lives at module scope. If/when
// concurrent sessions ever matter, this becomes a Map<sessionId, State>.

import fs from "node:fs";
import path from "node:path";

// ── State ─────────────────────────────────────

export type PlanModeState =
    | { mode: "act" }
    | {
        mode: "plan";
        enteredAt: number;
        reason: string;
        /** User-originated (/plan command) vs agent-internal auto-trigger */
        source: "user" | "auto";
    }
    | {
        mode: "spec";
        enteredAt: number;
        task: string;
        specPath: string;
        source: "user" | "auto";
    }
    | {
        mode: "awaiting_approval";
        enteredAt: number;
        task: string;
        /** Directory containing PRD.md / TECHNICAL.md / ARCHITECTURE.md */
        designDocsDir: string;
        source: "user" | "auto";
    };

let state: PlanModeState = { mode: "act" };

/** Optional listener fired when mode changes. UI/channel layers subscribe. */
type Listener = (s: PlanModeState) => void;
const listeners: Set<Listener> = new Set();

function emit() {
    for (const l of listeners) {
        try {
            l(state);
        } catch {
            /* listener failures must never affect agent flow */
        }
    }
}

// ── Public API ────────────────────────────────

export function isPlanMode(): boolean {
    return state.mode === "plan";
}

export function isSpecMode(): boolean {
    return state.mode === "spec";
}

export function isAwaitingApproval(): boolean {
    return state.mode === "awaiting_approval";
}

export function getPlanModeState(): PlanModeState {
    return state;
}

export function enterPlanMode(reason: string, source: "user" | "auto" = "user"): void {
    state = { mode: "plan", enteredAt: Date.now(), reason, source };
    emit();
}

export function exitPlanMode(): void {
    state = { mode: "act" };
    emit();
}

export function enterSpecMode(task: string, specPath: string, source: "user" | "auto" = "user"): void {
    state = { mode: "spec", enteredAt: Date.now(), task, specPath, source };
    emit();
}

/** Transition from spec → plan once the spec is finalized. */
export function specToPlan(reason: string, source: "user" | "auto" = "auto"): void {
    state = { mode: "plan", enteredAt: Date.now(), reason, source };
    emit();
}

/**
 * Enter "awaiting approval" after generate_design_docs writes the
 * PRD/technical/architecture trio. The agent can still read the repo
 * and edit the design docs themselves (for revisions the user asks
 * for) but cannot touch any other code until approved.
 */
export function enterAwaitingApproval(task: string, designDocsDir: string, source: "user" | "auto" = "auto"): void {
    state = { mode: "awaiting_approval", enteredAt: Date.now(), task, designDocsDir, source };
    emit();
}

/** User approved the design docs — transition to act mode so the agent can implement. */
export function approveAndExit(): void {
    state = { mode: "act" };
    emit();
}

export function onPlanModeChange(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

// ── Read-Only Tool Allowlist ──────────────────
// These are the tools the agent can call while plan mode is active.
// Deliberately conservative — if in doubt, leave a tool off this list.
// Anything with side effects (filesystem write, shell, browser click,
// memory write, OS input, swarm spawn, long-task start) is excluded.

export const PLAN_MODE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
    // Coding reads
    "read",
    "grep",
    "glob",
    "list_directory",
    "repo_map",
    "lsp",
    // Time
    "get_current_time",
    // Memory reads only
    "memory_search",
    "memory_list",
    "identity_view",
    "trait_list",
    "core_memory_read",
    "memory_snapshot",
    // Web reads
    "web_search",
    "weather",
    // Browser reads (no clicks, no typing, no navigation mutations)
    "browser_scan",
    "browser_extract",
    "browser_analyze",
    "browser_chrome_status",
    // System / info reads
    "system_info",
    "os_context",
    "os_accessibility_tree",
    "os_scan",
    "os_screenshot",
    "win_os_context",
    "win_os_screenshot",
    "linux_os_context",
    "linux_os_screenshot",
    "file_metadata",
    // GitHub reads are nuanced — list_webhooks/list_tasks/google_accounts are reads
    "list_webhooks",
    "list_tasks",
    "google_accounts",
    // The plan-exit tool itself must be available in plan mode
    "exit_plan_mode",
]);

/**
 * Filter a tool schema list down to only plan-mode-safe tools. Preserves
 * order and returns a new array. Used by the agent loop when plan mode
 * is active so the LLM never sees a mutation tool.
 */
export function filterToolsForPlanMode<T extends { function: { name: string } }>(
    tools: T[],
): T[] {
    return tools.filter((t) => PLAN_MODE_ALLOWED_TOOLS.has(t.function.name));
}

// ── Spec Mode Allowlist (Phase 4I) ───────────
// Spec mode is plan mode + a narrow write channel for the spec file and
// the finalize_spec tool. The agent is NOT allowed to write code here;
// only the spec document. Path gating lives in finalize_spec itself.

export const SPEC_MODE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
    ...PLAN_MODE_ALLOWED_TOOLS,
    "write",
    "append_file",
    "finalize_spec",
]);

export function filterToolsForSpecMode<T extends { function: { name: string } }>(
    tools: T[],
): T[] {
    return tools.filter((t) => SPEC_MODE_ALLOWED_TOOLS.has(t.function.name));
}

// ── Awaiting-Approval Allowlist ───────────────
// After generate_design_docs writes the PRD/TECHNICAL/ARCHITECTURE
// files, the agent is parked here until the user approves. Permitted
// tools are the full read-only set + edit/write (path-scoped to the
// design-docs dir via a runtime check in isToolAllowedInCurrentMode),
// plus the three tools that let the agent send the docs to the user
// and accept an approval signal:
//
//   - send_message_on_channel / send_push_notification — deliver docs
//   - render_md_to_pdf — TG/WA conversion before sending
//   - approve_design_docs — the explicit "user said yes" exit
//   - generate_design_docs — regenerate from scratch if user rejects
//   - generate_walkthrough is NOT here — that's Phase 3 (post-implement)
export const AWAITING_APPROVAL_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
    ...PLAN_MODE_ALLOWED_TOOLS,
    "edit",
    "write",
    "append_file",
    "render_md_to_pdf",
    "send_message_on_channel",
    "send_push_notification",
    "approve_design_docs",
    "generate_design_docs",
]);

export function filterToolsForAwaitingApproval<T extends { function: { name: string } }>(
    tools: T[],
): T[] {
    return tools.filter((t) => AWAITING_APPROVAL_ALLOWED_TOOLS.has(t.function.name));
}

/**
 * Is this a tool the agent can call right now, given the current mode?
 * Used as a last-resort safety check in the tool executor.
 */
export function isToolAllowedInCurrentMode(toolName: string): boolean {
    if (state.mode === "act") return true;
    if (state.mode === "spec") return SPEC_MODE_ALLOWED_TOOLS.has(toolName);
    if (state.mode === "awaiting_approval") return AWAITING_APPROVAL_ALLOWED_TOOLS.has(toolName);
    return PLAN_MODE_ALLOWED_TOOLS.has(toolName);
}

/**
 * Runtime path gate for edit/write while in awaiting_approval mode —
 * only files under the current designDocsDir may be modified. Other
 * states don't need this (plan-mode has no write tools, spec-mode
 * has its own path check in finalize_spec, act mode is unrestricted).
 *
 * Returns { allowed: true } or { allowed: false, reason }.
 */
function realResolveForGate(p: string): string {
    const abs = path.resolve(p);
    try {
        return fs.realpathSync(abs);
    } catch {
        const parts = abs.split(path.sep);
        const trailing: string[] = [];
        while (parts.length > 1) {
            const leaf = parts.pop();
            if (leaf) trailing.unshift(leaf);
            const candidate = parts.join(path.sep) || path.sep;
            try {
                const real = fs.realpathSync(candidate);
                return trailing.length ? path.join(real, ...trailing) : real;
            } catch {
                // keep walking up
            }
        }
        return abs;
    }
}

/**
 * Spec-mode path gate. Writes in spec mode are restricted to the
 * directory containing the spec file (so the agent can write the spec
 * and any sibling artifacts, but cannot touch arbitrary code).
 */
export function checkWritePathInSpecMode(absPath: string): { allowed: boolean; reason?: string } {
    if (state.mode !== "spec") return { allowed: true };
    try {
        const lst = fs.lstatSync(absPath);
        if (lst.isSymbolicLink()) {
            return {
                allowed: false,
                reason: `Spec mode: refusing to write through symlink ${absPath}.`,
            };
        }
    } catch {
        // file doesn't exist yet — fine
    }
    const resolved = realResolveForGate(absPath);
    const specDir = realResolveForGate(path.dirname(state.specPath));
    if (resolved === specDir || resolved.startsWith(specDir + path.sep)) return { allowed: true };
    return {
        allowed: false,
        reason: `Spec mode: writes are restricted to ${specDir}. Path ${absPath} is outside that directory.`,
    };
}

export function checkWritePathInApprovalMode(absPath: string): { allowed: boolean; reason?: string } {
    if (state.mode !== "awaiting_approval") return { allowed: true };
    const dir = state.designDocsDir;
    // If the file itself is a symlink, refuse outright — writeFileSync would
    // follow the link and could write into the dereferenced location.
    try {
        const lst = fs.lstatSync(absPath);
        if (lst.isSymbolicLink()) {
            return {
                allowed: false,
                reason: `While awaiting design-doc approval, refusing to write through symlink ${absPath}.`,
            };
        }
    } catch {
        // file doesn't exist yet — fine, we're about to create it
    }
    const resolved = realResolveForGate(absPath);
    const root = realResolveForGate(dir);
    if (resolved === root || resolved.startsWith(root + path.sep)) return { allowed: true };
    return {
        allowed: false,
        reason: `While awaiting design-doc approval, writes are restricted to ${dir}. Path ${absPath} is outside that directory.`,
    };
}

/**
 * The reminder body to inject each iteration while plan mode is active.
 */
export function planModeReminderBody(): string {
    if (state.mode === "plan") {
        return [
            "Plan mode is active.",
            "You may read, search, and reason — but must NOT modify files, run destructive commands, send messages, or call mutation tools.",
            "When your plan is ready, call exit_plan_mode with the full plan as the `plan` argument. After the user approves, the agent will execute in act mode.",
        ].join(" ");
    }
    if (state.mode === "spec") {
        return [
            `Spec mode is active. Task: ${state.task}.`,
            `Write the specification to ${state.specPath}. It must include: problem statement, acceptance criteria (bullet list), test scenarios, and out-of-scope notes.`,
            "Call finalize_spec when the document is complete — that transitions to plan mode, where you can outline the implementation.",
        ].join(" ");
    }
    if (state.mode === "awaiting_approval") {
        return [
            `Awaiting approval. Task: ${state.task}.`,
            `Design docs are written to ${state.designDocsDir}. You have NOT been given permission to implement yet.`,
            "Your next step is to deliver the docs to the user on the active channel and wait for their reply. Only when the user approves (yes / go ahead / looks good / proceed) do you call approve_design_docs to exit this mode and start implementation.",
            "If the user asks for revisions, edit the PRD/TECHNICAL/ARCHITECTURE files in place and re-send, or call generate_design_docs again. Do NOT touch any other files.",
        ].join(" ");
    }
    return "";
}
