// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Smart Recommendations ─────────────────────
// Track behavior patterns and suggest actions

// ── Types ─────────────────────────────────────

interface UserAction {
    type: string;
    detail: string;
    timestamp: number;
}

interface Recommendation {
    text: string;
    confidence: number;
    based_on: string;
}

// ── State ─────────────────────────────────────

const actionHistory: UserAction[] = [];
const MAX_HISTORY = 200;

// ── Track Action ──────────────────────────────

export function trackAction(type: string, detail: string): void {
    actionHistory.push({ type, detail, timestamp: Date.now() });
    if (actionHistory.length > MAX_HISTORY) {
        actionHistory.shift();
    }
}

// ── Analyze Patterns ──────────────────────────

export function getRecommendations(): Recommendation[] {
    const recommendations: Recommendation[] = [];

    // Analyze command frequency
    const cmdCounts = new Map<string, number>();
    for (const action of actionHistory) {
        if (action.type === "command") {
            cmdCounts.set(action.detail, (cmdCounts.get(action.detail) || 0) + 1);
        }
    }

    // Suggest shortcuts for frequent actions
    for (const [cmd, count] of cmdCounts) {
        if (count >= 5) {
            recommendations.push({
                text: `You use "${cmd}" frequently (${count}x). Consider creating a scheduled task or shortcut.`,
                confidence: Math.min(count / 10, 1),
                based_on: `${count} uses of "${cmd}"`,
            });
        }
    }

    // Time-based patterns
    const hourCounts = new Map<number, number>();
    for (const action of actionHistory) {
        const hour = new Date(action.timestamp).getHours();
        hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
    }

    const peakHour = [...hourCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (peakHour && peakHour[1] >= 10) {
        recommendations.push({
            text: `You're most active around ${peakHour[0]}:00. Consider scheduling important tasks for this time.`,
            confidence: 0.7,
            based_on: `${peakHour[1]} actions at hour ${peakHour[0]}`,
        });
    }

    return recommendations;
}

// ── Get Activity Summary ──────────────────────

export function getActivitySummary(): {
    total_actions: number;
    recent_24h: number;
    top_actions: Array<{ type: string; count: number }>;
} {
    const now = Date.now();
    const recent = actionHistory.filter((a) => now - a.timestamp < 86400000);

    const typeCounts = new Map<string, number>();
    for (const action of actionHistory) {
        typeCounts.set(action.type, (typeCounts.get(action.type) || 0) + 1);
    }

    return {
        total_actions: actionHistory.length,
        recent_24h: recent.length,
        top_actions: [...typeCounts.entries()]
            .map(([type, count]) => ({ type, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 5),
    };
}
