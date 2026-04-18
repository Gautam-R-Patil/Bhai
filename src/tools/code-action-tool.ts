// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Code Action & Code Execute Tools ─────────
// Two tools for code-as-action patterns (Smolagents-inspired):
//
//   1. `code_action` — LLM generates code from a task description, then
//      executes it in a sandbox with `tools.*` access.
//
//   2. `code_execute` — Directly execute a JavaScript code snippet that
//      calls multiple tools programmatically. More efficient than sequential
//      JSON tool calls for multi-step operations.
//
// Both run in a V8 vm sandbox with a `tools` proxy object that routes
// to the agent's registered tool handlers.

import type { ToolDefinition } from "./get-current-time.js";
import type { LLMClient } from "../llm.js";
import { runAndExecuteCodeAction, executeCodeAction } from "../agents/code-action-agent.js";
import type { ToolExecutor } from "../agents/code-action-agent.js";

// ── Injected Dependencies ────────────────────

let _llm: LLMClient | null = null;
let _toolExecutor: ToolExecutor | null = null;

export function setCodeActionLLM(llm: LLMClient): void {
    _llm = llm;
}

/**
 * Inject the tool executor so code_execute can call registered tools.
 * Called at boot from tools/index.ts after the registry is set up.
 */
export function setCodeActionExecutor(executor: ToolExecutor): void {
    _toolExecutor = executor;
}

// ── code_action Tool ─────────────────────────
// LLM generates code from a task description, then executes it.

export const codeActionTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "code_action",
            description: `Generate and execute JavaScript code to accomplish a task by composing multiple tool calls in a single code block.
Use this as an alternative to sequential JSON tool calls when:
- The task requires chaining multiple tool calls together with logic (conditionals, loops)
- You need to process intermediate results before deciding the next step
- The task benefits from code-level composition (e.g., reading a file, transforming its content, writing the result)

The LLM generates code that calls tools via tools.tool_name({ param: value }), then the code runs in a sandbox.
Returns the generated code, execution output, and success status.`,
            parameters: {
                type: "object",
                properties: {
                    task: {
                        type: "string",
                        description: "Description of the task to accomplish via generated code",
                    },
                    available_tools: {
                        type: "array",
                        items: { type: "string" },
                        description: "List of tool function names the code can call (e.g., ['read', 'write', 'shell_exec'])",
                    },
                    context: {
                        type: "string",
                        description: "Optional additional context for the code generation (e.g., prior results, file paths)",
                    },
                },
                required: ["task", "available_tools"],
            },
        },
    },

    async handler(input) {
        if (!_llm) {
            return JSON.stringify({ error: "Code action agent not initialized — LLM client not set" });
        }
        if (!_toolExecutor) {
            return JSON.stringify({ error: "Code action agent not initialized — tool executor not set" });
        }

        const task = input.task as string;
        const availableTools = input.available_tools as string[];
        const context = input.context as string | undefined;

        if (!task) {
            return JSON.stringify({ error: "Missing 'task' parameter" });
        }
        if (!availableTools || availableTools.length === 0) {
            return JSON.stringify({ error: "Missing 'available_tools' parameter" });
        }

        try {
            const result = await runAndExecuteCodeAction(
                _llm,
                task,
                availableTools,
                _toolExecutor,
                context,
            );

            return JSON.stringify({
                success: result.success,
                code: result.code,
                output: result.output,
                error: result.error,
            });
        } catch (err) {
            return JSON.stringify({
                error: `Code action failed: ${(err as Error).message}`,
            });
        }
    },
};

// ── code_execute Tool ────────────────────────
// Directly execute a code snippet with tools.* access.
// The agent writes code inline rather than asking the LLM to generate it.

export const codeExecuteTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "code_execute",
            description: `Execute a JavaScript code snippet that can call multiple tools programmatically. More efficient than sequential tool calls for multi-step operations.

The code runs in a sandbox with access to:
- tools.read({ file_path: "/path" }) — read a file (cat -n format)
- tools.edit({ file_path, old_string, new_string }) — exact-string edit (file must be read first)
- tools.write({ file_path, content }) — write or overwrite a file (read first if exists)
- tools.append_file({ file_path, content }) — append to a file
- tools.grep({ pattern, path, output_mode }) — regex content search
- tools.glob({ pattern, path }) — find files by glob
- tools.list_directory({ path: "/dir" }) — list directory contents
- tools.shell_exec({ command: "..." }) — run a shell command
- tools.web_search({ query: "..." }) — search the web
- tools.memory_search({ query: "..." }) — search memories
- tools.<any_tool>({ ...params }) — call any registered tool by name
- console.log() — log intermediate values
- Standard JS built-ins (JSON, Math, Date, Array, Map, Set, RegExp, etc.)

Code must return a string (or the return value will be JSON-stringified).
All tool calls are async — use await.

Example:
  const files = await tools.glob({ pattern: "src/**/*.ts" });
  const parsed = JSON.parse(files);
  const contents = [];
  for (const f of parsed.files.slice(0, 3)) {
    const c = await tools.read({ file_path: f });
    contents.push(c.slice(0, 100));
  }
  return \`Found \${parsed.files.length} TS files. Previews:\\n\${contents.join("\\n---\\n")}\`;`,
            parameters: {
                type: "object",
                properties: {
                    code: {
                        type: "string",
                        description: "JavaScript code to execute. Has access to the tools.* object with all registered tools as async functions, console.log(), and standard JS built-ins. Must return a string result.",
                    },
                    allowed_tools: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional whitelist of tool names the code may call. If omitted, all tools are accessible.",
                    },
                    timeout: {
                        type: "number",
                        description: "Execution timeout in milliseconds (default 120000 = 2 minutes, max 300000 = 5 minutes).",
                    },
                },
                required: ["code"],
            },
        },
    },

    async handler(input) {
        if (!_toolExecutor) {
            return JSON.stringify({ error: "Code execute not initialized — tool executor not set. This is a boot-time wiring issue." });
        }

        const code = input.code as string;
        const allowedTools = input.allowed_tools as string[] | undefined;
        let timeout = (input.timeout as number) || 120_000;

        if (!code) {
            return JSON.stringify({ error: "Missing 'code' parameter" });
        }

        // Clamp timeout: min 5s, max 5min
        timeout = Math.max(5_000, Math.min(300_000, timeout));

        try {
            const result = await executeCodeAction(code, _toolExecutor, {
                allowedTools,
                timeout,
            });

            return JSON.stringify({
                success: result.success,
                output: result.output,
                error: result.error,
            });
        } catch (err) {
            return JSON.stringify({
                error: `Code execution failed: ${(err as Error).message}`,
            });
        }
    },
};
