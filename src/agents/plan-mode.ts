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

// ── State ─────────────────────────────────────

export type PlanModeState =
    | { mode: "act" }
    | {
        mode: "plan";
        enteredAt: number;
        reason: string;
        /** User-originated (/plan command) vs agent-internal auto-trigger */
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

/**
 * Is this a tool the agent can call right now, given the current mode?
 * Used as a last-resort safety check in the tool executor.
 */
export function isToolAllowedInCurrentMode(toolName: string): boolean {
    if (state.mode === "act") return true;
    return PLAN_MODE_ALLOWED_TOOLS.has(toolName);
}

/**
 * The reminder body to inject each iteration while plan mode is active.
 */
export function planModeReminderBody(): string {
    if (state.mode !== "plan") return "";
    return [
        "Plan mode is active.",
        "You may read, search, and reason — but must NOT modify files, run destructive commands, send messages, or call mutation tools.",
        "When your plan is ready, call exit_plan_mode with the full plan as the `plan` argument. After the user approves, the agent will execute in act mode.",
    ].join(" ");
}
