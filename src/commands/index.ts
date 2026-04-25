// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { enterPlanMode, exitPlanMode, isPlanMode, isSpecMode, getPlanModeState, enterSpecMode } from "../agents/plan-mode.js";
import path from "node:path";
import type { LLMClient } from "../llm.js";

// ── Types ─────────────────────────────────────

export interface CommandResult {
    handled: boolean;
    response?: string;
}

interface CommandContext {
    config: Config;
    startTime: number;
    sessionTokens: number;
    conversationCount: () => number;  // getter — always reflects current count
    thinkingLevel: string;
    setThinkingLevel: (level: string) => void;
    clearConversation: () => void;
    llm?: LLMClient;
    sendProgress?: (msg: string) => Promise<void>;
}

// ── State ─────────────────────────────────────

let _thinkingLevel = "low";
let _ctx: CommandContext | null = null;


export function initCommands(ctx: CommandContext): void {
    _ctx = ctx;
    _thinkingLevel = ctx.thinkingLevel;
}

export function getThinkingLevel(): string {
    return _thinkingLevel;
}

// ── Command Router ────────────────────────────

export async function handleCommand(text: string): Promise<CommandResult> {
    if (!text.startsWith("/")) return { handled: false };

    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
        case "/start":
            return { handled: true, response: cmdStart() };
        case "/status":
            return { handled: true, response: cmdStatus() };
        case "/new":
            return { handled: true, response: cmdNew() };
        case "/compact":
            return { handled: true, response: cmdCompact() };
        case "/usage":
            return { handled: true, response: cmdUsage() };
        case "/think":
            return { handled: true, response: cmdThink(args) };
        case "/help":
            return { handled: true, response: cmdHelp() };
        case "/plan":
            return { handled: true, response: cmdPlan(args.join(" ")) };
        case "/noplan":
            return { handled: true, response: cmdNoPlan() };
        case "/spec":
            return { handled: true, response: cmdSpec(args.join(" ")) };
        case "/optimize-harness":
        case "/harness-optimize":
            return cmdOptimizeHarness(args);
        case "/harness-status":
            return cmdHarnessStatus();
        default:
            return { handled: false };
    }
}

// ── Command Implementations ───────────────────

function cmdStatus(): string {
    if (!_ctx) return "⚠️ Commands not initialized.";
    const uptime = Math.floor((Date.now() - _ctx.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    const secs = uptime % 60;

    return [
        "📊 **A.T.L.A.S Status**",
        "",
        `🤖 Engine: A.T.L.A.S AI`,
        `🧠 Thinking: \`${_thinkingLevel}\``,
        `⏱️ Uptime: ${hours}h ${mins}m ${secs}s`,
        `💬 Conversations: ${_ctx.conversationCount()}`,
        `🏢 Built by: XAGI Labs`,
        `🔒 Allowed users: ${_ctx.config.allowedUserIds.size}`,
    ].join("\n");
}

function cmdNew(): string {
    _ctx?.clearConversation();
    return "🗑️ Conversation cleared. Fresh start!";
}

function cmdCompact(): string {
    // Will be enhanced in context-pruning feature
    return "📦 Context compacted. Older messages summarized.";
}

function cmdUsage(): string {
    return [
        "📊 **Session Usage**",
        "",
        `💬 Messages: ${_ctx?.conversationCount() || 0}`,
        `🧠 Thinking: \`${_thinkingLevel}\``,
        `🤖 Engine: A.T.L.A.S AI`,
    ].join("\n");
}

function cmdThink(args: string[]): string {
    const validLevels = ["off", "low", "medium", "high"];
    if (args.length === 0 || !validLevels.includes(args[0])) {
        return `🧠 Thinking level: \`${_thinkingLevel}\`\n\nUsage: \`/think off|low|medium|high\``;
    }
    _thinkingLevel = args[0];
    _ctx?.setThinkingLevel(_thinkingLevel);
    return `🧠 Thinking level set to \`${_thinkingLevel}\``;
}

function cmdStart(): string {
    return [
        "**A.T.L.A.S** — your proactive AI agent",
        "",
        "I can browse the web, run deep research, manage files, execute code, and much more.",
        "",
        "Just tell me what you need in plain language, or use the quick actions below.",
    ].join("\n");
}

function cmdHelp(): string {
    return [
        "🤖 **A.T.L.A.S Commands**",
        "",
        "`/status` — Bot status and config",
        "`/new` — Clear conversation",
        "`/compact` — Compress conversation context",
        "`/think off|low|medium|high` — Set reasoning depth",
        "`/usage` — Session usage stats",
        "`/plan [task]` — Enter plan mode (research before acting)",
        "`/spec <task>` — Enter spec mode (write acceptance criteria first)",
        "`/noplan` — Exit plan/spec mode",
        "`/optimize-harness [n] [--fast]` — Run Meta-Harness optimization (n iterations)",
        "`/harness-status` — Show harness optimization history",
        "`/help` — This message",
        "",
        "Or use the quick action buttons below.",
    ].join("\n");
}

function cmdPlan(task: string): string {
    if (isPlanMode()) {
        const s = getPlanModeState();
        const since = s.mode === "plan" ? Math.round((Date.now() - s.enteredAt) / 1000) : 0;
        return `🧭 Already in plan mode (${since}s). Reason: ${s.mode === "plan" ? s.reason : "—"}. Send a task or \`/noplan\` to exit.`;
    }
    if (isSpecMode()) {
        const s = getPlanModeState();
        return `📝 Currently in spec mode (task: ${s.mode === "spec" ? s.task : "—"}). Run \`finalize_spec\` to transition to plan mode, or \`/noplan\` to cancel the spec first.`;
    }
    const reason = task.trim() || "User-invoked plan mode";
    enterPlanMode(reason, "user");
    return [
        "🧭 **Plan mode active.**",
        "",
        "The agent will only use read-only tools (read, grep, glob, web search, etc.) until it calls `exit_plan_mode` with a concrete plan.",
        "",
        task.trim() ? `Task: ${task.trim()}` : "Send your task now — the agent will research and return with a plan.",
    ].join("\n");
}

function cmdNoPlan(): string {
    if (!isPlanMode() && !isSpecMode()) {
        return "Plan/spec mode is already off.";
    }
    exitPlanMode();
    return "✅ Plan/spec mode exited. Agent is back to normal (act) mode.";
}

function cmdSpec(task: string): string {
    if (isSpecMode()) {
        const s = getPlanModeState();
        return `📝 Already in spec mode. Task: ${s.mode === "spec" ? s.task : "—"}. Finish writing the spec, then call finalize_spec.`;
    }
    if (isPlanMode()) {
        const s = getPlanModeState();
        return `🧭 Currently in plan mode (reason: ${s.mode === "plan" ? s.reason : "—"}). Run \`/noplan\` to exit first, then \`/spec <task>\` for a fresh spec.`;
    }
    const trimmed = task.trim();
    if (!trimmed) {
        return "Usage: `/spec <short task description>` — enters spec mode, where the agent writes a specification before planning or implementation.";
    }
    const slug = trimmed
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .trim()
        .split(/\s+/)
        .slice(0, 6)
        .join("-")
        .slice(0, 50) || `spec-${Date.now()}`;
    const specPath = path.resolve(".atlas", "specs", `${slug}.md`);
    enterSpecMode(trimmed, specPath, "user");
    return [
        "📝 **Spec mode active.**",
        "",
        `Task: ${trimmed}`,
        `Target spec file: ${specPath}`,
        "",
        "The agent will write a specification (problem, acceptance criteria, test scenarios, out-of-scope) before planning implementation. Send your next message to start. Finalize with `finalize_spec` or `/noplan` to cancel.",
    ].join("\n");
}

async function cmdOptimizeHarness(args: string[]): Promise<CommandResult> {
    if (!_ctx?.llm) {
        return { handled: true, response: "⚠️ LLM not available for harness optimization." };
    }
    const budget = parseInt(args[0] ?? "5", 10) || 5;
    const fastMode = args.includes("--fast");

    // Fire and forget — optimization runs in background
    setImmediate(async () => {
        try {
            const { runMetaHarnessOptimization } = await import("../harness/optimizer.js");
            await runMetaHarnessOptimization(_ctx!.llm!, { budget, fastMode }, _ctx!.sendProgress);
        } catch (err) {
            console.error("[HARNESS-CMD] Optimization failed:", (err as Error).message);
            _ctx?.sendProgress?.(`❌ Harness optimization failed: ${(err as Error).message}`).catch(() => {});
        }
    });

    return {
        handled: true,
        response: [
            `🔬 **Harness optimization started** (budget=${budget} iterations, fast=${fastMode})`,
            "",
            "The Meta-Harness optimizer will run in the background, evaluating configuration candidates and reporting progress.",
            fastMode ? "Fast mode: skipping network-dependent benchmarks." : "Full mode: running all benchmarks including task completion.",
            "",
            "Use `/harness-status` to check progress.",
        ].join("\n"),
    };
}

function cmdHarnessStatus(): CommandResult {
    try {
        const ATLAS_DATA_DIR = process.env.ATLAS_DATA_DIR || "data";
        const runsDir = join(ATLAS_DATA_DIR, "harness/runs");
        const activeConfig = join(ATLAS_DATA_DIR, "harness/active/harness-config.json");

        const lines = ["🔬 **Harness Optimization Status**", ""];

        if (existsSync(activeConfig)) {
            const cfg = JSON.parse(readFileSync(activeConfig, "utf-8"));
            lines.push(`✅ Active config: candidate \`${cfg.candidateId}\` (set ${new Date(cfg.createdAt).toLocaleDateString()})`);
        } else {
            lines.push("ℹ️ No active harness config — using defaults.");
        }

        if (existsSync(runsDir)) {
            const runs = readdirSync(runsDir).filter((d: string) => d.startsWith("run_")).sort().slice(-5);
            if (runs.length > 0) {
                lines.push("", `📁 Recent runs (${runs.length} shown):`);
                for (const run of runs) {
                    const lb = join(ATLAS_DATA_DIR, "harness/runs", run, "indexes/leaderboard.json");
                    if (existsSync(lb)) {
                        const d = JSON.parse(readFileSync(lb, "utf-8"));
                        lines.push(`  - \`${run}\`: best=${d.bestCandidateId} score=${d.bestObjective?.toFixed(0) ?? "n/a"} (${d.candidates?.length ?? 0} candidates)`);
                    }
                }
            }
        }

        lines.push("", "Use `/optimize-harness [budget] [--fast]` to run a new optimization.");
        return { handled: true, response: lines.join("\n") };
    } catch (err) {
        return { handled: true, response: `⚠️ Could not read harness status: ${(err as Error).message}` };
    }
}
