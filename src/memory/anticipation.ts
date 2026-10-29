// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Anticipation Engine ───────────────────────
// Predictive behavior engine: anticipates user needs based on patterns.
// Max 1 proactive suggestion per 5 sessions.
// Gated on relationship depth + trust score.

import { getHighConfidenceTraits, type BehavioralTrait } from "./traits.js";
import { getRecentEpisodes } from "./episodic.js";
import { getRelationshipState, canTriggerInitiative } from "./relationship.js";
import { getShortSummary } from "./session.js";

// ── Types ─────────────────────────────────────

export interface Anticipation {
    suggestion: string;
    confidence: number;   // 0–1
    basis: string;        // What triggered this
}

// ── State ─────────────────────────────────────

let sessionsSinceLastSuggestion = 0;
let lastSuggestion = "";

const MIN_SESSIONS_BETWEEN = 5;
const CONFIDENCE_THRESHOLD = 0.65;

// ── Track Session ─────────────────────────────

export function trackSessionForAnticipation(): void {
    sessionsSinceLastSuggestion++;
}

// ── Generate Anticipation ─────────────────────

/**
 * Analyzes current context and generates a proactive suggestion if appropriate.
 * Returns null if conditions aren't met (too recent, low trust, etc.)
 */
export function generateAnticipation(userId = "default"): Anticipation | null {
    // Gate: frequency
    if (sessionsSinceLastSuggestion < MIN_SESSIONS_BETWEEN) return null;

    // Gate: relationship depth + trust
    if (!canTriggerInitiative(userId)) return null;

    const traits = getHighConfidenceTraits(0.7);
    const episodes = getRecentEpisodes(userId, 5);
    const sessionSummary = getShortSummary();
    const relationship = getRelationshipState(userId);

    // Analyze patterns and generate suggestion
    const anticipation = analyzePatterns(traits, episodes, sessionSummary, relationship.trust_score);

    if (!anticipation || anticipation.confidence < CONFIDENCE_THRESHOLD) return null;

    // Avoid repeating same suggestion
    if (anticipation.suggestion === lastSuggestion) return null;

    // Record
    sessionsSinceLastSuggestion = 0;
    lastSuggestion = anticipation.suggestion;

    console.log(`[MEMORY][ANTICIPATION] Suggestion: ${anticipation.suggestion.substring(0, 80)} (conf=${anticipation.confidence.toFixed(2)})`);

    return anticipation;
}

// ── Prompt Snippet ────────────────────────────

export function getAnticipationSnippet(userId = "default"): string {
    const anticipation = generateAnticipation(userId);
    if (!anticipation) return "";

    return `💡 PROACTIVE INSIGHT (use naturally, don't force):\n- ${anticipation.suggestion}`;
}

// ── Pattern Analysis ──────────────────────────

function analyzePatterns(
    traits: BehavioralTrait[],
    episodes: Array<{ type: string; description: string; importance_score: number; timestamp: string }>,
    sessionSummary: string,
    trustScore: number
): Anticipation | null {
    const suggestions: Anticipation[] = [];

    // ── Pattern 1: Project launch follow-up ──
    const recentLaunches = episodes.filter(e =>
        e.type === "milestone" || e.type === "project_launch" || e.type === "achievement"
    );
    if (recentLaunches.length > 0) {
        const latest = recentLaunches[0];
        const daysAgo = (Date.now() - new Date(latest.timestamp).getTime()) / (1000 * 60 * 60 * 24);
        if (daysAgo < 14) {
            suggestions.push({
                suggestion: `Regarding your recent ${latest.type}: "${latest.description.substring(0, 50)}" — want a follow-up action plan or review?`,
                confidence: 0.7,
                basis: "recent_milestone",
            });
        }
    }

    // ── Pattern 2: Execution-focused user with pending goals ──
    const executionTraits = traits.filter(t =>
        t.trait_key.includes("execution") || t.trait_key.includes("action") || t.trait_key.includes("ship")
    );
    if (executionTraits.length > 0 && sessionSummary.length > 50) {
        suggestions.push({
            suggestion: "You seem to be in execution mode. Want me to draft a quick task breakdown for your current focus?",
            confidence: 0.65,
            basis: "execution_trait_pattern",
        });
    }

    // ── Pattern 3: Struggling user ──
    const struggles = episodes.filter(e => e.type === "struggle" && e.importance_score > 0.5);
    if (struggles.length > 0) {
        const latest = struggles[0];
        const daysAgo = (Date.now() - new Date(latest.timestamp).getTime()) / (1000 * 60 * 60 * 24);
        if (daysAgo < 7) {
            suggestions.push({
                suggestion: `You've been working through "${latest.description.substring(0, 40)}". Want a fresh approach or alternative strategy?`,
                confidence: 0.68,
                basis: "struggle_pattern",
            });
        }
    }

    // ── Pattern 4: High trust → deeper engagement ──
    if (trustScore > 0.8 && traits.length > 5) {
        suggestions.push({
            suggestion: "Based on our interactions, I've built a good model of your preferences. Want me to review and adjust anything?",
            confidence: 0.6,
            basis: "relationship_depth",
        });
    }

    // Return highest confidence suggestion
    if (suggestions.length === 0) return null;
    suggestions.sort((a, b) => b.confidence - a.confidence);
    return suggestions[0];
}
