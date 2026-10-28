// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Proactive Reward Model ───────────────────────
 * Scores whether a proactive action would be accepted or rejected.
 * Based on ProactiveAgent (ICLR 2025, 0.918 F1).
 * Replaces heuristic scoring in anticipation engine.
 *
 * Uses: user model signals, time context, recent engagement history,
 * content novelty, and interruption cost estimation.
 */

import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";

// ── Types ─────────────────────────────────────

export interface ProactiveScore {
    acceptanceProbability: number;  // 0-1
    interruptionCost: number;       // 0-1 (high = bad time to interrupt)
    novelty: number;                // 0-1
    relevance: number;              // 0-1
    recommendation: "surface" | "queue" | "suppress";
}

// ── Score Proactive Action ────────────────────

/**
 * Score a proposed proactive action using a lightweight LLM evaluation.
 * Falls back to heuristic scoring if LLM unavailable.
 */
export async function scoreProactiveAction(
    llm: LLMClient,
    proposedAction: string,
    context: {
        userActiveApp?: string;
        userIdleMinutes?: number;
        hourOfDay?: number;
        recentProactiveCount?: number;
        lastProactiveResponseType?: string;
        userMood?: string;
        relationshipDepth?: number;
    },
): Promise<ProactiveScore> {
    // Compute heuristic signals
    const interruptionCost = estimateInterruptionCost(context);
    const novelty = 0.5; // Would need embedding comparison for true novelty

    // Try LLM-based scoring for relevance and acceptance
    try {
        const messages: ChatCompletionMessageParam[] = [
            {
                role: "user",
                content: `Rate this proactive suggestion on a scale of 1-10:

SUGGESTION: "${proposedAction}"

CONTEXT:
- User is currently using: ${context.userActiveApp || "unknown"}
- User idle for: ${context.userIdleMinutes || 0} minutes
- Time: ${context.hourOfDay ?? 12}:00
- ${context.recentProactiveCount || 0} recent proactive messages sent
- User mood: ${context.userMood || "neutral"}

Would the user appreciate this right now? Score 1-10 and explain in one sentence.
Format: SCORE: [number] REASON: [explanation]`,
            },
        ];

        const response = await llm.chat({
            messages,
            systemPrompt: "Score proactive suggestions. Be strict — only high scores for genuinely useful, well-timed suggestions.",
            modelOverride: "openai/gpt-5-mini",
        });

        const content = response.choices?.[0]?.message?.content || "";
        const scoreMatch = content.match(/SCORE:\s*(\d+)/);
        const relevance = scoreMatch ? Math.min(10, parseInt(scoreMatch[1])) / 10 : 0.5;

        const acceptance = computeAcceptanceProbability(relevance, interruptionCost, novelty, context);

        return {
            acceptanceProbability: acceptance,
            interruptionCost,
            novelty,
            relevance,
            recommendation: acceptance > 0.6 ? "surface" : acceptance > 0.3 ? "queue" : "suppress",
        };
    } catch {
        // Heuristic fallback
        return heuristicScore(proposedAction, context, interruptionCost);
    }
}

// ── Heuristics ────────────────────────────────

function estimateInterruptionCost(context: {
    userActiveApp?: string;
    userIdleMinutes?: number;
    hourOfDay?: number;
    recentProactiveCount?: number;
}): number {
    let cost = 0.3; // Base cost

    // High cost if user is actively working
    if (context.userIdleMinutes !== undefined && context.userIdleMinutes < 2) {
        cost += 0.3; // User very active — bad time
    }

    // High cost if in focused app
    const focusedApps = ["Code", "Xcode", "IntelliJ", "Terminal", "vim"];
    if (context.userActiveApp && focusedApps.some(a => context.userActiveApp!.includes(a))) {
        cost += 0.2;
    }

    // High cost if many recent proactive messages
    if (context.recentProactiveCount && context.recentProactiveCount > 3) {
        cost += 0.15; // Notification fatigue
    }

    // Low cost during transition times
    const hour = context.hourOfDay ?? 12; // 0 is midnight, not "unknown"
    if (hour === 9 || hour === 13 || hour === 18) {
        cost -= 0.1; // Natural break times
    }

    return Math.max(0, Math.min(1, cost));
}

function computeAcceptanceProbability(
    relevance: number,
    interruptionCost: number,
    novelty: number,
    context: { relationshipDepth?: number },
): number {
    const relDepth = context.relationshipDepth || 0.5;

    // Acceptance = relevance × (1 - interruption_cost) × novelty_boost × relationship_factor
    const noveltyBoost = 0.8 + novelty * 0.2;
    const relationshipFactor = 0.7 + relDepth * 0.3;

    // A number, not toFixed's string: the heartbeat's suppress branch called
    // .toFixed on it, threw, and the catch surfaced the suppressed thought.
    return Number((relevance * (1 - interruptionCost * 0.7) * noveltyBoost * relationshipFactor).toFixed(3));
}

function heuristicScore(
    action: string,
    context: any,
    interruptionCost: number,
): ProactiveScore {
    const relevance = 0.5;
    const acceptance = Math.max(0, 0.5 - interruptionCost * 0.5);

    return {
        acceptanceProbability: acceptance,
        interruptionCost,
        novelty: 0.5,
        relevance,
        recommendation: acceptance > 0.4 ? "queue" : "suppress",
    };
}
