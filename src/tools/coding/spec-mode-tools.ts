// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── spec-mode tools ───────────────────────────
// Two tools that drive the spec/plan/act state machine:
// enter_spec_mode (start writing a specification artifact) and
// finalize_spec (commit the spec file and transition to plan mode).
//
// Spec mode is a stricter precursor to plan mode — the agent can only
// read code and write the single spec file. Once the spec is ready, the
// transition to plan mode lets the agent lay out the implementation.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { enterSpecMode, getPlanModeState, isSpecMode, specToPlan } from "../../agents/plan-mode.js";
import type { ToolDefinition } from "../get-current-time.js";

const SPECS_DIR = path.resolve(".atlas", "specs");

function safeSlug(task: string): string {
    return (
        task
            .toLowerCase()
            .replace(/[^\w\s-]/g, "")
            .trim()
            .split(/\s+/)
            .slice(0, 6)
            .join("-")
            .slice(0, 50) || `spec-${Date.now()}`
    );
}

// ── enter_spec_mode ──────────────────────────

export const enterSpecModeTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "enter_spec_mode",
            description:
                "Enter spec mode: write a formal specification BEFORE planning implementation. While in spec mode you can only read code and write the spec file. Use for new features, architectural changes, or any task where acceptance criteria should be written down first. Call finalize_spec to transition to plan mode.",
            parameters: {
                type: "object",
                properties: {
                    task: {
                        type: "string",
                        description: "Short description of the task or feature (used to derive the spec filename).",
                    },
                },
                required: ["task"],
            },
        },
    },
    async handler(input) {
        if (isSpecMode()) {
            const cur = getPlanModeState();
            return JSON.stringify({
                success: true,
                already_in_spec_mode: true,
                spec_path: cur.mode === "spec" ? cur.specPath : null,
                message: "Already in spec mode — continue writing the spec.",
            });
        }
        const task = (input.task as string) || "";
        if (!task.trim()) return JSON.stringify({ error: "task must not be empty" });

        if (!existsSync(SPECS_DIR)) {
            try {
                mkdirSync(SPECS_DIR, { recursive: true });
            } catch {
                /* best-effort */
            }
        }
        const slug = safeSlug(task);
        const specPath = path.join(SPECS_DIR, `${slug}.md`);
        enterSpecMode(task, specPath, "user");

        return JSON.stringify({
            success: true,
            mode: "spec",
            spec_path: specPath,
            message: `Spec mode active. Write the specification to ${specPath}. Include: problem statement, acceptance criteria (bullet list), test scenarios, out-of-scope notes. Call finalize_spec when done.`,
        });
    },
};

// ── finalize_spec ────────────────────────────

export const finalizeSpecTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "finalize_spec",
            description:
                "Finalize the specification and transition to plan mode. Call this once the spec file exists on disk with the complete specification (problem, acceptance criteria, test scenarios, out-of-scope). After this call you enter plan mode to outline the implementation.",
            parameters: {
                type: "object",
                properties: {
                    spec_body: {
                        type: "string",
                        description:
                            "Optional: full spec text. If provided, the tool writes it to the spec file. If omitted, the tool assumes the spec was already written via the `write` tool.",
                    },
                    summary: {
                        type: "string",
                        description: "One-paragraph summary of the spec (shown in the subsequent plan mode reminder).",
                    },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        const state = getPlanModeState();
        if (state.mode !== "spec") {
            return JSON.stringify({
                error: "finalize_spec can only be called from spec mode. Call enter_spec_mode first.",
            });
        }

        const specBody = (input.spec_body as string) || "";
        if (specBody.trim().length > 0) {
            try {
                mkdirSync(path.dirname(state.specPath), { recursive: true });
                writeFileSync(state.specPath, specBody, "utf-8");
            } catch (err) {
                return JSON.stringify({ error: `Failed to write spec file: ${(err as Error).message}` });
            }
        } else if (!existsSync(state.specPath)) {
            return JSON.stringify({
                error: `Spec file not found at ${state.specPath} and no spec_body was provided. Write the spec first (via write tool) or pass spec_body.`,
            });
        }

        const summary = (input.summary as string) || "Spec finalized.";
        specToPlan(`Implementation planning for: ${state.task}`, "auto");

        return JSON.stringify({
            success: true,
            mode: "plan",
            spec_path: state.specPath,
            task: state.task,
            summary,
            message: `Spec finalized at ${state.specPath}. Now in plan mode — outline the implementation and call exit_plan_mode when done.`,
        });
    },
};
