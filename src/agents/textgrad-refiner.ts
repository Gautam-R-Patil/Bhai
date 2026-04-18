// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── TextGrad Refiner ─────────────────────────────
 * Backpropagation via text — when evaluator scores low, generates
 * targeted textual "gradients" that guide the retry.
 * Published in Nature. Pushes GPT-3.5 close to GPT-4 on reasoning tasks.
 *
 * Instead of generic "try again" prompts, TextGrad produces specific
 * feedback like "Step 3 assumed X but evidence shows Y — revise."
 */

import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";

// ── Types ─────────────────────────────────────

export interface TextGradient {
    targetSection: string;       // Which part of the output to refine
    feedback: string;            // Specific textual gradient
    severity: "critical" | "moderate" | "minor";
    suggestedDirection: string;  // How to change it
}

export interface RefinementResult {
    refined: boolean;
    gradients: TextGradient[];
    refinedOutput: string;
    iterationsUsed: number;
}

// ── Generate Textual Gradients ────────────────

/**
 * Generate textual gradients (specific feedback) for a low-scoring output.
 * These act like backpropagation — pointing exactly at what needs to change.
 */
export async function generateGradients(
    llm: LLMClient,
    taskDescription: string,
    currentOutput: string,
    evaluationScores: { completeness: number; accuracy: number; coherence: number; actionability: number },
): Promise<TextGradient[]> {
    const weakDimensions: string[] = [];
    if (evaluationScores.completeness < 0.6) weakDimensions.push("completeness (missing parts)");
    if (evaluationScores.accuracy < 0.6) weakDimensions.push("accuracy (errors/inaccuracies)");
    if (evaluationScores.coherence < 0.6) weakDimensions.push("coherence (unclear/disorganized)");
    if (evaluationScores.actionability < 0.6) weakDimensions.push("actionability (not useful to user)");

    if (weakDimensions.length === 0) return [];

    const messages: ChatCompletionMessageParam[] = [
        {
            role: "user",
            content: `Analyze this output and provide SPECIFIC feedback for improvement.

TASK: ${taskDescription}

OUTPUT:
${currentOutput.substring(0, 3000)}

WEAK DIMENSIONS: ${weakDimensions.join(", ")}

For each issue, provide targeted feedback in this format:
SECTION: [which part of the output]
SEVERITY: [critical/moderate/minor]
FEEDBACK: [specific issue]
DIRECTION: [how to fix it]

Be precise and actionable — vague feedback is useless.`,
        },
    ];

    try {
        const response = await llm.chat({
            messages,
            systemPrompt: "You are a textual gradient generator. Produce precise, actionable feedback for each weakness. Be specific about what's wrong and how to fix it.",
            modelOverride: "anthropic/claude-haiku-4.5",
        });

        return parseGradients(response.choices?.[0]?.message?.content || "");
    } catch {
        return [];
    }
}

function parseGradients(response: string): TextGradient[] {
    const gradients: TextGradient[] = [];
    const blocks = response.split(/SECTION:/i).filter(b => b.trim());

    for (const block of blocks.slice(0, 5)) { // Max 5 gradients
        const section = block.split("\n")[0].trim();
        const severityMatch = block.match(/SEVERITY:\s*(critical|moderate|minor)/i);
        const feedbackMatch = block.match(/FEEDBACK:\s*(.+)/i);
        const directionMatch = block.match(/DIRECTION:\s*(.+)/i);

        if (feedbackMatch) {
            gradients.push({
                targetSection: section,
                feedback: feedbackMatch[1].trim(),
                severity: (severityMatch?.[1]?.toLowerCase() || "moderate") as TextGradient["severity"],
                suggestedDirection: directionMatch?.[1]?.trim() || "",
            });
        }
    }

    return gradients;
}

// ── Apply Gradients (Refine Output) ───────────

/**
 * Apply textual gradients to refine an output.
 * Iterates up to maxIterations times, applying gradients each round.
 */
export async function refineWithGradients(
    llm: LLMClient,
    taskDescription: string,
    currentOutput: string,
    gradients: TextGradient[],
    maxIterations = 2,
): Promise<RefinementResult> {
    if (gradients.length === 0) {
        return { refined: false, gradients: [], refinedOutput: currentOutput, iterationsUsed: 0 };
    }

    let output = currentOutput;
    let iterations = 0;

    for (let i = 0; i < maxIterations; i++) {
        iterations++;

        // Format gradients as refinement instructions
        const gradientInstructions = gradients
            .filter(g => i === 0 || g.severity === "critical") // In later iterations, only fix critical
            .map(g => `- [${g.severity.toUpperCase()}] ${g.targetSection}: ${g.feedback}. Fix: ${g.suggestedDirection}`)
            .join("\n");

        if (!gradientInstructions) break;

        const messages: ChatCompletionMessageParam[] = [
            {
                role: "user",
                content: `TASK: ${taskDescription}

CURRENT OUTPUT:
${output.substring(0, 3000)}

SPECIFIC ISSUES TO FIX:
${gradientInstructions}

Produce an improved version that addresses ALL listed issues. Output ONLY the improved content.`,
            },
        ];

        try {
            const response = await llm.chat({
                messages,
                systemPrompt: "Apply the specified corrections precisely. Output only the improved content.",
            });

            const newOutput = response.choices?.[0]?.message?.content?.trim();
            if (newOutput && newOutput.length > output.length * 0.3) {
                output = newOutput;
            } else {
                break; // No meaningful improvement
            }
        } catch {
            break;
        }
    }

    return {
        refined: output !== currentOutput,
        gradients,
        refinedOutput: output,
        iterationsUsed: iterations,
    };
}

/**
 * Full TextGrad pipeline: evaluate → generate gradients → refine.
 * Called by evaluator.ts when quality score is low.
 */
export async function textGradRefine(
    llm: LLMClient,
    taskDescription: string,
    output: string,
    scores: { completeness: number; accuracy: number; coherence: number; actionability: number },
): Promise<RefinementResult> {
    const gradients = await generateGradients(llm, taskDescription, output, scores);
    if (gradients.length === 0) {
        return { refined: false, gradients: [], refinedOutput: output, iterationsUsed: 0 };
    }
    return refineWithGradients(llm, taskDescription, output, gradients);
}
