// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Computer Use Tool ────────────────────────
// Exposes the hierarchical computer-use agent as a tool.
// Manager decomposes visual desktop tasks into actions,
// Workers execute low-level interactions (click, type, scroll).
// Inspired by Agent-S3 (69.9% OSWorld, near human 72%).

import { executeComputerUseTask } from "../agents/computer-use-agent.js";
import type { LLMClient } from "../llm.js";
import type { ToolDefinition } from "./get-current-time.js";

// ── LLM Client Injection ──────────────────────

let _llm: LLMClient | null = null;

export function setComputerUseLLM(llm: LLMClient): void {
    _llm = llm;
}

// ── Tool Definition ───────────────────────────

export const computerUseTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "computer_use",
            description: `Execute a desktop automation task using hierarchical computer use.
A manager agent plans the sequence of low-level desktop actions (click, type, scroll, key press, launch app),
then worker agents execute each step using screen understanding via OCR.

Use this for:
- Complex desktop automation that requires visual understanding of the screen
- Multi-step GUI workflows (e.g., "open Safari, navigate to a URL, fill a form")
- Tasks that need to interact with native macOS/desktop applications visually
- Any task that requires clicking on specific screen elements by their appearance

The task runs through: Plan → Execute → Verify cycle.
Returns the actions executed and the final state.`,
            parameters: {
                type: "object",
                properties: {
                    task: {
                        type: "string",
                        description:
                            "Description of the desktop task to accomplish (e.g., 'Open System Preferences and change the wallpaper')",
                    },
                    max_steps: {
                        type: "number",
                        description: "Maximum number of actions to execute (default: 20)",
                    },
                },
                required: ["task"],
            },
        },
    },

    async handler(input) {
        if (!_llm) {
            return JSON.stringify({ error: "Computer use agent not initialized — LLM client not set" });
        }

        const task = input.task as string;
        const maxSteps = (input.max_steps as number) || 20;

        if (!task) {
            return JSON.stringify({ error: "Missing 'task' parameter" });
        }

        try {
            const result = await executeComputerUseTask(_llm, task, maxSteps);

            return JSON.stringify({
                success: result.success,
                steps_used: result.stepsUsed,
                actions: result.actionsExecuted.map((a) => ({
                    type: a.type,
                    ...(a.x !== undefined && { x: a.x }),
                    ...(a.y !== undefined && { y: a.y }),
                    ...(a.text && { text: a.text }),
                    ...(a.key && { key: a.key }),
                    ...(a.app && { app: a.app }),
                })),
                final_state: result.finalState,
                error: result.error,
            });
        } catch (err) {
            return JSON.stringify({
                error: `Computer use failed: ${(err as Error).message}`,
            });
        }
    },
};
