// Copyright (c) 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── LLM-Generated Memory Briefings ──────────────────────────
// Instead of injecting raw memory snippets into the agent context,
// this module uses a cheap model (Haiku) to synthesize a cohesive,
// actionable briefing relevant to the current user message.
//
// The briefing pattern: raw memory fragments from 12+ parallel retrieval
// systems are fused into one paragraph by an LLM, producing higher
// relevance and lower token waste.

import type { LLMClient } from "../llm.js";

// ── Toggle: switch between LLM briefing and raw injection ──
export const USE_MEMORY_BRIEFING = true;
/**
 * Raw memory under this many chars is injected as-is: a few thousand extra
 * input tokens cost less than a briefing call (one more per-call credit and
 * 2-3s on the critical path). The injection cap is 8K chars (agent.contextCap).
 */
export const BRIEFING_MIN_CHARS = 6000;

/**
 * Synthesize raw memory section outputs into a concise, actionable briefing.
 *
 * @param llm - The LLM client (will use Haiku for cost efficiency)
 * @param rawMemories - Map of section name -> raw memory content (from 12 parallel retrievals)
 * @param userMessage - The current user message for relevance filtering
 * @param maxTokens - Maximum tokens for the briefing output (default 400)
 * @returns A single cohesive briefing paragraph, or null on failure (fail-open)
 */
export async function generateMemoryBriefing(
    llm: LLMClient,
    rawMemories: Record<string, string>,
    userMessage: string,
    maxTokens: number = 400,
): Promise<string | null> {
    // Filter out empty sections
    const nonEmpty = Object.entries(rawMemories).filter(([, v]) => v && v.trim().length > 0);
    if (nonEmpty.length === 0) return null;

    // Build the memory dump for the synthesizer
    const memoryDump = nonEmpty
        .map(([section, content]) => `--- ${section} ---\n${content}`)
        .join("\n\n");

    // Cap the memory dump to avoid sending too much to Haiku
    const MAX_INPUT_CHARS = 6000;
    const cappedDump = memoryDump.length > MAX_INPUT_CHARS
        ? memoryDump.substring(0, MAX_INPUT_CHARS) + "\n[... truncated]"
        : memoryDump;

    const briefingPrompt = `You are a memory briefing system for a personal AI assistant called Bhai.

Below are memory fragments retrieved from various memory subsystems (identity, traits, emotions, episodes, relationships, knowledge graph, core facts, recalled memories, task learnings, etc.).

The user's current message is: "${userMessage}"

MEMORY FRAGMENTS:
${cappedDump}

TASK: Synthesize these fragments into a concise, actionable briefing (max ~${maxTokens} tokens) that is directly relevant to the user's message. Rules:
- Focus only on what's useful for responding to this specific message
- Prioritize: user identity/name, relevant preferences, active context, relationship tone
- Omit generic or irrelevant memories
- Use bullet points for key facts, a short paragraph for context
- If the user's message is a greeting, keep the briefing very short (just name + relationship tone)
- Never fabricate information not present in the fragments

Output ONLY the briefing, no preamble.`;

    try {
        const response = await llm.chat({
            messages: [{ role: "user", content: briefingPrompt }],
            systemPrompt: "You are a concise memory synthesis engine. Output only the briefing.",
            modelOverride: "openai/gpt-4.1-nano",
            lean: true,
        });

        const briefing = response.choices?.[0]?.message?.content?.trim();
        if (!briefing || briefing.length < 10) return null;

        return briefing;
    } catch (err) {
        console.warn("[MEMORY][BRIEFING] LLM briefing generation failed (non-fatal):", (err as Error).message);
        return null;
    }
}
