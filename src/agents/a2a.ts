// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── A2A (Agent-to-Agent) Protocol ───────────────
// Implements Google's A2A protocol for inter-agent communication.
// Provides: Agent Card discovery, structured task lifecycle,
// agent-as-tool pattern, and HTTP endpoints for external requests.

import type { LLMClient, ChatCompletionTool } from "../llm.js";
import { runSubAgent, type AgentRole, type SubAgentResult } from "./sub-agent.js";
import { getToolNames } from "../tools/index.js";
import crypto from "node:crypto";

// ── Agent Card ──────────────────────────────────

export interface AgentCard {
    name: string;
    description: string;
    version: string;
    capabilities: string[];
    tools: string[];
    endpoint: string;
    maxConcurrentTasks: number;
}

const ATLAS_VERSION = "0.2.0";
const MAX_CONCURRENT_TASKS = 5;

/** Returns Bhai's Agent Card — a JSON capability descriptor. */
export function getAgentCard(): AgentCard {
    const port = process.env.OVERLAY_PORT || "18792";
    return {
        name: "Bhai",
        description: "Autonomous personal AI agent with research, coding, browser automation, system control, and memory capabilities.",
        version: ATLAS_VERSION,
        capabilities: ["research", "coding", "browser", "system", "memory"],
        tools: getToolNames(),
        endpoint: `http://127.0.0.1:${port}/a2a`,
        maxConcurrentTasks: MAX_CONCURRENT_TASKS,
    };
}

// ── Task Lifecycle ──────────────────────────────

export type TaskState = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

export interface A2ATask {
    id: string;
    description: string;
    state: TaskState;
    requester: string;
    assignee?: string;
    progress: number;
    result?: string;
    error?: string;
    createdAt: number;
    updatedAt: number;
}

// In-memory task store with cleanup
const taskStore = new Map<string, A2ATask>();
let taskCounter = 0;

// Periodic cleanup of old completed/failed/cancelled tasks (1 hour TTL)
const TASK_TTL_MS = 60 * 60 * 1000;

function cleanupOldTasks(): void {
    const now = Date.now();
    for (const [id, task] of taskStore) {
        if (
            (task.state === "completed" || task.state === "failed" || task.state === "cancelled") &&
            now - task.updatedAt > TASK_TTL_MS
        ) {
            taskStore.delete(id);
        }
    }
}

const _cleanupInterval = setInterval(cleanupOldTasks, 30 * 60 * 1000);
_cleanupInterval.unref();

/** Create a new A2A task. */
export function createTask(description: string, requester: string): A2ATask {
    const id = `a2a_${++taskCounter}_${crypto.randomBytes(4).toString("hex")}`;
    const now = Date.now();
    const task: A2ATask = {
        id,
        description,
        state: "pending",
        requester,
        progress: 0,
        createdAt: now,
        updatedAt: now,
    };
    taskStore.set(id, task);
    console.log(`[A2A] Task created: ${id} from ${requester}`);
    return task;
}

/** Update an A2A task's state and optionally its result/error. */
export function updateTaskState(taskId: string, state: TaskState, result?: string): void {
    const task = taskStore.get(taskId);
    if (!task) {
        console.warn(`[A2A] Cannot update unknown task: ${taskId}`);
        return;
    }
    task.state = state;
    task.updatedAt = Date.now();

    if (state === "completed") {
        task.progress = 100;
        if (result) task.result = result;
    } else if (state === "failed") {
        if (result) task.error = result;
    } else if (state === "in_progress") {
        // Increment progress heuristically if not already at 100
        if (task.progress < 90) task.progress += 10;
    } else if (state === "cancelled") {
        // No change to progress
    }

    console.log(`[A2A] Task ${taskId}: ${state}${result ? ` — ${result.substring(0, 80)}` : ""}`);
}

/** Get a specific task by ID. */
export function getTask(taskId: string): A2ATask | null {
    return taskStore.get(taskId) || null;
}

/** List tasks, optionally filtered by state. */
export function listTasks(filter?: { state?: TaskState }): A2ATask[] {
    const all = Array.from(taskStore.values());
    if (filter?.state) {
        return all.filter(t => t.state === filter.state);
    }
    return all;
}

// ── Task Execution via Sub-Agent ────────────────

/** Map A2A capabilities to sub-agent roles. */
function inferRole(description: string): AgentRole {
    const lower = description.toLowerCase();
    if (/\b(search|research|find|look up|information|gather)\b/.test(lower)) return "researcher";
    if (/\b(code|program|script|build|compile|install|deploy|shell|command)\b/.test(lower)) return "coder";
    if (/\b(browse|website|web page|navigate|click|scrape|extract.*web)\b/.test(lower)) return "browser";
    if (/\b(macos|applescript|screenshot|system|automate.*app|window)\b/.test(lower)) return "system";
    return "general";
}

/**
 * Execute an A2A task using the sub-agent infrastructure.
 * Runs asynchronously — updates task state as it progresses.
 */
export async function executeA2ATask(
    llm: LLMClient,
    taskId: string,
): Promise<void> {
    const task = taskStore.get(taskId);
    if (!task) {
        console.warn(`[A2A] Cannot execute unknown task: ${taskId}`);
        return;
    }

    // Check concurrency limit
    const activeTasks = Array.from(taskStore.values()).filter(
        t => t.state === "in_progress"
    );
    if (activeTasks.length >= MAX_CONCURRENT_TASKS) {
        updateTaskState(taskId, "failed", "Concurrency limit reached. Try again later.");
        return;
    }

    updateTaskState(taskId, "in_progress");
    const role = inferRole(task.description);
    task.assignee = role;

    try {
        const result: SubAgentResult = await runSubAgent(llm, {
            id: `a2a_agent_${taskId}`,
            role,
            description: task.description,
            maxIterations: 30,
            timeoutMs: 300_000, // 5 min
            onPartialResult: (partial, toolCallsSoFar) => {
                // Update progress proportionally
                task.progress = Math.min(90, Math.round((toolCallsSoFar / 30) * 100));
                task.updatedAt = Date.now();
            },
        });

        if (result.success) {
            updateTaskState(taskId, "completed", result.output);
        } else {
            updateTaskState(taskId, "failed", result.error || "Sub-agent execution failed");
        }
    } catch (err) {
        updateTaskState(taskId, "failed", (err as Error).message);
    }
}

/** Cancel a running A2A task. */
export function cancelA2ATask(taskId: string): boolean {
    const task = taskStore.get(taskId);
    if (!task) return false;
    if (task.state === "completed" || task.state === "failed" || task.state === "cancelled") {
        return false;
    }
    updateTaskState(taskId, "cancelled");
    return true;
}

// ── Agent-as-Tool Pattern ───────────────────────

/**
 * Creates a ChatCompletionTool definition from an AgentCard.
 * When the LLM invokes this tool, it delegates to the appropriate sub-agent
 * through the A2A task lifecycle.
 */
export function agentAsToolDefinition(card: AgentCard): ChatCompletionTool {
    return {
        type: "function",
        function: {
            name: `delegate_to_${card.name.toLowerCase().replace(/[^a-z0-9]/g, "_")}`,
            description: `Delegate a task to the "${card.name}" agent. ${card.description} Capabilities: ${card.capabilities.join(", ")}.`,
            parameters: {
                type: "object",
                properties: {
                    task_description: {
                        type: "string",
                        description: "A clear, detailed description of the task to delegate to this agent.",
                    },
                    priority: {
                        type: "string",
                        enum: ["critical", "normal", "low"],
                        description: "Task priority. Critical tasks get more iterations and timeout.",
                    },
                },
                required: ["task_description"],
            },
        },
    };
}

/**
 * Handle a tool call that delegates to an agent via A2A.
 * Returns the task result as a string for the calling LLM.
 */
export async function handleAgentToolCall(
    llm: LLMClient,
    args: { task_description: string; priority?: string },
): Promise<string> {
    const task = createTask(args.task_description, "agent_tool_call");
    await executeA2ATask(llm, task.id);

    const finalTask = getTask(task.id);
    if (!finalTask) return "Task execution failed: task not found after execution.";

    if (finalTask.state === "completed") {
        return finalTask.result || "(task completed with no output)";
    } else {
        return `Task failed: ${finalTask.error || "unknown error"}`;
    }
}

// ── HTTP Endpoint Handlers ──────────────────────

/**
 * Constant-time bearer-token check. Returns true when the supplied
 * Authorization header matches the ATLAS_A2A_TOKEN env var. Returns
 * false when the token is missing on either side — i.e. without a
 * configured token, every authenticated route is denied.
 */
function authorizeA2A(authHeader: string | null | undefined): boolean {
    const expected = process.env.ATLAS_A2A_TOKEN;
    if (!expected || !authHeader) return false;
    const m = /^Bearer\s+(\S+)\s*$/.exec(authHeader);
    if (!m) return false;
    const supplied = m[1];
    if (supplied.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
        diff |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
    }
    return diff === 0;
}

const UNAUTHORIZED = {
    status: 401,
    body: JSON.stringify({
        error: "Unauthorized",
        message: "A2A mutating routes require Authorization: Bearer <ATLAS_A2A_TOKEN>. Set ATLAS_A2A_TOKEN in env to enable A2A.",
    }),
    contentType: "application/json",
};

/**
 * Handle A2A HTTP requests. Called from the overlay HTTP server.
 * Routes:
 *   GET  /.well-known/agent.json  — Agent Card (PUBLIC, no auth — this is the discovery doc)
 *   POST /a2a/tasks               — Create task (AUTH)
 *   GET  /a2a/tasks                — List tasks (AUTH)
 *   GET  /a2a/tasks/:id           — Get task status (AUTH)
 *   POST /a2a/tasks/:id/cancel    — Cancel task (AUTH)
 *
 * Auth model: ATLAS_A2A_TOKEN env var must be set, and clients must send
 * `Authorization: Bearer <token>`. Without an env-set token, no mutating
 * route works — closes the drive-by-RCE primitive where any visited webpage
 * could POST tasks because the overlay HTTP server listens on 127.0.0.1.
 */
export function handleA2ARequest(
    method: string,
    pathname: string,
    body: string | null,
    llm: LLMClient,
    authHeader?: string | null,
): { status: number; body: string; contentType: string } {
    // GET /.well-known/agent.json — publishes capabilities; no auth required.
    if (pathname === "/.well-known/agent.json" && method === "GET") {
        return {
            status: 200,
            body: JSON.stringify(getAgentCard(), null, 2),
            contentType: "application/json",
        };
    }

    // Every other A2A route mutates or exposes task state — require a bearer.
    if (!authorizeA2A(authHeader)) return UNAUTHORIZED;

    // POST /a2a/tasks — create a new task
    if (pathname === "/a2a/tasks" && method === "POST") {
        if (!body) {
            return { status: 400, body: JSON.stringify({ error: "Request body required" }), contentType: "application/json" };
        }
        try {
            const parsed = JSON.parse(body);
            const description = parsed.description || parsed.task;
            const requester = parsed.requester || parsed.agent || "external";
            if (!description || typeof description !== "string") {
                return { status: 400, body: JSON.stringify({ error: "Missing 'description' field" }), contentType: "application/json" };
            }

            const task = createTask(description, requester);

            // Execute asynchronously — don't block the HTTP response
            executeA2ATask(llm, task.id).catch(err => {
                console.error(`[A2A] Background task execution failed: ${task.id}`, err);
                updateTaskState(task.id, "failed", (err as Error).message);
            });

            return {
                status: 201,
                body: JSON.stringify(task),
                contentType: "application/json",
            };
        } catch {
            return { status: 400, body: JSON.stringify({ error: "Invalid JSON body" }), contentType: "application/json" };
        }
    }

    // GET /a2a/tasks — list all tasks
    if (pathname === "/a2a/tasks" && method === "GET") {
        const tasks = listTasks();
        return {
            status: 200,
            body: JSON.stringify(tasks),
            contentType: "application/json",
        };
    }

    // Match /a2a/tasks/:id and /a2a/tasks/:id/cancel
    const taskIdMatch = pathname.match(/^\/a2a\/tasks\/([^/]+?)(?:\/cancel)?$/);
    if (taskIdMatch) {
        const taskId = taskIdMatch[1];
        const isCancel = pathname.endsWith("/cancel");

        // POST /a2a/tasks/:id/cancel
        if (isCancel && method === "POST") {
            const cancelled = cancelA2ATask(taskId);
            if (cancelled) {
                const task = getTask(taskId);
                return {
                    status: 200,
                    body: JSON.stringify(task),
                    contentType: "application/json",
                };
            }
            return { status: 404, body: JSON.stringify({ error: "Task not found or already terminal" }), contentType: "application/json" };
        }

        // GET /a2a/tasks/:id
        if (!isCancel && method === "GET") {
            const task = getTask(taskId);
            if (task) {
                return {
                    status: 200,
                    body: JSON.stringify(task),
                    contentType: "application/json",
                };
            }
            return { status: 404, body: JSON.stringify({ error: "Task not found" }), contentType: "application/json" };
        }
    }

    // Not an A2A route
    return { status: 404, body: JSON.stringify({ error: "Not found" }), contentType: "application/json" };
}

/**
 * Check if a request URL is an A2A route.
 */
export function isA2ARoute(pathname: string): boolean {
    return pathname === "/.well-known/agent.json" ||
        pathname.startsWith("/a2a/");
}
