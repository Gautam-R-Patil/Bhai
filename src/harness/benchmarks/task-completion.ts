// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Task Completion Benchmark ─────────────────────────────────────────────
// Runs 3 lightweight swarm tasks using the current harness config and scores
// them with the existing evaluator. Each task is time-capped at 60s.
// Requires a live LLM client — skipped in fast mode.

import type { LLMClient } from "../../llm.js";
import type { BenchmarkResult } from "./index.js";
import type { SubAgentResult } from "../../agents/sub-agent.js";

interface TaskCase {
    description: string;
    request: string;
    successKeywords: string[];  // response must contain at least 1 to count as success
    timeoutMs: number;
}

const TASK_CASES: TaskCase[] = [
    {
        description: "Simple factual lookup",
        request: "What is 2 to the power of 10? Show the calculation.",
        successKeywords: ["1024"],
        timeoutMs: 30000,
    },
    {
        description: "Memory recall task",
        request: "Tell me briefly what you know about my preferences and how I like to work.",
        successKeywords: ["prefer", "like", "use", "work", "you"],
        timeoutMs: 30000,
    },
    {
        description: "Simple reasoning task",
        request: "List the 5 most important factors to consider when optimizing an AI system's retrieval pipeline.",
        successKeywords: ["relevance", "accuracy", "precision", "recall", "latency", "quality", "retriev"],
        timeoutMs: 45000,
    },
];

export async function runTaskCompletionBenchmark(llm: LLMClient): Promise<BenchmarkResult> {
    const start = Date.now();

    try {
        const { runAgent } = await import("../../agent.js");
        const { evaluate } = await import("../../agents/evaluator.js");

        let totalScore = 0;
        let attempts = 0;
        const taskResults: Array<{ task: string; score: number; succeeded: boolean }> = [];

        for (const task of TASK_CASES) {
            const taskStart = Date.now();
            try {
                const controller = new AbortController();
                const timeoutHandle = setTimeout(() => controller.abort(), task.timeoutMs);

                let agentResponse = "";
                const taskStart = Date.now();
                try {
                    const result = await runAgent(
                        llm,
                        task.request,
                        undefined,     // no progress callback
                        undefined,     // no media
                        controller.signal,
                        [],            // historyFork: empty array isolates from global conversationHistory
                        "simple",      // modelHint
                        // Allowlist: exclude all memory-write tools to prevent DB mutation during benchmarks
                        ["recall", "get_core_memory", "core_memory_read", "web_search", "get_current_time",
                         "read", "grep", "glob", "list_directory"],
                    );
                    agentResponse = result.text;
                } finally {
                    clearTimeout(timeoutHandle);
                }

                const succeeded = task.successKeywords.some(kw =>
                    agentResponse.toLowerCase().includes(kw.toLowerCase())
                );

                // Build a properly-typed SubAgentResult map for the evaluator
                const stepResult: SubAgentResult = {
                    id: "benchmark-task",
                    role: "general",
                    success: succeeded,
                    output: agentResponse,
                    toolCalls: 0,
                    durationMs: Date.now() - taskStart,
                    estimatedCost: 0,
                };
                const stepResults = new Map<string, SubAgentResult>([["task", stepResult]]);
                const evalResult = await evaluate(llm, task.request, agentResponse, stepResults);

                const score = evalResult.score;
                totalScore += score;
                attempts++;

                taskResults.push({
                    task: task.description,
                    score,
                    succeeded,
                });
            } catch (taskErr) {
                attempts++;
                taskResults.push({ task: task.description, score: 0, succeeded: false });
            }
        }

        const avgScore = attempts > 0 ? totalScore / attempts : 0;

        return {
            name: "task-completion",
            score: avgScore / 100,  // normalize to 0-1 for composite
            details: {
                avgScore,
                attempts,
                tasks: taskResults,
            },
            durationMs: Date.now() - start,
        };
    } catch (err) {
        return {
            name: "task-completion",
            score: 0,
            details: {},
            durationMs: Date.now() - start,
            error: (err as Error).message,
        };
    }
}
