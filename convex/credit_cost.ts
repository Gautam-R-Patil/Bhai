// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Credit cost table — server-side only ────────────────────────
// Never exposed to the client. http.ts uses getCreditCost() to
// charge the account before forwarding the LLM request (see the
// precise pre-check at convex/http.ts section 3b).
//
// Tiers (kept in sync with src/model-router.ts and the MODEL_COSTS
// table in observability.ts):
//   Light  (0.25): Haiku / Flash / Nova Micro+Lite  — simple tasks, casual chat
//   Mid    (0.5):  Flash / Nova Pro                 — intermediate
//   Pro    (1):    Sonnet / GPT-4o / Gemini Pro     — tool calling, browser
//   Heavy  (3):    Opus / GPT-5                     — deep reasoning

export const CREDIT_COSTS: Record<string, number> = {
    // Light tier (0.25 credits)
    "amazon/nova-micro-v1": 0.25,
    "amazon/nova-lite-v1": 0.25,
    "google/gemini-2.5-flash-lite": 0.25,
    "google/gemini-2.0-flash-001": 0.25,
    "google/gemini-3-flash-preview": 0.25,
    "google/gemini-3.1-flash-lite-preview": 0.25,
    "anthropic/claude-haiku-4.5": 0.25,
    "gpt-4o-mini": 0.25,
    "google/gemini-2.0-flash-exp": 0.25,
    "openai/gpt-5-nano": 0.25,
    "openai/gpt-4.1-nano": 0.25,
    // Mid tier (0.5 credits)
    "amazon/nova-pro-v1": 0.5,
    "google/gemini-2.5-flash": 0.5,
    "openai/gpt-5-mini": 0.5,
    "deepseek/deepseek-chat-v3.1": 0.5,
    "deepseek/deepseek-v3.2-exp": 0.5,
    "z-ai/glm-4.6": 0.5,
    // Pro tier (1 credit)
    "anthropic/claude-sonnet-4.5": 1,
    "anthropic/claude-sonnet-4.6": 1,
    "google/gemini-3.1-pro-preview-customtools": 1,
    "gpt-4o": 1,
    // Heavy tier (3 credits)
    "anthropic/claude-opus-4.6": 3,
    "openai/gpt-5-image": 3,
    // Fallback for unknown model IDs. Pro-tier by default so we don't
    // under-bill a client that specified a model we haven't priced yet.
    default: 1,
};

/**
 * Look up the credit cost of a model by ID. Unknown models fall back to
 * the default (pro-tier) rate so a typo in a client-specified model
 * doesn't let the request skip billing.
 */
export function getCreditCost(modelId: string): number {
    return CREDIT_COSTS[modelId] ?? CREDIT_COSTS.default;
}
