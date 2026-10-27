// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Tool Selection Benchmark ──────────────────────────────────────────────
// Tests tool router accuracy using fixed (query → expected_tool_category)
// pairs. Also augments with historical patterns from audit.jsonl.
// No network calls needed — uses the in-process tool router.

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { BenchmarkResult } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ATLAS_DATA_DIR = process.env.ATLAS_DATA_DIR || join(__dirname, "../../../data");
const AUDIT_LOG_PATH = join(ATLAS_DATA_DIR, "audit.jsonl");

interface SelectionCase {
    query: string;
    expectedCategories: string[];  // at least one must be selected
}

// Fixed ground-truth cases derived from Bhai's tool categories
const FIXED_CASES: SelectionCase[] = [
    { query: "search the web for latest news about AI", expectedCategories: ["search", "web"] },
    { query: "open chrome browser and navigate to google", expectedCategories: ["browser", "system"] },
    { query: "remember that I prefer dark mode", expectedCategories: ["memory", "core"] },
    { query: "take a screenshot of my screen", expectedCategories: ["system", "media"] },
    { query: "run the tests in my project", expectedCategories: ["shell", "coding", "file_system"] },
    { query: "send a message to my friend on telegram", expectedCategories: ["integrations", "messaging"] },
    { query: "create a new file called index.ts", expectedCategories: ["file_system", "coding"] },
    { query: "what's the weather today", expectedCategories: ["search", "web", "integrations"] },
    { query: "read the contents of package.json", expectedCategories: ["file_system", "coding"] },
    { query: "play music on spotify", expectedCategories: ["integrations", "media", "system"] },
    { query: "write a python script to parse csv", expectedCategories: ["coding", "file_system", "shell"] },
    { query: "who are you and what can you do", expectedCategories: ["core", "memory"] },
    { query: "set an alarm for 9am tomorrow", expectedCategories: ["system", "integrations", "scheduling"] },
    { query: "deep research on machine learning papers", expectedCategories: ["search", "research", "web"] },
    { query: "edit the main.ts file to add error handling", expectedCategories: ["coding", "file_system"] },
];

export async function runToolSelectionBenchmark(): Promise<BenchmarkResult> {
    const start = Date.now();

    try {
        const { selectTools } = await import("../../tool-router.js");

        // Augment with historical cases from audit.jsonl (extract successful patterns)
        const auditCases = _loadAuditCases();
        const allCases = [...FIXED_CASES, ...auditCases];

        let hits = 0;
        let attempts = 0;
        const caseResults: Array<{ query: string; hit: boolean; selected: string[] }> = [];

        for (const testCase of allCases) {
            try {
                const selection = await selectTools({ message: testCase.query });
                const selectedCats = (selection.categories || []).map(c => c.toLowerCase());
                const selectedTools = (selection.tools || []).map(t =>
                    (t.function?.name ?? "").toLowerCase()
                );

                const hit = testCase.expectedCategories.some(expected => {
                    const exp = expected.toLowerCase();
                    return selectedCats.some(c => c.includes(exp) || exp.includes(c)) ||
                        selectedTools.some(t => t.includes(exp));
                });

                if (hit) hits++;
                attempts++;

                caseResults.push({
                    query: testCase.query,
                    hit,
                    selected: selectedCats,
                });
            } catch {
                attempts++;
                caseResults.push({ query: testCase.query, hit: false, selected: [] });
            }
        }

        const score = attempts > 0 ? hits / attempts : 0;

        return {
            name: "tool-selection",
            score,
            details: {
                hits,
                attempts,
                fixedCases: FIXED_CASES.length,
                auditCases: auditCases.length,
                cases: caseResults.slice(0, 20),  // cap output size
            },
            durationMs: Date.now() - start,
        };
    } catch (err) {
        return {
            name: "tool-selection",
            score: 0,
            details: {},
            durationMs: Date.now() - start,
            error: (err as Error).message,
        };
    }
}

// ── Audit log parsing ─────────────────────────────────────────────────────

function _loadAuditCases(): SelectionCase[] {
    if (!existsSync(AUDIT_LOG_PATH)) return [];
    try {
        const lines = readFileSync(AUDIT_LOG_PATH, "utf-8").split("\n").filter(Boolean);
        // Take a sample of successful tool calls and derive category expectations
        const successful = lines
            .map(l => { try { return JSON.parse(l); } catch { return null; } })
            .filter(e => e && e.success && e.tool && !e.cached)
            .slice(-100);

        const toolToCategory: Record<string, string> = {
            "web_search": "search", "browser_navigate": "browser", "browser_click": "browser",
            "read_file": "file_system", "write_file": "file_system", "edit_file": "file_system",
            "shell_exec": "shell", "os_screenshot": "system", "os_click": "system",
            "remember": "memory", "recall": "memory", "get_core_memory": "memory",
        };

        return successful.slice(0, 15).map(e => ({
            query: `Use the ${e.tool} tool`,
            expectedCategories: [toolToCategory[e.tool] ?? e.tool.split("_")[0]],
        }));
    } catch { return []; }
}
