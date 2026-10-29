// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Spotify fast search via Client Credentials ────
// Replaces the ~15s spogo `search track` path with a ~200ms call to the
// public Spotify Web API. Token is minted server-side (Convex env holds the
// client_secret); client only ever sees the short-lived app-only access token.
//
// Fails open: any network / auth / rate-limit error returns null so the
// caller can fall back to the existing spogo-based search.

import { getConvexSiteUrl } from "../config/keys.js";
import { encryptedFetch } from "../crypto-transport.js";
import { getSessionToken } from "../session.js";

export interface FastSearchResult {
    uri: string;
    name: string;
    artists: string;
}

interface CachedToken {
    access_token: string;
    expires_at: number; // epoch ms, already minus a safety margin
}

let _cachedToken: CachedToken | null = null;
let _loggedEndpointFailure = false;

const SAFETY_MARGIN_MS = 60_000; // refresh 60s before Spotify's real expiry

async function mintAppToken(): Promise<CachedToken | null> {
    const session = await getSessionToken();
    if (!session) return null;
    try {
        const resp = await encryptedFetch(`${getConvexSiteUrl()}/api/spotify/app-token`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${session}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
        });
        const data = (await resp.json()) as { access_token?: string; expires_in?: number; error?: string };
        if (!resp.ok || !data?.access_token || !data?.expires_in) {
            if (!_loggedEndpointFailure) {
                console.warn(
                    `[spotify-search] app-token endpoint failed: ${data?.error || resp.status}. Falling back to spogo search.`,
                );
                _loggedEndpointFailure = true;
            }
            return null;
        }
        _loggedEndpointFailure = false;
        return {
            access_token: data.access_token,
            expires_at: Date.now() + Math.max(0, (data.expires_in - 60) * 1000),
        };
    } catch (err) {
        if (!_loggedEndpointFailure) {
            console.warn(
                `[spotify-search] app-token network error: ${(err as Error).message}. Falling back to spogo search.`,
            );
            _loggedEndpointFailure = true;
        }
        return null;
    }
}

async function getAppToken(forceRefresh = false): Promise<string | null> {
    if (!forceRefresh && _cachedToken && _cachedToken.expires_at > Date.now() + SAFETY_MARGIN_MS) {
        return _cachedToken.access_token;
    }
    const fresh = await mintAppToken();
    if (!fresh) return null;
    _cachedToken = fresh;
    return fresh.access_token;
}

interface SpotifySearchTrackItem {
    uri: string;
    name: string;
    artists?: Array<{ name: string }>;
}

interface SpotifySearchResponse {
    tracks?: {
        items?: SpotifySearchTrackItem[];
    };
}

/**
 * Resolve a free-text query to a Spotify track URI via the public Web API.
 * Returns the top-ranked track or null on any error.
 *
 * Intentionally silent on failure so callers can fall back to spogo.
 */
export async function fastSearchTrack(query: string, limit = 10): Promise<FastSearchResult | null> {
    if (!query.trim()) return null;

    let token = await getAppToken();
    if (!token) return null;

    const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=${Math.min(10, Math.max(1, limit))}`;

    const doCall = async (t: string) => {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 4000);
            const resp = await fetch(url, {
                headers: { Authorization: `Bearer ${t}` },
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            return resp;
        } catch (err) {
            return null;
        }
    };

    let resp = await doCall(token);

    // 401 → token may have been invalidated early; evict and retry once with a fresh mint.
    if (resp && resp.status === 401) {
        _cachedToken = null;
        const fresh = await getAppToken(true);
        if (!fresh) return null;
        token = fresh;
        resp = await doCall(token);
    }

    if (!resp || !resp.ok) {
        // 429, 5xx, network — all silently fall back to spogo
        return null;
    }

    let data: SpotifySearchResponse;
    try {
        data = (await resp.json()) as SpotifySearchResponse;
    } catch {
        return null;
    }

    const first = data.tracks?.items?.[0];
    if (!first || !first.uri || !first.name) return null;

    const artists = (first.artists || [])
        .map((a) => a.name)
        .filter(Boolean)
        .join(", ");
    return { uri: first.uri, name: first.name, artists };
}

/**
 * Resets the in-memory token cache. Exposed for tests / manual reset.
 */
export function clearSpotifySearchCache(): void {
    _cachedToken = null;
}
