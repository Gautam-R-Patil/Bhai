// Copyright (c) 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Composable LLM Middleware Pipeline ──────────
// Middleware functions wrap the LLM `.chat()` call, each having
// the opportunity to inspect/modify params before the call and
// process/cache the result after. Middleware compose left-to-right:
//   composeLLMMiddleware(A, B, C) => A wraps B wraps C wraps actual call

import type {
    ChatCompletionMessageParam,
    ChatCompletionTool,
    ChatCompletion,
} from "openai/resources/chat/completions.js";

// ── Types ────────────────────────────────────────

export interface ChatParams {
    messages: ChatCompletionMessageParam[];
    tools?: ChatCompletionTool[];
    systemPrompt?: string;
    thinkingLevel?: string;
    modelOverride?: string;
    skillSlugs?: string[];
    /** Internal: the resolved model after routing */
    _resolvedModel?: string;
    /** Internal: pre-computed query embedding for cache */
    _queryEmbedding?: Float32Array | null;
    /** Internal: whether this is a thinking/reasoning call */
    _isThinking?: boolean;
}

export type LLMMiddleware = (
    params: ChatParams,
    next: (params: ChatParams) => Promise<ChatCompletion>,
) => Promise<ChatCompletion>;

// ── Composition ──────────────────────────────────

/**
 * Compose multiple middleware into a single middleware.
 * Execution order: first middleware is outermost (runs first on request,
 * last on response). An empty list returns a pass-through.
 */
export function composeLLMMiddleware(...middlewares: LLMMiddleware[]): LLMMiddleware {
    if (middlewares.length === 0) {
        return (params, next) => next(params);
    }

    return middlewares.reduceRight<LLMMiddleware>(
        (nextMiddleware, currentMiddleware) => {
            return (params, finalNext) => {
                return currentMiddleware(params, (modifiedParams) => {
                    return nextMiddleware(modifiedParams, finalNext);
                });
            };
        },
        (params, next) => next(params),
    );
}

// ── Built-in Middleware ──────────────────────────

/**
 * Cache middleware -- checks semantic cache before calling LLM,
 * caches response after. Only applies to simple queries (no tools,
 * no thinking mode).
 */
export function createCacheMiddleware(): LLMMiddleware {
    return async (params, next) => {
        const hasTools = params.tools && params.tools.length > 0;
        const isThinking = params._isThinking;

        // Only cache simple queries without tools or thinking
        if (hasTools || isThinking) {
            return next(params);
        }

        let queryEmbedding: Float32Array | null = null;

        try {
            const { getCachedResponse, embedQuery } = await import("./llm-cache.js");
            const lastUserMsg = [...params.messages].reverse().find(m => m.role === "user");
            const queryText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";

            if (queryText) {
                const model = params._resolvedModel || params.modelOverride || "default";
                const cached = await getCachedResponse(queryText, model);
                if (cached) return cached;
                queryEmbedding = await embedQuery(queryText);
            }
        } catch {
            // Cache module not available -- proceed without
        }

        // Store embedding for post-call caching
        params._queryEmbedding = queryEmbedding;

        const response = await next(params);

        // Cache the response after successful call
        if (queryEmbedding && !hasTools && !isThinking) {
            try {
                const { cacheResponse } = await import("./llm-cache.js");
                const lastUserMsg = [...params.messages].reverse().find(m => m.role === "user");
                const queryText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";
                const model = params._resolvedModel || params.modelOverride || "default";
                cacheResponse(queryText, queryEmbedding, model, response);
            } catch { /* cache module not available */ }
        }

        return response;
    };
}

/**
 * Language middleware -- detects user language from the last user
 * message and injects a "respond in {language}" instruction into
 * the system context.
 */
export function createLanguageMiddleware(): LLMMiddleware {
    return async (params, next) => {
        try {
            const { updateSessionLanguage, getLanguageInstruction } = await import("./language.js");
            const lastUserMsg = [...params.messages].reverse().find(m => m.role === "user");
            if (lastUserMsg && typeof lastUserMsg.content === "string") {
                updateSessionLanguage(lastUserMsg.content);
            }
            const instruction = getLanguageInstruction();
            if (instruction) {
                // Store it so the caller can inject it into context
                // We append it as metadata rather than modifying messages directly
                // to keep the middleware composable
                (params as unknown as Record<string, unknown>)._languageInstruction = instruction;
            }
        } catch {
            // Language module not available -- continue without
        }

        return next(params);
    };
}

/**
 * Telemetry middleware -- logs request timing, token counts,
 * and model used for each LLM call.
 */
export function createTelemetryMiddleware(): LLMMiddleware {
    return async (params, next) => {
        const startTime = Date.now();
        const model = params._resolvedModel || params.modelOverride || "unknown";

        let response: ChatCompletion;
        try {
            response = await next(params);
        } catch (err) {
            const elapsed = Date.now() - startTime;
            console.error(`  [LLM-TELEMETRY] ${model} FAILED after ${elapsed}ms: ${(err as Error).message}`);
            throw err;
        }

        const elapsed = Date.now() - startTime;
        const usage = response.usage;
        const promptTokens = usage?.prompt_tokens ?? 0;
        const completionTokens = usage?.completion_tokens ?? 0;
        const totalTokens = usage?.total_tokens ?? promptTokens + completionTokens;

        // Only log if meaningful (skip noise from cached responses)
        if (elapsed > 0) {
            console.log(
                `  [LLM-TELEMETRY] ${model} | ${elapsed}ms | ` +
                `${promptTokens} in / ${completionTokens} out (${totalTokens} total)`,
            );
        }

        return response;
    };
}

// ── Cost Tracking State ─────────────────────────

interface CostEntry {
    model: string;
    promptTokens: number;
    completionTokens: number;
    estimatedCost: number;
    timestamp: number;
}

const costLog: CostEntry[] = [];
const MAX_COST_LOG = 500;

// Approximate costs per 1M tokens (USD) -- rough estimates for routing
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
    "anthropic/claude-opus-4.6": { input: 15, output: 75 },
    "anthropic/claude-sonnet-4.6": { input: 3, output: 15 },
    "anthropic/claude-sonnet-4.5": { input: 3, output: 15 },
    "anthropic/claude-haiku-4.5": { input: 0.8, output: 4 },
    "google/gemini-3.1-pro-preview-customtools": { input: 1.25, output: 10 },
    "google/gemini-2.5-flash": { input: 0.15, output: 0.6 },
    "google/gemini-3-flash-preview": { input: 0.15, output: 0.6 },
    "google/gemini-3.1-flash-lite-preview": { input: 0.04, output: 0.15 },
    "google/gemini-2.5-flash-lite": { input: 0.04, output: 0.15 },
};

const DEFAULT_COST = { input: 1, output: 5 }; // Conservative default

/**
 * Cost middleware -- tracks estimated token costs per call.
 * Provides session-level cost aggregation via getCostSummary().
 */
export function createCostMiddleware(): LLMMiddleware {
    return async (params, next) => {
        const response = await next(params);

        const model = params._resolvedModel || params.modelOverride || "unknown";
        const usage = response.usage;
        const promptTokens = usage?.prompt_tokens ?? 0;
        const completionTokens = usage?.completion_tokens ?? 0;

        const costs = MODEL_COSTS[model] || DEFAULT_COST;
        const estimatedCost =
            (promptTokens / 1_000_000) * costs.input +
            (completionTokens / 1_000_000) * costs.output;

        const entry: CostEntry = {
            model,
            promptTokens,
            completionTokens,
            estimatedCost,
            timestamp: Date.now(),
        };

        costLog.push(entry);
        if (costLog.length > MAX_COST_LOG) {
            costLog.splice(0, costLog.length - MAX_COST_LOG);
        }

        return response;
    };
}

/**
 * Get a summary of estimated costs from the cost middleware.
 */
export function getCostSummary(): {
    totalCalls: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalEstimatedCost: number;
    byModel: Record<string, { calls: number; cost: number }>;
} {
    const byModel: Record<string, { calls: number; cost: number }> = {};
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalEstimatedCost = 0;

    for (const entry of costLog) {
        totalPromptTokens += entry.promptTokens;
        totalCompletionTokens += entry.completionTokens;
        totalEstimatedCost += entry.estimatedCost;

        if (!byModel[entry.model]) {
            byModel[entry.model] = { calls: 0, cost: 0 };
        }
        byModel[entry.model].calls++;
        byModel[entry.model].cost += entry.estimatedCost;
    }

    return {
        totalCalls: costLog.length,
        totalPromptTokens,
        totalCompletionTokens,
        totalEstimatedCost,
        byModel,
    };
}

/**
 * Reset cost tracking state.
 */
export function resetCostTracking(): void {
    costLog.length = 0;
}

// ── Default Pipeline ─────────────────────────────

/**
 * Create the default middleware pipeline used by LLMClient.chat().
 * Order: cache -> language -> telemetry -> cost -> actual LLM call
 */
export function createDefaultPipeline(): LLMMiddleware {
    return composeLLMMiddleware(
        createCacheMiddleware(),
        createLanguageMiddleware(),
        createTelemetryMiddleware(),
        createCostMiddleware(),
    );
}
