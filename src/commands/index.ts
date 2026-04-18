// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { Config } from "../config.js";
import { enterPlanMode, exitPlanMode, isPlanMode, getPlanModeState } from "../agents/plan-mode.js";

// ── Types ─────────────────────────────────────

export interface CommandResult {
    handled: boolean;
    response?: string;
}

interface CommandContext {
    config: Config;
    startTime: number;
    sessionTokens: number;
    conversationCount: number;
    thinkingLevel: string;
    setThinkingLevel: (level: string) => void;
    clearConversation: () => void;
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
        `💬 Conversations: ${_ctx.conversationCount}`,
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
        `💬 Messages: ${_ctx?.conversationCount || 0}`,
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
        "`/noplan` — Exit plan mode",
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
    if (!isPlanMode()) {
        return "Plan mode is already off.";
    }
    exitPlanMode();
    return "✅ Plan mode exited. Agent is back to normal (act) mode.";
}
