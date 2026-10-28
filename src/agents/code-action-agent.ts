// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Code-as-Action Agent ─────────────────────────
 * Inspired by Smolagents (HuggingFace, 26K+ stars).
 * Instead of JSON tool calls, generates TypeScript code that calls tools.
 * 30% fewer steps on difficult benchmarks.
 * More composable — code can call multiple tools in sequence.
 *
 * Two modes:
 *  1. `runCodeAction()` — LLM generates code from a task description (original)
 *  2. `executeCodeAction()` — Runs a user/agent-supplied code snippet directly
 *     in a vm sandbox with `tools.*` providing all registered tool handlers.
 */

import type { ChatCompletionMessageParam, LLMClient } from "../llm.js";
import { runIsolated } from "../security/vm-isolate.js";

// ── Types ─────────────────────────────────────

export interface CodeActionResult {
    code: string;
    output: string;
    success: boolean;
    error?: string;
}

/** Tool executor function signature — matches executeTool() from tools/index.ts */
export type ToolExecutor = (name: string, input: Record<string, unknown>) => Promise<string>;

// ── Dangerous Code Patterns ───────────────────

const DANGEROUS_PATTERNS = [
    "process.exit",
    "rm -rf /",
    "eval(",
    "new Function(",
    "require('child_process')",
    'require("child_process")',
    "fs.rmdirSync",
    "fs.unlinkSync('/')",
    "fs.rmSync('/')",
    "child_process",
    "__proto__",
    "constructor.constructor",
];

function containsDangerous(code: string): boolean {
    return DANGEROUS_PATTERNS.some((p) => code.includes(p));
}

// ── Sandbox Execution ─────────────────────────
// Runs a code snippet in a V8 sandbox with `tools` and `console` available.
// No access to process, require, fs write, or host globals.

const SANDBOX_TIMEOUT_MS = 120_000; // 2 minutes max
const MAX_OUTPUT_LENGTH = 50_000; // Truncate very large outputs

export async function executeCodeAction(
    code: string,
    executor: ToolExecutor,
    options?: {
        allowedTools?: string[];
        timeout?: number;
    },
): Promise<CodeActionResult> {
    // Safety check
    if (containsDangerous(code)) {
        return { code, output: "", success: false, error: "Code contains potentially dangerous operations" };
    }

    if (!code || code.trim().length < 5) {
        return { code, output: "", success: false, error: "Code snippet is empty or too short" };
    }

    const timeout = options?.timeout ?? SANDBOX_TIMEOUT_MS;
    const allowedSet = options?.allowedTools ? new Set(options.allowedTools) : null;
    const logs: string[] = [];

    // runIsolated hands the snippet no host-realm object: host builtins,
    // console fns, Buffer, setTimeout or a host Proxy all reach the host
    // Function through .constructor. `tools.*` and console cross as JSON.
    const r = await runIsolated({
        fn: `async function __codeActionSandbox(__input, tools, console) {\n${code}\n}`,
        api: `new Proxy({}, { get: (_, p) => typeof p === "string" && p !== "then" && p !== "toJSON" ? (args) => call(p, args === undefined ? {} : args) : undefined })`,
        onCall: (name, args) => {
            if (allowedSet && !allowedSet.has(name)) {
                throw new Error(
                    `Tool "${name}" is not in the allowed tool list. Available: ${[...allowedSet].join(", ")}`,
                );
            }
            return executor(name, (args ?? {}) as Record<string, unknown>);
        },
        onLog: (level, line) =>
            logs.push(level === "warn" ? `[WARN] ${line}` : level === "error" ? `[ERROR] ${line}` : line),
        timeoutMs: timeout,
        filename: "code-action-sandbox.vm",
    });

    if (!r.ok) {
        const errorMsg = r.error.startsWith("timeout after")
            ? `Code execution timed out after ${timeout / 1000}s`
            : r.error;
        const consoleOutput = logs.length > 0 ? `\n\n[Console output before error]\n${logs.join("\n")}` : "";
        return { code, output: "", success: false, error: `${errorMsg}${consoleOutput}` };
    }

    const rawResult = r.result;
    let output: string;
    if (typeof rawResult === "string") {
        output = rawResult;
    } else if (rawResult === undefined || rawResult === null) {
        output = logs.length > 0 ? logs.join("\n") : "[No return value]";
    } else {
        output = JSON.stringify(rawResult, null, 2);
    }

    // Prepend console logs if there were any and the result is separate
    if (logs.length > 0 && rawResult !== undefined && rawResult !== null) {
        output = `[Console output]\n${logs.join("\n")}\n\n[Return value]\n${output}`;
    }

    if (output.length > MAX_OUTPUT_LENGTH) {
        output = output.slice(0, MAX_OUTPUT_LENGTH) + `\n\n[... truncated at ${MAX_OUTPUT_LENGTH} chars]`;
    }

    return { code, output, success: true };
}

// ── LLM Code Generation (original mode) ──────

/**
 * Generate and execute a code action for a task.
 * The LLM writes TypeScript code that invokes tool functions.
 */
export async function runCodeAction(
    llm: LLMClient,
    task: string,
    availableTools: string[],
    context?: string,
): Promise<CodeActionResult> {
    const messages: ChatCompletionMessageParam[] = [
        {
            role: "user",
            content: `Write JavaScript code to accomplish this task. The code has access to a \`tools\` object where each tool is an async function.

TASK: ${task}
${context ? `CONTEXT: ${context}` : ""}

Available tools (call as tools.name({ param: value })):
${availableTools.map((t) => `- tools.${t}(params): Promise<string>`).join("\n")}

Rules:
- Write ONLY executable JavaScript code. Use async/await.
- Call tools via: const result = await tools.tool_name({ param: "value" })
- The code should return a string with the final result.
- You can use console.log() for intermediate output.
- Do NOT include function declarations, imports, or exports — just the body.
- Do NOT use require() or import statements.

Example:
  const files = await tools.list_directory({ path: "/src" });
  const readme = await tools.read({ file_path: "/README.md" });
  return \`Found files: \${files}\\nREADME: \${readme.slice(0, 200)}\`;`,
        },
    ];

    try {
        const response = await llm.chat({
            messages,
            systemPrompt:
                "Generate concise JavaScript code that calls tool functions via the tools.* object to complete the task. Output only code, no explanation. The code runs in a sandbox with access to tools.* and console.*.",
        });

        let code = response.choices?.[0]?.message?.content?.trim() || "";
        // Strip markdown code fences
        code = code
            .replace(/^```(?:javascript|typescript|js|ts)?\n?/i, "")
            .replace(/\n?```$/, "")
            .trim();

        if (!code || code.length < 10) {
            return { code: "", output: "", success: false, error: "No code generated" };
        }

        // Validate: no dangerous operations
        if (containsDangerous(code)) {
            return { code, output: "", success: false, error: "Code contains potentially dangerous operations" };
        }

        return { code, output: "[Code generated — ready for sandbox execution]", success: true };
    } catch (err) {
        return { code: "", output: "", success: false, error: (err as Error).message };
    }
}

/**
 * Full pipeline: LLM generates code, then execute it in sandbox.
 * Combines runCodeAction + executeCodeAction.
 */
export async function runAndExecuteCodeAction(
    llm: LLMClient,
    task: string,
    availableTools: string[],
    executor: ToolExecutor,
    context?: string,
): Promise<CodeActionResult> {
    // Step 1: Generate code
    const generated = await runCodeAction(llm, task, availableTools, context);
    if (!generated.success || !generated.code) {
        return generated;
    }

    // Step 2: Execute in sandbox
    const result = await executeCodeAction(generated.code, executor, {
        allowedTools: availableTools,
    });

    // Preserve the generated code in the result
    return { ...result, code: generated.code };
}
