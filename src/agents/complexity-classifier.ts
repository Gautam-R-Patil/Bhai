// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Complexity Classifier ────────────────────
// Analyzes user messages to detect tasks that would benefit from
// swarm (parallel multi-agent) or long-task (phased checkpointed) execution.
// Injects hints into the agent context — NOT an automatic trigger.

// ── Types ────────────────────────────────────

export interface ComplexityAnalysis {
    score: number;              // 0-1 complexity score
    suggestion: "none" | "swarm" | "long_task";
    reason: string;
    signals: string[];          // Which patterns were detected
}

// ── Signal Patterns ──────────────────────────

interface Signal {
    pattern: RegExp;
    weight: number;
    type: "swarm" | "long_task" | "both";
    label: string;
}

const SIGNALS: Signal[] = [
    // Multi-step indicators → swarm
    { pattern: /\band\b.*\band\b/i, weight: 0.15, type: "swarm", label: "multiple conjunctions" },
    { pattern: /\b(first|then|next|after that|finally)\b/i, weight: 0.1, type: "long_task", label: "sequential steps" },
    { pattern: /\d+\.\s/m, weight: 0.15, type: "both", label: "numbered list" },
    { pattern: /,\s*\w+,\s*\w+,/i, weight: 0.1, type: "swarm", label: "comma-separated items" },

    // Parallel opportunity indicators → swarm
    { pattern: /\bfor each\b/i, weight: 0.2, type: "swarm", label: "for-each pattern" },
    { pattern: /\ball of\b/i, weight: 0.1, type: "swarm", label: "all-of pattern" },
    { pattern: /\bevery\b/i, weight: 0.1, type: "swarm", label: "every pattern" },
    { pattern: /\bboth\b/i, weight: 0.1, type: "swarm", label: "both pattern" },
    { pattern: /\bsimultaneously\b/i, weight: 0.15, type: "swarm", label: "simultaneously" },
    { pattern: /\bin parallel\b/i, weight: 0.2, type: "swarm", label: "parallel request" },

    // Long-running indicators → long_task
    { pattern: /\bmonitor\b/i, weight: 0.15, type: "long_task", label: "monitoring" },
    { pattern: /\bwatch\b/i, weight: 0.1, type: "long_task", label: "watching" },
    { pattern: /\bcontinuously\b/i, weight: 0.2, type: "long_task", label: "continuous" },
    { pattern: /\bover time\b/i, weight: 0.15, type: "long_task", label: "over time" },
    { pattern: /\bphase/i, weight: 0.15, type: "long_task", label: "phased" },
    { pattern: /\bstep\s*by\s*step\b/i, weight: 0.15, type: "long_task", label: "step-by-step" },

    // Scope/scale indicators → both
    { pattern: /\bcomprehensive\b/i, weight: 0.1, type: "both", label: "comprehensive" },
    { pattern: /\bthorough\b/i, weight: 0.1, type: "both", label: "thorough" },
    { pattern: /\bdetailed\b/i, weight: 0.05, type: "both", label: "detailed" },
    { pattern: /\bfull\b/i, weight: 0.05, type: "both", label: "full" },

    // Tool diversity indicators → swarm
    { pattern: /\bresearch\b.*\b(create|write|build)\b/i, weight: 0.2, type: "swarm", label: "research+create" },
    { pattern: /\b(code|program|script)\b.*\b(test|deploy)\b/i, weight: 0.2, type: "swarm", label: "code+test" },
    { pattern: /\b(search|find)\b.*\b(download|save)\b/i, weight: 0.15, type: "swarm", label: "search+save" },
];

// ── Classifier ───────────────────────────────

/**
 * Analyze a user message for complexity signals.
 * Returns a suggestion and the reasons behind it.
 */
export function classifyComplexity(message: string): ComplexityAnalysis {
    let swarmScore = 0;
    let longTaskScore = 0;
    const matchedSignals: string[] = [];

    for (const signal of SIGNALS) {
        if (signal.pattern.test(message)) {
            matchedSignals.push(signal.label);
            if (signal.type === "swarm" || signal.type === "both") {
                swarmScore += signal.weight;
            }
            if (signal.type === "long_task" || signal.type === "both") {
                longTaskScore += signal.weight;
            }
        }
    }

    // Also factor in message length (longer = likely more complex)
    const lengthBonus = Math.min(0.2, message.length / 2000);
    swarmScore += lengthBonus;
    longTaskScore += lengthBonus;

    // Determine suggestion
    const maxScore = Math.max(swarmScore, longTaskScore);
    const score = Math.min(1, maxScore);

    let suggestion: "none" | "swarm" | "long_task" = "none";
    if (score >= 0.4) {
        suggestion = swarmScore >= longTaskScore ? "swarm" : "long_task";
    }

    const reason = matchedSignals.length > 0
        ? `Detected: ${matchedSignals.join(", ")}`
        : "No complexity signals detected";

    return { score, suggestion, reason, signals: matchedSignals };
}

/**
 * Generate a context hint for the agent based on complexity analysis.
 * Returns empty string if no hint needed.
 */
export function getComplexityHint(message: string): string {
    const analysis = classifyComplexity(message);

    if (analysis.suggestion === "swarm" && analysis.score >= 0.4) {
        return `💡 This task appears to have multiple independent sub-goals (${analysis.reason}). Consider using the swarm_task tool to parallelize the work for better efficiency.`;
    }

    if (analysis.suggestion === "long_task" && analysis.score >= 0.4) {
        return `💡 This task appears to be long-running with multiple phases (${analysis.reason}). Consider using start_long_task for checkpointed execution that can survive interruptions.`;
    }

    return "";
}
