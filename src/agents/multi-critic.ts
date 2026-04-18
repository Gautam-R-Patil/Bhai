// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Multi-Agent Reflexion (MAR) ──────────────────
 * Inspired by MAR (arXiv:2512.20845, Dec 2025).
 * When single-agent self-critique fails, spawns 2-3 critic sub-agents
 * with different evaluation perspectives. Aggregates into a consensus
 * reflection stored in task-learnings.
 *
 * Perspectives: completeness, correctness, user-alignment.
 */

import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";

// ── Types ─────────────────────────────────────

export interface CriticPerspective {
    name: string;
    focus: string;
    systemPrompt: string;
}

export interface CriticResult {
    perspective: string;
    assessment: string;
    score: number;        // 0-100
    suggestions: string[];
}

export interface ConsensusReflection {
    overall_score: number;
    key_issues: string[];
    consensus_suggestions: string[];
    should_retry: boolean;
}

// ── Critic Perspectives ───────────────────────

const PERSPECTIVES: CriticPerspective[] = [
    {
        name: "completeness",
        focus: "Was the task fully completed? Are there missing steps or partial results?",
        systemPrompt: "You are a completeness auditor. Your job is to identify gaps, missing steps, and incomplete work. Be thorough but fair.",
    },
    {
        name: "correctness",
        focus: "Is the output factually correct? Are there errors, hallucinations, or wrong assumptions?",
        systemPrompt: "You are a correctness validator. Your job is to find factual errors, logical flaws, and incorrect assumptions. Be precise.",
    },
    {
        name: "user_alignment",
        focus: "Does the result actually address what the user wanted? Is the tone and format appropriate?",
        systemPrompt: "You are a user advocate. Your job is to evaluate whether the output truly serves the user's needs, not just technically correct but actually useful.",
    },
];

// ── Run Multi-Critic Debate ───────────────────

/**
 * Run multi-critic evaluation on a task result.
 * Spawns critics in parallel, then aggregates into consensus.
 */
export async function runMultiCriticDebate(
    llm: LLMClient,
    taskDescription: string,
    taskResult: string,
    userContext?: string
): Promise<ConsensusReflection> {
    // Run all critics in parallel
    const criticResults = await Promise.all(
        PERSPECTIVES.map(perspective =>
            runCritic(llm, perspective, taskDescription, taskResult, userContext)
        )
    );

    // Aggregate into consensus
    return aggregateConsensus(criticResults);
}

// ── Individual Critic ─────────────────────────

async function runCritic(
    llm: LLMClient,
    perspective: CriticPerspective,
    taskDescription: string,
    taskResult: string,
    userContext?: string
): Promise<CriticResult> {
    const messages: ChatCompletionMessageParam[] = [
        {
            role: "user",
            content: `Evaluate this task result from the perspective of ${perspective.focus}

TASK: ${taskDescription}

RESULT:
${taskResult.substring(0, 3000)}

${userContext ? `USER CONTEXT: ${userContext}` : ""}

Provide:
1. A brief assessment (2-3 sentences)
2. A score from 0-100 (100 = perfect)
3. Up to 3 specific improvement suggestions

Format your response as:
ASSESSMENT: [your assessment]
SCORE: [number]
SUGGESTIONS:
- [suggestion 1]
- [suggestion 2]
- [suggestion 3]`,
        },
    ];

    try {
        const response = await llm.chat({
            messages,
            systemPrompt: perspective.systemPrompt,
            modelOverride: "anthropic/claude-haiku-4.5",
        });

        const content = response.choices?.[0]?.message?.content || "";
        return parseCriticResponse(perspective.name, content);
    } catch (err) {
        console.warn(`[MULTI-CRITIC] ${perspective.name} critic failed:`, (err as Error).message);
        return {
            perspective: perspective.name,
            assessment: "Evaluation failed",
            score: 50,
            suggestions: [],
        };
    }
}

function parseCriticResponse(perspective: string, response: string): CriticResult {
    const assessmentMatch = response.match(/ASSESSMENT:\s*(.+?)(?=\nSCORE:|$)/s);
    const scoreMatch = response.match(/SCORE:\s*(\d+)/);
    const suggestionsSection = response.match(/SUGGESTIONS:\s*([\s\S]+)$/);

    const assessment = assessmentMatch?.[1]?.trim() || response.substring(0, 200);
    const score = scoreMatch ? Math.min(100, Math.max(0, parseInt(scoreMatch[1]))) : 50;

    const suggestions: string[] = [];
    if (suggestionsSection) {
        const lines = suggestionsSection[1].split("\n").filter(l => l.trim().startsWith("-"));
        for (const line of lines.slice(0, 3)) {
            suggestions.push(line.replace(/^-\s*/, "").trim());
        }
    }

    return { perspective, assessment, score, suggestions };
}

// ── Consensus Aggregation ─────────────────────

function aggregateConsensus(results: CriticResult[]): ConsensusReflection {
    // Overall score: weighted average (correctness weighs more)
    const weights: Record<string, number> = {
        completeness: 0.3,
        correctness: 0.4,
        user_alignment: 0.3,
    };

    let weightedScore = 0;
    let totalWeight = 0;

    for (const r of results) {
        const w = weights[r.perspective] || 0.33;
        weightedScore += r.score * w;
        totalWeight += w;
    }

    const overallScore = totalWeight > 0 ? weightedScore / totalWeight : 50;

    // Collect all unique issues (assessments with score < 70)
    const keyIssues: string[] = results
        .filter(r => r.score < 70)
        .map(r => `[${r.perspective}] ${r.assessment}`);

    // Deduplicate suggestions (simple text overlap check)
    const allSuggestions = results.flatMap(r => r.suggestions);
    const uniqueSuggestions: string[] = [];
    for (const s of allSuggestions) {
        const isDuplicate = uniqueSuggestions.some(
            existing => existing.toLowerCase().includes(s.toLowerCase().substring(0, 30))
        );
        if (!isDuplicate) uniqueSuggestions.push(s);
    }

    return {
        overall_score: overallScore,
        key_issues: keyIssues.slice(0, 5),
        consensus_suggestions: uniqueSuggestions.slice(0, 5),
        should_retry: overallScore < 50,
    };
}
