// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// SICA Self-Editing Agent — Edits own instructions after repeated failures.
// Inspired by SICA (ICLR 2025 Workshop): 17-53% improvement on coding tasks.

import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";

export interface SelfEdit {
    targetFile: string;
    originalSnippet: string;
    editedSnippet: string;
    reason: string;
    applied: boolean;
}

export async function proposeSelfEdit(
    llm: LLMClient,
    failedTask: string,
    errorMessages: string[],
    relevantPromptSnippet: string,
    promptFilePath: string,
): Promise<SelfEdit | null> {
    const messages: ChatCompletionMessageParam[] = [
        {
            role: "user",
            content: `The agent failed at this task repeatedly:
TASK: ${failedTask}
ERRORS: ${errorMessages.slice(0, 3).join("\n")}

The relevant instruction section is:
---
${relevantPromptSnippet.substring(0, 1000)}
---

Suggest a MINIMAL edit to improve the instruction. Output:
REASON: [why the current instruction causes failure]
ORIGINAL: [the exact text to replace]
EDITED: [the improved text]

If no edit would help, respond "NO_EDIT".`,
        },
    ];

    try {
        const response = await llm.chat({
            messages,
            systemPrompt: "You are a self-improvement module. Suggest minimal instruction edits to fix recurring failures.",
            modelOverride: "openai/gpt-5-mini",
        });

        const content = response.choices?.[0]?.message?.content || "";
        if (content.trim() === "NO_EDIT") return null;

        const reasonMatch = content.match(/REASON:\s*(.+)/i);
        const origMatch = content.match(/ORIGINAL:\s*([\s\S]+?)(?=EDITED:|$)/i);
        const editMatch = content.match(/EDITED:\s*([\s\S]+)/i);

        if (!origMatch || !editMatch) return null;

        return {
            targetFile: promptFilePath,
            originalSnippet: origMatch[1].trim(),
            editedSnippet: editMatch[1].trim(),
            reason: reasonMatch?.[1]?.trim() || "Performance improvement",
            applied: false,
        };
    } catch { return null; }
}
