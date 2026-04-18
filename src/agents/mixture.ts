// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Mixture of Agents (MoA) for Synthesis ────
// Multiple "proposer" models synthesize independently in parallel.
// An "aggregator" then cherry-picks the best parts from each proposal.
// Gated behind step count (>= 5 steps or any failures).

import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";
import { selectForSynthesis } from "../model-router.js";
import type { SubAgentResult } from "./sub-agent.js";
import type { SwarmPlan } from "./swarm.js";

// ── Configuration ────────────────────────────

export interface MoAConfig {
    /** Number of parallel proposals to generate. Default: 3 */
    proposerCount: number;
    /** Minimum step count to trigger MoA. Default: 5 */
    stepThreshold: number;
}

const DEFAULT_CONFIG: MoAConfig = {
    proposerCount: 3,
    stepThreshold: 5,
};

// ── Gate: Should We Use MoA? ─────────────────

/**
 * Determine if MoA should be used for this swarm result.
 * Activates for complex results (many steps) or when failures occurred.
 */
export function shouldUseMoA(
    stepCount: number,
    failedCount: number,
    config: Partial<MoAConfig> = {},
): boolean {
    const c = { ...DEFAULT_CONFIG, ...config };
    return stepCount >= c.stepThreshold || failedCount > 0;
}

// ── MoA Synthesis ────────────────────────────

/**
 * Run Mixture of Agents synthesis:
 * 1. Fire N parallel synthesis proposals
 * 2. Aggregate the best parts into a final answer
 */
export async function synthesizeWithMoA(
    llm: LLMClient,
    userRequest: string,
    plan: SwarmPlan,
    results: Map<string, SubAgentResult>,
    config: Partial<MoAConfig> = {},
): Promise<string> {
    const c = { ...DEFAULT_CONFIG, ...config };

    // Build the shared context that all proposers will see
    const resultSummary = plan.steps.map(step => {
        const result = results.get(step.id);
        if (!result) return `### Step ${step.id} (${step.role}): NOT EXECUTED`;
        if (!result.success) return `### Step ${step.id} (${step.role}): FAILED\nError: ${result.error || "unknown"}`;
        return `### Step ${step.id} (${step.role}): ${step.description}\n${result.output}`;
    }).join("\n\n");

    const basePrompt = `The user asked: "${userRequest}"

I broke this into ${plan.steps.length} sub-tasks and executed them. Here are the results:

${resultSummary}

Now synthesize these results into a single, coherent response for the user. Be concise and natural — don't mention the steps or decomposition process.`;

    // Varied prompts for different perspectives
    const proposerVariants = [
        "Focus on completeness — make sure every part of the user's request is addressed.",
        "Focus on accuracy — only include claims directly supported by the step outputs.",
        "Focus on conciseness — give the most efficient response possible.",
    ];

    // ── Step 1: Generate parallel proposals ──
    console.log(`[MoA] Generating ${c.proposerCount} parallel synthesis proposals...`);

    const proposalPromises = Array.from({ length: c.proposerCount }, (_, i) => {
        const variant = proposerVariants[i % proposerVariants.length];
        const prompt = `${basePrompt}\n\nAdditional guidance: ${variant}`;

        return llm.chat({
            messages: [{ role: "user", content: prompt }] as ChatCompletionMessageParam[],
            systemPrompt: `You synthesize multi-step results into natural responses. ${variant}`,
            modelOverride: selectForSynthesis(userRequest).modelId,
        }).then(r => r.choices?.[0]?.message?.content || "")
            .catch(() => ""); // Individual proposal failure is OK
    });

    const proposals = (await Promise.all(proposalPromises)).filter(p => p.length > 0);

    if (proposals.length === 0) {
        // All proposals failed — fall back to concatenation
        return [...results.values()].map(r => r.output).filter(Boolean).join("\n\n");
    }

    if (proposals.length === 1) {
        // Only one succeeded — use it directly
        return proposals[0];
    }

    // ── Step 2: Aggregate ──
    console.log(`[MoA] Aggregating ${proposals.length} proposals...`);

    const aggregationPrompt = `The user asked: "${userRequest}"

${proposals.length} independent AI agents each synthesized the same research results. Here are their proposals:

${proposals.map((p, i) => `### Proposal ${i + 1}:\n${p}`).join("\n\n")}

Create the BEST possible response by cherry-picking the strongest parts from each proposal. Resolve any contradictions by favoring the most specific and well-supported claims. Be concise.`;

    try {
        const response = await llm.chat({
            messages: [{ role: "user", content: aggregationPrompt }] as ChatCompletionMessageParam[],
            systemPrompt: "You aggregate multiple AI proposals into one optimal response. Pick the best parts from each.",
            modelOverride: selectForSynthesis(userRequest).modelId,
        });

        return response.choices?.[0]?.message?.content || proposals[0];
    } catch {
        // Aggregation failed — return the first proposal
        return proposals[0];
    }
}
