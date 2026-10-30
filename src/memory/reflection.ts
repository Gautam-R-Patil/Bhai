// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Reflection Engine (SAC-DR Advanced + Living Continuity) ──
// Post-session reflection, dream replay, HMAC audit, emotional/episodic extraction,
// narrative compression. Strict JSON validation, per-reflection caps.

import crypto from "node:crypto";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import {
    type CalibratorBundle,
    type CalibratorRow,
    calibratorBeatsBaseline,
    computeBinStats,
    fitCalibrator,
    scoreCalibrator,
    tierBucket,
} from "../agents/metacognition.js";
import { getDataDir } from "../config/paths.js";
import type { ChatCompletionMessageParam, LLMClient } from "../llm.js";
import { auditLog } from "../security/audit-log.js";
import { protectForDisk } from "../security/pii-vault.js";
import { extractJSON } from "../utils/json-extract.js";
import { generateUUID } from "../utils/uuid.js";
import { consolidateMemories } from "./consolidation.js";
import { decayEmotions, recordEmotion } from "./emotional.js";
import { recordEpisode } from "./episodic.js";
import { getFieldValue, getIdentityProfile, statedField, updateIdentityProfile } from "./identity.js";
import { getKnowledgeGraphDB } from "./knowledge-graph.js";
import { updateRelationshipAfterSession } from "./relationship.js";
import { findDuplicates, mergeDuplicates, reorganizeMemories, synapticPrune } from "./self-evolving.js";
import { type EmotionalTone, updateSelfStateFromSession } from "./self-state.js";
import { getShortSummary } from "./session.js";
import {
    compactMemoryDB,
    dbTimeMs,
    extractMsgText,
    getMsgRole,
    indexConversationMessages,
    listMemories,
    remember,
    withoutMedia,
} from "./sqlite.js";
import { type LearningCategory, upsertLearning } from "./task-learnings.js";
import { getTemporalCache } from "./temporal-cache.js";
import { contradictTrait, decayTraits, getAllTraits, recordSessionCoOccurrences, reinforceTrait } from "./traits.js";
import { getHNSWIndex } from "./vector-index.js";

// ── Constants ─────────────────────────────────

const MAX_TRAIT_SIGNALS = 5;
const MAX_RETRIES = 1;
const HMAC_SECRET = "atlas-sacdr-audit-v1"; // Derived key for signing
const CONSOLIDATION_EVERY_N_REFLECTIONS = 5; // Run lightweight consolidation every 5th reflection

// Default 0 = persist FULL conversation history into conversations.messages_json.
// Emergency rollback to the legacy cap: set ATLAS_CORPUS_MAX_MESSAGES="20".
// Malformed / 0 / negative → treated as full.
const CORPUS_MAX_MESSAGES = (() => {
    const raw = process.env.ATLAS_CORPUS_MAX_MESSAGES;
    if (!raw) return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
})();

/**
 * Selects which messages to persist. max <= 0 → full history; max > 0 → last `max`.
 * Pure + side-effect-free so the persistence policy can be unit-tested directly.
 */
export function selectCorpusMessages<T>(history: T[], max: number): T[] {
    return max > 0 ? history.slice(-max) : history;
}

/**
 * The stored transcript plus the messages it lacks (same role+text match as
 * indexConversationMessages), so history pruned since the last reflection stays.
 */
export function mergeStoredMessages(storedJson: string, messages: unknown[]): unknown[] {
    let stored: unknown[] = [];
    try {
        const parsed = JSON.parse(storedJson);
        if (Array.isArray(parsed)) stored = parsed;
    } catch {
        /* unparseable row: replace it */
    }
    const key = (m: unknown) => {
        const text = extractMsgText(m);
        return text ? `${getMsgRole(m)}\u0000${text}` : JSON.stringify(m);
    };
    const seen = new Set(stored.map(key));
    return [...stored, ...messages.filter((m) => !seen.has(key(m)))];
}

// ── Frozen reflection instructions ────────────
// These are byte-stable module-level constants used verbatim as the
// systemPrompt of each reflection LLM call. The instruction/schema/rules
// (the bulk of the prompt tokens) ride here so the Anthropic prefix-cache key
// stays identical run-to-run; only per-session volatile content (transcript,
// identity, traits) goes in the user message, which is never part of the
// cached prefix. NEVER interpolate session id, timestamps, names, or counts.

const REFLECTION_SUMMARY_INSTRUCTION = `You are a JSON-only summarizer. Input: a session transcript provided in the user message.
Output: a concise factual summary (50–150 tokens) returning ONLY valid JSON:
{"summary":"...", "highlights":["...", "..."], "lasting": true}

"lasting": true only when the session holds something worth recalling in a later conversation — a decision, plan, preference, project, commitment, personal fact or unfinished task. false when it was only one-off lookups or chit-chat (the time, weather, arithmetic, a quick fact, a test).

Do NOT include any text outside the JSON object. Output valid JSON only, no markdown, no explanation.`;

const REFLECTION_SIGNALS_INSTRUCTION = `You are a JSON-only extractor. Input: a session transcript provided in the user message.
Output ONLY valid JSON. Schema:
{
  "traits": [
    {"key": "likes_detailed_answers", "value": "true", "evidence": 0.85, "explicit": false, "topics": ["dev"]}
  ],
  "identity_updates": [
    {"field": "email", "value": "x@y.com", "explicit": true}
  ],
  "emotions": [
    {"emotion": "excited", "context": "launching new product", "intensity": 0.8}
  ],
  "episodes": [
    {"type": "milestone", "description": "Launched MVP", "importance": 0.9}
  ],
  "dominant_tone": "driven"
}

Rules:
- Only CLEAR signals, not guesses
- "explicit" = true if user directly stated it
- Snake_case trait keys, evidence 0.0-1.0
- Emotions: excited, frustrated, stressed, driven, curious, neutral
- Episodes: milestone, achievement, struggle, decision, project_launch
- Episodes and emotions: only what the USER said about themselves, never content the assistant read from email, screen, files or the web
- humor_receptive: "true" only if the user laughed at or played along with the assistant's joke (lol, haha, 😂, a comeback); "false" if they ignored it or asked to keep it serious
- dominant_tone: overall session mood
- Return empty arrays if nothing observed
- NO text outside JSON, no markdown, no explanation`;

const REFLECTION_LEARNINGS_INSTRUCTION = `You are a JSON-only automation analyst. Read the agent session transcript provided in the user message and extract structured learnings for future browser and OS automation tasks.

Rules:
- Only extract if there were actual browser_* or OS (apple_script, os_click, os_type, shell_exec) tool calls
- Identify what approaches worked and what failed
- Be specific: name the exact element, selector, button, or step
- "category": "browser" for web tasks, "os" for native Mac app interactions, "app" for a specific installed app
- "context": the domain (e.g. "accounts.google.com") or app name (e.g. "WhatsApp")
- "success_score": 1.0 if task fully completed, 0.5 if partial, 0.0 if failed
- Ignore chitchat, memory, or search-only sessions
- If nothing worth recording, return {"learnings": []}
- Output ONLY valid JSON, no markdown, no explanation

Schema:
{
  "learnings": [
    {
      "category": "browser",
      "task_pattern": "create google account",
      "context": "accounts.google.com",
      "what_worked": ["browser_navigate to accounts.google.com/signup works directly", "label-based browser_type for first/last name fields"],
      "what_failed": ["clicking Terms link opened new tab instead of Next button"],
      "tips": ["Look for <button> tag not <a> for Next step", "Phone verification may block completion without real number"],
      "success_score": 0.5
    }
  ]
}`;

const REFLECTION_CODING_INSTRUCTION = `You are a JSON-only coding strategy extractor. Read the session transcript provided in the user message and identify reusable PATTERNS the agent discovered — things that worked, things that failed, and generalizable tips for similar future coding tasks.

Only extract GENERALIZABLE patterns (not one-off file edits). Examples of good patterns:
- "When editing TS files with union types, read the full type definition first"
- "Running vitest with a --testPathPattern is faster than full suite for targeted fixes"
- "For Rust lifetimes errors, refactor to clone() before re-architecting ownership"

Output ONLY valid JSON, no markdown:
{"strategies": [
  {"pattern": "<short rule>", "context": "<tech/language/domain>", "whatWorked": ["<concrete step>"], "whatFailed": ["<approach that failed, if any>"], "tips": ["<standalone takeaway>"], "successScore": 0.0-1.0}
]}

Rules:
- Return at most 3 strategies
- Skip the session entirely if no coding happened — output {"strategies": []}
- successScore reflects whether the overall task succeeded (1.0 = shipped and verified, 0.5 = partial, 0.0 = abandoned)
- Patterns must be reusable across projects, not "I fixed foo.ts line 42"`;

const REFLECTION_NARRATIVE_INSTRUCTION = `You compress a user profile and traits (provided in the user message) into a single-sentence identity narrative (max 50 words).
Refer to the user by name or as "they". Use he/she only when the profile or traits state the user's pronouns: a name says nothing about them.
Output ONLY the narrative text, no JSON, no quotes, nothing else.`;

/** he/she guessed from a name: a narrative using them, with no pronouns stated anywhere, is redone. */
const GENDERED_PRONOUN = /\b(he|she|him|her|his|hers|himself|herself)\b/i;
export function narrativeGuessesPronouns(narrative: string, profileText: string): boolean {
    return GENDERED_PRONOUN.test(narrative) && !/pronoun/i.test(profileText);
}

// ── Reflection Counter (for periodic consolidation) ──
let _reflectionCounter = 0;

// ── UUID Fallback ─────────────────────────────

/** @deprecated Use generateUUID() from utils/uuid.ts instead */
export const v4Fallback = generateUUID;

// ── Types ─────────────────────────────────────

interface ReflectionSummary {
    summary: string;
    highlights: string[];
    /** Worth recalling later; false = one-off lookups (kept in the transcript archive only). */
    lasting?: boolean;
}

interface TraitSignal {
    key: string;
    value: string;
    evidence: number;
    explicit: boolean;
    topics: string[];
}

interface IdentityUpdate {
    field: string;
    value: string;
    explicit: boolean;
}

interface EmotionalSignal {
    emotion: string;
    context: string;
    intensity: number;
}

interface EpisodicSignal {
    type: string;
    description: string;
    importance: number;
}

interface ExtractionResult {
    traits: TraitSignal[];
    identity_updates: IdentityUpdate[];
    emotions: EmotionalSignal[];
    episodes: EpisodicSignal[];
    dominant_tone: string;
}

// ── Reflection Entry Point ────────────────────

/**
 * Runs asynchronously after a session ends or after N turns.
 * Non-blocking — errors logged but never thrown to user.
 */
export async function runReflection(
    llm: LLMClient,
    conversationHistory: ChatCompletionMessageParam[],
    sessionId: string = generateUUID(),
    // An expired session passes its own: by then the live session is the new, empty one.
    sessionSummaryInput: string = getShortSummary(),
): Promise<void> {
    console.log("[MEMORY][REFLECTION] Starting post-session reflection...");

    try {
        // ── 1. Build input ────────────────────────
        const transcript = buildTranscript(conversationHistory);

        const reflectionInput = sessionSummaryInput
            ? `Session context: ${sessionSummaryInput}\n\nRecent transcript:\n${transcript}`
            : transcript;

        if (reflectionInput.length < 50) {
            console.log("[MEMORY][REFLECTION] Skipped — insufficient content");
            return;
        }

        // ── 2. Summarize the session ──────────────
        const summary = await extractSummary(llm, reflectionInput);
        if (summary) {
            // A session of one-off lookups (time, weather, sums) isn't a memory: it went in at
            // importance 6 and crowded recall. Its transcript and summary still go to the archive.
            if (summary.lasting !== false) {
                remember(summary.summary, "session_summary", "reflection,session", 6, "reflection");
                signedAuditLog("session_summary_stored", { length: summary.summary.length });
                console.log(`[MEMORY][REFLECTION] Summary stored (${summary.summary.length} chars)`);
            } else {
                console.log("[MEMORY][REFLECTION] Summary not kept as a memory: nothing lasting in this session");
            }

            // ── 2b. Persist to conversations table ──
            try {
                const db = getKnowledgeGraphDB();
                if (db) {
                    // The live history is raw (only LLM payloads are masked): mask before it hits disk.
                    const messagesToStore = protectForDisk(
                        withoutMedia(selectCorpusMessages(conversationHistory, CORPUS_MAX_MESSAGES)),
                    );
                    // One row per session: periodic reflections append what is new to it.
                    const existing = db.exec(
                        "SELECT id, messages_json FROM conversations WHERE session_id = ? ORDER BY id DESC LIMIT 1",
                        [sessionId],
                    )[0]?.values[0];
                    let convId = existing?.[0] as number | undefined;
                    if (convId) {
                        const merged = mergeStoredMessages(existing?.[1] as string, messagesToStore);
                        db.run(
                            "UPDATE conversations SET messages_json = ?, summary = ?, updated_at = datetime('now') WHERE id = ?",
                            [
                                JSON.stringify(selectCorpusMessages(merged, CORPUS_MAX_MESSAGES)),
                                summary.summary,
                                convId,
                            ],
                        );
                    } else {
                        db.run(`INSERT INTO conversations (session_id, messages_json, summary) VALUES (?, ?, ?)`, [
                            sessionId,
                            JSON.stringify(messagesToStore),
                            summary.summary,
                        ]);
                        convId = db.exec("SELECT last_insert_rowid()")[0]?.values[0]?.[0] as number;
                    }
                    console.log(`[MEMORY][REFLECTION] Conversation saved (session ${sessionId.substring(0, 8)})`);

                    // ── Incremental write-side sync: decompose into per-message
                    // rows so session_search's FTS index picks up this session
                    // immediately (the boot backfill is the fallback). Non-fatal. ──
                    if (convId && process.env.ATLAS_NO_SESSION_SEARCH !== "true") {
                        try {
                            indexConversationMessages(convId, sessionId, messagesToStore);
                        } catch {
                            /* non-fatal — boot backfill will recover */
                        }
                    }

                    if (convId && summary.summary) {
                        import("./embeddings.js")
                            .then(async ({ embedText, embeddingToBuffer, isReady }) => {
                                if (!isReady()) return;
                                try {
                                    const { getRawDb } = await import("./sqlite.js");
                                    const raw = getRawDb();
                                    if (!raw) return;
                                    const embedding = await embedText(summary.summary);
                                    const buffer = embeddingToBuffer(embedding);
                                    raw.prepare(
                                        "INSERT OR REPLACE INTO conversation_embeddings (conversation_id, embedding) VALUES (?, ?)",
                                    ).run(convId, buffer);
                                } catch {
                                    /* non-fatal */
                                }
                            })
                            .catch(() => {
                                /* non-fatal */
                            });
                    }
                }
            } catch (err) {
                console.error("[MEMORY][REFLECTION] Conversation save failed (non-fatal):", err);
            }
        }

        // ── 3. Extract all signals (traits + identity + emotions + episodes) ──
        const extraction = await extractSignals(llm, reflectionInput);

        let traitUpdates = 0;
        let hadEmotionalSignals = false;
        let hadEpisodicSignals = false;
        let dominantTone: EmotionalTone = "neutral";

        if (extraction) {
            // ── 3a. Trait signals (capped) ────────
            const traitSignals = extraction.traits.slice(0, MAX_TRAIT_SIGNALS);

            for (const signal of traitSignals) {
                if (!signal.key || !signal.value) continue;

                const result = reinforceTrait(signal.key, signal.value, {
                    explicit: signal.explicit,
                    topics: signal.topics || [],
                });

                if (result) {
                    traitUpdates++;
                    signedAuditLog("trait_reinforced", {
                        trait_key: signal.key,
                        value: signal.value,
                        confidence: result.confidence,
                        explicit: signal.explicit,
                    });
                    console.log(
                        `[MEMORY][REFLECTION] Trait: ${signal.key} = ${signal.value} (conf=${result.confidence.toFixed(2)})`,
                    );
                }
            }

            // ── Record co-occurrences ──
            recordSessionCoOccurrences();

            // ── 3b. Identity updates (safeguarded) ──
            for (const update of extraction.identity_updates) {
                if (!update.field || !update.value) continue;

                if (update.explicit) {
                    const currentProfile = getIdentityProfile();
                    const currentValue = getFieldValue(
                        (currentProfile as unknown as Record<string, string | undefined>)[update.field],
                    );

                    if (currentValue && currentValue !== update.value) {
                        signedAuditLog("identity_conflict_detected", {
                            field: update.field,
                            old_value: String(currentValue),
                            new_value: update.value,
                            action: "overwritten_explicit",
                        });
                    }

                    updateIdentityProfile({ [update.field]: statedField(update.field, update.value) });
                    signedAuditLog("identity_updated", { field: update.field, value: update.value, explicit: true });
                    console.log(`[MEMORY][REFLECTION] Identity: ${update.field} = ${update.value} (explicit)`);
                } else {
                    signedAuditLog("identity_pending", { field: update.field, value: update.value, explicit: false });
                    console.log(`[MEMORY][REFLECTION] Identity pending: ${update.field} = ${update.value}`);
                }
            }

            // ── 3c. Emotional signals ──
            // Only what the owner brought up this session: asked "what do you know about me?",
            // Bhai recited stored setbacks and this pass saved them again as new events.
            const said = ownerWords(conversationHistory);
            for (const em of extraction.emotions || []) {
                if (!em.emotion || !em.context) continue;
                if (!saidByOwner(em.context, said)) continue;
                recordEmotion(em.emotion, em.context, em.intensity || 0.5);
                hadEmotionalSignals = true;
            }

            // ── 3d. Episodic signals ──
            for (const ep of extraction.episodes || []) {
                if (!ep.type || !ep.description) continue;
                if (!saidByOwner(ep.description, said)) continue;
                recordEpisode(ep.type, ep.description, ep.importance || 0.5);
                hadEpisodicSignals = true;
            }

            // ── 3e. Dominant tone ──
            if (extraction.dominant_tone) {
                const validTones: EmotionalTone[] = [
                    "driven",
                    "stressed",
                    "excited",
                    "neutral",
                    "curious",
                    "frustrated",
                ];
                if (validTones.includes(extraction.dominant_tone as EmotionalTone)) {
                    dominantTone = extraction.dominant_tone as EmotionalTone;
                }
            }

            console.log(
                `[MEMORY][REFLECTION] Processed ${traitUpdates} traits, ${extraction.emotions?.length || 0} emotions, ${extraction.episodes?.length || 0} episodes`,
            );
        }

        // ── 3g. Coding strategy extraction ────────
        // Only fires if this session actually touched the coding primitives
        // (edit / write / test_run). Stores successful patterns in the
        // "code" task-learnings category so future coding queries can
        // recall them via recallLearnings("code", query).
        try {
            if (sessionTouchedCoding(conversationHistory)) {
                const strategies = await extractCodingStrategies(llm, reflectionInput);
                for (const s of strategies) {
                    upsertLearning(
                        "code" as LearningCategory,
                        s.pattern,
                        s.context || "coding",
                        s.whatWorked || [],
                        s.whatFailed || [],
                        s.tips || [],
                        typeof s.successScore === "number" ? s.successScore : 0.75,
                    );
                }
                if (strategies.length > 0) {
                    console.log(`[MEMORY][REFLECTION] Coding strategies captured: ${strategies.length}`);
                }
            }
        } catch (err) {
            console.warn("[MEMORY][REFLECTION] Coding strategy extraction failed (non-fatal):", (err as Error).message);
        }

        // ── 4. Update self-state ──────────────────
        const turnCount = conversationHistory.filter((m) => m.role === "user").length;
        updateSelfStateFromSession(turnCount, dominantTone);

        // ── 5. Update relationship state ──────────
        updateRelationshipAfterSession(turnCount, hadEmotionalSignals, hadEpisodicSignals);

        // ── 6. Decay stale data ───────────────────
        const traitsPruned = decayTraits();
        const emotionsPruned = decayEmotions();
        if (traitsPruned > 0 || emotionsPruned > 0) {
            console.log(`[MEMORY][DECAY] Pruned ${traitsPruned} traits, ${emotionsPruned} emotions`);
        }

        // ── 7. Auto-extract browser / OS task learnings ──────────────────────────────
        // Only runs when the session actually involved browser or OS tool use.
        // Non-blocking: errors are swallowed.
        const hasBrowserOrOS = conversationHistory.some((m) => {
            const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
            return /browser_|os_click|os_type|apple_script|shell_exec/.test(c);
        });
        if (hasBrowserOrOS) {
            await extractTaskLearnings(llm, reflectionInput);
        }

        // ── 7b. Lightweight SleepGate consolidation on session end ──
        // Normally only runs during nightly dreaming; this runs a lighter version
        // after each reflection to catch conflicts and strengthen important memories sooner.
        try {
            const { runSleepGateConsolidation } = await import("./sleep-gate.js");
            const kgDb = getKnowledgeGraphDB();
            if (kgDb) {
                const sgResult = await runSleepGateConsolidation(kgDb);
                if (sgResult.totalProcessed > 0) {
                    console.log(
                        `[MEMORY][REFLECTION] SleepGate: ${sgResult.conflictsDetected} conflicts, ${sgResult.memoriesForgotten} forgotten, ${sgResult.memoriesStrengthened} strengthened`,
                    );
                }
            }
        } catch {
            /* sleep-gate non-fatal */
        }

        // ── 8. Periodic lightweight consolidation (every Nth reflection) ──
        _reflectionCounter++;
        if (_reflectionCounter % CONSOLIDATION_EVERY_N_REFLECTIONS === 0) {
            try {
                const kgDb = getKnowledgeGraphDB();
                if (kgDb) {
                    console.log(
                        `[MEMORY][REFLECTION] Running periodic consolidation (every ${CONSOLIDATION_EVERY_N_REFLECTIONS} reflections)...`,
                    );
                    const consolidation = await consolidateMemories(kgDb, llm);
                    if (consolidation.crystalsCreated > 0) {
                        console.log(
                            `[MEMORY][REFLECTION] Periodic consolidation: ${consolidation.crystalsCreated} crystals from ${consolidation.clusteredCount} memories`,
                        );
                    }
                }
            } catch (err) {
                console.error("[MEMORY][REFLECTION] Periodic consolidation failed (non-fatal):", err);
            }
        }

        console.log("[MEMORY][REFLECTION] ✅ Reflection complete");
    } catch (err) {
        console.error("[MEMORY][REFLECTION] ❌ Failed (non-fatal):", err);
    }
}

// ── Dream Replay (Nightly Consolidation) ──────

/**
 * Nightly consolidation: clusters session summaries, merges overlapping
 * trait signals, penalizes unstable traits, updates trait graph edges,
 * and generates narrative compression.
 */
export async function runDreamReplay(llm: LLMClient): Promise<void> {
    console.log("[MEMORY][REPLAY] Starting dream replay...");

    try {
        // ── 1. Load recent session summaries (last 7 days) ──
        const recentSummaries = listMemories("session_summary", 20).filter(
            (m) => Date.now() - dbTimeMs(m.created_at) < 7 * 24 * 60 * 60 * 1000,
        );

        if (recentSummaries.length < 2) {
            console.log("[MEMORY][REPLAY] Not enough summaries for clustering (need ≥2)");
            return;
        }

        console.log(`[MEMORY][REPLAY] Clustering ${recentSummaries.length} summaries...`);

        // ── 2. Cluster by topic similarity ──
        const clusters = clusterSummaries(recentSummaries.map((s) => s.content));

        // ── 3. Analyze trait stability via LLM ──
        const allTraits = getAllTraits();
        const traitFlips = detectTraitInstability(allTraits);

        // ── 4. Penalize unstable traits (flip ratio > 30%) ──
        for (const flip of traitFlips) {
            const trait = allTraits.find((t) => t.trait_key === flip.key);
            if (trait && flip.flipRatio > 0.3) {
                contradictTrait(flip.key, trait.value);
                signedAuditLog("dream_replay_penalized", { trait: flip.key, flipRatio: flip.flipRatio });
                console.log(
                    `[MEMORY][REPLAY] Penalized unstable trait: ${flip.key} (flip ratio=${flip.flipRatio.toFixed(2)})`,
                );
            }
        }

        // ── 5. Record cross-cluster co-occurrences ──
        recordSessionCoOccurrences();

        // ── 5b. Reorganize memories (synaptic pruning + HNSW-based dedup + tier assignment) ──
        try {
            const kgDb = getKnowledgeGraphDB();
            if (kgDb) {
                const result = reorganizeMemories(kgDb);
                console.log(
                    `[MEMORY][REPLAY] 🧹 Synaptic pruning: ${result.pruned} pruned, ${result.weakened} weakened, ${result.strengthened} strengthened, ${result.merged} dupes merged`,
                );
                console.log(
                    `[MEMORY][REPLAY] 📊 Tiers: ${result.tiers.hot} hot, ${result.tiers.warm} warm, ${result.tiers.cold} cold`,
                );
            }
        } catch {
            /* non-fatal */
        }

        // ── 5c+. Memory Consolidation (Knowledge Crystals — uses Lite model) ──
        try {
            const kgDb = getKnowledgeGraphDB();
            if (kgDb) {
                const consolidation = await consolidateMemories(kgDb, llm);
                if (consolidation.crystalsCreated > 0) {
                    console.log(
                        `[MEMORY][REPLAY] 💎 Created ${consolidation.crystalsCreated} knowledge crystals from ${consolidation.clusteredCount} memories`,
                    );
                }
            }
        } catch (err) {
            console.error("[MEMORY][REPLAY] Consolidation failed (non-fatal):", err);
        }

        // ── 5e. Clear temporal cache (fresh start after reorganization) ──
        try {
            getTemporalCache().clearCache();
        } catch {
            /* non-fatal */
        }

        // ── 5f. Persist HNSW index ──
        try {
            getHNSWIndex().persist();
        } catch {
            /* non-fatal */
        }

        // ── 5g. Memory Studio insights (mood, theme, avoidance, most-discussed) ──
        try {
            const { runStudioInsights } = await import("./studio-insights.js");
            const r = await runStudioInsights(llm, 7);
            console.log(`[MEMORY][REPLAY] 🪞 Generated ${r.generated} studio insights`);
        } catch (err) {
            console.error("[MEMORY][REPLAY] Studio insights failed (non-fatal):", err);
        }

        // ── 5h. Metacog confidence calibration (P5.2 — ZERO LLM) ──
        // Pure-stats fit over data/metacog-outcomes.jsonl → data/metacog-calibrators.json.
        // Acting on the result is OFF until ATLAS_METACOG_SHADOW=false AND ECE/Brier
        // beat the constant-base-rate baseline; until then this is instrumentation only.
        try {
            const r = runCalibrationFit();
            if (r) {
                console.log(
                    `[MEMORY][REPLAY] 📐 Calibration: ${r.rows} rows, global ECE ${r.globalEce.toFixed(3)} → cal ${r.calEce.toFixed(3)} (${r.beatsBaseline ? "BEATS" : "below"} baseline)`,
                );
            }
        } catch (err) {
            console.error("[MEMORY][REPLAY] Calibration fit failed (non-fatal):", err);
        }

        // ── 6. Narrative compression (every 30 days) ──
        await generateNarrativeCompression(llm);

        console.log(
            `[MEMORY][REPLAY] ✅ Dream replay complete (${clusters.length} clusters, ${traitFlips.length} instabilities)`,
        );
    } catch (err) {
        console.error("[MEMORY][REPLAY] ❌ Failed (non-fatal):", err);
    }
}

// ── P5.2: Nightly confidence-calibration fit (ZERO LLM) ──
// Reads the metacog outcome log, fits a per-(taskType × tierBucket) Platt
// (cold-start) → isotonic (≥200 samples) calibrator, and persists ONLY the
// cells that beat the constant-base-rate baseline. Atomic tmp+rename write.
// Fully fail-open: any error returns null and the hot path simply finds no
// (or a stale) bundle. Gated by ATLAS_NO_METACOG_LOG (no log → nothing to fit).
const CALIBRATION_MAX_ROWS = 5000;
const CALIBRATION_MIN_FIT_ROWS = 30;

export function runCalibrationFit(): {
    rows: number;
    globalEce: number;
    calEce: number;
    beatsBaseline: boolean;
} | null {
    if (process.env.ATLAS_NO_METACOG_LOG === "true") return null;
    const fs = nodeFs;
    const path = nodePath;
    const dataDir = getDataDir();
    const logFile = path.join(dataDir, "metacog-outcomes.jsonl");

    let raw: string;
    try {
        raw = fs.readFileSync(logFile, "utf8");
    } catch {
        return null; // no log yet
    }

    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const recent = lines.slice(-CALIBRATION_MAX_ROWS);
    const rows: CalibratorRow[] = [];
    for (const line of recent) {
        try {
            const o = JSON.parse(line) as Record<string, unknown>;
            if (typeof o.finalConfidence !== "number") continue;
            rows.push({
                finalConfidence: o.finalConfidence,
                taskCompleted: o.taskCompleted === true,
                taskType: typeof o.taskType === "string" ? o.taskType : null,
                modelTier: typeof o.modelTier === "string" ? o.modelTier : null,
            });
        } catch {
            /* skip malformed line */
        }
    }
    if (rows.length < CALIBRATION_MIN_FIT_ROWS) return null;

    const globalStats = computeBinStats(rows);
    const globalCal = fitCalibrator(rows);
    const globalScore = scoreCalibrator(globalCal, rows);
    const globalBeats = calibratorBeatsBaseline(globalStats, globalScore.brier, globalScore.ece);

    const perKey: CalibratorBundle["perKey"] = {};
    const diagnostics: CalibratorBundle["diagnostics"] = { __global__: globalStats };

    const groups = new Map<string, CalibratorRow[]>();
    for (const r of rows) {
        const key = `${r.taskType ?? "?"}|${tierBucket(r.modelTier)}`;
        const g = groups.get(key);
        if (g) g.push(r);
        else groups.set(key, [r]);
    }
    for (const [key, g] of groups) {
        if (g.length < CALIBRATION_MIN_FIT_ROWS) continue;
        const stats = computeBinStats(g);
        const cal = fitCalibrator(g);
        const score = scoreCalibrator(cal, g);
        diagnostics[key] = stats;
        if (calibratorBeatsBaseline(stats, score.brier, score.ece)) perKey[key] = cal;
    }

    const bundle: CalibratorBundle = {
        version: 1,
        builtTs: new Date().toISOString(),
        global: globalBeats ? globalCal : null,
        perKey,
        diagnostics,
    };

    try {
        fs.mkdirSync(dataDir, { recursive: true });
        const tmp = path.join(dataDir, `metacog-calibrators.json.tmp-${process.pid}`);
        fs.writeFileSync(tmp, JSON.stringify(bundle), "utf8");
        fs.renameSync(tmp, path.join(dataDir, "metacog-calibrators.json"));
    } catch {
        return null; // write failed — leave any existing bundle untouched
    }

    return {
        rows: rows.length,
        globalEce: globalStats.ece,
        calEce: globalScore.ece,
        beatsBaseline: globalBeats,
    };
}

// ── Narrative Compression ─────────────────────

/**
 * Generates a compressed identity narrative from all traits and identity.
 * Stored as a high-priority meta trait (identity_narrative).
 * Only runs if existing narrative is >30 days old or missing.
 */
async function generateNarrativeCompression(llm: LLMClient): Promise<void> {
    // Check if narrative exists and is recent
    const allTraits = getAllTraits();
    const existing = allTraits.find((t) => t.trait_key === "identity_narrative");
    const profileText = JSON.stringify(getIdentityProfile()) + allTraits.map((t) => ` ${t.trait_key}=${t.value}`).join("");
    if (existing && !narrativeGuessesPronouns(String(existing.value), profileText)) {
        const daysOld = (Date.now() - new Date(existing.last_seen_ts).getTime()) / (1000 * 60 * 60 * 24);
        if (daysOld < 30) {
            console.log("[MEMORY][REPLAY] Narrative compression skipped — recent enough");
            return;
        }
    }

    const identity = getIdentityProfile();
    const traits = allTraits.filter((t) => t.confidence > 0.5 && t.trait_key !== "identity_narrative");

    if (traits.length < 3) {
        console.log("[MEMORY][REPLAY] Not enough traits for narrative compression");
        return;
    }

    const userContent = `Identity: ${JSON.stringify(identity)}
Traits: ${traits.map((t) => `${t.trait_key}=${t.value} (${(t.confidence * 100).toFixed(0)}%)`).join(", ")}`;

    try {
        const response = await llm.chat({
            messages: [{ role: "user", content: userContent }],
            systemPrompt: REFLECTION_NARRATIVE_INSTRUCTION,
        });

        const narrative = (response.choices[0]?.message?.content || "").trim();
        if (narrative.length > 10 && narrative.length < 300) {
            reinforceTrait("identity_narrative", narrative, { explicit: false, topics: ["meta", "identity"] });
            signedAuditLog("narrative_compressed", { narrative: narrative.substring(0, 100) });
            console.log(`[MEMORY][REPLAY] Narrative: "${narrative.substring(0, 80)}..."`);
        }
    } catch (err) {
        console.error("[MEMORY][REPLAY] Narrative compression failed:", err);
    }
}

// ── Task Learning Extraction ───────────────────────────────

interface LearningEntry {
    category: string; // "browser" | "os" | "app"
    task_pattern: string; // short label, e.g. "create google account"
    context: string; // domain or app, e.g. "accounts.google.com" or "WhatsApp"
    what_worked: string[]; // concrete steps/approaches that succeeded
    what_failed: string[]; // steps/approaches that failed and why
    tips: string[]; // standalone free-form tips
    success_score: number; // 0.0–1.0 (was the task ultimately successful?)
}

interface LearningsResult {
    learnings: LearningEntry[];
}

async function extractTaskLearnings(llm: LLMClient, transcript: string): Promise<void> {
    const userContent = `Transcript:
${transcript.substring(0, 8000)}`;

    try {
        const response = await llm.chat({
            messages: [{ role: "user", content: userContent }],
            systemPrompt: REFLECTION_LEARNINGS_INSTRUCTION,
        });

        const text = response.choices[0]?.message?.content || "";
        const parsed = parseAndValidateJSON<LearningsResult>(text, validateLearnings);
        if (!parsed || parsed.learnings.length === 0) {
            console.log("[LEARNINGS] No learnings extracted for this session");
            return;
        }

        for (const entry of parsed.learnings) {
            const cat = (
                ["browser", "os", "app"].includes(entry.category) ? entry.category : "browser"
            ) as LearningCategory;
            upsertLearning(
                cat,
                entry.task_pattern,
                entry.context,
                entry.what_worked || [],
                entry.what_failed || [],
                entry.tips || [],
                typeof entry.success_score === "number" ? entry.success_score : 0.5,
            );
        }

        console.log(`[LEARNINGS] ✅ Auto-extracted ${parsed.learnings.length} learning(s) from session`);
    } catch (err) {
        console.error("[LEARNINGS] Extraction failed (non-fatal):", err);
    }
}

function validateLearnings(obj: unknown): obj is LearningsResult {
    if (typeof obj !== "object" || obj === null) return false;
    const o = obj as Record<string, unknown>;
    if (!Array.isArray(o.learnings)) return false;
    for (const l of o.learnings) {
        if (typeof l !== "object" || l === null) return false;
        const entry = l as Record<string, unknown>;
        if (typeof entry.task_pattern !== "string" || typeof entry.context !== "string") return false;
    }
    return true;
}

// ── Summary Extraction ────────────────────────────────────

async function extractSummary(llm: LLMClient, input: string): Promise<ReflectionSummary | null> {
    const userContent = `Transcript:
${input}`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await llm.chat({
                messages: [{ role: "user", content: userContent }],
                systemPrompt: REFLECTION_SUMMARY_INSTRUCTION,
            });

            const text = response.choices[0]?.message?.content || "";
            const parsed = parseAndValidateJSON<ReflectionSummary>(text, validateSummary);
            if (parsed) return parsed;

            if (attempt < MAX_RETRIES) {
                console.log("[MEMORY][REFLECTION] Summary JSON invalid, retrying...");
            }
        } catch {
            if (attempt >= MAX_RETRIES) return null;
        }
    }

    console.log("[MEMORY][REFLECTION] Summary extraction failed after retries");
    return null;
}

// ── Signal Extraction (Extended) ──────────────

async function extractSignals(llm: LLMClient, input: string): Promise<ExtractionResult | null> {
    const userContent = `Session:
${input}`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await llm.chat({
                messages: [{ role: "user", content: userContent }],
                systemPrompt: REFLECTION_SIGNALS_INSTRUCTION,
            });

            const text = response.choices[0]?.message?.content || "";
            const parsed = parseAndValidateJSON<ExtractionResult>(text, validateExtraction);
            if (parsed) return parsed;

            if (attempt < MAX_RETRIES) {
                console.log("[MEMORY][REFLECTION] Extraction JSON invalid, retrying...");
            }
        } catch {
            if (attempt >= MAX_RETRIES) return null;
        }
    }

    console.log("[MEMORY][REFLECTION] Signal extraction failed after retries");
    return null;
}

// ── Coding Strategy Extraction (Phase 4E) ────
// Called from runReflection when the session touched coding primitives.
// Output is piped into upsertLearning("code", ...) so subsequent coding
// queries can recall successful patterns via recallLearnings("code", q).

interface CodingStrategy {
    pattern: string;
    context?: string;
    whatWorked?: string[];
    whatFailed?: string[];
    tips?: string[];
    successScore?: number;
}

const CODING_TOOL_SIGNATURES = new Set([
    "edit",
    "write",
    "append_file",
    "notebook_edit",
    "test_run",
    "code_action",
    "code_execute",
    "repo_map",
    "lsp",
]);

function sessionTouchedCoding(history: ChatCompletionMessageParam[]): boolean {
    for (const msg of history) {
        if (msg.role !== "assistant" || !("tool_calls" in msg) || !msg.tool_calls) continue;
        if (!Array.isArray(msg.tool_calls)) continue;
        for (const tc of msg.tool_calls) {
            // Tolerate providers that omit tc.type or spell it differently —
            // match on function.name presence alone, which is the stable
            // contract across OpenAI, Anthropic, Gemini tool-call shapes.
            const fnName = (tc as { function?: { name?: unknown } })?.function?.name;
            if (typeof fnName === "string" && CODING_TOOL_SIGNATURES.has(fnName)) {
                return true;
            }
        }
    }
    return false;
}

const STRATEGY_FIELD_CAP = 500;
function clampStr(s: string): string {
    return s.length > STRATEGY_FIELD_CAP ? s.slice(0, STRATEGY_FIELD_CAP) : s;
}

async function extractCodingStrategies(llm: LLMClient, input: string): Promise<CodingStrategy[]> {
    const userContent = `Transcript:
${input.slice(0, 6000)}`;

    try {
        const response = await llm.chat({
            messages: [{ role: "user", content: userContent }],
            systemPrompt: REFLECTION_CODING_INSTRUCTION,
            modelOverride: "openai/gpt-4.1-nano",
            responseFormat: "json_object",
        });
        const text = response.choices?.[0]?.message?.content || "";
        const jsonStr = extractJSON(text);
        if (!jsonStr) return [];
        const parsed = JSON.parse(jsonStr) as { strategies?: unknown };
        if (!Array.isArray(parsed.strategies)) return [];
        const out: CodingStrategy[] = [];
        for (const raw of parsed.strategies.slice(0, 3)) {
            if (typeof raw !== "object" || raw === null) continue;
            const s = raw as Record<string, unknown>;
            if (typeof s.pattern !== "string" || s.pattern.length < 4) continue;
            out.push({
                pattern: clampStr(s.pattern),
                context: clampStr(typeof s.context === "string" ? s.context : "coding"),
                whatWorked: Array.isArray(s.whatWorked)
                    ? (s.whatWorked as string[]).filter((x) => typeof x === "string").map(clampStr)
                    : [],
                whatFailed: Array.isArray(s.whatFailed)
                    ? (s.whatFailed as string[]).filter((x) => typeof x === "string").map(clampStr)
                    : [],
                tips: Array.isArray(s.tips)
                    ? (s.tips as string[]).filter((x) => typeof x === "string").map(clampStr)
                    : [],
                successScore: typeof s.successScore === "number" ? s.successScore : 0.7,
            });
        }
        return out;
    } catch {
        return [];
    }
}

// ── JSON Validation ───────────────────────────

function parseAndValidateJSON<T>(text: string, validator: (obj: unknown) => obj is T): T | null {
    try {
        const jsonStr = extractJSON(text);
        if (!jsonStr) return null;
        const parsed = JSON.parse(jsonStr);
        return validator(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function validateSummary(obj: unknown): obj is ReflectionSummary {
    if (typeof obj !== "object" || obj === null) return false;
    const o = obj as Record<string, unknown>;
    return typeof o.summary === "string" && o.summary.length > 0 && Array.isArray(o.highlights);
}

function validateExtraction(obj: unknown): obj is ExtractionResult {
    if (typeof obj !== "object" || obj === null) return false;
    const o = obj as Record<string, unknown>;

    if (!Array.isArray(o.traits)) return false;
    // identity_updates, emotions, episodes optional for backward compat
    if (o.identity_updates !== undefined && !Array.isArray(o.identity_updates)) return false;

    for (const t of o.traits) {
        if (typeof t !== "object" || t === null) return false;
        const trait = t as Record<string, unknown>;
        if (typeof trait.key !== "string" || typeof trait.value !== "string") return false;
    }

    // Fill defaults for optional fields
    const record = obj as Record<string, unknown>;
    if (!record.identity_updates) record.identity_updates = [];
    if (!record.emotions) record.emotions = [];
    if (!record.episodes) record.episodes = [];
    if (!record.dominant_tone) record.dominant_tone = "neutral";

    return true;
}

// ── HMAC-Signed Audit Logging ─────────────────

function signedAuditLog(action: string, details: Record<string, unknown>): void {
    try {
        const payload = {
            action,
            ts: new Date().toISOString(),
            user_id: "default",
            ...details,
        };
        const payloadStr = JSON.stringify(payload);

        // Compute HMAC-SHA256
        const hmac = crypto.createHmac("sha256", HMAC_SECRET);
        hmac.update(payloadStr);
        const signature = hmac.digest("hex");

        // Goes to data/audit.jsonl, not the memories table — signed JSON blobs
        // were being embedded and recalled as if they were facts.
        auditLog(`memory_${action}`, { ...payload, sig: signature });
    } catch {
        // Never let audit failures affect main flow
    }
}

// ── Transcript Builder ────────────────────────

const SIGNAL_STOP = new Set(
    "about after again also been could does doing from have just like more much really should some than that their them then there these they this very what when where which while with would your user assistant asked".split(" "),
);
const signalWords = (t: string) =>
    (t.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter((w) => !SIGNAL_STOP.has(w));

export interface SessionWords {
    owner: Set<string>;
    assistant: Set<string>;
}

/** Words the owner and Bhai wrote this session (channel notes stripped). */
export function ownerWords(history: ChatCompletionMessageParam[]): SessionWords {
    const owner = new Set<string>();
    const assistant = new Set<string>();
    for (const m of history.slice(-40)) {
        if (typeof m.content !== "string" || (m.role !== "user" && m.role !== "assistant")) continue;
        const text = m.content.replace(/\[(?:SOURCE|BROWSER CONTEXT|Browser context|From browser)[^\]]*\]/g, "");
        for (const w of signalWords(text)) (m.role === "user" ? owner : assistant).add(w);
    }
    return { owner, assistant };
}

/**
 * Not a recap of Bhai's own words: drop a signal only when it repeats what Bhai said (two
 * or more words) and shares nothing with the owner. Comparing with the owner's words alone
 * dropped feelings told in Hinglish ("thak gaya hoon" → "tired after a long day").
 */
export function saidByOwner(text: string, words: SessionWords): boolean {
    const w = signalWords(text);
    if (w.some((x) => words.owner.has(x))) return true;
    return w.filter((x) => words.assistant.has(x)).length < 2;
}

function buildTranscript(history: ChatCompletionMessageParam[]): string {
    return history
        .slice(-20)
        .filter((m) => m.role === "user" || (m.role === "assistant" && typeof m.content === "string"))
        .map((m) => {
            const content = typeof m.content === "string" ? m.content : "";
            return `${m.role}: ${content.substring(0, 250)}`;
        })
        .join("\n");
}

// ── Clustering Helpers ────────────────────────

interface SummaryCluster {
    summaries: string[];
    keywords: Set<string>;
}

function clusterSummaries(summaries: string[]): SummaryCluster[] {
    const clusters: SummaryCluster[] = [];

    for (const summary of summaries) {
        const keywords = extractKeywords(summary);
        let merged = false;

        for (const cluster of clusters) {
            const overlap = keywordOverlap(keywords, cluster.keywords);
            if (overlap > 0.3) {
                cluster.summaries.push(summary);
                for (const kw of keywords) cluster.keywords.add(kw);
                merged = true;
                break;
            }
        }

        if (!merged) {
            clusters.push({ summaries: [summary], keywords });
        }
    }

    return clusters;
}

function extractKeywords(text: string): Set<string> {
    const stopwords = new Set([
        "the",
        "a",
        "an",
        "is",
        "are",
        "was",
        "to",
        "of",
        "in",
        "for",
        "and",
        "or",
        "this",
        "that",
        "with",
        "on",
        "at",
        "by",
        "it",
    ]);
    return new Set(
        text
            .toLowerCase()
            .replace(/[^\w\s]/g, " ")
            .split(/\s+/)
            .filter((w) => w.length > 3 && !stopwords.has(w)),
    );
}

function keywordOverlap(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let overlap = 0;
    for (const word of a) {
        if (b.has(word)) overlap++;
    }
    return overlap / Math.min(a.size, b.size);
}

// ── Trait Instability Detection ───────────────

interface TraitFlip {
    key: string;
    flipRatio: number;
}

function detectTraitInstability(
    traits: Array<{ trait_key: string; confidence: number; reinforcement_count: number }>,
): TraitFlip[] {
    const flips: TraitFlip[] = [];

    for (const t of traits) {
        // High reinforcement count but low confidence = unstable
        if (t.reinforcement_count > 3 && t.confidence < 0.4) {
            const flipRatio = 1 - t.confidence;
            flips.push({ key: t.trait_key, flipRatio });
        }
    }

    return flips;
}

// ── Daily Decay + Dream Replay (Scheduler) ────

export function runDailyDecay(nightly = false): void {
    console.log("[MEMORY][DECAY] Running daily decay...");
    const traitsPruned = decayTraits();
    const emotionsPruned = decayEmotions();

    // Also decay memory scores (from self-evolving.ts)
    try {
        const kgDb = getKnowledgeGraphDB();
        if (kgDb) {
            // Synaptic Homeostasis Pruning — prune/weaken/strengthen based on
            // strength scores. Once per pass (applyDecay is the same prune).
            const pruneResult = synapticPrune(kgDb);
            const memoriesDecayed = pruneResult.pruned;
            console.log(
                `[MEMORY][DECAY] Synaptic prune: ${pruneResult.pruned} pruned, ${pruneResult.weakened} weakened, ${pruneResult.strengthened} strengthened`,
            );

            // HNSW-based duplicate merging — merge near-duplicate memories
            const dupesMerged = mergeDuplicates(kgDb);
            if (dupesMerged > 0) {
                console.log(`[MEMORY][DECAY] Merged ${dupesMerged} duplicate memories`);
            }

            console.log(
                `[MEMORY][DECAY] Daily decay complete: ${traitsPruned} traits, ${emotionsPruned} emotions, ${memoriesDecayed} memories decayed`,
            );
        } else {
            console.log(
                `[MEMORY][DECAY] Daily decay complete: ${traitsPruned} traits, ${emotionsPruned} emotions pruned`,
            );
        }
    } catch (err) {
        console.error("[MEMORY][DECAY] Memory decay failed (non-fatal):", err);
        console.log(`[MEMORY][DECAY] Daily decay partial: ${traitsPruned} traits, ${emotionsPruned} emotions pruned`);
    }
    compactMemoryDB(nightly);
}
