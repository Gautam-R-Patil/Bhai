// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Tool Bridge — Translates ATLAS tools ↔ Gemini/OpenAI function declarations ──

import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { getToolSchemasByNames, executeTool } from "../../tools/index.js";
import type { GeminiFunctionDeclaration, LiveToolCall, LiveToolResult } from "./types.js";
import { getVoiceToolNames } from "./types.js";

// Per-tool hard timeout. Beyond this we return an error to the model so one
// hung tool doesn't stall the Promise.all and freeze the voice session.
export const VOICE_TOOL_TIMEOUT_MS = 8000;

// ── Schema Translation ───────────────────────────

/**
 * Convert OpenAI ChatCompletionTool to Gemini FunctionDeclaration format.
 * The schemas are very similar — both use JSON Schema for parameters —
 * but the wrapping differs.
 */
function openAIToGemini(tool: ChatCompletionTool): GeminiFunctionDeclaration {
    const fn = tool.function;
    const params = fn.parameters as Record<string, unknown> | undefined;

    return {
        name: fn.name,
        description: fn.description,
        parametersJsonSchema: params ? {
            type: "object",
            properties: (params.properties as Record<string, unknown>) || {},
            required: (params.required as string[]) || [],
        } : undefined,
    };
}

/**
 * Get Gemini-formatted function declarations for voice-appropriate tools.
 * Only includes fast, voice-suitable tools (no browser automation, deep research, etc.)
 */
export function getVoiceToolDeclarations(): GeminiFunctionDeclaration[] {
    const schemas = getToolSchemasByNames(getVoiceToolNames());
    return schemas.map(openAIToGemini);
}

/**
 * Get OpenAI-formatted tool schemas for voice-appropriate tools.
 * Used by the OpenAI Realtime backend (already in correct format).
 */
export function getVoiceToolSchemas(): ChatCompletionTool[] {
    return getToolSchemasByNames(getVoiceToolNames());
}

// Truncate tool args for log readability. Keeps diagnostics tight in a
// voice session where many turns fire.
function summarizeArgs(args: Record<string, unknown>): string {
    try {
        const s = JSON.stringify(args);
        return s.length > 120 ? s.slice(0, 117) + "…" : s;
    } catch {
        return "[unserializable]";
    }
}

function runWithTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        promise.then(
            (v) => { clearTimeout(t); resolve(v); },
            (e) => { clearTimeout(t); reject(e); },
        );
    });
}

// ── Tool Execution ───────────────────────────────

/**
 * Execute tool calls from the live voice backend.
 * Runs ALL calls in parallel and returns results.
 * This function does NOT block audio — caller should fire-and-forget.
 */
export async function executeVoiceToolCalls(calls: LiveToolCall[]): Promise<LiveToolResult[]> {
    const results = await Promise.all(
        calls.map(async (call): Promise<LiveToolResult> => {
            const start = Date.now();
            console.log(`  [LIVE] Tool ${call.name} → ${summarizeArgs(call.args)}`);
            try {
                const result = await runWithTimeout(
                    executeTool(call.name, call.args),
                    VOICE_TOOL_TIMEOUT_MS,
                    `tool ${call.name}`,
                );
                console.log(`  [LIVE] Tool ${call.name} completed in ${Date.now() - start}ms`);
                return { id: call.id, name: call.name, result };
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                console.error(`  [LIVE] Tool ${call.name} failed in ${Date.now() - start}ms: ${message}`);
                return { id: call.id, name: call.name, result: { error: message } };
            }
        })
    );
    return results;
}
