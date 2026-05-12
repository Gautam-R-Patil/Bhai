// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Client-side session token manager.
// Authenticates with Convex HTTP actions using session tokens instead of deploy keys.
// Token is held in memory only — never written to disk.

import { getConvexSiteUrl } from "./config/keys.js";
import { hostname } from "node:os";
import { generateKeyPair, deriveSharedKey, clearCryptoState } from "./crypto-transport.js";
import { KDF_VERSION_LATEST, isSupportedKdfVersion } from "./crypto-kdf.js";

// ── State ─────────────────────────────────────
let _sessionToken: string | null = null;
let _sessionExpiry: number = 0;
let _refreshTimer: NodeJS.Timeout | null = null;

// Refresh 1 hour before expiry to avoid clock skew issues
const REFRESH_BUFFER_MS = 60 * 60 * 1000;

// ── Public API ─────────────────────────────────

/**
 * Get the current session token. If no session exists or it's expired, creates a new one.
 * Returns null if authentication fails (no ATLAS_OTPLESS_USER_ID).
 */
export async function getSessionToken(): Promise<string | null> {
    const userId = process.env.ATLAS_OTPLESS_USER_ID;
    if (!userId) return null;

    // Return cached token if still valid
    if (_sessionToken && _sessionExpiry > Date.now() + REFRESH_BUFFER_MS) {
        return _sessionToken;
    }

    // Try to refresh existing token first
    if (_sessionToken && _sessionExpiry > Date.now()) {
        try {
            await refreshSession();
            return _sessionToken;
        } catch {
            // Token may be revoked, create new
        }
    }

    // Create new session
    await createSession(userId);
    return _sessionToken;
}

/**
 * Get session token synchronously (may be null if not yet created).
 * Use getSessionToken() for the async version that auto-creates.
 */
export function getSessionTokenSync(): string | null {
    if (_sessionToken && _sessionExpiry > Date.now()) {
        return _sessionToken;
    }
    return null;
}

/**
 * Initialize session on startup. Call once during boot.
 */
export async function initSession(): Promise<boolean> {
    const userId = process.env.ATLAS_OTPLESS_USER_ID;
    if (!userId) {
        console.error("[Session] No ATLAS_OTPLESS_USER_ID — cannot create session");
        return false;
    }

    try {
        await createSession(userId);
        startRefreshTimer();
        console.log("[Session] Session initialized successfully");
        return true;
    } catch (err: unknown) {
        console.error("[Session] Failed to create session:", (err as Error).message);
        return false;
    }
}

/**
 * Revoke the current session (logout/shutdown).
 */
export async function revokeCurrentSession(): Promise<void> {
    if (!_sessionToken) return;

    stopRefreshTimer();

    try {
        const convexUrl = getConvexSiteUrl();
        await fetch(`${convexUrl}/api/auth/revoke`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${_sessionToken}`,
                "Content-Type": "application/json",
            },
        });
    } catch {
        // Best-effort revocation
    }

    _sessionToken = null;
    _sessionExpiry = 0;
    clearCryptoState();
}

/**
 * Handle 401 response — re-authenticate and return new token.
 * Call this when an API call returns 401.
 */
export async function handleAuthError(): Promise<string | null> {
    const userId = process.env.ATLAS_OTPLESS_USER_ID;
    if (!userId) return null;

    console.log("[Session] Token expired or invalid, re-authenticating...");
    _sessionToken = null;
    _sessionExpiry = 0;

    try {
        await createSession(userId);
        return _sessionToken;
    } catch (err: unknown) {
        console.error("[Session] Re-authentication failed:", (err as Error).message);
        return null;
    }
}

// ── Internal ───────────────────────────────────

async function createSession(otplessUserId: string): Promise<void> {
    const convexUrl = getConvexSiteUrl();

    // Generate ECDH key pair for E2E encryption
    const clientPublicKey = generateKeyPair();

    const response = await fetch(`${convexUrl}/api/auth/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            otplessUserId,
            deviceFingerprint: getDeviceFingerprint(),
            clientPublicKey,
            // Tell the server which KDF version the client is prepared
            // to use. Server echoes back the version it actually used
            // (older servers ignore this field and default to v1; the
            // client respects whatever the server echoes). See
            // crypto-kdf.ts for the version ↔ algorithm mapping.
            kdfVersion: KDF_VERSION_LATEST,
        }),
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(`Session creation failed (${response.status}): ${(error as any).error}`);
    }

    const data = (await response.json()) as {
        token: string;
        expiresAt: number;
        serverPublicKey?: string;
        kdfVersion?: number;
    };
    _sessionToken = data.token;
    _sessionExpiry = data.expiresAt;

    // Derive shared AES-256 key from server's public key. The client only
    // honours the latest supported KDF (HKDF v2). v1 (raw SHA256-concat)
    // is refused outright — `deriveSharedKey` throws if the version isn't
    // KDF_VERSION_LATEST. This closes a downgrade vector where a coerced
    // or man-in-the-middled bootstrap response (the bootstrap is plaintext
    // by necessity — it's establishing the key) could push the client
    // back onto the weaker KDF. If the server hasn't been redeployed with
    // HKDF support, every login fails loudly here rather than silently
    // running on weaker crypto.
    if (data.serverPublicKey) {
        if (!isSupportedKdfVersion(data.kdfVersion)) {
            throw new Error(
                "Server did not echo kdfVersion in /api/auth/session response — refusing to derive a shared key under an unknown algorithm. Update Convex deploy.",
            );
        }
        deriveSharedKey(data.serverPublicKey, data.kdfVersion);
        console.log(
            `[Session] E2E encryption established (ECDH + AES-256-GCM, KDF v${data.kdfVersion})`,
        );
    }
}

async function refreshSession(): Promise<void> {
    if (!_sessionToken) throw new Error("No session to refresh");

    const convexUrl = getConvexSiteUrl();
    const response = await fetch(`${convexUrl}/api/auth/refresh`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${_sessionToken}`,
            "Content-Type": "application/json",
        },
    });

    if (!response.ok) {
        throw new Error(`Session refresh failed: ${response.status}`);
    }

    const data = await response.json() as { expiresAt: number };
    _sessionExpiry = data.expiresAt;
}

function startRefreshTimer(): void {
    stopRefreshTimer();

    // Refresh every 12 hours (well within 24h TTL)
    const REFRESH_INTERVAL = 12 * 60 * 60 * 1000;

    _refreshTimer = setInterval(async () => {
        try {
            if (_sessionToken) {
                await refreshSession();
                console.log("[Session] Token refreshed successfully");
            }
        } catch {
            // Will re-create on next getSessionToken() call
            console.warn("[Session] Token refresh failed, will re-create on next use");
        }
    }, REFRESH_INTERVAL);
    _refreshTimer.unref?.();
}

function stopRefreshTimer(): void {
    if (_refreshTimer) {
        clearInterval(_refreshTimer);
        _refreshTimer = null;
    }
}

function getDeviceFingerprint(): string {
    const platform = process.platform;
    const host = hostname();
    const user = process.env.USER || process.env.USERNAME || "unknown";
    return `${platform}:${host}:${user}`;
}
