// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Theory of Mind ───────────────────────────────
 * Track user's mental state: what they know, believe, want, expect.
 * Before responding, consider the user's perspective.
 * Core component of general intelligence.
 */

import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";

// ── Types ─────────────────────────────────────

export interface MentalModel {
    knowledgeState: string[];       // What the user likely knows about the current topic
    beliefs: string[];              // What the user believes (may be incorrect)
    goals: string[];                // What the user is trying to achieve
    expectations: string[];         // What the user expects from the agent
    emotionalState: string;         // Current emotional disposition
    expertiseLevel: "novice" | "intermediate" | "expert";
    communicationPreference: string; // How they prefer to receive information
}

// ── Infer Mental State ────────────────────────

/**
 * Infer the user's mental model from conversation context.
 * Called before generating a response to calibrate output.
 */
export async function inferMentalModel(
    llm: LLMClient,
    recentMessages: string[],
    userProfile?: string,
): Promise<MentalModel> {
    const messages: ChatCompletionMessageParam[] = [
        {
            role: "user",
            content: `Analyze the user's mental state from this conversation:

${recentMessages.slice(-5).join("\n")}
${userProfile ? `\nUser profile: ${userProfile}` : ""}

Infer:
KNOWS: [what they likely know, comma-separated]
BELIEVES: [what they believe, may be wrong]
WANTS: [their immediate goal]
EXPECTS: [what they expect from the assistant]
EMOTION: [emotional state in one word]
EXPERTISE: [novice/intermediate/expert on the current topic]
PREFERS: [how they prefer information: brief/detailed/code-first/etc]`,
        },
    ];

    try {
        const response = await llm.chat({
            messages,
            systemPrompt: "Infer the user's mental model. Be empathetic and accurate. Output only the requested fields.",
            modelOverride: "anthropic/claude-haiku-4.5",
        });

        const content = response.choices?.[0]?.message?.content || "";
        return parseMentalModel(content);
    } catch {
        return defaultModel();
    }
}

/**
 * Generate response calibration instructions based on mental model.
 * Injected into the system prompt before generating a response.
 */
export function getResponseCalibration(model: MentalModel): string {
    const parts: string[] = [];

    if (model.expertiseLevel === "novice") {
        parts.push("User is a novice on this topic — explain fundamentals, avoid jargon.");
    } else if (model.expertiseLevel === "expert") {
        parts.push("User is an expert — be precise, skip basics, go deep.");
    }

    if (model.emotionalState === "frustrated" || model.emotionalState === "confused") {
        parts.push("User seems frustrated — be patient, validate their experience, offer clear next steps.");
    }

    if (model.expectations.length > 0) {
        parts.push(`User expects: ${model.expectations.join(", ")}`);
    }

    if (model.beliefs.length > 0) {
        parts.push(`User believes: ${model.beliefs.join(", ")} — gently correct if wrong.`);
    }

    if (model.communicationPreference) {
        parts.push(`Communication preference: ${model.communicationPreference}`);
    }

    return parts.length > 0
        ? `THEORY OF MIND (calibrate your response):\n${parts.map(p => `- ${p}`).join("\n")}`
        : "";
}

function parseMentalModel(response: string): MentalModel {
    const knowsMatch = response.match(/KNOWS:\s*(.+)/i);
    const believesMatch = response.match(/BELIEVES:\s*(.+)/i);
    const wantsMatch = response.match(/WANTS:\s*(.+)/i);
    const expectsMatch = response.match(/EXPECTS:\s*(.+)/i);
    const emotionMatch = response.match(/EMOTION:\s*(\w+)/i);
    const expertiseMatch = response.match(/EXPERTISE:\s*(\w+)/i);
    const prefersMatch = response.match(/PREFERS:\s*(.+)/i);

    return {
        knowledgeState: knowsMatch?.[1]?.split(",").map(s => s.trim()) || [],
        beliefs: believesMatch?.[1]?.split(",").map(s => s.trim()) || [],
        goals: wantsMatch?.[1]?.split(",").map(s => s.trim()) || [],
        expectations: expectsMatch?.[1]?.split(",").map(s => s.trim()) || [],
        emotionalState: emotionMatch?.[1]?.toLowerCase() || "neutral",
        expertiseLevel: (expertiseMatch?.[1]?.toLowerCase() as MentalModel["expertiseLevel"]) || "intermediate",
        communicationPreference: prefersMatch?.[1]?.trim() || "",
    };
}

function defaultModel(): MentalModel {
    return {
        knowledgeState: [], beliefs: [], goals: [], expectations: [],
        emotionalState: "neutral", expertiseLevel: "intermediate", communicationPreference: "",
    };
}
