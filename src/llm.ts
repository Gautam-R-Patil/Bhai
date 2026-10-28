// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { Config } from "./config.js";
import type {
    ChatCompletionMessageParam,
    ChatCompletionTool,
    ChatCompletion,
} from "openai/resources/chat/completions.js";
import { getSessionToken, handleAuthError } from "./session.js";
import { getConvexSiteUrl } from "./config/keys.js";
import { encryptedFetch } from "./crypto-transport.js";

// ── Types ─────────────────────────────────────

export type { ChatCompletionMessageParam, ChatCompletionTool, ChatCompletion };

export type ThinkingLevel = "off" | "low" | "medium" | "high" | "max";

// Builds the client-side dynamic system block (clock + widget hint + optional
// language instruction). The clock is bucketed to the hour so this block is
// byte-stable across requests within a session — it rides ahead of the
// server-side history cache breakpoint (convex/http.ts ~:666), and a
// to-the-second timestamp busted the Anthropic prefix cache on every call.
// The live clock widget renders exact time to the user regardless.
export function buildDynamicContextBlock(
    languageContext = "",
    now: Date = new Date(),
): string {
    const hourBucket = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
    const timeContext = `[SYSTEM CLOCK: Current date/time is approximately ${hourBucket.toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" } as Intl.DateTimeFormatOptions)} ${Intl.DateTimeFormat().resolvedOptions().timeZone}]`;
    const widgetContext = `[UI WIDGETS]\nIf the user asks for the current time, DO NOT output the time in plain text. Instead, output EXACTLY this hidden tag so the UI renders a beautiful real-time animated clock widget:\n<!--WIDGET: {"type": "clock"}-->\nIf they ask for the date, you can use the clock widget too, or just say the date.`;
    const lang = languageContext ? `\n\n${languageContext}` : "";
    return `${timeContext}\n\n${widgetContext}${lang}`;
}

export interface LLMClient {
    chat(params: {
        messages: ChatCompletionMessageParam[];
        tools?: ChatCompletionTool[];
        systemPrompt?: string;
        /**
         * Server-side prompt slug to use as the system prompt instead of the
         * default identity stack. The server fetches the slug's content from
         * its DB and treats it like a systemPromptOverride. Lets internal
         * callers (e.g. the orchestrator) swap base prompts without bundling
         * any content client-side.
         */
        serverPromptSlug?: string;
        thinkingLevel?: ThinkingLevel;
        modelOverride?: string;
        skillSlugs?: string[];
        responseFormat?: "json_object";
        /**
         * Helper call (classifier, HyDE, briefing): no thinking, no clock/widget
         * context, and — when it has no tools — no server rules preamble. Much
         * faster and cheaper; use only for calls that just transform text.
         */
        lean?: boolean;
        /**
         * Deadline per model attempt, in ms, instead of the transport's default
         * (ATLAS_LLM_ATTEMPT_TIMEOUT_MS, 25s). For long generations, e.g. a
         * thinking model writing a few KB of code.
         */
        timeoutMs?: number;
    }): Promise<ChatCompletion>;
    config: Config;
}

// ── Models ────────────────────────────────────

export const MODELS = {
    PRO: "anthropic/claude-opus-4.6",
    SONNET: "anthropic/claude-sonnet-4.6",
    SONNET_45: "anthropic/claude-sonnet-4.5",
    HAIKU: "anthropic/claude-haiku-4.5",
    GEMINI_PRO: "google/gemini-3.1-pro-preview-customtools",
    GEMINI_25_FLASH: "google/gemini-2.5-flash",
    FLASH: "google/gemini-3-flash-preview",
    FLASH_LITE: "google/gemini-3.1-flash-lite-preview",
    GEMINI_25_FLASH_LITE: "google/gemini-2.5-flash-lite",
    NOVA_PRO: "amazon/nova-pro-v1",
    NOVA_LITE: "amazon/nova-lite-v1",
    NOVA_MICRO: "amazon/nova-micro-v1",
    DEEPSEEK_V31: "deepseek/deepseek-chat-v3.1",
    DEEPSEEK_V32: "deepseek/deepseek-v3.2-exp",
    DEEPSEEK_V4_PRO: "deepseek/deepseek-v4-pro",
    GLM_46: "z-ai/glm-4.6",
    GPT5_MINI: "openai/gpt-5-mini",
    GPT5_NANO: "openai/gpt-5-nano",
    GPT41_NANO: "openai/gpt-4.1-nano",
    QWEN37_PLUS: "qwen/qwen3.7-plus",
    QWEN3_VL_235B: "qwen/qwen3-vl-235b-a22b-instruct",
};

export const MODEL_DISPLAY: Record<string, string> = {
    [MODELS.PRO]: "Opus 4.6",
    [MODELS.SONNET]: "Sonnet 4.6",
    [MODELS.SONNET_45]: "Sonnet 4.5",
    [MODELS.HAIKU]: "Haiku 4.5",
    [MODELS.GEMINI_PRO]: "Gemini 3.1 Pro",
    [MODELS.GEMINI_25_FLASH]: "Gemini 2.5 Flash",
    [MODELS.FLASH]: "Gemini 3 Flash",
    [MODELS.FLASH_LITE]: "Flash Lite",
    [MODELS.GEMINI_25_FLASH_LITE]: "Gemini 2.5 Flash Lite",
    [MODELS.NOVA_PRO]: "Nova Pro",
    [MODELS.NOVA_LITE]: "Nova Lite",
    [MODELS.NOVA_MICRO]: "Nova Micro",
    [MODELS.DEEPSEEK_V31]: "DeepSeek V3.1",
    [MODELS.DEEPSEEK_V32]: "DeepSeek V3.2 (exp)",
    [MODELS.DEEPSEEK_V4_PRO]: "DeepSeek V4 Pro",
    [MODELS.GLM_46]: "GLM 4.6",
};

import { IS_MAC, IS_WIN } from "./tools/platform.js";
import { createDefaultPipeline, type ChatParams } from "./llm-middleware.js";
import { sanitizeToolSchemas, type ToolSchemaShape } from "./tools/schema-sanitizer.js";
import { sanitizeContextEchoes } from "./context-scrubber.js";
import { protect, protectMessages } from "./security/pii-vault.js";
import { tryParseOssToolCalls } from "./llm-parser-fallback.js";

// Platform identifier sent to server for platform-specific prompt assembly
const PLATFORM = IS_MAC ? "mac" : IS_WIN ? "win" : "linux";

// ── Singleton middleware pipeline ────────────────
// Created once, reused for all LLM calls. Middleware order:
// cache → language → telemetry → cost → actual LLM call
const llmMiddleware = createDefaultPipeline();

// ── Circuit Breaker (delegated to Rust router) ──────────────────
// Circuit breaker state lives in the native Rust model router for single source of truth.
// update_model_stats(success=false) increments consecutive failures and trips the breaker.
// update_model_stats(success=true) resets consecutive failures and closes the breaker.
// isCircuitOpen() checks if a model is currently tripped (3 consecutive failures, 5min cooldown).

async function isModelCircuitOpen(model: string): Promise<boolean> {
    try {
        const { isCircuitOpen } = await import("./model-router.js");
        return isCircuitOpen(model);
    } catch {
        return false; // If router not loaded, fail open
    }
}

async function getModelFallback(model: string, exclude?: string[]): Promise<string | null> {
    try {
        const { getHorizontalFailoverModel } = await import("./model-router.js");
        return getHorizontalFailoverModel(model, exclude);
    } catch {
        return null;
    }
}

// ── Create Client ─────────────────────────────

export function createLLMClient(config: Config): LLMClient {
    const proxyUrl = `${getConvexSiteUrl()}/api/llm/chat`;

    return {
        config,
        async chat({ messages, tools, systemPrompt, serverPromptSlug, thinkingLevel, modelOverride, skillSlugs, responseFormat, lean, timeoutMs }) {
            // A fresh deadline per fetch (each fallback hop gets its own), or none
            // so encryptedFetch applies its default.
            const deadline = () => (timeoutMs && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);
            // ── Network health guard: fail fast if internet is down ──
            try {
                const { isOffline, reportNetworkError } = await import("./network-health.js");
                if (isOffline()) {
                    throw new Error("Network offline — skipping LLM call");
                }
            } catch (err) {
                // Only re-throw if it's our offline error, not an import failure
                if ((err as Error).message?.includes("Network offline")) throw err;
            }

            // ── Middleware Pipeline ────────────────────
            // Cache, language detection, telemetry, and cost tracking are handled
            // by the composable middleware pipeline. The inner `next` function
            // contains the core network logic (failover, auth, etc.).

            // Unspecified callers are background work (reflection, summaries,
            // classifiers): the cheap, fast model is the right default.
            const model = modelOverride || MODELS.HAIKU;
            const effort = lean ? "off" : thinkingLevel || "off";
            const isThinking = effort !== "off";

            // Build middleware params
            const middlewareParams: ChatParams = {
                messages,
                tools,
                systemPrompt,
                thinkingLevel,
                modelOverride,
                skillSlugs,
                responseFormat,
                _resolvedModel: model,
                _isThinking: isThinking,
            };

            // The middleware pipeline wraps the core LLM call
            return llmMiddleware(middlewareParams, async (params) => {
                // Resolve language instruction from middleware (if detected)
                const languageContext = (params as unknown as Record<string, unknown>)._languageInstruction as string || "";

                // Dynamic context (non-sensitive, stays client-side).
                // Server will prepend the system prompt from its DB before this.
                // Lean helper calls skip it: a classifier doesn't need the clock.
                // Cards, OTPs, UPI IDs, Aadhaar numbers and cookies leave as handles
                // ([OTP_1]); typing tools turn them back into values (pii-vault.ts).
                const allMessages: ChatCompletionMessageParam[] = protectMessages(
                    lean
                        ? [...params.messages]
                        : [{ role: "system", content: buildDynamicContextBlock(languageContext) }, ...params.messages],
                );

                // Scale max_tokens based on thinking level
                const maxTokensByThinking: Record<string, number> = {
                    off: 4096, low: 8192, medium: 16384, high: 32768, max: 65536,
                };
                const maxTokens = maxTokensByThinking[effort] || 4096;

                // Build proxy request body (OpenRouter-compatible)
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const requestBody: any = {
                    model,
                    max_tokens: maxTokens,
                    messages: allMessages,
                    tools:
                        params.tools && params.tools.length > 0
                            ? (sanitizeToolSchemas(
                                  params.tools as unknown as ToolSchemaShape[],
                              ) as typeof params.tools)
                            : undefined,
                    platform: PLATFORM,
                    skillSlugs: params.skillSlugs || [],
                    systemPromptOverride: params.systemPrompt ? protect(params.systemPrompt) : undefined,
                    serverPromptSlug: serverPromptSlug || undefined,
                    // Grammar-constrained decoding for JSON-expecting calls.
                    // Mutually exclusive with tool use — the server drops it
                    // when tools are present so the flag is safe to set in
                    // middleware-agnostic code paths.
                    response_format: responseFormat === "json_object" ? { type: "json_object" } : undefined,
                    lean: lean || undefined,
                };

                // Always send an effort: every Claude model thinks by default
                // (Sonnet at high). "none" makes the proxy turn thinking off
                // (disabled on Haiku, between_tools on Sonnet) at the lowest effort.
                // Callers that never chose a level (planners, sub-agents,
                // research, synthesis) keep the old default: lowest effort with
                // thinking on. Only an explicit "off" or a lean helper call
                // turns thinking off.
                requestBody.reasoning = { effort: isThinking ? effort : lean || thinkingLevel === "off" ? "none" : "low" };

            // Exclude already-tried models so each hop surfaces a new provider.
            // Window-aware mode (opt-in): estimate the request's token size once
            // and skip fallback candidates whose context window can't hold it,
            // closing the silent 1M→200K hop on large-context turns. Zero LLM cost.
            const windowAware = process.env.ATLAS_WINDOW_AWARE_PRUNE === "true";
            let estTokens = 0;
            if (windowAware) {
                try {
                    const { estimateMessagesTokens } = await import("./memory/context-pruning.js");
                    estTokens = estimateMessagesTokens(allMessages);
                } catch { estTokens = 0; }
            }
            // Every id runs on one of three Claude models, so failing over to an
            // alias of the same model just repeats the failed call. Only hop to
            // a different model, and at most once.
            const { claudeTier } = await import("./model-router.js");
            const modelsToTry: string[] = [model];
            const tried: string[] = [model];
            for (let i = 0; i < 4 && modelsToTry.length < 2; i++) {
                const seed = tried[tried.length - 1];
                const next = await getModelFallback(seed, tried);
                if (!next || tried.includes(next)) break;
                tried.push(next);
                if (modelsToTry.some((m) => claudeTier(m) === claudeTier(next))) continue;
                if (windowAware && estTokens > 0) {
                    try {
                        const { getContextWindow } = await import("./model-router.js");
                        // Skip a candidate that can't hold the request (+headroom).
                        if (getContextWindow(next) < estTokens * 1.1) {
                            modelsToTry.push(next); // still record as tried so we don't re-pick it
                            continue;
                        }
                    } catch { /* fail-open: keep the candidate */ }
                }
                modelsToTry.push(next);
            }
            let lastError: Error | null = null;

            for (const currentModel of modelsToTry) {
                // Skip circuit-broken models instantly
                if (await isModelCircuitOpen(currentModel)) {
                    const display = MODEL_DISPLAY[currentModel] || currentModel;
                    console.warn(`  ⚡ Skipping ${display} (circuit breaker open)`);
                    continue;
                }

                const isFallback = currentModel !== model;
                if (isFallback) {
                    console.warn(`  🔄 Falling back to ${MODEL_DISPLAY[currentModel] || currentModel}...`);
                }

                // Rebuild body for this model (fallbacks drop provider constraints)
                const modelBody = { ...requestBody, model: currentModel };

                try {
                    let sessionToken = await getSessionToken();
                    if (!sessionToken) {
                        throw new Error("Not authenticated — no session token available");
                    }

                    const callStart = Date.now();
                    const response = await encryptedFetch(proxyUrl, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": `Bearer ${sessionToken}`,
                        },
                        body: JSON.stringify(modelBody),
                        signal: deadline(),
                    });

                    // Handle auth expiry — re-authenticate and retry once
                    if (response.status === 401) {
                        sessionToken = await handleAuthError();
                        if (!sessionToken) {
                            throw new Error("Authentication failed — could not refresh session");
                        }
                        const retryResponse = await encryptedFetch(proxyUrl, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                "Authorization": `Bearer ${sessionToken}`,
                            },
                            body: JSON.stringify(modelBody),
                            signal: deadline(),
                        });
                        if (!retryResponse.ok) {
                            const errData = await retryResponse.json().catch(() => ({}));
                            const raw = (errData as any).error;
                            const rawStr = typeof raw === "string" ? raw : raw ? JSON.stringify(raw) : `HTTP ${retryResponse.status}`;
                            const { sanitizeSecrets } = await import("./security/secrets-sanitizer.js");
                            throw Object.assign(
                                new Error(sanitizeSecrets(rawStr).sanitized.slice(0, 500)),
                                { status: retryResponse.status }
                            );
                        }
                        return await retryResponse.json() as ChatCompletion;
                    }

                    // Credit exhaustion — don't retry, throw immediately
                    if (response.status === 402) {
                        throw new Error("You've run out of AI credits. Top up to continue.");
                    }

                    if (!response.ok) {
                        const errData = await response.json().catch(() => ({}));
                        const errMsg = (errData as any).error?.message || (errData as any).error || `HTTP ${response.status}`;
                        const rawStr = typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg);
                        const { sanitizeSecrets } = await import("./security/secrets-sanitizer.js");
                        const safe = sanitizeSecrets(rawStr).sanitized;
                        const errStr = safe.slice(0, 200);
                        console.error(`  ❌ ${MODEL_DISPLAY[currentModel] || currentModel} failed (${response.status}): ${errStr}`);
                        throw Object.assign(
                            new Error(safe.slice(0, 500)),
                            { status: response.status }
                        );
                    }

                    const responseData = await response.json() as ChatCompletion;
                    const callLatency = Date.now() - callStart;

                    // Log thinking if present
                    const choice = responseData.choices?.[0];
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const reasoning = (choice as any)?.message?.reasoning_content
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        || (choice as any)?.message?.reasoning;
                    if (reasoning && typeof reasoning === "string") {
                        const preview = reasoning.substring(0, 150).replace(/\n/g, " ");
                        console.log(`  💭 Thinking: ${preview}...`);
                    }

                    // Track success for adaptive routing
                    try {
                        const { updateModelStats } = await import("./model-router.js");
                        const inputEst = responseData.usage?.prompt_tokens || 500;
                        const outputEst = responseData.usage?.completion_tokens || 300;
                        updateModelStats(currentModel, callLatency, true, inputEst, outputEst);
                    } catch { /* router not loaded yet */ }

                    // Report network success to health monitor
                    try {
                        const { reportNetworkSuccess } = await import("./network-health.js");
                        reportNetworkSuccess();
                    } catch { /* */ }

                    if (isFallback) {
                        console.log(`  ✅ Fallback to ${MODEL_DISPLAY[currentModel] || currentModel} succeeded`);
                    }

                    // OSS tool-call parser fallback: when the server returns
                    // content with embedded <tool_call>… / <|python_tag|> / other
                    // native markup but tool_calls is empty, parse and fill it in.
                    tryParseOssToolCalls(responseData);

                    // Strip any leaked <memory-context> fence echoes from the
                    // final assistant content before it reaches channels.
                    const msg = responseData.choices?.[0]?.message as
                        | { content?: string | null }
                        | undefined;
                    if (msg && typeof msg.content === "string" && msg.content) {
                        msg.content = sanitizeContextEchoes(msg.content);
                    }

                    // Response caching is now handled by the cache middleware in the pipeline

                    return responseData;
                } catch (err) {
                    lastError = err as Error;
                    const status = (err as { status?: number }).status;

                    // Track failure for adaptive routing
                    try {
                        const { updateModelStats } = await import("./model-router.js");
                        updateModelStats(currentModel, 0, false, 0, 0, status);
                    } catch { /* router not loaded yet */ }

                    // Non-retryable client errors (auth, forbidden) — throw, don't try other models
                    const nonRetryable = [401, 402, 403];
                    if (status && nonRetryable.includes(status)) {
                        throw err;
                    }

                    // Report network errors to health monitor so it can detect offline state
                    const errMsg = (err as Error).message || "";
                    const isNetworkError = errMsg.includes("fetch failed") || errMsg.includes("ENOTFOUND") ||
                        errMsg.includes("ETIMEDOUT") || errMsg.includes("ECONNREFUSED") ||
                        errMsg.includes("ENETUNREACH") || errMsg.includes("EHOSTUNREACH") ||
                        errMsg.includes("aborted") || errMsg.includes("network");
                    if (isNetworkError) {
                        try {
                            const { reportNetworkError } = await import("./network-health.js");
                            const netStatus = await reportNetworkError();
                            if (netStatus === "offline") {
                                // Internet is down — no point trying more models
                                console.warn(`  ❌ Internet appears to be down — aborting model fallback chain`);
                                break;
                            }
                        } catch { /* health monitor not loaded */ }
                    }

                    // For everything else (400, 408, 429, 500, network) → immediately try next model
                    console.warn(`  ⚠️ ${MODEL_DISPLAY[currentModel] || currentModel} failed — trying next model...`);
                }
            }

            // ── Last-resort retry: if all models are circuit-broken, force-retry the primary model ──
            // This prevents the system from going completely dead for 5 minutes when all breakers trip simultaneously
            // (common during brief network outages that resolve quickly)
            if (modelsToTry.length > 0) {
                const primaryModel = modelsToTry[0];
                console.warn(`  ⚠️ All models circuit-broken — force-retrying ${MODEL_DISPLAY[primaryModel] || primaryModel} as last resort...`);
                try {
                    const modelBody = {
                        ...requestBody,
                        model: primaryModel,
                    };
                    let sessionToken = await getSessionToken();
                    if (sessionToken) {
                        const response = await encryptedFetch(proxyUrl, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                "Authorization": `Bearer ${sessionToken}`,
                            },
                            body: JSON.stringify(modelBody),
                            signal: deadline(),
                        });
                        if (response.ok) {
                            const responseData = await response.json() as ChatCompletion;
                            // Success! Reset circuit breaker for this model
                            try {
                                const { updateModelStats } = await import("./model-router.js");
                                updateModelStats(primaryModel, 0, true, 0, 0);
                            } catch { /* */ }
                            console.log(`  ✅ Last-resort retry succeeded — ${MODEL_DISPLAY[primaryModel] || primaryModel} is back`);
                            return responseData;
                        }
                    }
                } catch {
                    // Truly dead — fall through to throw
                }
            }

            throw lastError || new Error("All models failed");
            }); // end llmMiddleware wrapper
        },
    };
}
