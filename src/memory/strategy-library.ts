// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Strategy Library ────────────────────────────
// Persistent library of task execution strategies learned from experience.
// Inspired by Voyager's skill library — stores what worked, what failed,
// and the recovery approaches for different task types.
//
// Three loops feed into this:
//   1. agent.ts saveStrategy()s a multi-tool task when it completes
//   2. the overlay's thumbs up/down reinforceStrategy()s the latest one
//   3. getStrategyContext() hands a matching strategy to the next similar turn

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ─────────────────────────────────────

export interface Strategy {
    id: string;
    pattern: string;          // e.g. "play_song_spotify", "send_whatsapp_message"
    description: string;       // Human-readable: "To play a song: 1. search_play 2. if fails..."
    steps: string[];           // Ordered tool calls: ["spotify:play", "os_nav", "os_click_element:text"]
    successCount: number;
    failureCount: number;
    lastUsed: number;          // timestamp
    confidence: number;        // successCount / (successCount + failureCount)
    tags: string[];            // ["spotify", "music", "play"]
    createdAt: number;
}

interface StrategyStore {
    strategies: Strategy[];
    version: number;
}

// ── State ─────────────────────────────────────

const DATA_DIR = join(homedir(), ".atlas", "data");
const STORE_FILE = join(DATA_DIR, "strategy-library.json");
const MAX_STRATEGIES = 200;
const SAVE_DEBOUNCE_MS = 3000;
const DECAY_DAYS = 60; // Strategies unused for 60 days lose confidence

let store: StrategyStore = { strategies: [], version: 1 };
let initialized = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

// ── Init ──────────────────────────────────────

export function initStrategyLibrary(): void {
    if (initialized) return;
    try {
        mkdirSync(DATA_DIR, { recursive: true });
        if (existsSync(STORE_FILE)) {
            store = JSON.parse(readFileSync(STORE_FILE, "utf-8"));
            console.log(`📚 Strategy Library: ${store.strategies.length} strategies loaded`);
        } else {
            console.log(`📚 Strategy Library: Starting fresh`);
        }
    } catch (err) {
        console.warn(`📚 Strategy Library: Failed to load:`, (err as Error).message);
    }
    initialized = true;
}

// ── Save ──────────────────────────────────────

function scheduleSave(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
        } catch (err) {
            console.warn(`📚 Strategy Library: Save failed:`, (err as Error).message);
        }
    }, SAVE_DEBOUNCE_MS);
}

// ── Save/Update Strategy ──────────────────────

export function saveStrategy(opts: {
    pattern: string;
    description: string;
    steps: string[];
    success: boolean;
    tags?: string[];
}): Strategy {
    if (!initialized) initStrategyLibrary();

    const { pattern, description, steps, success, tags = [] } = opts;

    // Check if a strategy with this pattern already exists
    const existing = store.strategies.find(s => s.pattern === pattern);

    if (existing) {
        // Update existing strategy
        if (success) {
            existing.successCount++;
        } else {
            existing.failureCount++;
        }
        existing.confidence = existing.successCount / (existing.successCount + existing.failureCount);
        existing.lastUsed = Date.now();
        // Update description and steps if this was a success (learn from successful approach)
        if (success && description) {
            existing.description = description;
            existing.steps = steps;
        }
        // Merge tags
        for (const tag of tags) {
            if (!existing.tags.includes(tag)) existing.tags.push(tag);
        }
        scheduleSave();
        return existing;
    }

    // Create new strategy
    const strategy: Strategy = {
        id: `strat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        pattern,
        description,
        steps,
        successCount: success ? 1 : 0,
        failureCount: success ? 0 : 1,
        lastUsed: Date.now(),
        confidence: success ? 1.0 : 0.0,
        tags,
        createdAt: Date.now(),
    };

    store.strategies.push(strategy);

    // Cap at MAX_STRATEGIES — remove lowest confidence
    if (store.strategies.length > MAX_STRATEGIES) {
        store.strategies.sort((a, b) => b.confidence - a.confidence);
        store.strategies = store.strategies.slice(0, MAX_STRATEGIES);
    }

    scheduleSave();
    console.log(`📚 Strategy saved: "${pattern}" (${success ? "✅" : "❌"}) — ${store.strategies.length} total`);
    return strategy;
}

// ── Get Best Matching Strategy ────────────────

export function getStrategy(query: string): Strategy | null {
    if (!initialized) initStrategyLibrary();
    if (store.strategies.length === 0) return null;
    // An empty/whitespace query normalizes to "" which patternLower.includes("")
    // matches for every strategy (+5 each) — injecting an unrelated strategy into
    // the prompt for a contentless (e.g. media-only) message.
    if (query.trim() === "") return null;

    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

    let bestMatch: Strategy | null = null;
    let bestScore = 0;

    for (const strategy of store.strategies) {
        // Skip low-confidence strategies
        if (strategy.confidence < 0.3) continue;

        let score = 0;

        // Pattern match (exact or substring)
        const patternLower = strategy.pattern.toLowerCase();
        if (queryLower.includes(patternLower) || patternLower.includes(queryLower.replace(/\s+/g, "_"))) {
            score += 5;
        }

        // Tag matching
        for (const tag of strategy.tags) {
            if (queryLower.includes(tag.toLowerCase())) {
                score += 2;
            }
        }

        // Word overlap
        const descWords = strategy.description.toLowerCase().split(/\s+/);
        const wordOverlap = queryWords.filter(w => descWords.some(d => d.includes(w))).length;
        score += wordOverlap;

        // Confidence bonus
        score *= strategy.confidence;

        // Recency bonus (used in last 7 days → +20%)
        const daysSinceUse = (Date.now() - strategy.lastUsed) / (1000 * 60 * 60 * 24);
        if (daysSinceUse < 7) score *= 1.2;

        if (score > bestScore) {
            bestScore = score;
            bestMatch = strategy;
        }
    }

    return bestScore >= 2 ? bestMatch : null;
}

// ── Get Top Strategies ────────────────────────

export function getTopStrategies(limit = 10): Strategy[] {
    if (!initialized) initStrategyLibrary();
    return [...store.strategies]
        .filter(s => s.confidence >= 0.3)
        .sort((a, b) => {
            // Sort by confidence * recency
            const aRecency = Math.exp(-0.01 * (Date.now() - a.lastUsed) / (1000 * 60 * 60 * 24));
            const bRecency = Math.exp(-0.01 * (Date.now() - b.lastUsed) / (1000 * 60 * 60 * 24));
            return (b.confidence * bRecency) - (a.confidence * aRecency);
        })
        .slice(0, limit);
}

// ── Reinforce Strategy (from feedback) ────────

export function reinforceStrategy(pattern: string, isGood: boolean): void {
    if (!initialized) initStrategyLibrary();
    const strategy = store.strategies.find(s => s.pattern === pattern);
    if (!strategy) return;

    if (isGood) {
        strategy.successCount++;
    } else {
        strategy.failureCount++;
    }
    strategy.confidence = strategy.successCount / (strategy.successCount + strategy.failureCount);
    strategy.lastUsed = Date.now();
    scheduleSave();
}

// ── Decay Unused Strategies ───────────────────

export function decayStrategies(): void {
    if (!initialized) initStrategyLibrary();
    const now = Date.now();
    const decayThreshold = DECAY_DAYS * 24 * 60 * 60 * 1000;

    for (const strategy of store.strategies) {
        const age = now - strategy.lastUsed;
        if (age > decayThreshold) {
            strategy.confidence *= 0.9; // 10% decay
            if (strategy.confidence < 0.1) {
                // Mark for removal
                strategy.confidence = 0;
            }
        }
    }

    // Remove dead strategies
    const before = store.strategies.length;
    store.strategies = store.strategies.filter(s => s.confidence > 0);
    const removed = before - store.strategies.length;
    if (removed > 0) {
        console.log(`📚 Strategy Library: Decayed ${removed} stale strategies`);
        scheduleSave();
    }
}

// ── Get Strategy Context for Orchestrator ─────

export function getStrategyContext(query: string): string {
    const strategy = getStrategy(query);
    if (!strategy) return "";

    const reliabilityPct = Math.round(strategy.confidence * 100);
    return `\n[LEARNED STRATEGY] Pattern: "${strategy.pattern}" (${reliabilityPct}% reliable, used ${strategy.successCount + strategy.failureCount} times)\n` +
        `Description: ${strategy.description}\n` +
        `Steps: ${strategy.steps.join(" → ")}\n` +
        `Use this proven approach. Adapt if needed but prefer what worked before.`;
}
