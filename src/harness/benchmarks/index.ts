// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

export { runMemoryRecallBenchmark } from "./memory-recall.js";
export { runToolSelectionBenchmark } from "./tool-selection.js";
export { runTaskCompletionBenchmark } from "./task-completion.js";

export interface BenchmarkResult {
    name: string;
    score: number;   // 0-1 normalized
    details: Record<string, unknown>;
    durationMs: number;
    error?: string;
}
