// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Memory Recall Benchmark ───────────────────────────────────────────────
// Tests memory retrieval precision using a fixed set of query→expected_content
// pairs derived from actual Bhai usage patterns. No network calls needed.
// Measures how many of the top-k retrieved memories match the expected answer.

import type { BenchmarkResult } from "./index.js";
import { getDimensionValue } from "../registry.js";

interface RecallCase {
    query: string;
    expectedKeywords: string[];   // at least one must appear in top-k results
    category?: string;
}

// Fixed test cases — representative of real Bhai memory queries
const RECALL_CASES: RecallCase[] = [
    { query: "user's preferred programming language", expectedKeywords: ["typescript", "javascript", "python", "code"], category: "preference" },
    { query: "recent project the user is working on", expectedKeywords: ["project", "build", "app", "feature", "work"] },
    { query: "user's work schedule or daily routine", expectedKeywords: ["morning", "work", "schedule", "routine", "daily"] },
    { query: "tools the user uses for development", expectedKeywords: ["vscode", "editor", "terminal", "git", "node", "npm"] },
    { query: "user's goals or objectives", expectedKeywords: ["goal", "want", "plan", "aim", "objective"] },
    { query: "recent conversations about Bhai", expectedKeywords: ["atlas", "agent", "ai", "assistant"] },
    { query: "user's location or timezone", expectedKeywords: ["location", "city", "timezone", "country", "india", "gmt"] },
    { query: "coding style preferences", expectedKeywords: ["style", "format", "lint", "prettier", "biome", "eslint"] },
    { query: "communication preferences", expectedKeywords: ["telegram", "message", "chat", "notify", "send"] },
    { query: "past tasks that succeeded well", expectedKeywords: ["success", "complete", "done", "worked", "good"] },
];

export async function runMemoryRecallBenchmark(): Promise<BenchmarkResult> {
    const start = Date.now();

    try {
        const { recall } = await import("../../memory/sqlite.js");
        const k = getDimensionValue<number>("memory.recall.k") ?? 10;

        let hits = 0;
        let attempts = 0;
        const caseResults: Array<{ query: string; hit: boolean; retrieved: number }> = [];

        for (const testCase of RECALL_CASES) {
            try {
                const results = await recall(testCase.query, k, undefined, undefined, undefined, undefined, { touch: false });
                const allContent = results.map(r => r.content.toLowerCase()).join(" ");

                const hit = testCase.expectedKeywords.some(kw =>
                    allContent.includes(kw.toLowerCase())
                );

                if (hit) hits++;
                attempts++;

                caseResults.push({
                    query: testCase.query,
                    hit,
                    retrieved: results.length,
                });
            } catch {
                attempts++;
                caseResults.push({ query: testCase.query, hit: false, retrieved: 0 });
            }
        }

        const score = attempts > 0 ? hits / attempts : 0;

        return {
            name: "memory-recall",
            score,
            details: {
                hits,
                attempts,
                k,
                cases: caseResults,
            },
            durationMs: Date.now() - start,
        };
    } catch (err) {
        return {
            name: "memory-recall",
            score: 0,
            details: {},
            durationMs: Date.now() - start,
            error: (err as Error).message,
        };
    }
}
