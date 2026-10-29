// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Dynamic Role Assignment ──────────────────
// Keyword-based role classifier that recommends roles based on
// task description analysis. Overrides planned role when there's
// a strong mismatch (confidence > 0.7).

import type { AgentRole } from "./sub-agent.js";

// ── Role Keywords ────────────────────────────
// Each role has a set of weighted keywords that indicate it's the right choice.
// Higher weights = more specific to that role.

interface WeightedKeyword {
    pattern: RegExp;
    weight: number;
}

const ROLE_KEYWORDS: Record<AgentRole, WeightedKeyword[]> = {
    researcher: [
        { pattern: /\bsearch\b/i, weight: 2 },
        { pattern: /\bfind\b/i, weight: 1.5 },
        { pattern: /\blook\s*up\b/i, weight: 2 },
        { pattern: /\bresearch\b/i, weight: 3 },
        { pattern: /\bwhat\s+is\b/i, weight: 1.5 },
        { pattern: /\binformation\s+about\b/i, weight: 2 },
        { pattern: /\bsummarize\b/i, weight: 1.5 },
        { pattern: /\bcite\b/i, weight: 2 },
        { pattern: /\bsource/i, weight: 1.5 },
        { pattern: /\blearn\s+about\b/i, weight: 2 },
        { pattern: /\bdiscover\b/i, weight: 1.5 },
        { pattern: /\binvestig/i, weight: 2 },
    ],
    coder: [
        { pattern: /\bwrite\s+code\b/i, weight: 3 },
        { pattern: /\bcreate\s+file\b/i, weight: 2.5 },
        { pattern: /\brun\s+command\b/i, weight: 2 },
        { pattern: /\binstall\b/i, weight: 2 },
        { pattern: /\bbuild\b/i, weight: 1.5 },
        { pattern: /\bcompile\b/i, weight: 2.5 },
        { pattern: /\bscript\b/i, weight: 1.5 },
        { pattern: /\bmodify\b.*\bfile\b/i, weight: 2 },
        { pattern: /\bedit\b.*\bcode\b/i, weight: 2.5 },
        { pattern: /\bshell\b/i, weight: 2 },
        { pattern: /\bterminal\b/i, weight: 2 },
        { pattern: /\bgit\b/i, weight: 1.5 },
        { pattern: /\bnpm\b/i, weight: 2 },
        { pattern: /\bpip\b/i, weight: 2 },
        { pattern: /\bfunction\b/i, weight: 1 },
        { pattern: /\bclass\b/i, weight: 1 },
        { pattern: /\bfix\b.*\bbug\b/i, weight: 2 },
        { pattern: /\brefactor\b/i, weight: 2 },
        { pattern: /\bimplment\b/i, weight: 2 },
    ],
    browser: [
        { pattern: /\bnavigate\b/i, weight: 2.5 },
        { pattern: /\bwebsite\b/i, weight: 2 },
        { pattern: /\bweb\s*page\b/i, weight: 2 },
        { pattern: /\bclick\b/i, weight: 2 },
        { pattern: /\bfill\s*(in|out)?\s*form\b/i, weight: 3 },
        { pattern: /\blogin\b/i, weight: 2 },
        { pattern: /\bsign\s*(in|up)\b/i, weight: 2 },
        { pattern: /\bdownload\b/i, weight: 1.5 },
        { pattern: /\bscrape\b/i, weight: 2.5 },
        { pattern: /\bextract\b.*\bpage\b/i, weight: 2.5 },
        { pattern: /\bbrowse\b/i, weight: 2 },
        { pattern: /\burl\b/i, weight: 1.5 },
        { pattern: /\bopen\b.*\bsite\b/i, weight: 2 },
        { pattern: /\bweb\b/i, weight: 1 },
    ],
    system: [
        { pattern: /\bapple\s*script\b/i, weight: 3 },
        { pattern: /\bscreenshot\b/i, weight: 2.5 },
        { pattern: /\bmacOS\b/i, weight: 2.5 },
        { pattern: /\bopen\s+app\b/i, weight: 2 },
        { pattern: /\bbrightness\b/i, weight: 3 },
        { pattern: /\bvolume\b/i, weight: 3 },
        { pattern: /\bdesktop\b/i, weight: 1.5 },
        { pattern: /\bFinder\b/i, weight: 2.5 },
        { pattern: /\bsystem\s*prefer/i, weight: 2.5 },
        { pattern: /\bautomate\b/i, weight: 1.5 },
        { pattern: /\bkeyboard\s*shortcut\b/i, weight: 2 },
        { pattern: /\bmouse\b/i, weight: 1.5 },
    ],
    general: [], // No specific keywords — catch-all
};

// ── Analyzer ─────────────────────────────────

export interface RoleRecommendation {
    recommendedRole: AgentRole;
    confidence: number;
    reason: string;
    matchedKeywords: string[];
}

/**
 * Analyze a task description and recommend the best role.
 * Returns the recommendation with confidence score.
 */
export function analyzeRole(description: string): RoleRecommendation {
    const scores: Record<AgentRole, { score: number; matches: string[] }> = {
        researcher: { score: 0, matches: [] },
        coder: { score: 0, matches: [] },
        browser: { score: 0, matches: [] },
        system: { score: 0, matches: [] },
        general: { score: 0, matches: [] },
    };

    for (const [role, keywords] of Object.entries(ROLE_KEYWORDS) as [AgentRole, WeightedKeyword[]][]) {
        for (const kw of keywords) {
            if (kw.pattern.test(description)) {
                scores[role].score += kw.weight;
                scores[role].matches.push(kw.pattern.source);
            }
        }
    }

    // Find the best role
    let bestRole: AgentRole = "general";
    let bestScore = 0;
    let secondBestScore = 0;

    for (const [role, { score }] of Object.entries(scores) as [AgentRole, { score: number; matches: string[] }][]) {
        if (role === "general") continue; // general is fallback only
        if (score > bestScore) {
            secondBestScore = bestScore;
            bestScore = score;
            bestRole = role;
        } else if (score > secondBestScore) {
            secondBestScore = score;
        }
    }

    // Compute confidence: based on absolute score and margin over second best
    // Confidence = min(1, score / 8) * (1 - secondBest / (score + 1))
    const absoluteConf = Math.min(1, bestScore / 8);
    const marginConf = bestScore > 0 ? 1 - secondBestScore / (bestScore + 1) : 0;
    const confidence = absoluteConf * marginConf;

    return {
        recommendedRole: bestScore > 0 ? bestRole : "general",
        confidence,
        reason: bestScore > 0
            ? `Matched ${scores[bestRole].matches.length} keywords for ${bestRole} (score: ${bestScore.toFixed(1)})`
            : "No role-specific keywords found",
        matchedKeywords: scores[bestRole]?.matches || [],
    };
}

/**
 * Determine if the planned role should be overridden.
 * Only overrides when there's a clear mismatch (confidence > 0.7).
 */
export function shouldOverrideRole(
    plannedRole: AgentRole,
    description: string,
    confidenceThreshold = 0.7,
): { override: boolean; newRole?: AgentRole; reason?: string } {
    // Don't override "general" — it can use all tools
    if (plannedRole === "general") return { override: false };

    const recommendation = analyzeRole(description);

    // Only override if recommendation differs AND is confident
    if (recommendation.recommendedRole !== plannedRole && recommendation.confidence >= confidenceThreshold) {
        return {
            override: true,
            newRole: recommendation.recommendedRole,
            reason: recommendation.reason,
        };
    }

    return { override: false };
}
