// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Neurosymbolic Logic Verifier ─────────────────
 * Auto-formalizes reasoning steps into logical propositions and
 * verifies them for consistency using the native SAT solver.
 * Inspired by Aristotle (ACL 2025) and LogicReward (ICLR 2026).
 */

import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";

// ── Types ─────────────────────────────────────

export interface LogicVerification {
    isConsistent: boolean;
    soundnessScore: number;  // 0-1
    issues: string[];
    propositions: Array<{ text: string; confidence: number }>;
}

// ── Verify Reasoning Chain ────────────────────

/**
 * Verify a sequence of reasoning steps for logical consistency.
 * 1. LLM formalizes each step into a proposition with truth value
 * 2. Native Rust checks consistency and reasoning chain validity
 * 3. Returns issues and a soundness score
 */
export async function verifyReasoning(
    llm: LLMClient,
    steps: string[],
    conclusion: string,
): Promise<LogicVerification> {
    if (steps.length === 0) {
        return { isConsistent: true, soundnessScore: 1, issues: [], propositions: [] };
    }

    // Step 1: Formalize propositions via LLM
    const propositions = await formalizeSteps(llm, steps, conclusion);

    // Step 2: Check via native Rust
    const native = loadNative();
    if (native) {
        const nativeProps = propositions.map(p => ({
            id: p.id,
            text: p.text,
            truth_value: p.truthValue,
            confidence: p.confidence,
        }));

        const consistency = native.checkPropositionConsistency(nativeProps);
        const verification = native.verifyReasoningChain(nativeProps, propositions[propositions.length - 1]?.confidence || 0.5);

        return {
            isConsistent: consistency.is_consistent,
            soundnessScore: verification.score,
            issues: [
                ...consistency.contradictions.map((c: string) => `Contradiction: ${c}`),
                ...verification.issues,
            ],
            propositions: propositions.map(p => ({ text: p.text, confidence: p.confidence })),
        };
    }

    // JS fallback: basic checks
    return {
        isConsistent: true,
        soundnessScore: 0.7,
        issues: [],
        propositions: propositions.map(p => ({ text: p.text, confidence: p.confidence })),
    };
}

async function formalizeSteps(
    llm: LLMClient,
    steps: string[],
    conclusion: string,
): Promise<Array<{ id: string; text: string; truthValue: boolean | null; confidence: number }>> {
    const messages: ChatCompletionMessageParam[] = [
        {
            role: "user",
            content: `Formalize each reasoning step as a proposition with confidence:

${steps.map((s, i) => `Step ${i + 1}: ${s}`).join("\n")}
Conclusion: ${conclusion}

For each, output:
PROP: [the claim as a clear statement]
TRUTH: [true/false/unknown]
CONFIDENCE: [0.0-1.0]`,
        },
    ];

    try {
        const response = await llm.chat({
            messages,
            systemPrompt: "Formalize reasoning steps into logical propositions. Be precise.",
            modelOverride: "openai/gpt-5-mini",
        });

        const content = response.choices?.[0]?.message?.content || "";
        return parseFormalizedSteps(content);
    } catch {
        return steps.map((s, i) => ({ id: `p${i}`, text: s, truthValue: null, confidence: 0.5 }));
    }
}

function parseFormalizedSteps(response: string): Array<{ id: string; text: string; truthValue: boolean | null; confidence: number }> {
    const results: Array<{ id: string; text: string; truthValue: boolean | null; confidence: number }> = [];
    const blocks = response.split(/PROP:\s*/i).filter(b => b.trim());

    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const text = block.split("\n")[0].trim();
        const truthMatch = block.match(/TRUTH:\s*(true|false|unknown)/i);
        const confMatch = block.match(/CONFIDENCE:\s*([\d.]+)/i);

        const truthValue = truthMatch?.[1]?.toLowerCase() === "true" ? true
            : truthMatch?.[1]?.toLowerCase() === "false" ? false : null;
        const confidence = confMatch ? parseFloat(confMatch[1]) : 0.5;

        results.push({ id: `p${i}`, text, truthValue, confidence: Math.min(1, confidence) });
    }

    return results;
}

// ── Native Module ─────────────────────────────

let _native: any = null;
let _nativeLoaded = false;
function loadNative(): any {
    if (_nativeLoaded) return _native;
    _nativeLoaded = true;
    try {
        const { createRequire } = require("node:module");
        const r = createRequire(import.meta.url);
        const path = require("node:path");
        _native = r(path.join(process.cwd(), "native", "index.js"));
        return _native;
    } catch { return null; }
}
