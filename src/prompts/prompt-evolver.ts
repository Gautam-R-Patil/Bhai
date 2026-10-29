// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Prompt Evolver ───────────────────────────────
 * Self-modifying prompt engine inspired by HyperAgent (Meta, ICLR 2026).
 * After tasks, evaluates prompt effectiveness. If performance drops,
 * generates variants and A/B tests them. Persists winning variants.
 *
 * This is the core of the agent's ability to improve itself over time.
 */

import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";
import type { Database } from "../memory/sqlite.js";

// ── Types ─────────────────────────────────────

export interface PromptVariant {
    id: string;
    segmentName: string;        // "identity" | "rules" | "browsing" | "thinking" | "custom"
    content: string;
    version: number;
    successCount: number;
    failureCount: number;
    totalUses: number;
    avgQualityScore: number;
    avgTokenCount: number;
    avgUserSatisfaction: number;
    isActive: boolean;
    createdAt: string;
}

// ── State ─────────────────────────────────────

let db: Database | null = null;

// ── Init ──────────────────────────────────────

export function _resetPromptEvolverForTests(): void {
    db = null;
}

export function initPromptEvolver(database: Database): void {
    db = database;

    db.run(`
        CREATE TABLE IF NOT EXISTS prompt_variants (
            id TEXT PRIMARY KEY,
            segment_name TEXT NOT NULL,
            content TEXT NOT NULL,
            version INTEGER DEFAULT 1,
            success_count INTEGER DEFAULT 0,
            failure_count INTEGER DEFAULT 0,
            total_uses INTEGER DEFAULT 0,
            avg_quality_score REAL DEFAULT 0.5,
            avg_token_count REAL DEFAULT 1000,
            avg_user_satisfaction REAL DEFAULT 0.5,
            is_active INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);

    try { db.run("CREATE INDEX IF NOT EXISTS idx_pv_segment ON prompt_variants(segment_name)"); } catch { /* */ }
    try { db.run("CREATE INDEX IF NOT EXISTS idx_pv_active ON prompt_variants(is_active)"); } catch { /* */ }

    console.log("[PROMPT-EVOLVER] Initialized");
}

// ── Record Outcome ────────────────────────────

/**
 * Record the outcome of a task that used a specific prompt variant.
 * Updates metrics and triggers evolution check.
 */
export function recordOutcome(
    segmentName: string,
    taskSucceeded: boolean,
    qualityScore: number,
    tokenCount: number,
    userEngaged: boolean,
): void {
    if (!db) return;

    // Get active variant for this segment
    const results = db.exec(
        "SELECT id, total_uses, avg_quality_score, avg_token_count, avg_user_satisfaction, success_count, failure_count FROM prompt_variants WHERE segment_name = ? AND is_active = 1",
        [segmentName]
    );

    if (!results[0]?.values[0]) return;

    const [id, totalUses, avgQ, avgT, avgS, succCount, failCount] = results[0].values[0] as [string, number, number, number, number, number, number];
    const newTotal = totalUses + 1;
    const alpha = 1 / Math.min(newTotal, 20);

    // Exponential moving average updates
    const newAvgQ = avgQ * (1 - alpha) + qualityScore * alpha;
    const newAvgT = avgT * (1 - alpha) + tokenCount * alpha;
    const newAvgS = avgS * (1 - alpha) + (userEngaged ? 0.8 : 0.3) * alpha;

    db.run(
        `UPDATE prompt_variants SET
            total_uses = ?, avg_quality_score = ?, avg_token_count = ?,
            avg_user_satisfaction = ?,
            success_count = success_count + ?,
            failure_count = failure_count + ?
         WHERE id = ?`,
        [newTotal, newAvgQ, newAvgT, newAvgS, taskSucceeded ? 1 : 0, taskSucceeded ? 0 : 1, id]
    );
}

// ── Evolution ─────────────────────────────────

/**
 * Check if any prompt segments need evolution.
 * Called during dreaming or idle periods.
 */
export async function evolvePrompts(llm: LLMClient): Promise<string[]> {
    if (!db) return [];

    const evolved: string[] = [];

    // Find active variants with enough samples and declining performance
    const results = db.exec(
        `SELECT id, segment_name, content, total_uses, avg_quality_score,
                success_count, failure_count
         FROM prompt_variants
         WHERE is_active = 1 AND total_uses >= 10`,
        []
    );

    if (!results[0]?.values) return [];

    for (const row of results[0].values) {
        const [id, segName, content, uses, avgQ, succ, fail] = row as [string, string, string, number, number, number, number];

        const successRate = uses > 0 ? succ / uses : 0.5;

        // Evolve if success rate below 70% or quality below 0.5
        if (successRate < 0.7 || avgQ < 0.5) {
            const newVariant = await generateVariant(llm, segName, content, successRate, avgQ);
            if (newVariant) {
                saveVariant(segName, newVariant);
                evolved.push(segName);
                console.log(`[PROMPT-EVOLVER] Generated new variant for "${segName}" (success: ${(successRate * 100).toFixed(0)}%, quality: ${avgQ.toFixed(2)})`);
            }
        }
    }

    return evolved;
}

async function generateVariant(
    llm: LLMClient,
    segmentName: string,
    currentContent: string,
    successRate: number,
    qualityScore: number,
): Promise<string | null> {
    const messages: ChatCompletionMessageParam[] = [
        {
            role: "user",
            content: `You are a prompt optimization system. The following prompt segment "${segmentName}" has a ${(successRate * 100).toFixed(0)}% success rate and ${qualityScore.toFixed(2)} quality score.

CURRENT PROMPT:
${currentContent.substring(0, 2000)}

Generate an improved version that:
1. Addresses likely failure modes (unclear instructions, missing context, wrong tone)
2. Is more specific about expected behavior
3. Reduces token waste (removes redundant instructions)
4. Maintains the core intent and personality

Output ONLY the improved prompt text, nothing else.`,
        },
    ];

    try {
        const response = await llm.chat({
            messages,
            systemPrompt: "You are a prompt engineering expert. Output only the improved prompt text.",
            modelOverride: "openai/gpt-5-mini",
        });

        const content = response.choices?.[0]?.message?.content?.trim();
        if (content && content.length > 50) return content;
        return null;
    } catch {
        return null;
    }
}

function saveVariant(segmentName: string, content: string): void {
    if (!db) return;

    const id = `${segmentName}_v${Date.now()}`;
    db.run(
        `INSERT INTO prompt_variants (id, segment_name, content, is_active)
         VALUES (?, ?, ?, 0)`,
        [id, segmentName, content]
    );

    // Also draft to the self-improvement buffer so nightly synthesis can
    // promote a winning variant to the user's server-side addendum. The
    // local prompt_variants table keeps the per-variant metrics; the draft
    // mirrors only the content for upload. Failures are non-fatal — the
    // local variant still exists and can be picked up next cycle.
    try {
        const { addDraft } = require("../memory/self-improvement-drafts.js") as typeof import("../memory/self-improvement-drafts.js");
        // Map evolver segment name → addendum slug. "memory-prompt-" is a
        // 14-char prefix; the slug cap is 64 chars total, so truncate the
        // normalized segment to 50 chars to leave room.
        const normalized = segmentName
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 50);
        const slug = `memory-prompt-${normalized}`;
        addDraft({
            kind: "memory",
            slug,
            content,
            reason: `Auto-evolved variant for segment '${segmentName}' (low quality/success baseline)`,
        });
    } catch (err) {
        // Likely slug validation failure; non-fatal — local variant is preserved.
        console.warn(`[PROMPT-EVOLVER] Could not draft variant for '${segmentName}':`, (err as Error).message);
    }
}

// ── Get Active Prompt ─────────────────────────

/**
 * Get the active prompt variant for a segment.
 * Returns the content of the best-performing variant.
 */
export function getActivePrompt(segmentName: string): string | null {
    if (!db) return null;

    const results = db.exec(
        "SELECT content FROM prompt_variants WHERE segment_name = ? AND is_active = 1",
        [segmentName]
    );

    const content = results[0]?.values[0]?.[0];
    return typeof content === "string" ? content : null;
}

/**
 * Activate a challenger variant if it outperforms the current one.
 * Uses native Rust scoring for the comparison.
 */
export function tryAdoptChallenger(segmentName: string): boolean {
    if (!db) return false;

    const native = loadNative();
    if (!native) return false;

    // Get active and best challenger
    const active = db.exec(
        `SELECT id, success_count, failure_count, total_uses, avg_quality_score, avg_token_count, avg_user_satisfaction, created_at
         FROM prompt_variants WHERE segment_name = ? AND is_active = 1`,
        [segmentName]
    );

    const challengers = db.exec(
        `SELECT id, success_count, failure_count, total_uses, avg_quality_score, avg_token_count, avg_user_satisfaction, created_at
         FROM prompt_variants WHERE segment_name = ? AND is_active = 0 AND total_uses >= 5
         ORDER BY avg_quality_score DESC LIMIT 1`,
        [segmentName]
    );

    if (!active[0]?.values[0] || !challengers[0]?.values[0]) return false;

    const toVariant = (row: unknown[]): any => ({
        id: row[0], segment_name: segmentName, content_hash: "",
        success_count: row[1], failure_count: row[2], total_uses: row[3],
        avg_quality_score: row[4], avg_token_count: row[5], avg_user_satisfaction: row[6],
        created_at_ms: new Date(row[7] as string).getTime(),
    });

    const decision = native.compareVariants(
        toVariant(active[0].values[0]),
        toVariant(challengers[0].values[0])
    );

    if (decision.should_evolve) {
        const activeId = active[0].values[0][0] as string;
        const challengerId = challengers[0].values[0][0] as string;
        db.run("UPDATE prompt_variants SET is_active = 0 WHERE id = ?", [activeId]);
        db.run("UPDATE prompt_variants SET is_active = 1 WHERE id = ?", [challengerId]);
        console.log(`[PROMPT-EVOLVER] Adopted challenger for "${segmentName}": ${decision.reasoning}`);
        return true;
    }

    return false;
}

// ── Native Module ─────────────────────────────

let _native: any = null;
let _nativeLoaded = false;

function loadNative(): any {
    if (_nativeLoaded) return _native;
    _nativeLoaded = true;
    try {
        const { createRequire } = require("node:module");
        const nativeRequire = createRequire(import.meta.url);
        const path = require("node:path");
        _native = nativeRequire(path.join(process.cwd(), "native", "index.js"));
        return _native;
    } catch { return null; }
}
