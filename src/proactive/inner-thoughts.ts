// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Inner Thoughts Engine ────────────────────────
 * Continuous background reasoning pipeline inspired by the "Inner Thoughts Framework"
 * (2025). Runs on each heartbeat tick to form, evaluate, and selectively surface
 * proactive thoughts.
 *
 * 5-stage pipeline:
 *   1. Trigger — Detect activation signals from environment
 *   2. Retrieve — Pull relevant context from memory
 *   3. Form — Generate a candidate thought via LLM
 *   4. Evaluate — Score thought on relevance, urgency, novelty, appropriateness
 *   5. Participate — Decide: suppress, queue, or surface immediately
 *
 * Key difference from old proactive check: separates *thinking* from *saying*.
 * Thoughts form continuously; only high-scoring, novel ones become messages.
 */

import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";
import type { UserPresence } from "./activity.js";
import type { Database } from "../memory/sqlite.js";
import { collectSignals, shouldActivate, type TriggerSignal } from "./trigger-detector.js";
import {
    initThoughtJournal, recordThought, getRecentThoughts,
    getJournalEntriesForStats, getQueuedThoughts, markQueuedAsSurfaced, updateThoughtResponse,
    type ThoughtRecord,
} from "./thought-journal.js";
import { getIdentityPromptSnippet } from "../memory/identity.js";
import { getCoreMemory } from "../memory/sqlite.js";
import { getSessionSummary } from "../memory/session.js";
import { describePresence } from "./activity.js";
import { shouldSuppressMessage } from "./dnd.js";
import { embedText, cosineSimilarity, isReady as isEmbeddingReady } from "../memory/embeddings.js";
import { getTimeContext } from "../alive-ux.js";
import * as nativeModule from "../../native/index.js";

// ── Types ─────────────────────────────────────

interface ThoughtCandidate {
    content: string;
    triggerType: string;
    context: string;
}

interface ThoughtScore {
    relevance: number;
    urgency: number;
    novelty: number;
    appropriateness: number;
    composite: number;
    decision: "suppressed" | "queued" | "surfaced";
}

export interface InnerThoughtsConfig {
    onThoughtSurfaced: (message: string) => Promise<void>;
}

// ── State ─────────────────────────────────────

let _initialized = false;
let _config: InnerThoughtsConfig | null = null;
let _llm: LLMClient | null = null;

// Adaptive thresholds (learned from user engagement)
let surfaceThreshold = 0.55;
let queueThreshold = 0.35;

// ── Init ──────────────────────────────────────

export function initInnerThoughts(
    db: Database,
    llm: LLMClient,
    config: InnerThoughtsConfig
): void {
    initThoughtJournal(db);
    _llm = llm;
    _config = config;
    _initialized = true;

    // Update adaptive thresholds from historical data
    updateAdaptiveThresholds();

    console.log("[INNER-THOUGHTS] Engine initialized");
}

// ── Main Tick ─────────────────────────────────

/**
 * Run one tick of the Inner Thoughts Engine.
 * Called every heartbeat (~30 minutes). Returns the surfaced message, or null.
 */
export async function tick(context: {
    presence: UserPresence;
    monitorAlerts: string | null;
    hourNow: number;
    lastAppTransition?: { from: string; to: string } | null;
}): Promise<string | null> {
    if (!_initialized || !_llm || !_config) return null;

    try {
        // ── Stage 1: Trigger Detection ──
        const signals = collectSignals({
            presence: context.presence,
            monitorAlerts: context.monitorAlerts,
            hourNow: context.hourNow,
            lastAppTransition: context.lastAppTransition,
        });

        const activation = shouldActivate(signals);

        if (!activation.shouldActivate) {
            // Check if we have queued thoughts that should be surfaced
            return await surfaceQueuedThought();
        }

        // ── Stage 2: Context Retrieval ──
        const thoughtContext = retrieveContext(context.presence, activation.primaryTrigger);

        // ── Stage 3: Thought Formation ──
        const candidate = await formThought(thoughtContext, activation, context.hourNow);
        if (!candidate) return null;

        // ── Stage 4: Evaluation ──
        const score = await evaluateThought(candidate);

        // ── Stage 5: Participation Decision ──
        const thoughtId = recordThought(
            candidate.content,
            candidate.triggerType,
            score,
            score.decision
        );

        if (score.decision === "surfaced") {
            // Check DND before actually surfacing
            const suppress = await shouldSuppressMessage(candidate.content);
            if (suppress) {
                console.log("[INNER-THOUGHTS] Thought surfaced but suppressed by DND, queueing instead");
                return null;
            }

            console.log(`[INNER-THOUGHTS] 💭 Surfacing thought (score: ${score.composite.toFixed(2)}, trigger: ${activation.primaryTrigger})`);
            return candidate.content;
        } else if (score.decision === "queued") {
            console.log(`[INNER-THOUGHTS] 📋 Queued thought (score: ${score.composite.toFixed(2)})`);
        } else {
            console.log(`[INNER-THOUGHTS] 🔇 Suppressed thought (score: ${score.composite.toFixed(2)})`);
        }

        return null;
    } catch (err) {
        console.error("[INNER-THOUGHTS] Tick error:", (err as Error).message);
        return null;
    }
}

// ── Stage 2: Context Retrieval ────────────────

function retrieveContext(presence: UserPresence, trigger: string): string {
    const parts: string[] = [];

    // Current activity
    parts.push(`Situation: ${describePresence(presence)}`);

    // Time context
    const timeCtx = getTimeContext();
    parts.push(`Time: ${timeCtx.period}`);

    // User identity (if available)
    try {
        const identity = getIdentityPromptSnippet();
        if (identity) parts.push(`User info: ${identity.substring(0, 300)}`);
    } catch { /* */ }

    // Core memories (if available)
    try {
        const coreMems = getCoreMemory(3);
        if (coreMems && coreMems.length > 0) {
            parts.push("Key facts: " + (coreMems as any[]).map((m: any) => m.content).join("; "));
        }
    } catch { /* */ }

    // Last session context
    try {
        const session = getSessionSummary();
        if (session) parts.push(`Recent context: ${session.substring(0, 300)}`);
    } catch { /* */ }

    parts.push(`Trigger: ${trigger}`);

    return parts.join("\n");
}

// ── Stage 3: Thought Formation ────────────────

async function formThought(
    context: string,
    activation: { primaryTrigger: string; combinedWeight: number },
    hourNow: number
): Promise<ThoughtCandidate | null> {
    if (!_llm) return null;

    const messages: ChatCompletionMessageParam[] = [
        {
            role: "user",
            content: `You're having an internal thought about what might be useful or interesting to share with the user right now. You're NOT texting them yet — just forming a thought.

${context}

Based on this context, form ONE brief thought (1-2 sentences max) about something the user might find useful, interesting, or timely right now.

Rules:
- Be specific and actionable, not generic
- Relate to their current context (what they're doing, time of day, recent topics)
- If nothing genuinely useful comes to mind, respond with exactly "NOTHING"
- Don't be annoying — only form thoughts that add real value
- Sound like a thoughtful friend, not a notification bot

Your thought:`,
        },
    ];

    try {
        const response = await _llm.chat({
            messages,
            systemPrompt: "You're the internal reasoning module of a personal AI agent. Generate a brief proactive thought, or NOTHING if there's nothing worth saying.",
            modelOverride: "openai/gpt-4.1-nano",
        });

        const content = response.choices?.[0]?.message?.content?.trim();
        if (!content || content === "NOTHING" || content.length < 10) {
            return null;
        }

        return {
            content,
            triggerType: activation.primaryTrigger,
            context,
        };
    } catch (err) {
        console.warn("[INNER-THOUGHTS] Thought formation failed:", (err as Error).message);
        return null;
    }
}

// ── Stage 4: Evaluation ───────────────────────

async function evaluateThought(candidate: ThoughtCandidate): Promise<ThoughtScore> {
    // Compute novelty via embedding similarity
    let novelty = 1.0;
    try {
        if (isEmbeddingReady()) {
            const thoughtEmbedding = await embedText(candidate.content, "query");
            const recentThoughts = getRecentThoughts(24, 20);

            if (recentThoughts.length > 0) {
                // Check similarity against recent thoughts
                const recentTexts = recentThoughts.map(t => t.content);
                const recentEmbeddings = await Promise.all(
                    recentTexts.slice(0, 10).map(t => embedText(t, "document"))
                );

                let maxSim = 0;
                for (const emb of recentEmbeddings) {
                    const sim = cosineSimilarity(thoughtEmbedding, emb);
                    if (sim > maxSim) maxSim = sim;
                }

                novelty = Math.max(0, 1 - maxSim);
            }
        }
    } catch {
        // Embedding not available — assume novel
    }

    // Heuristic scoring for other dimensions
    const relevance = estimateRelevance(candidate);
    const urgency = estimateUrgency(candidate);
    const appropriateness = estimateAppropriateness(candidate);

    // Try native scoring
    let composite: number;
    let decision: "suppressed" | "queued" | "surfaced";

    try {
        const native = loadNative();
        if (native) {
            const result = native.scoreThought(
                relevance, urgency, novelty, appropriateness,
                surfaceThreshold, queueThreshold
            );
            composite = result.composite;
            decision = result.decision as "suppressed" | "queued" | "surfaced";
        } else {
            throw new Error("native not available");
        }
    } catch {
        // JS fallback
        composite = 0.35 * relevance + 0.25 * urgency + 0.25 * novelty + 0.15 * appropriateness;
        decision = composite >= surfaceThreshold ? "surfaced"
            : composite >= queueThreshold ? "queued"
            : "suppressed";
    }

    return { relevance, urgency, novelty, appropriateness, composite, decision };
}

// ── Heuristic Scorers ─────────────────────────

function estimateRelevance(candidate: ThoughtCandidate): number {
    const content = candidate.content.toLowerCase();
    let score = 0.5;

    // Higher relevance for specific, actionable content
    if (content.includes("meeting") || content.includes("deadline") || content.includes("reminder")) {
        score += 0.2;
    }
    if (content.includes("you") || content.includes("your")) {
        score += 0.1; // Personalized content
    }
    // Lower relevance for generic observations
    if (content.includes("weather") || content.includes("good morning")) {
        score -= 0.1;
    }

    return Math.max(0, Math.min(1, score));
}

function estimateUrgency(candidate: ThoughtCandidate): number {
    const content = candidate.content.toLowerCase();
    let score = 0.3;

    if (content.includes("urgent") || content.includes("asap") || content.includes("now")) {
        score += 0.4;
    }
    if (content.includes("soon") || content.includes("today") || content.includes("in ")) {
        score += 0.2;
    }
    if (content.includes("reminder") || content.includes("don't forget")) {
        score += 0.15;
    }

    return Math.max(0, Math.min(1, score));
}

function estimateAppropriateness(candidate: ThoughtCandidate): number {
    // Start at a reasonable baseline
    let score = 0.6;

    // Shorter is generally more appropriate for proactive thoughts
    if (candidate.content.length < 100) score += 0.1;
    if (candidate.content.length > 300) score -= 0.15;

    // Context-relevant thoughts are more appropriate
    if (candidate.triggerType === "prospective") score += 0.2; // Triggered by reminder
    if (candidate.triggerType === "monitor") score += 0.1;

    return Math.max(0, Math.min(1, score));
}

// ── Queued Thought Surfacing ──────────────────

async function surfaceQueuedThought(): Promise<string | null> {
    const queued = getQueuedThoughts(3);
    if (queued.length === 0) return null;

    // Only surface if the highest-scored queued thought is above threshold
    const best = queued[0];
    if (best.composite_score < queueThreshold + 0.1) return null;

    markQueuedAsSurfaced([best.id]);
    console.log(`[INNER-THOUGHTS] 📋→💬 Surfacing queued thought #${best.id} (score: ${best.composite_score.toFixed(2)})`);
    return best.content;
}

// ── Adaptive Threshold Updates ────────────────

function updateAdaptiveThresholds(): void {
    try {
        const native = loadNative();
        if (native) {
            const entries = getJournalEntriesForStats(168); // Last 7 days
            if (entries.length > 10) {
                const thresholds = native.computeAdaptiveThresholds(
                    entries.map((e) => ({ compositeScore: e.composite_score, decision: e.decision, userResponse: e.user_response, createdAtMs: e.created_at_ms })),
                );
                if (thresholds.length >= 2) {
                    surfaceThreshold = thresholds[0];
                    queueThreshold = thresholds[1];
                    console.log(`[INNER-THOUGHTS] Adaptive thresholds: surface=${surfaceThreshold.toFixed(2)}, queue=${queueThreshold.toFixed(2)}`);
                }
            }
        }
    } catch {
        // Keep defaults
    }
}

// ── Native Module ─────────────────────────────


function loadNative(): any {
    // A static import: `require` doesn't exist in ESM (nor in the esbuild bundle),
    // so the old createRequire path always returned null and the native scorers
    // never ran.
    return nativeModule;
}

// ── Export for Heartbeat Integration ──────────

/**
 * Called by heartbeat to mark that the user engaged with a proactive message.
 * Used to improve adaptive thresholds over time.
 */
export function recordUserEngagement(engaged: boolean): void {
    try {
        const recent = getRecentThoughts(1, 1).filter(t => t.decision === "surfaced" && !t.user_response);
        if (recent.length > 0) {
            updateThoughtResponse(recent[0].id, engaged ? "engaged" : "ignored");
        }
    } catch { /* */ }

    // Periodically update thresholds
    updateAdaptiveThresholds();
}
