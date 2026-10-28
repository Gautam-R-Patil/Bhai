// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Sub-Agent Runtime ─────────────────────────
// Lightweight agent runner with role-based system prompts and filtered tool subsets.
// Each sub-agent gets its own message history and can only see the tools it needs.
// Uses smart context windowing to limit token usage in long-running tasks.

import path from "node:path";
import { isUntrustedToolResult, wrapUntrustedToolResult } from "../context-scrubber.js";
import type { ChatCompletionMessageParam, ChatCompletionTool, LLMClient } from "../llm.js";
import { selectForSubAgent } from "../model-router.js";
import { executeTool, getToolSchemasByNames } from "../tools/index.js";
import { extractPrimaryPath, logToolAction, summarizeToolCall } from "../utils/debug-log.js";
import { isToolError } from "./error-types.js";
import { smartTruncate } from "./smart-truncate.js";

// ── Worktree path rewriting (Phase 4G) ────────
// File-tool arg names that carry a path the operation will act on. For
// each, when the sub-agent has a workingDirectory set, we reroute the
// path into the worktree so edits don't race against each other in the
// shared main checkout.
const FILE_TOOL_PATH_ARGS: Record<string, string[]> = {
    read: ["file_path"],
    edit: ["file_path"],
    write: ["file_path"],
    append_file: ["file_path", "path"],
    notebook_edit: ["notebook_path"],
    grep: ["path"],
    glob: ["path"],
    list_directory: ["path"],
    delete_file: ["file_path"],
};
const SHELL_TOOLS = new Set(["shell_exec", "shell_exec_background", "test_run"]);

function rewritePathsForWorktree(fnName: string, fnArgs: Record<string, unknown>, workingDirectory: string): void {
    // Shell-family tools: inject cwd (unchanged Phase 4G behavior).
    if (SHELL_TOOLS.has(fnName)) {
        if (!("cwd" in fnArgs)) fnArgs.cwd = workingDirectory;
        return;
    }
    // File-family tools: rewrite each path arg.
    const pathKeys = FILE_TOOL_PATH_ARGS[fnName];
    if (!pathKeys) return;
    const root = process.cwd();
    const wd = path.resolve(workingDirectory);
    for (const key of pathKeys) {
        const val = fnArgs[key];
        if (typeof val !== "string" || val.length === 0) continue;
        if (path.isAbsolute(val)) {
            // Absolute path under the main checkout → remap into the worktree.
            // Absolute paths outside the main checkout are left alone so the
            // agent can still reach /tmp or referenced external files.
            const normalized = path.normalize(val);
            if (normalized === root || normalized.startsWith(root + path.sep)) {
                fnArgs[key] = path.join(wd, path.relative(root, normalized));
            }
        } else {
            fnArgs[key] = path.resolve(wd, val);
        }
    }
}

// NOTE: a2a.ts imports sub-agent.ts, so we use lazy dynamic imports to break the cycle.

// ── Context Window Configuration ─────────────────
// Keep last N messages in LLM context to prevent token bloat in long tasks
const MAX_CONTEXT_MESSAGES = 20; // Keep last 20 messages (10 exchanges)
const SUMMARIZE_THRESHOLD = 30; // Summarize when history exceeds this

// ── Loop / Stuckness Detection ────────────────────
// Detects when a sub-agent is repeating the same tool calls
const STUCK_WINDOW_SIZE = 5; // Track last N tool calls
const STUCK_WARNING_THRESHOLD = 3; // Inject warning after N consecutive identical calls
const STUCK_CRITICAL_THRESHOLD = 5; // Force-exit after N consecutive identical calls

/**
 * Fence attacker-influenceable tool output the same way the main agent does
 * (agent.ts executeToolCall), so web/tool text reads as data, not instructions.
 * Honors ATLAS_NO_UNTRUSTED_WRAP=true.
 */
function fenceToolResult(fnName: string, result: string): string {
    if (process.env.ATLAS_NO_UNTRUSTED_WRAP === "true" || !isUntrustedToolResult(fnName)) return result;
    return wrapUntrustedToolResult(fnName, result);
}

/** Fast hash for tool call deduplication (FNV-1a inspired). */
function hashToolCall(toolName: string, args: string): string {
    return `${toolName}::${args}`;
}

/** Check for repeated tool call patterns. Returns "none" | "warning" | "critical". */
function detectStuckPattern(toolHistory: string[]): "none" | "warning" | "critical" {
    if (toolHistory.length < STUCK_WARNING_THRESHOLD) return "none";
    const recent = toolHistory.slice(-STUCK_CRITICAL_THRESHOLD);
    const last = recent[recent.length - 1];

    // Count consecutive identical calls from the end
    let consecutive = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
        if (recent[i] === last) consecutive++;
        else break;
    }

    if (consecutive >= STUCK_CRITICAL_THRESHOLD) return "critical";
    if (consecutive >= STUCK_WARNING_THRESHOLD) return "warning";
    return "none";
}

// ── Role Definitions ─────────────────────────

export type AgentRole = "researcher" | "coder" | "browser" | "system" | "general";

const ROLE_TOOLS: Record<AgentRole, string[]> = {
    researcher: [
        "web_search",
        "deep_research",
        "memory_store",
        "memory_search",
        "memory_list",
        "read",
        "grep",
        "glob",
        "get_current_time",
    ],
    coder: [
        "shell_exec",
        "shell_exec_background",
        "shell_check_process",
        "shell_wait_process",
        "shell_kill_process",
        "read",
        "edit",
        "write",
        "append_file",
        "grep",
        "glob",
        "notebook_edit",
        "list_directory",
        "delete_file",
        "get_current_time",
        "code_action",
        "code_execute",
        "repo_map",
        "lsp",
        "test_run",
        "fix_issue",
        "enter_plan_mode",
        "exit_plan_mode",
        "enter_spec_mode",
        "finalize_spec",
        // Browser verification for UI/frontend changes (Phase 4J)
        "browser_verify",
        "browser_navigate",
        "browser_scan",
        "browser_wait",
        "browser_run_js",
        // Web design toolkit (Phase 4K): asset search + download + scaffolding
        "stock_image_search",
        "icon_search",
        "web_asset_download",
        "scaffold_project",
        // Codebase comprehension + git (Phase 4L)
        "codebase_index",
        "codebase_query",
        "code_change_summary",
        "agents_md_scaffold",
        "git_op",
        // Complex-task docs: pre-approval + post-completion walkthrough
        "generate_design_docs",
        "approve_design_docs",
        "generate_walkthrough",
        "render_md_to_pdf",
        "screen_record",
        "demo_project",
    ],
    browser: [
        "web_search",
        "browser_navigate",
        "browser_scan",
        "browser_click_at",
        "browser_type",
        "browser_scroll",
        "browser_extract",
        "browser_back",
        "browser_analyze",
        "browser_run_js",
        "browser_wait",
        "browser_select",
        "browser_keyboard",
        "browser_switch_tab",
        "browser_close",
        "browser_scroll_element",
        "browser_handle_captcha",
        "get_current_time",
    ],
    system: [
        // Element-aware clicking and app control first; coordinates/AppleScript are fallbacks.
        "os_smart_click",
        "os_inspect",
        "app_manager",
        "open_in_app",
        "shell_exec",
        "apple_script",
        "os_screenshot",
        "os_click",
        "os_type",
        "os_context",
        "os_ocr_click",
        "os_visual_verify",
        "read",
        "write",
        "edit",
        "get_current_time",
    ],
    general: [], // Will use all tools
};

const ROLE_PROMPTS: Record<AgentRole, string> = {
    researcher: `You are a focused research agent. Your job is to find information using search and memory tools.
Rules:
- Be concise and factual. Return structured findings, not essays.
- Always cite sources when using web search.
- CRITICAL: Only research topics DIRECTLY described in your task. Do NOT invent tangential or loosely related topics.
- When using deep_research, use your task description (or a focused subset) as the topic. Do NOT generate your own creative research queries unrelated to the task.
- Use profile="quick" for deep_research unless your task explicitly requires comprehensive research.
- Stop as soon as you have enough information — don't over-research.
- Output your findings as a clear bullet-point summary.`,

    coder: `You are a focused coding agent. Your job is to read, write, and modify code files.
Rules:
- Write clean, working code with no placeholders.
- Always read existing files before modifying them.
- Test your changes when possible (run build, lint, etc).
- Output a brief summary of what you did and any relevant file paths.`,

    browser: `You are a focused browser automation agent. Your job is to interact with web pages.
Rules:
- Always scan the page after navigating to understand the layout.
- Use precise element IDs from scan results for clicks and typing.
- Handle errors gracefully — retry with different approaches if needed.
- Output what you found or accomplished on the page.`,

    system: `You are a focused system agent. Your job is to automate macOS tasks.
Rules:
- Use AppleScript for app automation, shell_exec for terminal commands.
- Take screenshots to verify your actions worked.
- Be careful with destructive operations — always verify before proceeding.
- Output a brief summary of what you accomplished.`,

    general: `You are a general-purpose agent. Complete the assigned task using any available tools.
Rules:
- Be efficient — use the minimum number of tool calls needed.
- Output a concise summary of your results.`,
};

// ── Dynamic Tool Expansion (#12) ─────────────
// Allows sub-agents to request additional tools mid-execution.

const REQUEST_TOOLS_SCHEMA: ChatCompletionTool = {
    type: "function",
    function: {
        name: "request_tools",
        description:
            "Request additional tools that are not in your current toolset. Provide tool names you need. Available categories: shell (shell_exec), files/coding (read, edit, write, append_file, grep, glob), browser (browser_navigate, browser_scan, browser_click_at), memory (memory_store, memory_search), web (web_search, deep_research).",
        parameters: {
            type: "object",
            properties: {
                tool_names: {
                    type: "array",
                    items: { type: "string" },
                    description: "Names of the tools you need access to",
                },
                reason: {
                    type: "string",
                    description: "Brief reason why you need these tools",
                },
            },
            required: ["tool_names", "reason"],
        },
    },
};

// Tools that are always safe to grant to any role
const SAFE_EXPANSION_TOOLS = new Set([
    "read",
    "edit",
    "write",
    "append_file",
    "grep",
    "glob",
    "list_directory",
    "get_current_time",
    "memory_store",
    "memory_search",
    "memory_list",
    "web_search",
    "shell_exec",
]);

// ── A2A Delegation Tool ─────────────────────────
// Allows sub-agents to delegate tasks to other specialized agents via A2A protocol.
// Uses lazy dynamic import to avoid circular dependency (a2a.ts imports sub-agent.ts).

let _a2aDelegateTool: ChatCompletionTool | null = null;
const _A2A_DELEGATE_PREFIX = "delegate_to_";

async function getA2ADelegateTool(): Promise<ChatCompletionTool> {
    if (!_a2aDelegateTool) {
        const { getAgentCard, agentAsToolDefinition } = await import("./a2a.js");
        _a2aDelegateTool = agentAsToolDefinition(getAgentCard());
    }
    return _a2aDelegateTool;
}

/** Check if a tool call name is the A2A delegate tool. */
function isA2ADelegateCall(fnName: string): boolean {
    return fnName.startsWith(_A2A_DELEGATE_PREFIX);
}

/** Handle A2A delegation via lazy import. */
async function execA2ADelegate(llm: LLMClient, args: { task_description: string; priority?: string }): Promise<string> {
    const { handleAgentToolCall } = await import("./a2a.js");
    return handleAgentToolCall(llm, args);
}

// ── Sub-Agent Types ──────────────────────────

export interface SubAgentTask {
    id: string;
    role: AgentRole;
    description: string;
    context?: string; // Context from dependency results
    maxIterations?: number; // Default: 15
    timeoutMs?: number; // Default: 60000
    priority?: "critical" | "normal" | "low"; // From critical path analysis (#4)
    /** Callback for streaming partial results every N tool calls (#19) */
    onPartialResult?: (partialOutput: string, toolCallsSoFar: number) => void;
    /** Interval for emitting partial results (in tool calls). Default: 5 */
    partialResultInterval?: number;
    /**
     * Optional working directory for this sub-agent. When set, shell_exec
     * calls that don't specify their own cwd get this one injected, and a
     * reminder is appended to the system prompt so the model knows to use
     * absolute paths rooted here for read/edit/write. Used by Phase 4G
     * worktree isolation for parallel coder agents.
     */
    workingDirectory?: string;
}

export interface SubAgentResult {
    id: string;
    role: AgentRole;
    success: boolean;
    output: string;
    toolCalls: number;
    durationMs: number;
    estimatedCost: number; // Accumulated estimated cost in credits (#16)
    error?: string;
}

// ── Smart Context Windowing Helpers ─────────────

/**
 * Summarize older messages into a compact synopsis.
 * Uses extractive summarization (no LLM call) to keep it fast.
 */
function summarizeOldMessages(messages: ChatCompletionMessageParam[]): string {
    const toolNames: string[] = [];
    const keyOutputs: string[] = [];

    for (const msg of messages) {
        if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls) {
            // Extract tool names used
            for (const tc of msg.tool_calls) {
                if (!toolNames.includes(tc.function.name)) {
                    toolNames.push(tc.function.name);
                }
            }
        } else if (msg.role === "tool" && typeof msg.content === "string") {
            // Extract first line of tool outputs (usually the most informative)
            const firstLine = msg.content.split("\n")[0].substring(0, 200);
            if (firstLine.length > 20 && !firstLine.startsWith("{")) {
                keyOutputs.push(firstLine);
            }
        } else if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.length > 50) {
            // Extract assistant conclusions
            const conclusion = msg.content.substring(0, 300);
            if (!conclusion.startsWith("[") && !conclusion.startsWith("{")) {
                keyOutputs.push(`Assistant: ${conclusion}...`);
            }
        }
    }

    const summary: string[] = [];
    if (toolNames.length > 0) {
        summary.push(`Tools used: ${toolNames.join(", ")}`);
    }
    if (keyOutputs.length > 0) {
        summary.push(`Key findings:\n- ${keyOutputs.slice(0, 5).join("\n- ")}`);
    }

    return summary.join("\n\n") || "Previous steps completed.";
}

// ── Run Sub-Agent ────────────────────────────

export async function runSubAgent(
    llm: LLMClient,
    task: SubAgentTask,
    onProgress?: (stepId: string, msg: string) => Promise<void>,
): Promise<SubAgentResult> {
    const startTime = Date.now();
    // Priority-based scaling for iterations and timeout (#4)
    const priorityScale = task.priority === "critical" ? 1.5 : task.priority === "low" ? 0.75 : 1.0;
    const maxIter = Math.round((task.maxIterations || 50) * priorityScale);
    const timeout = Math.round((task.timeoutMs || 300000) * priorityScale); // 5 min base

    // Get role-specific tools (general gets all)
    const roleToolNames = [...(ROLE_TOOLS[task.role] || [])];
    const expandedTools = new Set(roleToolNames); // Tracks dynamically added tools (#12)
    const a2aTool = await getA2ADelegateTool();
    let tools: ChatCompletionTool[];
    if (task.role === "general" || roleToolNames.length === 0) {
        const { getToolSchemas } = await import("../tools/index.js");
        tools = [
            ...getToolSchemas(),
            a2aTool, // A2A: allow delegation to other agents
        ];
    } else {
        // Add the request_tools meta-tool so sub-agents can expand their toolset (#12)
        // Add A2A delegate tool for inter-agent delegation
        tools = [...getToolSchemasByNames(roleToolNames), REQUEST_TOOLS_SCHEMA, a2aTool];
    }

    // Build a focused system prompt
    let systemPrompt = ROLE_PROMPTS[task.role];
    if (task.workingDirectory) {
        systemPrompt += `\n\nYour working directory for this task is: ${task.workingDirectory}\nAll shell commands default to this cwd. File tools (read/edit/write/grep/glob/etc.) automatically reroute relative or main-checkout-rooted paths into this worktree — you can reference paths as they appear in the repo-map and they'll land in the right place. Only use absolute paths OUTSIDE this worktree when you deliberately need to reach something beyond the workspace (e.g., /tmp).`;
    }

    // Build initial message with task description + any upstream context
    let userContent = `## Your Task\n${task.description}`;
    if (task.context) {
        userContent = `## Context from Previous Steps\n${task.context}\n\n${userContent}`;
    }

    // Full history (for context retention and debugging)
    const fullHistory: ChatCompletionMessageParam[] = [{ role: "user", content: userContent }];

    // Summary of older messages (created when history exceeds threshold)
    let historySummary = "";

    let iterations = 0;
    let totalToolCalls = 0;
    let errorCount = 0; // Track errors for model escalation (#13)
    let estimatedCost = 0; // Accumulated estimated cost (#16)
    const toolCallHistory: string[] = []; // Track tool calls for loop detection (#11)
    // Why the loop stopped without a final answer. Every such exit is a failure,
    // so swarm/mesh recovery (retry → rephrase → reroute → skip) gets to run.
    let failure = "";

    try {
        while (iterations < maxIter) {
            // Check timeout
            if (Date.now() - startTime > timeout) {
                console.warn(`  ⏰ Sub-agent ${task.id} timed out after ${timeout}ms`);
                failure = `Sub-agent timed out after ${timeout}ms`;
                break;
            }

            iterations++;

            // ── Smart Context Windowing ──────────────────
            // Send only recent messages to LLM to prevent token bloat
            let messages: ChatCompletionMessageParam[];
            if (fullHistory.length <= MAX_CONTEXT_MESSAGES) {
                // Short history — send everything
                messages = fullHistory;
            } else {
                // Long history — send summary + recent messages
                const recentMessages = fullHistory.slice(-MAX_CONTEXT_MESSAGES);

                // Create a context summary if we haven't yet, or if history grew a lot
                if (fullHistory.length >= SUMMARIZE_THRESHOLD && !historySummary) {
                    const oldMessages = fullHistory.slice(0, -MAX_CONTEXT_MESSAGES);
                    historySummary = summarizeOldMessages(oldMessages);
                }

                // Prepend summary context to first message
                if (historySummary) {
                    const contextNote: ChatCompletionMessageParam = {
                        role: "user",
                        content: `[CONTEXT SUMMARY - Previous ${fullHistory.length - MAX_CONTEXT_MESSAGES} messages]\n${historySummary}\n\n[END SUMMARY - Recent conversation continues below]`,
                    };
                    messages = [contextNote, ...recentMessages];
                } else {
                    messages = recentMessages;
                }
            }

            const modelSelection = selectForSubAgent(
                task.priority === "critical" ? `[COMPLEX TASK] ${task.description}` : task.description,
                iterations,
                errorCount,
                task.role,
            );
            estimatedCost += modelSelection.estimatedCostPerCall || 0; // (#16)

            const response = await llm.chat({
                messages,
                tools: tools.length > 0 ? tools : undefined,
                systemPrompt,
                modelOverride: modelSelection.modelId,
            });

            const choice = response.choices?.[0];
            if (!choice) {
                failure = "Sub-agent got an empty LLM response";
                break;
            }

            const toolCalls = choice.message?.tool_calls;
            const content = choice.message?.content || "";

            // No tool calls → agent is done
            if (!toolCalls || toolCalls.length === 0) {
                return {
                    id: task.id,
                    role: task.role,
                    success: true,
                    output: content || "(no output)",
                    toolCalls: totalToolCalls,
                    durationMs: Date.now() - startTime,
                    estimatedCost,
                };
            }

            // Process tool calls — add to full history
            fullHistory.push({ role: "assistant", content, tool_calls: toolCalls } as ChatCompletionMessageParam);

            for (const tc of toolCalls) {
                const fnName = tc.function.name;
                let fnArgs: Record<string, unknown> = {};
                try {
                    fnArgs = JSON.parse(tc.function.arguments || "{}");
                } catch {
                    /* */
                }

                // Handle request_tools meta-tool (#12)
                if (fnName === "request_tools") {
                    const requested = (fnArgs.tool_names as string[]) || [];
                    const granted: string[] = [];
                    for (const toolName of requested) {
                        if (!expandedTools.has(toolName) && SAFE_EXPANSION_TOOLS.has(toolName)) {
                            expandedTools.add(toolName);
                            granted.push(toolName);
                        }
                    }
                    if (granted.length > 0) {
                        // Rebuild tool schemas with expanded set
                        tools = [...getToolSchemasByNames([...expandedTools]), REQUEST_TOOLS_SCHEMA, a2aTool];
                        console.log(`    🔓 Sub-agent ${task.id}: granted tools [${granted.join(", ")}]`);
                    }
                    fullHistory.push({
                        role: "tool",
                        tool_call_id: tc.id,
                        content:
                            granted.length > 0
                                ? `Granted access to: ${granted.join(", ")}. You can now use these tools.`
                                : `No new tools granted. Requested tools are either already available or not permitted for your role.`,
                    } as ChatCompletionMessageParam);
                    continue;
                }

                // Handle A2A agent delegation tool
                if (isA2ADelegateCall(fnName)) {
                    const delegateArgs = fnArgs as { task_description: string; priority?: string };
                    if (onProgress) {
                        await onProgress(task.id, `🤝 [${task.role}] delegating task via A2A`).catch(() => {});
                    }
                    console.log(`    🤝 Sub-agent ${task.id} (${task.role}): A2A delegation`);
                    try {
                        const delegateResult = await execA2ADelegate(llm, delegateArgs);
                        totalToolCalls++;
                        toolCallHistory.push(hashToolCall(fnName, tc.function.arguments || ""));
                        fullHistory.push({
                            role: "tool",
                            tool_call_id: tc.id,
                            content: fenceToolResult(fnName, smartTruncate(fnName, delegateResult)),
                        } as ChatCompletionMessageParam);
                    } catch (delegateErr) {
                        errorCount++;
                        totalToolCalls++;
                        fullHistory.push({
                            role: "tool",
                            tool_call_id: tc.id,
                            content: `A2A delegation failed: ${(delegateErr as Error).message}`,
                        } as ChatCompletionMessageParam);
                    }
                    continue;
                }

                if (onProgress) {
                    await onProgress(task.id, `🔧 [${task.role}] ${fnName}`).catch(() => {});
                }

                // Phase 4G: workingDirectory enforcement.
                // For shell-family tools: inject cwd (same as before).
                // For file-family tools (read/edit/write/grep/glob/etc.):
                // rewrite path-bearing args so the operation lands in the
                // sub-agent's worktree instead of the shared main checkout.
                if (task.workingDirectory && typeof fnArgs === "object" && fnArgs) {
                    rewritePathsForWorktree(fnName, fnArgs as Record<string, unknown>, task.workingDirectory);
                }

                // Structured, file-aware breadcrumb for every tool call —
                // tells trace readers WHICH file the agent is touching and
                // WHAT specifically it's doing, not just the tool name.
                logToolAction({
                    tool: fnName,
                    filePath: extractPrimaryPath(fnArgs),
                    action: summarizeToolCall(fnName, fnArgs),
                    context: { sub_agent: task.id, role: task.role },
                });
                const result = await executeTool(fnName, fnArgs);
                totalToolCalls++;

                // Track errors for model escalation (#13)
                if (isToolError(result)) {
                    errorCount++;
                }

                // Track tool calls for loop detection (#11)
                toolCallHistory.push(hashToolCall(fnName, tc.function.arguments || ""));

                fullHistory.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: fenceToolResult(fnName, smartTruncate(fnName, result)), // Smart truncation (#3)
                } as ChatCompletionMessageParam);
            }

            // ── Streaming Partial Results (#19) ──────
            const interval = task.partialResultInterval || 5;
            if (task.onPartialResult && totalToolCalls > 0 && totalToolCalls % interval === 0) {
                const lastAssistantMsg = [...fullHistory].reverse().find((m) => m.role === "assistant");
                const partialOutput = typeof lastAssistantMsg?.content === "string" ? lastAssistantMsg.content : "";
                try {
                    task.onPartialResult(partialOutput, totalToolCalls);
                } catch {
                    /* */
                }
            }

            // ── Loop Detection (#11) ──────────────────
            const stuckLevel = detectStuckPattern(toolCallHistory);
            if (stuckLevel === "critical") {
                console.warn(
                    `  🔄 Sub-agent ${task.id} stuck (critical) — forcing exit after ${totalToolCalls} repeated tool calls`,
                );
                failure = `Sub-agent stuck in a loop repeating the same tool call (${totalToolCalls} tool calls)`;
                break;
            } else if (stuckLevel === "warning") {
                console.warn(`  🔄 Sub-agent ${task.id} may be stuck — injecting warning`);
                fullHistory.push({
                    role: "user",
                    content:
                        "⚠️ You appear to be repeating the same action with the same arguments. This is not making progress. Try a COMPLETELY DIFFERENT approach or tool. If you have enough information, stop and provide your answer.",
                } as ChatCompletionMessageParam);
            }
        }

        // No final answer: keep the last assistant text as partial output.
        const lastAssistant = [...fullHistory].reverse().find((m) => m.role === "assistant");
        const lastContent = typeof lastAssistant?.content === "string" ? lastAssistant.content : "";

        return {
            id: task.id,
            role: task.role,
            success: false,
            output: lastContent || `(partial: ${totalToolCalls} tool calls, no final answer)`,
            toolCalls: totalToolCalls,
            durationMs: Date.now() - startTime,
            estimatedCost,
            error: failure || `Sub-agent hit max iterations (${maxIter}) without finishing`,
        };
    } catch (err) {
        return {
            id: task.id,
            role: task.role,
            success: false,
            output: "",
            toolCalls: totalToolCalls,
            durationMs: Date.now() - startTime,
            estimatedCost,
            error: (err as Error).message,
        };
    }
}
