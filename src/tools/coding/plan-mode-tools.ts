// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── plan-mode tools ───────────────────────────
// Two tools that drive the plan/act state machine from inside the agent
// loop: enter_plan_mode (agent-initiated plan entry) and exit_plan_mode
// (hand the plan back to the user and flip to act mode).

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { enterPlanMode, exitPlanMode, isPlanMode } from "../../agents/plan-mode.js";
import type { ToolDefinition } from "../get-current-time.js";

// ── enter_plan_mode ───────────────────────────

export const enterPlanModeTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "enter_plan_mode",
            description:
                "Enter plan mode: research and design before making any mutations. While in plan mode you can only call read-only tools (read, grep, glob, web_search, etc.). Use this when a task is multi-file, requires design decisions, or would otherwise benefit from a read-only exploration phase. End plan mode by calling exit_plan_mode with the full plan.",
            parameters: {
                type: "object",
                properties: {
                    reason: {
                        type: "string",
                        description: "Brief reason for entering plan mode (what you need to investigate).",
                    },
                },
                required: ["reason"],
            },
        },
    },
    async handler(input) {
        if (isPlanMode()) {
            return JSON.stringify({
                success: true,
                already_in_plan_mode: true,
                message: "Already in plan mode — continue investigating.",
            });
        }
        const reason = (input.reason as string) || "(no reason given)";
        enterPlanMode(reason, "user");
        return JSON.stringify({
            success: true,
            mode: "plan",
            message:
                "Plan mode active. Only read-only tools are available. Investigate the codebase, then call exit_plan_mode with your plan.",
        });
    },
};

// ── exit_plan_mode ────────────────────────────

export const exitPlanModeTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "exit_plan_mode",
            description:
                "Exit plan mode with a concrete implementation plan. Call this when you have finished researching and have a complete plan ready. The plan will be saved to disk and shown to the user, and the agent will return to act mode so edits/writes become available again.",
            parameters: {
                type: "object",
                properties: {
                    plan: {
                        type: "string",
                        description:
                            "The full implementation plan. Markdown is fine. Include: the problem, the approach, specific files to modify, and a brief verification step. Keep it scannable — bullets over paragraphs.",
                    },
                },
                required: ["plan"],
            },
        },
    },
    async handler(input) {
        const plan = (input.plan as string) || "";
        if (!plan.trim()) {
            return JSON.stringify({
                error: "plan must not be empty — include the full implementation plan.",
            });
        }

        // Persist the plan to a tmp file so channel layers or the user can
        // retrieve it later if the session is interrupted.
        const dir = path.join(tmpdir(), "atlas-plans");
        try {
            mkdirSync(dir, { recursive: true });
            const fname = `plan-${Date.now()}.md`;
            writeFileSync(path.join(dir, fname), plan, "utf-8");
        } catch {
            // Persistence is best-effort — don't fail exit on FS errors.
        }

        const wasInPlanMode = isPlanMode();
        exitPlanMode();

        return JSON.stringify({
            success: true,
            mode: "act",
            was_in_plan_mode: wasInPlanMode,
            plan,
            message:
                "Plan mode exited. Now proceed with implementation using act-mode tools (edit, write, shell_exec, etc.). The user has seen the plan.",
        });
    },
};
