// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Hypothesis-Driven Research Engine ────────────
 * Before research, generates explicit hypotheses.
 * Designs searches to test/refute each.
 * Tracks evidence with confidence levels.
 * Scientific reasoning applied to information gathering.
 */

import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";

// ── Types ─────────────────────────────────────

export interface Hypothesis {
    id: string;
    statement: string;
    confidence: number;       // 0-1 current belief
    evidenceFor: string[];
    evidenceAgainst: string[];
    status: "untested" | "supported" | "refuted" | "inconclusive";
    searchQueries: string[];  // Designed queries to test this hypothesis
}

export interface ResearchPlan {
    question: string;
    hypotheses: Hypothesis[];
    queryOrder: string[];     // Optimal query execution order
}

// ── Generate Hypotheses ───────────────────────

/**
 * Generate hypotheses for a research question.
 * Returns structured hypotheses with designed search queries.
 */
export async function generateHypotheses(
    llm: LLMClient,
    researchQuestion: string,
    priorKnowledge?: string,
): Promise<ResearchPlan> {
    const messages: ChatCompletionMessageParam[] = [
        {
            role: "user",
            content: `Research question: "${researchQuestion}"
${priorKnowledge ? `Prior knowledge: ${priorKnowledge}` : ""}

Generate 2-4 competing hypotheses. For each:
H: [hypothesis statement]
CONFIDENCE: [0.0-1.0 prior belief]
SEARCH_FOR: [query to find supporting evidence]
SEARCH_AGAINST: [query to find contradicting evidence]`,
        },
    ];

    try {
        const response = await llm.chat({
            messages,
            systemPrompt: `Today is ${new Date().toDateString()}. You are a scientific research planner. Generate falsifiable hypotheses with designed search strategies.`, // lean: no clock otherwise
            modelOverride: "openai/gpt-5-mini",
            lean: true,
        });

        const content = response.choices?.[0]?.message?.content || "";
        const hypotheses = parseHypotheses(content);

        // Order queries by expected information gain (interleave for/against)
        const queryOrder: string[] = [];
        for (const h of hypotheses) {
            for (const q of h.searchQueries) {
                if (!queryOrder.includes(q)) queryOrder.push(q);
            }
        }

        return { question: researchQuestion, hypotheses, queryOrder };
    } catch {
        return {
            question: researchQuestion,
            hypotheses: [{ id: "h0", statement: researchQuestion, confidence: 0.5, evidenceFor: [], evidenceAgainst: [], status: "untested", searchQueries: [researchQuestion] }],
            queryOrder: [researchQuestion],
        };
    }
}

/**
 * Update hypothesis confidence given new evidence.
 */
export function updateHypothesis(
    hypothesis: Hypothesis,
    evidence: string,
    supports: boolean,
    strength: number,
): Hypothesis {
    const updated = { ...hypothesis };

    if (supports) {
        updated.evidenceFor.push(evidence);
        updated.confidence = Math.min(1, updated.confidence + strength * 0.2);
    } else {
        updated.evidenceAgainst.push(evidence);
        updated.confidence = Math.max(0, updated.confidence - strength * 0.2);
    }

    // Update status
    if (updated.confidence > 0.8 && updated.evidenceFor.length >= 2) {
        updated.status = "supported";
    } else if (updated.confidence < 0.2 && updated.evidenceAgainst.length >= 2) {
        updated.status = "refuted";
    } else if (updated.evidenceFor.length + updated.evidenceAgainst.length >= 3) {
        updated.status = "inconclusive";
    }

    return updated;
}

function parseHypotheses(response: string): Hypothesis[] {
    const hypotheses: Hypothesis[] = [];
    const blocks = response.split(/H:\s*/i).filter(b => b.trim());

    for (let i = 0; i < blocks.length && i < 4; i++) {
        const block = blocks[i];
        const statement = block.split("\n")[0].trim();
        const confMatch = block.match(/CONFIDENCE:\s*([\d.]+)/i);
        const forMatch = block.match(/SEARCH_FOR:\s*(.+)/i);
        const againstMatch = block.match(/SEARCH_AGAINST:\s*(.+)/i);

        const queries: string[] = [];
        if (forMatch) queries.push(forMatch[1].trim());
        if (againstMatch) queries.push(againstMatch[1].trim());

        hypotheses.push({
            id: `h${i}`,
            statement,
            confidence: confMatch ? parseFloat(confMatch[1]) : 0.5,
            evidenceFor: [],
            evidenceAgainst: [],
            status: "untested",
            searchQueries: queries,
        });
    }

    return hypotheses;
}
