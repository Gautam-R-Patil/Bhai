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

export interface LLMClient {
    chat(params: {
        messages: ChatCompletionMessageParam[];
        tools?: ChatCompletionTool[];
        systemPrompt?: string;
        thinkingLevel?: ThinkingLevel;
        modelOverride?: string;
        skillSlugs?: string[];
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
    GEMINI_20_FLASH: "google/gemini-2.0-flash-001",
    NOVA_PRO: "amazon/nova-pro-v1",
    NOVA_LITE: "amazon/nova-lite-v1",
    NOVA_MICRO: "amazon/nova-micro-v1",
};

// Display names (used in terminal/frontend)
// @deprecated — Fallback chains are now resolved dynamically from the Rust router via getHorizontalFailover()
export const MODEL_FALLBACKS: Record<string, string[]> = {
    [MODELS.PRO]: [MODELS.SONNET, MODELS.GEMINI_PRO],
    [MODELS.SONNET]: [MODELS.SONNET_45, MODELS.GEMINI_PRO],
    [MODELS.SONNET_45]: [MODELS.SONNET, MODELS.GEMINI_PRO],
    [MODELS.HAIKU]: [MODELS.GEMINI_25_FLASH, MODELS.FLASH],
    [MODELS.GEMINI_PRO]: [MODELS.GEMINI_25_FLASH, MODELS.SONNET],
    [MODELS.GEMINI_25_FLASH]: [MODELS.FLASH, MODELS.NOVA_PRO],
    [MODELS.FLASH]: [MODELS.GEMINI_25_FLASH, MODELS.HAIKU],
    [MODELS.FLASH_LITE]: [MODELS.GEMINI_25_FLASH_LITE, MODELS.HAIKU],
    [MODELS.GEMINI_25_FLASH_LITE]: [MODELS.NOVA_LITE, MODELS.GEMINI_20_FLASH],
    [MODELS.GEMINI_20_FLASH]: [MODELS.GEMINI_25_FLASH_LITE, MODELS.NOVA_LITE],
    [MODELS.NOVA_PRO]: [MODELS.GEMINI_25_FLASH, MODELS.FLASH],
    [MODELS.NOVA_LITE]: [MODELS.GEMINI_25_FLASH_LITE, MODELS.GEMINI_20_FLASH],
    [MODELS.NOVA_MICRO]: [MODELS.NOVA_LITE, MODELS.GEMINI_25_FLASH_LITE],
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
    [MODELS.GEMINI_20_FLASH]: "Gemini 2.0 Flash",
    [MODELS.NOVA_PRO]: "Nova Pro",
    [MODELS.NOVA_LITE]: "Nova Lite",
    [MODELS.NOVA_MICRO]: "Nova Micro",
};

import { IS_MAC, IS_WIN } from "./tools/platform.js";
import { createDefaultPipeline, type ChatParams } from "./llm-middleware.js";

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

async function getModelFallback(model: string): Promise<string | null> {
    try {
        const { getHorizontalFailoverModel } = await import("./model-router.js");
        return getHorizontalFailoverModel(model);
    } catch {
        return null;
    }
}

// ── Create Client ─────────────────────────────

export function createLLMClient(config: Config): LLMClient {
    const proxyUrl = `${getConvexSiteUrl()}/api/llm/chat`;

    return {
        config,
        async chat({ messages, tools, systemPrompt, thinkingLevel, modelOverride, skillSlugs }) {
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

            const model = modelOverride || MODELS.PRO;
            const effort = thinkingLevel || "off";
            const isThinking = effort !== "off";

            // Build middleware params
            const middlewareParams: ChatParams = {
                messages,
                tools,
                systemPrompt,
                thinkingLevel,
                modelOverride,
                skillSlugs,
                _resolvedModel: model,
                _isThinking: isThinking,
            };

            // The middleware pipeline wraps the core LLM call
            return llmMiddleware(middlewareParams, async (params) => {
                // Resolve language instruction from middleware (if detected)
                const languageContext = (params as unknown as Record<string, unknown>)._languageInstruction as string || "";

                // Dynamic context (non-sensitive, stays client-side)
                // Server will prepend the system prompt from its DB before this.
                const now = new Date();
                const timeContext = `[SYSTEM CLOCK: Current date/time is ${now.toLocaleString("en-US", { timeZoneName: "short" })}]`;
                const widgetContext = `[UI WIDGETS]\nIf the user asks for the current time, DO NOT output the time in plain text. Instead, output EXACTLY this hidden tag so the UI renders a beautiful real-time animated clock widget:\n<!--WIDGET: {"type": "clock"}-->\nIf they ask for the date, you can use the clock widget too, or just say the date.`;

                const dynamicContext = timeContext + "\n\n" + widgetContext + (languageContext ? "\n\n" + languageContext : "");

                // Prepend dynamic context as first system message.
                const allMessages: ChatCompletionMessageParam[] = [
                    { role: "system", content: dynamicContext },
                    ...params.messages,
                ];

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
                    tools: params.tools && params.tools.length > 0 ? params.tools : undefined,
                    platform: PLATFORM,
                    skillSlugs: params.skillSlugs || [],
                    systemPromptOverride: params.systemPrompt || undefined,
                };

                // Model-aware provider routing
                if (model.startsWith("anthropic/") && !isThinking) {
                    requestBody.provider = { order: ["Google Vertex"] };
                }

                // Add reasoning config for thinking models
                if (isThinking) {
                    const apiEffort = effort === "max" ? "high" : effort;
                    requestBody.reasoning = { effort: apiEffort };
                }

            // ── Fast failover: on first error, immediately try next model ──
            // Build fallback chain: primary → up to 4 fallbacks from router
            const modelsToTry: string[] = [model];
            let fb = await getModelFallback(model);
            if (fb && !modelsToTry.includes(fb)) modelsToTry.push(fb);
            if (fb) {
                const fb2 = await getModelFallback(fb);
                if (fb2 && !modelsToTry.includes(fb2)) modelsToTry.push(fb2);
                if (fb2) {
                    const fb3 = await getModelFallback(fb2);
                    if (fb3 && !modelsToTry.includes(fb3)) modelsToTry.push(fb3);
                }
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
                const modelBody = {
                    ...requestBody,
                    model: currentModel,
                    provider: isFallback ? undefined : requestBody.provider,
                };

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
                        });
                        if (!retryResponse.ok) {
                            const errData = await retryResponse.json().catch(() => ({}));
                            throw Object.assign(
                                new Error((errData as any).error || `HTTP ${retryResponse.status}`),
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
                        const errStr = typeof errMsg === 'string' ? errMsg.slice(0, 200) : JSON.stringify(errMsg).slice(0, 200);
                        console.error(`  ❌ ${MODEL_DISPLAY[currentModel] || currentModel} failed (${response.status}): ${errStr}`);
                        throw Object.assign(
                            new Error(typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg)),
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
