// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { SupabaseClient } from "@supabase/supabase-js";

// ── Types ─────────────────────────────────────

export interface SupabaseMemory {
    id?: string;
    content: string;
    embedding?: number[];
    category: string;
    metadata: Record<string, unknown>;
    created_at?: string;
}

// ── Singleton ─────────────────────────────────

let supabase: SupabaseClient | null = null;

// ── Initialize ────────────────────────────────

export async function initSupabase(): Promise<SupabaseClient | null> {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;

    if (!url || !key) {
        console.log("ℹ️  Supabase not configured (SUPABASE_URL / SUPABASE_ANON_KEY missing). Skipping.");
        return null;
    }

    // Loaded only when Supabase is configured, not at boot.
    const { createClient } = await import("@supabase/supabase-js");
    supabase = createClient(url, key);
    console.log("☁️  Supabase connected");
    return supabase;
}

// ── Store Memory ──────────────────────────────

export async function storeRemoteMemory(memory: SupabaseMemory): Promise<string | null> {
    if (!supabase) return null;

    const { data, error } = await supabase
        .from("memories")
        .insert({
            content: memory.content,
            embedding: memory.embedding,
            category: memory.category,
            metadata: memory.metadata,
        })
        .select("id")
        .single();

    if (error) {
        console.error("Supabase store error:", error.message);
        return null;
    }

    return data?.id || null;
}

// ── Semantic Search (pgvector) ────────────────

export async function semanticSearch(
    queryEmbedding: number[],
    limit = 10,
    threshold = 0.7
): Promise<SupabaseMemory[]> {
    if (!supabase) return [];

    const { data, error } = await supabase.rpc("match_memories", {
        query_embedding: queryEmbedding,
        match_threshold: threshold,
        match_count: limit,
    });

    if (error) {
        console.error("Supabase search error:", error.message);
        return [];
    }

    return (data || []) as SupabaseMemory[];
}

// ── Text Search (Fallback) ────────────────────

export async function textSearchRemote(
    query: string,
    limit = 10
): Promise<SupabaseMemory[]> {
    if (!supabase) return [];

    const { data, error } = await supabase
        .from("memories")
        .select("*")
        .textSearch("content", query, { type: "websearch" })
        .limit(limit);

    if (error) {
        console.error("Supabase text search error:", error.message);
        return [];
    }

    return (data || []) as SupabaseMemory[];
}

// ── Sync from Local ───────────────────────────

export async function syncLocalToRemote(
    localMemories: Array<{ content: string; category: string; tags: string }>
): Promise<number> {
    if (!supabase) return 0;

    let synced = 0;
    for (const mem of localMemories) {
        const result = await storeRemoteMemory({
            content: mem.content,
            category: mem.category,
            metadata: { tags: mem.tags, source: "local_sync" },
        });
        if (result) synced++;
    }

    return synced;
}
