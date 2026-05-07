// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Swarm Task Tool ───────────────────────────
// Exposes the swarm orchestrator as a tool the main agent can invoke
// for complex multi-step tasks that benefit from parallel sub-agents.

import type { ToolDefinition } from "./get-current-time.js";
import type { LLMClient } from "../llm.js";
import { runSwarm } from "../agents/swarm.js";
import { isTriviallyDirectExecutable } from "./swarm-gate.js";

// ── LLM Client Injection ──────────────────────
// The tool needs the LLM client but tools are pure handlers.
// We inject it at boot time via setSwarmLLM().

let _llm: LLMClient | null = null;
let _onProgress: ((msg: string) => Promise<void>) | null = null;

export function setSwarmLLM(llm: LLMClient): void {
    _llm = llm;
}

export function setSwarmProgress(fn: (msg: string) => Promise<void>): void {
    _onProgress = fn;
}

export function clearSwarmProgress(): void {
    _onProgress = null;
}

// ── Tool Definition ───────────────────────────

export const swarmTask: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "swarm_task",
            description: `Decompose a complex, multi-part task into specialized sub-agents that run in parallel.
Use this when the user's request involves MULTIPLE INDEPENDENT sub-tasks that benefit from different expertise.
Examples: "Research X and also write a script for Y", "Check the weather, search my files, and send a message".
Do NOT use for simple, single-focus tasks — just handle those directly.`,
            parameters: {
                type: "object",
                properties: {
                    task: {
                        type: "string",
                        description: "The full task description to decompose and execute with the swarm",
                    },
                },
                required: ["task"],
            },
        },
    },

    async handler(input) {
        if (!_llm) {
            return JSON.stringify({ error: "Swarm not initialized — LLM client not set" });
        }

        const task = input.task as string;
        if (!task) {
            return JSON.stringify({ error: "Missing 'task' parameter" });
        }

        // Direct-execute gate — see isTriviallyDirectExecutable() above.
        if (isTriviallyDirectExecutable(task)) {
            return JSON.stringify({
                status: "rejected",
                reason: "Task is too simple to benefit from swarm decomposition",
                message: "Handle this directly with a single tool call or short reasoning loop. Swarm decomposition adds 6-10 s of orchestration overhead without parallelism benefit for single-verb tasks.",
            });
        }

        try {
            const result = await runSwarm(_llm, task, _onProgress || undefined);

            if (result.stepsCompleted === 0 && !result.synthesis) {
                return JSON.stringify({
                    status: "skipped",
                    reason: result.plan.reasoning,
                    message: "Task is too simple for swarm decomposition — handle it directly.",
                });
            }

            return JSON.stringify({
                status: "completed",
                steps_completed: result.stepsCompleted,
                steps_failed: result.stepsFailed,
                duration_seconds: (result.totalDurationMs / 1000).toFixed(1),
                synthesis: result.synthesis,
            });
        } catch (err) {
            return JSON.stringify({
                error: `Swarm execution failed: ${(err as Error).message}`,
            });
        }
    },
};
