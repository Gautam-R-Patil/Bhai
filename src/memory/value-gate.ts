// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { createHash } from "node:crypto";

export type Source = "user" | "tool" | "reflection" | "consolidation";

export interface GateDecision {
    reject: boolean;
    reason: string;
}

export interface AllowDecision {
    allow: boolean;
    reason: string;
}

const TOOL_RESULT_PREFIX = /^\[tool result\]/;
const WM_SPILL_PREFIX = /^\[WM-Spill\]/;
const MAX_CONTENT_LENGTH = 2000;

export function hardReject(content: string, source: Source, _importance: number, _category: string): GateDecision {
    if (source === "tool" && TOOL_RESULT_PREFIX.test(content)) {
        return { reject: true, reason: "tool_result_prefix" };
    }
    if (content.includes('"screenshot_base64"') || content.includes('"image_base64"')) {
        return { reject: true, reason: "binary_blob" };
    }
    if (WM_SPILL_PREFIX.test(content)) {
        return { reject: true, reason: "wm_spill_marker" };
    }
    if (content.length > MAX_CONTENT_LENGTH) {
        return { reject: true, reason: "oversize" };
    }
    if (isPureJson(content)) {
        return { reject: true, reason: "pure_json" };
    }
    return { reject: false, reason: "" };
}

function isPureJson(content: string): boolean {
    const trimmed = content.trim();
    if (trimmed.length < 2) return false;
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    const looksObj = first === "{" && last === "}";
    const looksArr = first === "[" && last === "]";
    if (!looksObj && !looksArr) return false;
    try {
        JSON.parse(trimmed);
        return true;
    } catch {
        return false;
    }
}

const CURATED_CATEGORIES = new Set([
    "identity",
    "person",
    "session_summary",
    "knowledge_crystal",
    "recovery_reflection",
    "brand",
    "research",
    "voice",
]);

const HIGH_IMPORTANCE_THRESHOLD = 8;

export function hardAllow(_content: string, source: Source, importance: number, category: string): AllowDecision {
    if (source === "reflection") return { allow: true, reason: "source_reflection" };
    if (source === "consolidation") return { allow: true, reason: "source_consolidation" };
    if (importance >= HIGH_IMPORTANCE_THRESHOLD) return { allow: true, reason: "high_importance" };
    if (CURATED_CATEGORIES.has(category)) return { allow: true, reason: "curated_category" };
    return { allow: false, reason: "" };
}

const LLM_TIMEOUT_MS = 2000;
const LLM_CACHE_MAX = 10000;
const llmCache = new Map<string, "ADD" | "DROP">();

export interface LlmGateResult {
    decision: "ADD" | "DROP";
    reason: string;
}

interface LlmClientLike {
    // biome-ignore lint/suspicious/noExplicitAny: parameter type is bivariant so any[] is the only way to accept both
    // the real LLMClient (whose messages is the OpenAI ChatCompletionMessageParam[]) and test stubs that pass simpler shapes.
    chat: (params: {
        messages: any[];
        systemPrompt?: string;
        modelOverride?: string;
        [key: string]: unknown;
    }) => Promise<{ choices: Array<{ message: { content: string | null } }> }>;
}

export function __clearLlmGateCacheForTesting(): void {
    llmCache.clear();
}

function sha256Key(content: string): string {
    return createHash("sha256").update(content).digest("hex");
}

function cacheGet(key: string): "ADD" | "DROP" | undefined {
    return llmCache.get(key);
}

function cachePut(key: string, value: "ADD" | "DROP"): void {
    if (llmCache.size >= LLM_CACHE_MAX) {
        const firstKey = llmCache.keys().next().value;
        if (firstKey !== undefined) llmCache.delete(firstKey);
    }
    llmCache.set(key, value);
}

export async function llmGate(content: string, llm: LlmClientLike | null): Promise<LlmGateResult> {
    if (!llm) return { decision: "DROP", reason: "no_llm" };

    const key = sha256Key(content);
    const cached = cacheGet(key);
    if (cached) {
        return { decision: cached, reason: cached === "ADD" ? "cache_add" : "cache_drop" };
    }

    let response: Awaited<ReturnType<LlmClientLike["chat"]>> | null = null;
    try {
        const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("gate_timeout")), LLM_TIMEOUT_MS),
        );
        response = await Promise.race([
            llm.chat({
                messages: [
                    {
                        role: "user",
                        content:
                            "Is this a durable fact about the user, their projects, their preferences, or a generalizable learning? Or is it execution telemetry (tool calls, errors, system noise)?\n\nReply ADD or DROP only.\n\nContent:\n" +
                            content,
                    },
                ],
                systemPrompt: "You are a concise memory admission classifier. Respond with only the word ADD or DROP.",
                modelOverride: "openai/gpt-4.1-nano",
            }),
            timeoutPromise,
        ]);
    } catch {
        return { decision: "DROP", reason: "llm_error" };
    }

    const raw = response.choices[0]?.message?.content;
    if (typeof raw !== "string") return { decision: "DROP", reason: "llm_malformed" };
    const trimmed = raw.trim().toUpperCase();

    if (trimmed === "ADD") {
        cachePut(key, "ADD");
        return { decision: "ADD", reason: "llm_add" };
    }
    if (trimmed === "DROP") {
        cachePut(key, "DROP");
        return { decision: "DROP", reason: "llm_drop" };
    }
    return { decision: "DROP", reason: "llm_malformed" };
}
