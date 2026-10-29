// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { Database } from "./sqlite.js";
import { beginTransaction, commitTransaction, rollbackTransaction } from "./sqlite.js";

// ── Types ─────────────────────────────────────

export interface BehavioralTrait {
    trait_key: string;
    value: string;
    confidence: number;           // 0.0 – 1.0
    explicit: boolean;            // true = user stated directly
    topics: string[];             // related topic tags
    reinforcement_count: number;  // times reinforced
    last_seen_ts: string;
    created_at: string;
}

// ── Constants ─────────────────────────────────

const BASE_ALPHA = 0.12;         // Base reinforcement step (increased from 0.08 for faster convergence)
const K_EXPLICIT = 3;            // Explicit multiplier (increased from 2)
const COOLDOWN_FACTOR = 0.5;     // Reduce α if reinforced in prior session
const LAMBDA = 0.02;             // Exponential decay rate per day
const MAX_DECAY_DAYS = 14;       // Clamp inactive days
const REMOVAL_THRESHOLD = 0.1;
const HIGH_CONFIDENCE = 0.7;
const MAX_SESSION_UPDATES = 5;   // Per-session cap
const MAX_TRAITS_INJECTION = 8;
const TOKEN_BUDGET_DEFAULT = 600;
const STABILITY_BONUS_WEIGHT = 0.1;

// ── Debug ─────────────────────────────────────

let MEMORY_DEBUG = false;

export function setMemoryDebug(enabled: boolean): void {
    MEMORY_DEBUG = enabled;
}

function debugLog(tag: string, msg: string): void {
    if (MEMORY_DEBUG) console.log(`[MEMORY][${tag}] ${msg}`);
}

// ── Conflict Map ──────────────────────────────

const CONFLICT_MAP: Record<string, string[]> = {
    likes_short_answers: ["likes_detailed_answers"],
    likes_detailed_answers: ["likes_short_answers"],
    risk_averse: ["risk_tolerant"],
    risk_tolerant: ["risk_averse"],
    prefers_formal: ["prefers_casual"],
    prefers_casual: ["prefers_formal"],
    prefers_brevity: ["prefers_verbose"],
    prefers_verbose: ["prefers_brevity"],
};

// ── Session State ─────────────────────────────

// Per-session cap tracking (reset on session start)
const sessionTraitUpdates = new Set<string>();
let sessionUpdateCount = 0;
let lastSessionId = "";

// Traits reinforced in the *previous* session (for cooldown)
let previousSessionTraits = new Set<string>();

export function resetSessionTraitCaps(sessionId: string): void {
    previousSessionTraits = new Set(sessionTraitUpdates);
    sessionTraitUpdates.clear();
    sessionUpdateCount = 0;
    lastSessionId = sessionId;
    debugLog("CAP", `Session caps reset for ${sessionId}`);
}

// ── Singleton ─────────────────────────────────

let _db: Database | null = null;

// ── Initialize ────────────────────────────────

export function initTraitsDB(db: Database): void {
    _db = db;

    db.run(`
    CREATE TABLE IF NOT EXISTS behavioral_traits (
      trait_key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      explicit INTEGER DEFAULT 0,
      topics TEXT DEFAULT '[]',
      reinforcement_count INTEGER DEFAULT 0,
      last_seen_ts TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

    // Safe migrations for existing tables
    try { db.run("ALTER TABLE behavioral_traits ADD COLUMN explicit INTEGER DEFAULT 0"); } catch { /* already exists */ }
    try { db.run("ALTER TABLE behavioral_traits ADD COLUMN topics TEXT DEFAULT '[]'"); } catch { /* already exists */ }
    try { db.run("ALTER TABLE behavioral_traits ADD COLUMN reinforcement_count INTEGER DEFAULT 0"); } catch { /* already exists */ }
    // Anchor for incremental decay (see decayTraits). Separate from last_seen_ts
    // so decay never corrupts the recency signal that ranking reads.
    try { db.run("ALTER TABLE behavioral_traits ADD COLUMN last_decay_ts TEXT"); } catch { /* already exists */ }

    console.log("🧬 Behavioral traits engine initialized (SAC-DR)");
}

// ── Reinforce ─────────────────────────────────

/**
 * Strengthen a trait's confidence with SAC-DR formula.
 * Per-session caps enforced. Cooldown applied if same trait was in prior session.
 * Conflict detection auto-contradicts opposing traits.
 */
export function reinforceTrait(
    traitKey: string,
    value: string,
    options: { explicit?: boolean; topics?: string[] } = {}
): BehavioralTrait | null {
    if (!_db) throw new Error("Traits DB not initialized");

    const isExplicit = options.explicit ?? false;

    // ── Per-session caps ── (they damp inferred drift; what the user says
    // outright always lands). A skip returns null so callers don't report the
    // OLD trait as a success.
    if (!isExplicit && sessionUpdateCount >= MAX_SESSION_UPDATES) {
        debugLog("CAP", `Session cap hit (${MAX_SESSION_UPDATES}), skipping: ${traitKey}`);
        return null;
    }
    if (!isExplicit && sessionTraitUpdates.has(traitKey)) {
        debugLog("CAP", `Trait already updated this session, skipping: ${traitKey}`);
        return null;
    }

    // ── Conflict detection ──
    const conflicts = CONFLICT_MAP[traitKey] || [];
    for (const conflictKey of conflicts) {
        const conflicting = getTrait(conflictKey);
        if (conflicting && conflicting.confidence >= HIGH_CONFIDENCE) {
            debugLog("CAP", `Conflict detected: ${traitKey} vs ${conflictKey} (${conflicting.confidence}). Contradicting.`);
            contradictTrait(conflictKey, value);
        }
    }

    const topics = options.topics || [];
    const existing = getTrait(traitKey);

    // ── Compute alpha with explicit boost + cooldown + reinforcement bonus ──
    const s = isExplicit ? 1 : 0;
    let alpha = BASE_ALPHA * (1 + K_EXPLICIT * s);

    // Reinforcement count bonus: traits seen many times converge faster
    if (existing && existing.reinforcement_count > 0) {
        alpha *= (1 + Math.log2(existing.reinforcement_count + 1) * 0.1);
    }

    // Cooldown: reduce alpha if same trait was reinforced in previous session
    if (previousSessionTraits.has(traitKey)) {
        alpha *= COOLDOWN_FACTOR;
        debugLog("CAP", `Cooldown applied to ${traitKey}, α reduced to ${alpha.toFixed(3)}`);
    }

    if (existing) {
        if (existing.value === value) {
            // Same value → reinforce
            const newConf = Math.min(1.0, existing.confidence + alpha * (1 - existing.confidence));
            const mergedTopics = mergeTopics(existing.topics, topics);
            const newExplicit = existing.explicit || isExplicit ? 1 : 0;
            const newCount = (existing.reinforcement_count || 0) + 1;

            _db.run(
                `UPDATE behavioral_traits SET confidence = ?, explicit = ?, topics = ?,
                 reinforcement_count = ?, last_seen_ts = datetime('now') WHERE trait_key = ?`,
                [newConf, newExplicit, JSON.stringify(mergedTopics), newCount, traitKey]
            );
            debugLog("CAP", `Reinforced ${traitKey}: ${existing.confidence.toFixed(3)} → ${newConf.toFixed(3)} (α=${alpha.toFixed(3)})`);
        } else {
            // Different value → contradiction path
            sessionTraitUpdates.add(traitKey);
            sessionUpdateCount++;
            if (isExplicit) {
                // "Actually, keep it short": the correction replaces the old value at
                // explicit confidence (contradictTrait would halve or zero it).
                _db.run(
                    `UPDATE behavioral_traits SET value = ?, confidence = ?, explicit = 1, reinforcement_count = 0,
                     last_seen_ts = datetime('now') WHERE trait_key = ?`,
                    [value, 0.65, traitKey],
                );
                return getTrait(traitKey);
            }
            return contradictTrait(traitKey, value);
        }
    } else {
        // New trait — start at initial confidence based on explicit
        const initialConf = isExplicit ? 0.65 : 0.45;
        _db.run(
            `INSERT INTO behavioral_traits (trait_key, value, confidence, explicit, topics, reinforcement_count)
             VALUES (?, ?, ?, ?, ?, 1)`,
            [traitKey, value, initialConf, isExplicit ? 1 : 0, JSON.stringify(topics)]
        );
        debugLog("CAP", `New trait ${traitKey} = ${value} (conf=${initialConf}, explicit=${isExplicit})`);
    }

    sessionTraitUpdates.add(traitKey);
    sessionUpdateCount++;
    return getTrait(traitKey)!;
}

// ── Contradict ────────────────────────────────

/**
 * When evidence contradicts a trait: lower confidence, optionally update value.
 * Strong explicit contradictions zero out confidence.
 */
export function contradictTrait(
    traitKey: string,
    newValue: string,
    options: { explicit?: boolean } = {}
): BehavioralTrait {
    if (!_db) throw new Error("Traits DB not initialized");

    const existing = getTrait(traitKey);
    const isExplicit = options.explicit ?? false;
    const beta = 0.5;

    if (existing) {
        // Explicit strong contradiction → zero out
        const newConf = isExplicit ? 0 : Math.max(0, existing.confidence * (1 - beta));
        _db.run(
            `UPDATE behavioral_traits SET value = ?, confidence = ?,
             last_seen_ts = datetime('now') WHERE trait_key = ?`,
            [newValue, newConf, traitKey]
        );
        debugLog("CAP", `Contradicted ${traitKey}: ${existing.confidence.toFixed(3)} → ${newConf.toFixed(3)} (explicit=${isExplicit})`);
    } else {
        _db.run(
            `INSERT INTO behavioral_traits (trait_key, value, confidence, reinforcement_count) VALUES (?, ?, 0.3, 0)`,
            [traitKey, newValue]
        );
    }

    return getTrait(traitKey)!;
}

// ── Upsert ────────────────────────────────────

export function upsertTrait(
    traitKey: string,
    value: string,
    confidence: number,
    options: { explicit?: boolean; topics?: string[] } = {}
): void {
    if (!_db) throw new Error("Traits DB not initialized");

    _db.run(
        `INSERT INTO behavioral_traits (trait_key, value, confidence, explicit, topics, reinforcement_count, last_seen_ts)
         VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
         ON CONFLICT(trait_key) DO UPDATE SET
           value = excluded.value,
           confidence = excluded.confidence,
           explicit = max(behavioral_traits.explicit, excluded.explicit),
           topics = excluded.topics,
           reinforcement_count = behavioral_traits.reinforcement_count + 1,
           last_seen_ts = excluded.last_seen_ts`,
        [traitKey, value, Math.max(0, Math.min(1.0, confidence)),
            options.explicit ? 1 : 0, JSON.stringify(options.topics || [])]
    );

}

// ── Exponential Decay ─────────────────────────

/**
 * Apply exponential decay: confidence *= exp(-λ * days_inactive)
 * Prune traits below threshold. Returns count pruned.
 *
 * Decays INCREMENTALLY from last_decay_ts (or last_seen_ts, whichever is
 * later), then advances last_decay_ts. The product of the per-run factors is
 * exp(-λ * total_inactive_days), so running this many times a day converges to
 * the right value instead of compounding. The old `min(confidence, factor)`
 * never decayed anything below ~0.76 (so pruning was dead), and a plain
 * `confidence * exp(-λ * fullInactive)` recomputed over the full gap each run
 * would over-decay quadratically and prune genuine traits after a week's gap.
 */
/** Pure decay decision for one trait, so the math is testable without the DB. */
export function computeTraitDecay(
    confidence: number,
    lastSeenMs: number,
    lastDecayMs: number | null,
    nowMs: number,
): { action: "prune" | "update" | "none"; newConfidence: number } {
    const anchor = Math.max(lastSeenMs, lastDecayMs ?? lastSeenMs);
    const daysInactive = Math.min((nowMs - anchor) / (1000 * 60 * 60 * 24), MAX_DECAY_DAYS);
    if (daysInactive <= 0) return { action: "none", newConfidence: confidence };
    const newConf = confidence * Math.exp(-LAMBDA * daysInactive);
    if (newConf < REMOVAL_THRESHOLD) return { action: "prune", newConfidence: newConf };
    if (Math.abs(newConf - confidence) > 0.001) return { action: "update", newConfidence: newConf };
    return { action: "none", newConfidence: confidence };
}

export function decayTraits(): number {
    if (!_db) return 0;

    // Get all traits for decay calculation
    const results = _db.exec(
        "SELECT trait_key, confidence, last_seen_ts, last_decay_ts FROM behavioral_traits"
    );

    if (results.length === 0 || results[0].values.length === 0) return 0;

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    let decayed = 0;

    beginTransaction();
    try {
        for (const row of results[0].values) {
            const traitKey = row[0] as string;
            const confidence = row[1] as number;
            const lastSeen = new Date(row[2] as string).getTime();
            // Anchor = the later of last-seen / last-decay. Reinforcement bumps
            // last_seen_ts to now, so a just-reinforced trait has anchor == now
            // and doesn't decay until real idle time accrues.
            const lastDecay = row[3] ? new Date(row[3] as string).getTime() : lastSeen;
            const d = computeTraitDecay(confidence, lastSeen, lastDecay, now);

            if (d.action === "prune") {
                _db.run("DELETE FROM behavioral_traits WHERE trait_key = ?", [traitKey]);
                debugLog("DECAY", `Pruned trait ${traitKey} (conf=${d.newConfidence.toFixed(3)} < ${REMOVAL_THRESHOLD})`);
                decayed++;
            } else if (d.action === "update") {
                _db.run(
                    "UPDATE behavioral_traits SET confidence = ?, last_decay_ts = ? WHERE trait_key = ?",
                    [d.newConfidence, nowIso, traitKey]
                );
                debugLog("DECAY", `Decayed ${traitKey}: ${confidence.toFixed(3)} → ${d.newConfidence.toFixed(3)}`);
            }
        }
        commitTransaction();
    } catch {
        rollbackTransaction();
    }

    return decayed;
}

// ── Token-Budgeted Trait Injection ────────────

/**
 * Get traits for prompt injection, scored by relevance * confidence * recency * stability.
 * Respects token budget and max count.
 */
export function getTraitsForInjection(
    query: string,
    tokenBudget = TOKEN_BUDGET_DEFAULT
): string {
    if (!_db) return "";

    const allTraits = getAllTraits();
    if (allTraits.length === 0) return "";

    const queryTokens = tokenizeForRelevance(query);

    // Check predictive cache
    if (_predictiveCache && _predictiveCache.snippet &&
        Date.now() - _predictiveCache.timestamp < PREDICTIVE_CACHE_TTL_MS) {
        const cacheSimilarity = computeQuerySimilarity(queryTokens, _predictiveCache.queryTokens);
        if (cacheSimilarity > 0.6) {
            debugLog("CACHE", "Predictive snippet served from cache");
            return _predictiveCache.snippet;
        }
    }

    // Load correlations for scoring boost
    const correlationMap = loadCorrelationMap();

    // Score each trait
    const scored = allTraits
        .filter(t => t.confidence >= 0.3)
        .map(t => {
            const relevance = computeRelevance(queryTokens, t);
            const recencyWeight = computeRecencyWeight(t.last_seen_ts);
            const stabilityBonus = Math.log((t.reinforcement_count || 0) + 1);
            const correlationBoost = getCorrelationBoost(t.trait_key, correlationMap);
            const priority = t.confidence * relevance * recencyWeight
                * (1 + STABILITY_BONUS_WEIGHT * stabilityBonus)
                * (1 + 0.05 * correlationBoost);
            return { trait: t, priority };
        })
        .sort((a, b) => b.priority - a.priority);

    // Select traits within token budget
    const selected: BehavioralTrait[] = [];
    let usedTokens = 0;

    for (const { trait } of scored) {
        if (selected.length >= MAX_TRAITS_INJECTION) break;

        const line = formatTraitLine(trait);
        const lineTokens = estimateTokens(line);

        if (usedTokens + lineTokens > tokenBudget) break;

        selected.push(trait);
        usedTokens += lineTokens;
    }

    if (selected.length === 0) return "";

    const lines = selected.map(formatTraitLine);
    debugLog("INJECTION", `Injecting ${selected.length} traits (${usedTokens} tokens within ${tokenBudget} budget)`);

    const snippet = "### USER BEHAVIORAL PROFILE\n" + lines.join("\n");

    // Update predictive cache for next call
    _predictiveCache = {
        snippet,
        queryTokens,
        timestamp: Date.now(),
    };

    return snippet;
}

// ── Legacy snippet (kept for backward compat) ─

export function getTraitsPromptSnippet(): string {
    return getTraitsForInjection("", TOKEN_BUDGET_DEFAULT);
}

// ── Get / List ────────────────────────────────

export function getTrait(traitKey: string): BehavioralTrait | null {
    if (!_db) return null;

    const results = _db.exec(
        `SELECT trait_key, value, confidence, explicit, topics,
                reinforcement_count, last_seen_ts, created_at
         FROM behavioral_traits WHERE trait_key = ?`,
        [traitKey]
    );

    if (results.length === 0 || results[0].values.length === 0) return null;
    return rowToTrait(results[0].values[0]);
}

export function getAllTraits(): BehavioralTrait[] {
    if (!_db) return [];

    const results = _db.exec(
        `SELECT trait_key, value, confidence, explicit, topics,
                reinforcement_count, last_seen_ts, created_at
         FROM behavioral_traits ORDER BY confidence DESC`
    );

    if (results.length === 0) return [];
    return results[0].values.map(rowToTrait);
}

export function getHighConfidenceTraits(threshold = HIGH_CONFIDENCE): BehavioralTrait[] {
    if (!_db) return [];

    const results = _db.exec(
        `SELECT trait_key, value, confidence, explicit, topics,
                reinforcement_count, last_seen_ts, created_at
         FROM behavioral_traits WHERE confidence >= ?
         ORDER BY confidence DESC`,
        [threshold]
    );

    if (results.length === 0) return [];
    return results[0].values.map(rowToTrait);
}

export function deleteTrait(traitKey: string): boolean {
    if (!_db) return false;
    _db.run("DELETE FROM behavioral_traits WHERE trait_key = ?", [traitKey]);
    return true;
}

// ── Memory Snapshot Export ─────────────────────

export function exportTraitsSnapshot(): {
    traits: BehavioralTrait[];
    session_caps: { updates: number; max: number; traits_touched: string[] };
} {
    return {
        traits: getAllTraits(),
        session_caps: {
            updates: sessionUpdateCount,
            max: MAX_SESSION_UPDATES,
            traits_touched: Array.from(sessionTraitUpdates),
        },
    };
}

// ── Helpers ───────────────────────────────────

function rowToTrait(row: unknown[]): BehavioralTrait {
    let topics: string[] = [];
    try { topics = JSON.parse((row[4] as string) || "[]"); } catch { /* */ }

    return {
        trait_key: row[0] as string,
        value: row[1] as string,
        confidence: row[2] as number,
        explicit: (row[3] as number) === 1,
        topics,
        reinforcement_count: (row[5] as number) || 0,
        last_seen_ts: row[6] as string,
        created_at: row[7] as string,
    };
}

function formatTraitLine(t: BehavioralTrait): string {
    const conf = Math.round(t.confidence * 100);
    return `- ${formatTraitKey(t.trait_key)}: ${t.value} (confidence ${conf}%)`;
}

function formatTraitKey(key: string): string {
    return key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

// ── Token estimation (~4 chars per token) ─────

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

// ── Relevance scoring ─────────────────────────

const STOPWORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "do", "does", "did",
    "to", "of", "in", "for", "on", "with", "at", "by", "from", "it",
    "this", "that", "and", "or", "but", "not", "so", "if", "my", "your",
    "i", "me", "we", "you", "he", "she", "they", "what", "how", "can",
]);

function tokenizeForRelevance(text: string): Set<string> {
    return new Set(
        text.toLowerCase()
            .replace(/[^\w\s]/g, " ")
            .split(/\s+/)
            .filter(w => w.length > 2 && !STOPWORDS.has(w))
            .map(basicStem)
    );
}

function basicStem(word: string): string {
    // Very basic stemming: remove common suffixes
    return word
        .replace(/ing$/, "")
        .replace(/tion$/, "t")
        .replace(/ness$/, "")
        .replace(/ment$/, "")
        .replace(/able$/, "")
        .replace(/ful$/, "")
        .replace(/ly$/, "")
        .replace(/ed$/, "")
        .replace(/er$/, "")
        .replace(/es$/, "")
        .replace(/s$/, "");
}

function computeRelevance(queryTokens: Set<string>, trait: BehavioralTrait): number {
    if (queryTokens.size === 0) return 0.5; // No query → moderate relevance

    // Combine trait_key + topics into token set
    const traitText = [
        trait.trait_key.replace(/_/g, " "),
        trait.value,
        ...trait.topics,
    ].join(" ");

    const traitTokens = tokenizeForRelevance(traitText);
    if (traitTokens.size === 0) return 0.3;

    // Jaccard-like overlap
    let overlap = 0;
    for (const token of queryTokens) {
        if (traitTokens.has(token)) overlap++;
    }

    const similarity = overlap / Math.max(1, Math.min(queryTokens.size, traitTokens.size));
    // Base relevance of 0.3 ensures all high-confidence traits still appear
    return 0.3 + 0.7 * similarity;
}

function computeRecencyWeight(lastSeenTs: string): number {
    const daysAgo = (Date.now() - new Date(lastSeenTs).getTime()) / (1000 * 60 * 60 * 24);
    // Exponential falloff but never below 0.5
    return Math.max(0.5, Math.exp(-0.05 * daysAgo));
}

function mergeTopics(existing: string[], incoming: string[]): string[] {
    const set = new Set([...existing, ...incoming]);
    return Array.from(set).slice(0, 10);
}

// ── Predictive Injection Cache ────────────────

const PREDICTIVE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface PredictiveCache {
    snippet: string;
    queryTokens: Set<string>;
    timestamp: number;
}

let _predictiveCache: PredictiveCache | null = null;

function computeQuerySimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let overlap = 0;
    for (const token of a) {
        if (b.has(token)) overlap++;
    }
    return overlap / Math.max(a.size, b.size);
}

// ── Trait Graph Edges ─────────────────────────

/**
 * Record co-occurrence of two traits appearing in the same session.
 */
export function recordCoOccurrence(traitA: string, traitB: string): void {
    if (!_db) return;
    // Ensure consistent ordering
    const [a, b] = traitA < traitB ? [traitA, traitB] : [traitB, traitA];

    _db.run(
        `INSERT INTO trait_edges (trait_a, trait_b, weight, correlation_count)
         VALUES (?, ?, 0.1, 1)
         ON CONFLICT(trait_a, trait_b) DO UPDATE SET
           weight = min(1.0, weight + 0.05),
           correlation_count = correlation_count + 1`,
        [a, b]
    );
    debugLog("GRAPH", `Co-occurrence: ${a} ↔ ${b}`);
}

/**
 * Get traits correlated with the given key.
 */
export function getCorrelatedTraits(traitKey: string): Array<{ trait: string; weight: number }> {
    if (!_db) return [];

    const results = _db.exec(
        `SELECT CASE WHEN trait_a = ? THEN trait_b ELSE trait_a END AS related, weight
         FROM trait_edges
         WHERE trait_a = ? OR trait_b = ?
         ORDER BY weight DESC LIMIT 5`,
        [traitKey, traitKey, traitKey]
    );

    if (results.length === 0) return [];
    return results[0].values.map(row => ({
        trait: row[0] as string,
        weight: row[1] as number,
    }));
}

/**
 * Record co-occurrences for all traits updated in the current session.
 */
export function recordSessionCoOccurrences(): void {
    const traits = Array.from(sessionTraitUpdates);
    for (let i = 0; i < traits.length; i++) {
        for (let j = i + 1; j < traits.length; j++) {
            recordCoOccurrence(traits[i], traits[j]);
        }
    }
}

function loadCorrelationMap(): Map<string, number> {
    if (!_db) return new Map();
    const results = _db.exec(
        "SELECT trait_a, trait_b, weight FROM trait_edges WHERE weight > 0.2"
    );
    const map = new Map<string, number>();
    if (results.length === 0) return map;
    for (const row of results[0].values) {
        const a = row[0] as string;
        const b = row[1] as string;
        const w = row[2] as number;
        map.set(a, (map.get(a) || 0) + w);
        map.set(b, (map.get(b) || 0) + w);
    }
    return map;
}

function getCorrelationBoost(traitKey: string, correlationMap: Map<string, number>): number {
    return correlationMap.get(traitKey) || 0;
}
