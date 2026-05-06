// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Memory Bridge — Extracts memory context for live voice sessions ──
// Replicates the 12-system memory injection from agent.ts (lines 620-850)
// but as a standalone, reusable function.

import { recall, getCoreMemory } from "../../memory/sqlite.js";
import { findEntities, getKnowledgeGraphDB } from "../../memory/knowledge-graph.js";
import { getIdentityPromptSnippet } from "../../memory/identity.js";
import { getTraitsForInjection } from "../../memory/traits.js";
import { getSessionSummary } from "../../memory/session.js";
import { getSelfStateSnippet } from "../../memory/self-state.js";
import { getEmotionalContextSnippet } from "../../memory/emotional.js";
import { getEpisodicSnippet } from "../../memory/episodic.js";
import { getRelationshipSnippet } from "../../memory/relationship.js";
import { getAnticipationSnippet } from "../../memory/anticipation.js";
import { getUserModelSnippet } from "../../memory/user-model.js";
import { getWMSnippet } from "../../memory/working-memory.js";
import { getTimezone } from "../../location/index.js";

// ── Full Memory Context (at session start) ───────

/**
 * Retrieves the full memory context for injection into a live voice session.
 * This mirrors the agent.ts iteration-1 memory injection but runs standalone.
 */
export async function getFullMemoryContext(userHint?: string): Promise<string> {
    const parts: string[] = [];

    // ── Live datetime context ──
    const now = new Date();
    const timeStr = now.toLocaleTimeString("en-IN", {
        hour: "2-digit", minute: "2-digit", hour12: true, timeZone: getTimezone(),
    });
    const dateStr = now.toLocaleDateString("en-IN", {
        weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: getTimezone(),
    });
    const localHour = parseInt(
        now.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: getTimezone() })
    ) || 0;
    const greeting = localHour < 12 ? "morning" : localHour < 17 ? "afternoon" : localHour < 21 ? "evening" : "night";
    parts.push(`CURRENT CONTEXT:\n- Date: ${dateStr}\n- Time: ${timeStr} (${getTimezone()})\n- Period: ${greeting}`);

    // ── Identity profile ──
    try {
        const identitySnippet = getIdentityPromptSnippet();
        if (identitySnippet) parts.push(identitySnippet);
    } catch { /* not initialized */ }

    // ── Behavioral traits ──
    try {
        const traitsSnippet = getTraitsForInjection("voice conversation", 600);
        if (traitsSnippet) parts.push(traitsSnippet);
    } catch { /* */ }

    // ── Session context ──
    const sessionSummary = getSessionSummary();
    if (sessionSummary) parts.push(sessionSummary);

    // ── Self-state ──
    try {
        const selfStateSnippet = getSelfStateSnippet();
        if (selfStateSnippet) parts.push(selfStateSnippet);
    } catch { /* */ }

    // ── Emotional context ──
    try {
        const emotionalSnippet = getEmotionalContextSnippet();
        if (emotionalSnippet) parts.push(emotionalSnippet);
    } catch { /* */ }

    // ── Episodic milestones ──
    try {
        const episodicSnippet = getEpisodicSnippet();
        if (episodicSnippet) parts.push(episodicSnippet);
    } catch { /* */ }

    // ── Relationship tone ──
    try {
        const relationshipSnippet = getRelationshipSnippet();
        if (relationshipSnippet) parts.push(relationshipSnippet);
    } catch { /* */ }

    // ── Anticipation ──
    try {
        const anticipationSnippet = getAnticipationSnippet();
        if (anticipationSnippet) parts.push(anticipationSnippet);
    } catch { /* */ }

    // ── User model ──
    try {
        const userModelSnippet = await getUserModelSnippet();
        if (userModelSnippet) parts.push(userModelSnippet);
    } catch { /* */ }

    // ── Core memory ──
    try {
        const coreMems = getCoreMemory(10);
        if (coreMems && coreMems.length > 0) {
            parts.push(
                "CORE MEMORY (Always remember these facts about the user):\n" +
                coreMems.map((m: any) => `- (${m.category}) ${m.content}`).join("\n")
            );
        }
    } catch { /* DB not initialized */ }

    // ── Query-specific recall ──
    if (userHint) {
        try {
            const queriedMems = await recall(userHint, 5);
            if (queriedMems && queriedMems.length > 0) {
                parts.push(
                    "RELEVANT MEMORIES:\n" +
                    queriedMems.map((m: any) => `- (${m.category}) ${m.content}`).join("\n")
                );
            }
        } catch { /* */ }

        // ── Knowledge graph ──
        try {
            const kgDb = getKnowledgeGraphDB();
            if (kgDb) {
                const entities = findEntities(kgDb, userHint);
                if (entities.length > 0) {
                    const entityLines = entities.slice(0, 5).map(e =>
                        `- [${e.type}] ${e.name}${e.properties && Object.keys(e.properties).length > 0 ? ` (${JSON.stringify(e.properties)})` : ""}`
                    );
                    parts.push("RELATED ENTITIES:\n" + entityLines.join("\n"));
                }
            }
        } catch { /* */ }
    }

    // ── Working memory ──
    try {
        const wmSnippet = getWMSnippet();
        if (wmSnippet) parts.push(wmSnippet);
    } catch { /* */ }

    // ── Active goals (matches agent.ts iteration-1 injection) ──
    try {
        const { getGoalsSnippet } = await import("../../memory/goals.js");
        const goals = getGoalsSnippet();
        if (goals) parts.push(goals);
    } catch { /* goals module optional */ }

    // ── Task learnings — proven strategies for the kinds of work the
    // user tends to ask for. Generic key gives us the top global patterns. ──
    try {
        const { getTaskLearningsContext } = await import("../../memory/task-learnings.js");
        const learnings = getTaskLearningsContext(userHint || "voice conversation");
        if (learnings) parts.push(learnings);
    } catch { /* task-learnings optional */ }

    // ── Recent memories — last few high-score entries, regardless of topic. ──
    try {
        const recent = await recall("", 5);
        if (recent && recent.length > 0) {
            parts.push(
                "RECENT MEMORIES:\n" +
                recent.map((m: any) => `- (${m.category}) ${m.content}`).join("\n"),
            );
        }
    } catch { /* */ }

    return parts.join("\n\n");
}

// ── Lightweight Refresh (mid-session, every N turns) ──

/**
 * Quick memory refresh — only the fast, sync memory systems.
 * Used for periodic context updates during an active live session.
 */
export function getLightMemoryRefresh(): string {
    const parts: string[] = [];

    // Datetime (always refresh)
    const now = new Date();
    const timeStr = now.toLocaleTimeString("en-IN", {
        hour: "2-digit", minute: "2-digit", hour12: true, timeZone: getTimezone(),
    });
    parts.push(`Current time: ${timeStr} (${getTimezone()})`);

    // Core memory (fast SQLite read)
    try {
        const coreMems = getCoreMemory(5);
        if (coreMems && coreMems.length > 0) {
            parts.push(
                "Core memory:\n" +
                coreMems.map((m: any) => `- ${m.content}`).join("\n")
            );
        }
    } catch { /* */ }

    // Self-state + emotional (sync, fast)
    try {
        const selfState = getSelfStateSnippet();
        if (selfState) parts.push(selfState);
    } catch { /* */ }

    try {
        const emotional = getEmotionalContextSnippet();
        if (emotional) parts.push(emotional);
    } catch { /* */ }

    return parts.join("\n\n");
}
