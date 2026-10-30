// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Account guard — validates account status and credits via Convex HTTP proxy.
// Credits are deducted server-side atomically with each LLM call.
// This module only checks whether the account is allowed to proceed.

import { getSessionToken } from "./session.js";
import { getConvexSiteUrl } from "./config/keys.js";
import { encryptedFetch } from "./crypto-transport.js";
import { claudeTier } from "./model-router.js";

// ── State ──────────────────────────────────────
let lastKnownCredits: number | null = null;
let lastCheckTime = 0;
let consecutiveErrors = 0;
const STALE_CACHE_MS = 60_000; // Trust cache for up to 60s during network issues
const MAX_ERRORS_BEFORE_BLOCK = 5;
/** The server enforces credits on every LLM call, so a fresh "allowed" needn't be re-fetched each turn. */
const FRESH_ALLOWED_MS = 30_000;
let lastAllowedTime = 0;

// Session credit tracking (local bookkeeping only — server is authoritative)
let sessionCreditsUsed = 0;
let sessionLLMCalls = 0;

// ── Credit Costs (for local display/tracking only) ──
// Mirrors convex/credit_cost.ts: priced by the Claude model a request runs on.
// Server-side proxy has its own copy and handles actual deduction.
const CREDITS_BY_TIER = { haiku: 0.25, sonnet: 1, opus: 2 } as const;

/** Get credit cost for a specific model (local estimate) */
export function getCreditCost(modelId: string): number {
    return CREDITS_BY_TIER[claudeTier(modelId)];
}

/**
 * Track credit usage locally (for session stats display).
 * Actual deduction happens server-side in the HTTP proxy.
 */
export async function deductCredit(modelId?: string, amount?: number): Promise<void> {
    const cost = amount ?? (modelId ? getCreditCost(modelId) : 1);
    sessionCreditsUsed += cost;
    sessionLLMCalls++;

    // Update local estimate
    if (lastKnownCredits !== null) {
        lastKnownCredits = Math.max(0, lastKnownCredits - cost);
    }
}

/** Force flush (no-op now — credits are deducted server-side) */
export async function forceFlushCredits(): Promise<void> {
    // No-op: server-side proxy handles credit deduction atomically
}

/** Get session credit usage stats */
export function getSessionCreditStats(): { creditsUsed: number; llmCalls: number; remaining: number | null } {
    return {
        creditsUsed: sessionCreditsUsed,
        llmCalls: sessionLLMCalls,
        remaining: lastKnownCredits,
    };
}

/** Reset session credit tracking */
export function resetSessionCreditStats(): void {
    sessionCreditsUsed = 0;
    sessionLLMCalls = 0;
}

/** Get current known credit balance (may be stale) */
export function getKnownCreditBalance(): number | null {
    return lastKnownCredits;
}

/**
 * Check whether the account is allowed to proceed.
 * Calls the Convex HTTP proxy's account status endpoint.
 * Fail-closed: if anything goes wrong, block.
 */
export async function checkAccountStatus(): Promise<{ allowed: boolean; reason?: string }> {
    const now = Date.now();
    const userId = process.env.ATLAS_OTPLESS_USER_ID;

    if (!userId) {
        console.log("[AccountGuard] No userId — blocking");
        return { allowed: false, reason: "Not signed in. Please log in through the Bhai app." };
    }

    if (lastKnownCredits !== null && lastKnownCredits > 0 && now - lastAllowedTime < FRESH_ALLOWED_MS) {
        return { allowed: true };
    }

    try {
        const sessionToken = await getSessionToken();
        if (!sessionToken) {
            return { allowed: false, reason: "Could not authenticate. Please restart the app." };
        }

        const convexUrl = getConvexSiteUrl();
        const response = await encryptedFetch(`${convexUrl}/api/account/status`, {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${sessionToken}`,
            },
        });

        if (response.status === 401) {
            return { allowed: false, reason: "Session expired. Please restart the app." };
        }

        if (!response.ok) {
            throw new Error(`Status check failed: ${response.status}`);
        }

        const data = await response.json() as { status: string; plan: string; ai_credits: number };

        // Reset error counter on success
        consecutiveErrors = 0;
        lastCheckTime = now;
        lastKnownCredits = data.ai_credits;

        if (data.status !== "active") {
            console.log(`[AccountGuard] Account status: ${data.status} — blocking`);
            return { allowed: false, reason: `Account is ${data.status}. Contact the XAGI Labs team at hello@xagilab.com.` };
        }

        if (data.ai_credits <= 0) {
            console.log("[AccountGuard] Credits exhausted — blocking");
            return { allowed: false, reason: "You've run out of AI credits. Reach the XAGI Labs team at xagilab.com for more." };
        }

        console.log(`[AccountGuard] Account OK (status: ${data.status}, credits: ${data.ai_credits})`);
        lastAllowedTime = now;
        return { allowed: true };

    } catch (err: unknown) {
        consecutiveErrors++;
        console.warn(`[AccountGuard] Fetch error #${consecutiveErrors}: ${(err as Error).message}`);

        // Stale cache safety net
        const cacheAge = now - lastCheckTime;
        if (
            lastKnownCredits !== null &&
            lastKnownCredits > 0 &&
            cacheAge < STALE_CACHE_MS &&
            consecutiveErrors < MAX_ERRORS_BEFORE_BLOCK
        ) {
            console.log(`[AccountGuard] Using stale cache (age: ${Math.round(cacheAge / 1000)}s, credits: ${lastKnownCredits})`);
            return { allowed: true };
        }

        console.log("[AccountGuard] Failing closed after persistent errors");
        return {
            allowed: false,
            reason: "Could not verify your account. Check your internet connection and try again.",
        };
    }
}

let _initialized = false;

/** Initialize the account guard. Called once at bot startup. */
export async function initAccountGuard(): Promise<void> {
    if (_initialized) return;
    _initialized = true;

    console.log("[AccountGuard] Initializing...");

    const userId = process.env.ATLAS_OTPLESS_USER_ID;
    if (!userId) {
        console.error("[AccountGuard] No ATLAS_OTPLESS_USER_ID — bot cannot start without a signed-in account.");
        setTimeout(() => process.exit(78), 1000); // 78: not allowed to run — the app won't auto-restart
        return;
    }

    const check = await checkAccountStatus();
    if (!check.allowed) {
        console.error(`[AccountGuard] Startup blocked: ${check.reason}`);
        setTimeout(() => process.exit(78), 1000); // 78: not allowed to run — the app won't auto-restart
    } else {
        console.log("[AccountGuard] Startup authorized");
    }
}
