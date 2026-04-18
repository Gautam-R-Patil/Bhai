// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Live Voice Integration — Boot, overlay, Telegram wiring ──

import type { LLMClient } from "../../llm.js";
import type { LiveVoiceConfig } from "./types.js";
import { LiveVoiceSession } from "./session.js";
import { getConvexSiteUrl } from "../../config/keys.js";
import { getSessionToken } from "../../session.js";

// ── Singleton Session ────────────────────────────

let activeSession: LiveVoiceSession | null = null;
let cachedKeys: LiveVoiceConfig["keys"] | null = null;

// ── Fetch API Keys from Convex ───────────────────

async function fetchVoiceKeys(convexSiteUrl: string, sessionToken: string): Promise<LiveVoiceConfig["keys"]> {
    if (cachedKeys) return cachedKeys;

    try {
        const response = await fetch(`${convexSiteUrl}/api/keys/voice`, {
            headers: {
                "Authorization": `Bearer ${sessionToken}`,
                "Content-Type": "application/json",
            },
        });

        if (!response.ok) {
            console.warn(`[LIVE] Failed to fetch voice keys: ${response.status}`);
            return {};
        }

        const data = await response.json() as Record<string, string>;
        cachedKeys = {
            google: data.googleApiKey || undefined,
            openai: data.openaiApiKey || undefined,
            deepgram: data.deepgramApiKey || undefined,
        };

        const available = Object.entries(cachedKeys)
            .filter(([_, v]) => !!v)
            .map(([k]) => k);
        console.log(`[LIVE] Voice keys loaded: ${available.join(", ") || "none"}`);

        return cachedKeys;
    } catch (err) {
        console.warn("[LIVE] Voice key fetch failed:", (err as Error).message);
        return {};
    }
}

// ── Initialize ───────────────────────────────────

/**
 * Initialize live voice mode at boot.
 * Fetches API keys from Convex and makes live voice available.
 * Does NOT start a session — that's triggered by user action.
 */
export async function initLiveVoice(llm: LLMClient): Promise<void> {
    // Fetch keys from Convex server (same place as OpenRouter key)
    try {
        const convexUrl = getConvexSiteUrl();
        const token = await getSessionToken();
        if (convexUrl && token) {
            await fetchVoiceKeys(convexUrl, token);
        }
    } catch (err) {
        console.warn("[LIVE] Could not fetch voice keys from Convex:", (err as Error).message);
    }

    // Also check environment variables as fallback
    if (!cachedKeys || (!cachedKeys.google && !cachedKeys.openai)) {
        cachedKeys = {
            google: process.env.GOOGLE_API_KEY,
            openai: process.env.OPENAI_API_KEY,
            deepgram: process.env.DEEPGRAM_API_KEY,
        };
    }

    const hasBackend = cachedKeys?.google || cachedKeys?.openai;
    if (hasBackend) {
        const primary = cachedKeys?.google ? "Gemini Live" : "OpenAI Realtime";
        console.log(`   Voice  : Live mode ready (${primary})`);
    } else {
        console.log("   Voice  : Live mode unavailable (no GOOGLE_API_KEY or OPENAI_API_KEY)");
    }
}

// ── Start / Stop ─────────────────────────────────

/**
 * Start a live voice session. Only one can be active at a time.
 */
export async function startLiveVoice(llm: LLMClient): Promise<LiveVoiceSession> {
    if (activeSession?.isActive) {
        throw new Error("A live voice session is already active");
    }

    if (!cachedKeys || (!cachedKeys.google && !cachedKeys.openai)) {
        throw new Error("No voice API keys available. Set GOOGLE_API_KEY or OPENAI_API_KEY.");
    }

    const session = new LiveVoiceSession(
        {
            keys: cachedKeys,
            backend: process.env.LIVE_VOICE_BACKEND as any || "auto",
            voiceName: process.env.LIVE_VOICE_NAME,
        },
        llm,
    );

    // Log events
    session.on("event", (event: any) => {
        if (event.type === "tool_call") {
            const calls = event.data as any[];
            console.log(`[LIVE] Tool calls: ${calls.map((c: any) => c.name).join(", ")}`);
        }
    });

    await session.start();
    activeSession = session;

    // Auto-cleanup on session end
    session.on("session_ended", () => {
        if (activeSession === session) {
            activeSession = null;
        }
    });

    return session;
}

/**
 * Stop the active live voice session.
 */
export async function stopLiveVoice(): Promise<void> {
    if (activeSession) {
        await activeSession.stop();
        activeSession = null;
    }
}

/**
 * Get the current active session (if any).
 */
export function getActiveLiveSession(): LiveVoiceSession | null {
    return activeSession;
}

/**
 * Check if live voice is available (API keys configured).
 */
export function isLiveVoiceAvailable(): boolean {
    return !!(cachedKeys?.google || cachedKeys?.openai);
}
