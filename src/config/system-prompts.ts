// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── System prompt fetcher ──────────────────────
// Client-side helper for subsystems that need raw prompt content
// (voice live mode, dream replay). Prompts are stored in Convex and
// fetched via the session-authed /api/system/prompt endpoint so the
// desktop bundle ships zero prompt files on disk.
//
// Cache is in-memory for the session — prompts change rarely (they
// only update when someone re-runs scripts/seed-system-content.ts).
// Call invalidateSystemPromptCache() if a refresh is needed mid-run.

import { getConvexSiteUrl } from "./keys.js";
import { encryptedFetch } from "../crypto-transport.js";
import { getSessionToken, handleAuthError } from "../session.js";

interface CachedPrompt {
    content: string;
    version: number;
    fetchedAt: number;
}

const cache = new Map<string, CachedPrompt>();
// Prompts change rarely (only on a re-seed), but a long-running session should
// still pick up a re-seed without a full restart. Serve from cache for this
// long, then re-fetch once — and if that re-fetch fails, keep the stale copy
// rather than dropping to "" (losing the prompt mid-session is worse than a
// slightly old one).
const PROMPT_TTL_MS = 60 * 60_000;
// In-flight fetches are coalesced so parallel callers share a single network
// roundtrip. Without this, a cold startup that fetches identity + rules +
// rules-mac + coding + spec in parallel can stampede the endpoint and race
// on the auth-refresh path.
const inflight = new Map<string, Promise<string>>();
// Single-flight auth refresh so concurrent 401s don't mint multiple tokens.
let authRefreshPromise: Promise<string | null> | null = null;

async function refreshAuthOnce(): Promise<string | null> {
    if (!authRefreshPromise) {
        authRefreshPromise = handleAuthError().finally(() => {
            authRefreshPromise = null;
        });
    }
    return authRefreshPromise;
}

/**
 * Fetch a system prompt by slug from the Convex server. Returns "" on
 * any error so callers can fail open (no prompt injection is safer than
 * a hard crash when the server is unreachable).
 */
export async function fetchSystemPrompt(slug: string): Promise<string> {
    const cached = cache.get(slug);
    if (cached && Date.now() - cached.fetchedAt < PROMPT_TTL_MS) return cached.content;
    // Stale (or absent): re-fetch, but fall back to the stale copy on any failure.
    const stale = cached?.content ?? "";

    const pending = inflight.get(slug);
    if (pending) return pending;

    const p = (async () => {
        try {
            const convexUrl = getConvexSiteUrl();
            let token = await getSessionToken();
            if (!token) return stale;

            const url = `${convexUrl}/api/system/prompt?slug=${encodeURIComponent(slug)}`;
            let response = await encryptedFetch(url, {
                method: "GET",
                headers: { Authorization: `Bearer ${token}` },
            });

            if (response.status === 401) {
                token = await refreshAuthOnce();
                if (!token) return stale;
                response = await encryptedFetch(url, {
                    method: "GET",
                    headers: { Authorization: `Bearer ${token}` },
                });
            }

            if (!response.ok) return stale;

            const body = (await response.json()) as { slug: string; content: string; version: number };
            if (!body?.content) return stale;

            cache.set(slug, { content: body.content, version: body.version, fetchedAt: Date.now() });
            return body.content;
        } catch (err) {
            console.warn(`[system-prompts] Failed to fetch ${slug}:`, (err as Error).message);
            return stale;
        } finally {
            inflight.delete(slug);
        }
    })();

    inflight.set(slug, p);
    return p;
}

/**
 * Fetch several prompts in parallel. Returns a slug→content map. Missing
 * slugs are simply absent from the map.
 */
export async function fetchSystemPrompts(slugs: string[]): Promise<Record<string, string>> {
    const results = await Promise.all(slugs.map(async (s) => [s, await fetchSystemPrompt(s)] as const));
    const out: Record<string, string> = {};
    for (const [s, c] of results) if (c) out[s] = c;
    return out;
}

export function invalidateSystemPromptCache(slug?: string): void {
    if (slug) cache.delete(slug);
    else cache.clear();
}
