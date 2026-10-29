// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { getConversationHistory } from "../agent.js";
import type { ChatCompletionMessageParam } from "../llm.js";

// Zero-LLM session recap: classifies recent tool activity and lists touched
// files straight from the in-process conversation history. No API call.

const TOOL_CLASS: Array<[RegExp, string]> = [
    [/^browser_/, "Browsing"],
    [/^(web_search|web_fetch|web_extract|deep_research|research_)/, "Research"],
    [/^(edit|write|append_file|notebook_edit)$/, "Editing files"],
    [/^(shell_exec|test_run|shell_)/, "Shell"],
    [/^(read_file|read|grep|glob|search_files|codebase_)/, "Reading code"],
    [/^(os_|screen_|computer_)/, "Computer use"],
    [/^(remember|recall|memory_)/, "Memory"],
];

function classify(toolName: string): string {
    for (const [re, label] of TOOL_CLASS) {
        if (re.test(toolName)) return label;
    }
    return "Other";
}

interface ToolCallShape {
    function?: { name?: string; arguments?: string };
}

export function buildRecap(turns = 20): string {
    const history = getConversationHistory();
    if (history.length === 0) return "📋 No conversation yet to recap.";

    // ×3 to span user+assistant+tool triples; cheap over-slice from the tail.
    const recent = history.slice(-(turns * 3));

    const classCounts = new Map<string, number>();
    const touched: string[] = [];
    const touchedSet = new Set<string>();
    const fileToolCallIds = new Map<string, string>(); // tool_call_id -> file (for preview lookup)
    let totalToolCalls = 0;

    for (const msg of recent) {
        if (msg.role !== "assistant") continue;
        const calls = (msg as { tool_calls?: ToolCallShape[] }).tool_calls;
        if (!Array.isArray(calls)) continue;
        for (const tc of calls) {
            const name = tc.function?.name;
            if (!name) continue;
            totalToolCalls++;
            classCounts.set(classify(name), (classCounts.get(classify(name)) ?? 0) + 1);

            // Touched files (cap 5), best-effort arg parse.
            try {
                const args = JSON.parse(tc.function?.arguments || "{}") as Record<string, unknown>;
                let file: string | undefined;
                if (/^(edit|write|append_file|read_file|read|notebook_edit)$/.test(name)) {
                    file = (args.file_path as string) ?? (args.path as string);
                } else if (name === "shell_exec" || name.startsWith("shell_")) {
                    const cmd = (args.command as string) ?? "";
                    const first = cmd.trim().split(/\s+/)[1]; // arg after the binary
                    if (first && (first.includes("/") || first.includes("."))) file = first;
                }
                if (file && !touchedSet.has(file) && touched.length < 5) {
                    touchedSet.add(file);
                    touched.push(file);
                }
            } catch {
                /* malformed args — skip */
            }
        }
    }

    const userTurns = recent.filter((m: ChatCompletionMessageParam) => m.role === "user").length;

    const lines: string[] = [`📋 **Recap (last ~${turns} turns)**`, ""];
    lines.push(`• ${userTurns} user message(s), ${totalToolCalls} tool call(s)`);
    if (classCounts.size > 0) {
        const activity = [...classCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k} (${v})`)
            .join(", ");
        lines.push(`• Activity: ${activity}`);
    }
    if (touched.length > 0) {
        lines.push("• Files touched:");
        for (const f of touched) lines.push(`  - \`${f}\``);
    }
    return lines.join("\n");
}
