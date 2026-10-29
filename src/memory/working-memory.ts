// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Working Memory ───────────────────────────────
 * Explicit separation of working memory (active context) from LTM.
 * Based on 2026 research on unified LTM/STM management and HiAgent (ACL 2025).
 *
 * Working memory is a bounded buffer of attention-weighted items.
 * Items with decaying attention are spilled to long-term memory.
 * High-relevance items are injected into the prompt at each turn.
 *
 * Operations: retain (add), recall (retrieve), reflect (consolidate), spill (evict to LTM).
 */

import type { Database } from "./sqlite.js";
import { embedText, cosineSimilarity, isReady as isEmbeddingReady } from "./embeddings.js";

// ── Types ─────────────────────────────────────

export interface WMItem {
    id: string;
    contentType: "fact" | "task_context" | "tool_result" | "user_message" | "agent_thought";
    summary: string;
    fullContent?: string;       // Full content stored separately (not in prompt)
    attentionScore: number;     // 0-1
    importance: number;         // 0-1 intrinsic importance
    accessCount: number;
    createdTick: number;
    lastAccessedTick: number;
    tokenEstimate: number;
}

export interface WorkingMemoryState {
    items: WMItem[];
    currentTick: number;
    tokenBudget: number;        // Max tokens for WM injection
    capacity: number;           // Max items
}

// ── State ─────────────────────────────────────

let state: WorkingMemoryState = {
    items: [],
    currentTick: 0,
    tokenBudget: 3000,
    capacity: 20,
};

// ── Init ──────────────────────────────────────

export function initWorkingMemory(tokenBudget = 3000, capacity = 20): void {
    state = { items: [], currentTick: 0, tokenBudget, capacity };
    console.log(`[WM] Initialized (budget: ${tokenBudget} tokens, capacity: ${capacity})`);
}

// ── Retain (Add to WM) ───────────────────────

/**
 * Add an item to working memory. If WM is full, replaces the lowest-attention item.
 */
export function retain(
    id: string,
    contentType: WMItem["contentType"],
    summary: string,
    importance = 0.5,
    fullContent?: string,
): boolean {
    const tokenEstimate = Math.ceil(summary.length / 4);

    // Check if item already exists (update instead of add)
    const existing = state.items.find(i => i.id === id);
    if (existing) {
        existing.summary = summary;
        existing.importance = importance;
        existing.attentionScore = Math.min(1, existing.attentionScore + 0.2);
        existing.lastAccessedTick = state.currentTick;
        existing.accessCount++;
        return true;
    }

    // Try native module for retain decision
    const native = loadNative();
    if (native) {
        const nativeState = toNativeState();
        const decision = native.shouldRetain(nativeState, importance, tokenEstimate);
        if (!decision.should_retain) return false;

        if (decision.replaces_id) {
            spillItem(decision.replaces_id);
        }
    } else {
        // JS fallback: if full, remove lowest attention
        if (state.items.length >= state.capacity) {
            const lowest = state.items.reduce((min, item) =>
                item.attentionScore < min.attentionScore ? item : min
            );
            if (importance <= lowest.attentionScore) return false;
            spillItem(lowest.id);
        }
    }

    state.items.push({
        id,
        contentType,
        summary,
        fullContent,
        attentionScore: Math.max(importance, 0.5),
        importance,
        accessCount: 1,
        createdTick: state.currentTick,
        lastAccessedTick: state.currentTick,
        tokenEstimate,
    });

    return true;
}

// ── Recall (Retrieve from WM) ─────────────────

/**
 * Get the current working memory contents for prompt injection.
 * Returns items sorted by attention score, respecting token budget.
 */
export function recall(maxTokens?: number): WMItem[] {
    const budget = maxTokens || state.tokenBudget;

    // Try native selection
    const native = loadNative();
    if (native) {
        const nativeState = toNativeState();
        const selectedIds = native.selectForInjection(nativeState, budget);
        return state.items
            .filter(i => selectedIds.includes(i.id))
            .sort((a, b) => b.attentionScore - a.attentionScore);
    }

    // JS fallback
    const sorted = [...state.items].sort((a, b) => b.attentionScore - a.attentionScore);
    const selected: WMItem[] = [];
    let tokenCount = 0;

    for (const item of sorted) {
        if (tokenCount + item.tokenEstimate > budget) continue;
        selected.push(item);
        tokenCount += item.tokenEstimate;
    }

    return selected;
}

/**
 * Get working memory as a formatted string for prompt injection.
 */
export function getWMSnippet(maxTokens?: number): string {
    const items = recall(maxTokens);
    if (items.length === 0) return "";

    const lines = items.map(i => {
        const typeLabel: Record<string, string> = {
            fact: "[fact]", task_context: "[task]", tool_result: "[tool]",
            user_message: "[user]", agent_thought: "[thought]",
        };
        const label = typeLabel[i.contentType] || "[item]";
        return `${label} ${i.summary}`;
    });

    return `WORKING MEMORY (active context):\n${lines.join("\n")}`;
}

// ── Reflect (Update Attention) ────────────────

/**
 * Update attention scores based on current query relevance.
 * Called at the start of each agent iteration.
 */
export async function reflect(currentQuery: string): Promise<void> {
    state.currentTick++;

    if (!isEmbeddingReady() || state.items.length === 0) {
        // Simple time-based decay
        for (const item of state.items) {
            const ticksSinceAccess = state.currentTick - item.lastAccessedTick;
            item.attentionScore *= Math.exp(-0.05 * ticksSinceAccess);
        }
        return;
    }

    // Compute relevance to current query
    try {
        const queryEmb = await embedText(currentQuery, "query");
        const relevanceScores: number[] = [];

        for (const item of state.items) {
            const itemEmb = await embedText(item.summary, "document");
            const sim = cosineSimilarity(queryEmb, itemEmb);
            relevanceScores.push(Math.max(0, sim));
        }

        // Try native attention update
        const native = loadNative();
        if (native) {
            const nativeState = toNativeState();
            const updated = native.updateAttentionScores(nativeState, relevanceScores);
            for (let i = 0; i < state.items.length && i < updated.length; i++) {
                state.items[i].attentionScore = updated[i];
            }
        } else {
            // JS fallback
            for (let i = 0; i < state.items.length; i++) {
                const ticksSinceAccess = state.currentTick - state.items[i].lastAccessedTick;
                const decay = Math.exp(-0.05 * ticksSinceAccess);
                const relevance = relevanceScores[i] || 0;
                state.items[i].attentionScore = Math.min(1,
                    state.items[i].attentionScore * decay + relevance * 0.5 + state.items[i].importance * 0.1
                );
            }
        }
    } catch {
        // Embedding failed — simple decay
        for (const item of state.items) {
            item.attentionScore *= 0.95;
        }
    }

    // Spill items below threshold
    const toSpill = state.items.filter(i => i.attentionScore < 0.15);
    for (const item of toSpill) {
        spillItem(item.id);
    }
}

// ── Spill (Evict to LTM) ─────────────────────

function spillItem(itemId: string): void {
    const idx = state.items.findIndex(i => i.id === itemId);
    if (idx === -1) return;
    state.items.splice(idx, 1);
}

// ── Access Tracking ───────────────────────────

export function recordAccess(itemId: string): void {
    const item = state.items.find(i => i.id === itemId);
    if (item) {
        item.accessCount++;
        item.lastAccessedTick = state.currentTick;
        item.attentionScore = Math.min(1, item.attentionScore + 0.3);
    }
}

// ── Stats ─────────────────────────────────────

export function getWMStats(): {
    itemCount: number;
    totalTokens: number;
    avgAttention: number;
    tick: number;
} {
    const totalTokens = state.items.reduce((sum, i) => sum + i.tokenEstimate, 0);
    const avgAttention = state.items.length > 0
        ? state.items.reduce((sum, i) => sum + i.attentionScore, 0) / state.items.length
        : 0;

    return {
        itemCount: state.items.length,
        totalTokens,
        avgAttention,
        tick: state.currentTick,
    };
}

// ── Native Module ─────────────────────────────

function toNativeState(): any {
    return {
        items: state.items.map(i => ({
            id: i.id,
            content_type: i.contentType,
            summary: i.summary,
            attention_score: i.attentionScore,
            importance: i.importance,
            access_count: i.accessCount,
            created_tick: i.createdTick,
            last_accessed_tick: i.lastAccessedTick,
            token_estimate: i.tokenEstimate,
        })),
        current_tick: state.currentTick,
        total_tokens: state.items.reduce((s, i) => s + i.tokenEstimate, 0),
        capacity: state.capacity,
        token_budget: state.tokenBudget,
    };
}

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
