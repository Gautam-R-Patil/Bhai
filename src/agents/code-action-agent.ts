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

import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";
import * as vm from "node:vm";

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
    return DANGEROUS_PATTERNS.some(p => code.includes(p));
}

// ── Tool Proxy Builder ────────────────────────
// Creates a `tools` proxy object where `tools.any_tool_name({ ...params })`
// routes to the real tool executor. This is the bridge between generated
// code and the agent's registered tools.

function buildToolsProxy(
    executor: ToolExecutor,
    allowedTools?: string[],
): Record<string, (input: Record<string, unknown>) => Promise<string>> {
    // Use a Proxy so every property access returns an async tool caller.
    // This avoids having to enumerate all tool names up front.
    const allowedSet = allowedTools ? new Set(allowedTools) : null;

    return new Proxy({} as Record<string, (input: Record<string, unknown>) => Promise<string>>, {
        get(_target, prop: string) {
            // Allow toString / Symbol.toPrimitive for debugging
            if (typeof prop === "symbol" || prop === "toJSON" || prop === "then") return undefined;

            return async (input: Record<string, unknown> = {}): Promise<string> => {
                if (allowedSet && !allowedSet.has(prop)) {
                    throw new Error(`Tool "${prop}" is not in the allowed tool list. Available: ${[...allowedSet].join(", ")}`);
                }
                return executor(prop, input);
            };
        },
        has(_target, prop: string) {
            if (allowedSet) return allowedSet.has(prop);
            return true;  // Assume all tools exist — executor handles unknown tools
        },
        ownKeys() {
            return allowedSet ? [...allowedSet] : [];
        },
        getOwnPropertyDescriptor(_target, prop: string) {
            if (allowedSet && !allowedSet.has(prop)) return undefined;
            return { configurable: true, enumerable: true, writable: false };
        },
    });
}

// ── Sandbox Execution ─────────────────────────
// Runs a code snippet in a V8 sandbox with `tools` and `console` available.
// No access to process, require, fs write, or host globals.

const SANDBOX_TIMEOUT_MS = 120_000; // 2 minutes max
const MAX_OUTPUT_LENGTH = 50_000;   // Truncate very large outputs

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
    const toolsProxy = buildToolsProxy(executor, options?.allowedTools);

    // Capture console output
    const logs: string[] = [];
    const sandboxConsole = Object.freeze({
        log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
        warn: (...args: unknown[]) => logs.push(`[WARN] ${args.map(String).join(" ")}`),
        error: (...args: unknown[]) => logs.push(`[ERROR] ${args.map(String).join(" ")}`),
        info: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    });

    // Wrap user code in an async IIFE that receives tools and console
    const wrappedSource = `
        (async function __codeActionSandbox(__tools, __console) {
            const tools = __tools;
            const console = __console;
            ${code}
        })
    `;

    let compiledScript: vm.Script;
    try {
        compiledScript = new vm.Script(wrappedSource, {
            filename: "code-action-sandbox.vm",
        });
    } catch (err) {
        return { code, output: "", success: false, error: `Syntax error: ${(err as Error).message}` };
    }

    // Build sandboxed context — no host globals, no process, no require
    const sandbox: Record<string, unknown> = {
        JSON,
        Math,
        Date,
        String,
        Number,
        Boolean,
        Array,
        Object,
        RegExp,
        Map,
        Set,
        WeakMap,
        WeakSet,
        Promise,
        Error,
        TypeError,
        RangeError,
        SyntaxError,
        URIError,
        Buffer,
        URL,
        URLSearchParams,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        encodeURIComponent,
        decodeURIComponent,
        encodeURI,
        decodeURI,
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        console: sandboxConsole,
    };

    const context = vm.createContext(sandbox, {
        name: "code-action-sandbox",
        codeGeneration: {
            strings: false,  // Block eval() / new Function()
            wasm: false,
        },
    });

    try {
        // Get the wrapper function from the sandbox
        const handlerFn = compiledScript.runInContext(context, {
            timeout: 30_000,  // Compile-phase timeout
        }) as (
            tools: Record<string, (input: Record<string, unknown>) => Promise<string>>,
            console: Record<string, (...args: unknown[]) => void>,
        ) => Promise<unknown>;

        // Execute with overall timeout
        const resultPromise = handlerFn(toolsProxy, sandboxConsole);
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`Code execution timed out after ${timeout / 1000}s`)), timeout);
        });

        const rawResult = await Promise.race([resultPromise, timeoutPromise]);

        // Format output
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

        // Truncate if too large
        if (output.length > MAX_OUTPUT_LENGTH) {
            output = output.slice(0, MAX_OUTPUT_LENGTH) + `\n\n[... truncated at ${MAX_OUTPUT_LENGTH} chars]`;
        }

        return { code, output, success: true };
    } catch (err) {
        const errorMsg = (err as Error).message;
        const consoleOutput = logs.length > 0 ? `\n\n[Console output before error]\n${logs.join("\n")}` : "";
        return { code, output: "", success: false, error: `${errorMsg}${consoleOutput}` };
    }
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
${availableTools.map(t => `- tools.${t}(params): Promise<string>`).join("\n")}

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
            systemPrompt: "Generate concise JavaScript code that calls tool functions via the tools.* object to complete the task. Output only code, no explanation. The code runs in a sandbox with access to tools.* and console.*.",
        });

        let code = response.choices?.[0]?.message?.content?.trim() || "";
        // Strip markdown code fences
        code = code.replace(/^```(?:javascript|typescript|js|ts)?\n?/i, "").replace(/\n?```$/, "").trim();

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
