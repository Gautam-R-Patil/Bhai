// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Inbox execution engine — runs the suggestedAction.toolCalls of an
// approved InboxItem and returns the aggregate result.
// Phase 6.1 of the proactive overhaul.

import type { SuggestedToolCall } from "../intent.js";

export type ExecutionResult = {
    status: "done" | "failed";
    summary: string;             // user-facing one-line summary
    perCallResults: Array<{
        toolName: string;
        ok: boolean;
        output?: string;          // truncated to ~500 chars for user display
        error?: string;
    }>;
};

export type ExecutorDeps = {
    executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
};

const RESULT_PREVIEW_CHARS = 500;

/**
 * Run all toolCalls in order. Short-circuits on the first failure —
 * no retry logic, no partial success (the user approved a bundle).
 * Returns a summary the Composer can display back.
 */
export async function executeApprovedIntent(
    toolCalls: SuggestedToolCall[],
    deps: ExecutorDeps,
): Promise<ExecutionResult> {
    if (toolCalls.length === 0) {
        return {
            status: "done",
            summary: "Approved (no tool calls to run).",
            perCallResults: [],
        };
    }

    const perCallResults: ExecutionResult["perCallResults"] = [];

    for (const call of toolCalls) {
        let raw: string;
        try {
            raw = await deps.executeTool(call.toolName, call.args);
        } catch (err) {
            const error = (err as Error).message;
            perCallResults.push({ toolName: call.toolName, ok: false, error });
            return {
                status: "failed",
                summary: `Failed at ${call.toolName}: ${error.slice(0, 200)}`,
                perCallResults,
            };
        }

        // executeTool returns a string — either a JSON blob or an error JSON like {"error":"..."}
        const isError = isExecuteToolErrorString(raw);
        if (isError) {
            const errMsg = extractErrorMessage(raw);
            perCallResults.push({ toolName: call.toolName, ok: false, error: errMsg });
            return {
                status: "failed",
                summary: `Failed at ${call.toolName}: ${errMsg.slice(0, 200)}`,
                perCallResults,
            };
        }

        perCallResults.push({
            toolName: call.toolName,
            ok: true,
            output: raw.slice(0, RESULT_PREVIEW_CHARS),
        });
    }

    const summary = perCallResults.length === 1
        ? `Done with ${perCallResults[0].toolName}.`
        : `Done — ran ${perCallResults.length} tool calls.`;

    return { status: "done", summary, perCallResults };
}

function isExecuteToolErrorString(raw: string): boolean {
    // executeTool returns JSON like {"error":"..."} on failure. Parse once.
    try {
        const parsed = JSON.parse(raw);
        return typeof parsed === "object" && parsed !== null && typeof parsed.error === "string";
    } catch {
        return false;  // not JSON = not an error in the expected shape
    }
}

function extractErrorMessage(raw: string): string {
    try {
        const parsed = JSON.parse(raw) as { error?: string };
        return parsed.error ?? "unknown error";
    } catch {
        return "unparseable error";
    }
}
