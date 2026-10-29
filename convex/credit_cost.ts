// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { toClaudeModel } from "./claude";

// ── Credit cost table — server-side only ────────────────────────
// Never exposed to the client. http.ts uses getCreditCost() to
// charge the account before forwarding the LLM request (see the
// precise pre-check at convex/http.ts section 3b).
//
// Every request runs on one of three Claude models (convex/claude.ts),
// so credits follow the model that actually answers, in line with
// real API prices (per 1M tokens in/out):
//   Haiku 5.5  $0.10/$0.50 → 0.25 credits
//   Sonnet 5.5 $2/$10      → 1 credit
//   Opus 5.5   $4/$20      → 2 credits
export const CREDIT_COSTS: Record<string, number> = {
    "claude-haiku-5-5": 0.25,
    "claude-sonnet-5-5": 1,
    "claude-opus-5-5": 2,
};

/**
 * Credit cost of a request by the client's model ID. Any ID resolves to one
 * of the three Claude models; unknown IDs land on Sonnet (pro tier), so a
 * typo can't skip billing.
 */
export function getCreditCost(modelId: string): number {
    // Grok (unhinged mode) is priced like Sonnet; on Azure failure the request
    // falls back to Sonnet anyway (toClaudeModel maps it there).
    return CREDIT_COSTS[toClaudeModel(modelId)];
}
