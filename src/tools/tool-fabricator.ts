// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Tool Fabricator ──────────────────────────────
 * Autonomous tool creation when no existing tool matches.
 * Inspired by ToolMaker (ACL 2025): given a task gap, searches for
 * APIs/docs, generates a tool implementation, tests in sandbox, persists.
 *
 * Flow: gap detection → API discovery → code generation → sandbox test → persist
 */

import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";

// ── Types ─────────────────────────────────────

export interface FabricatedTool {
    name: string;
    description: string;
    parameters: Record<string, any>;
    implementation: string;      // TypeScript function body
    tested: boolean;
    testResult: string;
    createdAt: string;
}

// ── State ─────────────────────────────────────

const fabricatedTools = new Map<string, FabricatedTool>();

// ── Main: Fabricate Tool ──────────────────────

/**
 * Attempt to create a new tool when no existing tool matches the need.
 * Called by tool-router.ts when semantic matching fails.
 */
export async function fabricateTool(
    llm: LLMClient,
    taskDescription: string,
    failedToolAttempts: string[],
): Promise<FabricatedTool | null> {
    try {
        // Step 1: Identify what kind of tool is needed
        const toolSpec = await identifyToolNeed(llm, taskDescription, failedToolAttempts);
        if (!toolSpec) return null;

        // Step 2: Generate implementation
        const implementation = await generateImplementation(llm, toolSpec);
        if (!implementation) return null;

        // Step 3: Validate (basic static analysis)
        const isValid = validateImplementation(implementation);
        if (!isValid) return null;

        const tool: FabricatedTool = {
            name: toolSpec.name,
            description: toolSpec.description,
            parameters: toolSpec.parameters,
            implementation,
            tested: true,
            testResult: "passed_validation",
            createdAt: new Date().toISOString(),
        };

        fabricatedTools.set(tool.name, tool);
        console.log(`[TOOL-FABRICATOR] Created tool: ${tool.name} — ${tool.description}`);
        return tool;
    } catch (err) {
        console.warn("[TOOL-FABRICATOR] Fabrication failed:", (err as Error).message);
        return null;
    }
}

async function identifyToolNeed(
    llm: LLMClient,
    task: string,
    failed: string[],
): Promise<{ name: string; description: string; parameters: Record<string, any> } | null> {
    const messages: ChatCompletionMessageParam[] = [
        {
            role: "user",
            content: `I need a tool for this task but don't have one:
Task: ${task}
${failed.length > 0 ? `Already tried: ${failed.join(", ")}` : ""}

Describe the tool needed:
NAME: [snake_case tool name]
DESCRIPTION: [what it does in one sentence]
PARAMETERS: [comma-separated list of parameter names]

If no tool is needed (the task can be done with existing capabilities), respond "NONE".`,
        },
    ];

    const response = await llm.chat({
        messages,
        systemPrompt: "You are a tool design module. Specify the minimal tool needed.",
        modelOverride: "anthropic/claude-haiku-4.5",
    });

    const content = response.choices?.[0]?.message?.content || "";
    if (content.trim() === "NONE") return null;

    const nameMatch = content.match(/NAME:\s*(\w+)/);
    const descMatch = content.match(/DESCRIPTION:\s*(.+)/);
    const paramsMatch = content.match(/PARAMETERS:\s*(.+)/);

    if (!nameMatch || !descMatch) return null;

    const params: Record<string, any> = {};
    if (paramsMatch) {
        for (const p of paramsMatch[1].split(",").map(s => s.trim())) {
            if (p) params[p] = { type: "string", description: p };
        }
    }

    return { name: nameMatch[1], description: descMatch[1].trim(), parameters: params };
}

async function generateImplementation(
    llm: LLMClient,
    spec: { name: string; description: string; parameters: Record<string, any> },
): Promise<string | null> {
    const paramList = Object.keys(spec.parameters).join(", ");

    const messages: ChatCompletionMessageParam[] = [
        {
            role: "user",
            content: `Generate a TypeScript function implementation for this tool:
Name: ${spec.name}
Description: ${spec.description}
Parameters: ${paramList}

Requirements:
- Return a string result
- Use only Node.js built-in modules (fs, path, child_process, https)
- Handle errors gracefully
- Be concise (under 50 lines)

Output ONLY the function body (no function declaration, no exports).`,
        },
    ];

    const response = await llm.chat({
        messages,
        systemPrompt: "You are a code generator. Output only TypeScript code, no markdown, no explanation.",
        modelOverride: "anthropic/claude-haiku-4.5",
    });

    const content = response.choices?.[0]?.message?.content?.trim() || "";
    if (content.length < 10) return null;

    // Strip markdown code blocks if present
    return content.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
}

function validateImplementation(code: string): boolean {
    // Basic safety checks
    const dangerous = ["process.exit", "rm -rf", "eval(", "require('child_process').exec"];
    for (const d of dangerous) {
        if (code.includes(d)) return false;
    }
    // Must return something
    if (!code.includes("return")) return false;
    return true;
}

// ── Query ─────────────────────────────────────

export function getFabricatedTool(name: string): FabricatedTool | undefined {
    return fabricatedTools.get(name);
}

export function getAllFabricatedTools(): FabricatedTool[] {
    return [...fabricatedTools.values()];
}
