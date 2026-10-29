// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Emotional Memory Layer ────────────────────
// Captures emotional context from interactions.
// Used for empathetic tone adaptation and milestone reinforcement.
// Decays with time.

import type { Database } from "./sqlite.js";
import { generateUUID } from "../utils/uuid.js";

// ── Types ─────────────────────────────────────

export interface EmotionalMemory {
    id: string;
    user_id: string;
    emotion: string;
    context: string;
    intensity: number;    // 0–1
    timestamp: string;
}

// ── Constants ─────────────────────────────────

const EMOTION_DECAY_LAMBDA = 0.05;  // Faster decay than traits (emotions are transient)
const MAX_DECAY_DAYS = 30;
const INTENSITY_THRESHOLD = 0.1;
const MAX_INJECTION_ITEMS = 3;

// ── Singleton ─────────────────────────────────

let _db: Database | null = null;

// ── Initialize ────────────────────────────────

export function initEmotionalMemory(db: Database): void {
    _db = db;
    console.log("💭 Emotional memory initialized");
}

// ── Record Emotion ────────────────────────────

export function recordEmotion(
    emotion: string,
    context: string,
    intensity = 0.5,
    userId = "default"
): EmotionalMemory {
    if (!_db) throw new Error("Emotional memory not initialized");

    const id = generateUUID();
    _db.run(
        `INSERT INTO emotional_memory (id, user_id, emotion, context, intensity)
         VALUES (?, ?, ?, ?, ?)`,
        [id, userId, emotion, context, Math.max(0, Math.min(1, intensity))]
    );

    console.log(`[MEMORY][EMOTION] Recorded: ${emotion} (${(intensity * 100).toFixed(0)}%) — ${context.substring(0, 60)}`);

    return { id, user_id: userId, emotion, context, intensity, timestamp: new Date().toISOString() };
}

// ── Get Recent Emotions ───────────────────────

export function getRecentEmotions(userId = "default", limit = 10): EmotionalMemory[] {
    if (!_db) return [];

    const results = _db.exec(
        `SELECT id, user_id, emotion, context, intensity, timestamp
         FROM emotional_memory WHERE user_id = ?
         ORDER BY timestamp DESC LIMIT ?`,
        [userId, limit]
    );

    if (results.length === 0) return [];
    return results[0].values.map(rowToEmotion);
}

// ── Get Dominant Emotion ──────────────────────

export function getDominantEmotion(userId = "default"): { emotion: string; intensity: number } | null {
    const recent = getRecentEmotions(userId, 5);
    if (recent.length === 0) return null;

    // Weight by intensity and recency
    const emotionScores = new Map<string, number>();
    const now = Date.now();

    for (const em of recent) {
        const daysAgo = (now - new Date(em.timestamp).getTime()) / (1000 * 60 * 60 * 24);
        const recencyWeight = Math.exp(-0.1 * daysAgo);
        const score = em.intensity * recencyWeight;

        emotionScores.set(em.emotion, (emotionScores.get(em.emotion) || 0) + score);
    }

    let dominant = { emotion: "neutral", intensity: 0 };
    for (const [emotion, score] of emotionScores) {
        if (score > dominant.intensity) {
            dominant = { emotion, intensity: Math.min(1, score) };
        }
    }

    return dominant.intensity > 0.2 ? dominant : null;
}

// ── Decay Emotions ────────────────────────────

export function decayEmotions(): number {
    if (!_db) return 0;

    const results = _db.exec(
        "SELECT id, intensity, timestamp FROM emotional_memory"
    );
    if (results.length === 0 || results[0].values.length === 0) return 0;

    const now = Date.now();
    let pruned = 0;

    for (const row of results[0].values) {
        const id = row[0] as string;
        const currentIntensity = row[1] as number;
        const ts = new Date(row[2] as string).getTime();
        const daysInactive = Math.min((now - ts) / (1000 * 60 * 60 * 24), MAX_DECAY_DAYS);

        // Idempotent decay: compute from time-since-creation, not from current value.
        // This prevents double-decay when decayEmotions() runs multiple times.
        const decayFactor = Math.exp(-EMOTION_DECAY_LAMBDA * daysInactive);
        const newIntensity = Math.min(currentIntensity, decayFactor);

        if (newIntensity < INTENSITY_THRESHOLD) {
            _db.run("DELETE FROM emotional_memory WHERE id = ?", [id]);
            pruned++;
        } else if (Math.abs(newIntensity - currentIntensity) > 0.01) {
            _db.run("UPDATE emotional_memory SET intensity = ? WHERE id = ?", [newIntensity, id]);
        }
    }

    return pruned;
}

// ── Emotional Salience Gating (Amygdala Effect) ──

/**
 * Get the current overall emotional intensity.
 * Used by remember() to boost importance of memories stored during emotional moments.
 */
export function getCurrentEmotionalIntensity(userId = "default"): number {
    const dominant = getDominantEmotion(userId);
    return dominant ? dominant.intensity : 0;
}

// ── Prompt Snippet ────────────────────────────

export function getEmotionalContextSnippet(userId = "default"): string {
    const recent = getRecentEmotions(userId, MAX_INJECTION_ITEMS);
    if (recent.length === 0) return "";

    const dominant = getDominantEmotion(userId);
    const parts: string[] = [];

    if (dominant && dominant.intensity > 0.3) {
        parts.push(`- Dominant mood: ${dominant.emotion} (${(dominant.intensity * 100).toFixed(0)}%)`);
    }

    for (const em of recent) {
        if (em.intensity > 0.3) {
            parts.push(`- ${em.emotion}: ${em.context.substring(0, 80)} (${(em.intensity * 100).toFixed(0)}%)`);
        }
    }

    if (parts.length === 0) return "";
    return "💭 EMOTIONAL CONTEXT (recent emotional signals):\n" + parts.join("\n");
}

// ── Helpers ───────────────────────────────────

function rowToEmotion(row: unknown[]): EmotionalMemory {
    return {
        id: row[0] as string,
        user_id: row[1] as string,
        emotion: row[2] as string,
        context: row[3] as string,
        intensity: row[4] as number,
        timestamp: row[5] as string,
    };
}

// generateId moved to ../utils/uuid.ts as generateUUID
