// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Network Health Monitor ───────────────────────
// Detects offline/degraded state, notifies the user, and prevents wasted
// network retries when the internet is down. Subsystems (heartbeat, research,
// proactive messages, LLM client) check isOnline() before making calls.

import { getConvexSiteUrl } from "./config/keys.js";

// ── Types ────────────────────────────────────────

export type NetworkStatus = "online" | "degraded" | "offline";

interface StatusChangeEvent {
    prev: NetworkStatus;
    next: NetworkStatus;
    timestamp: number;
}

type StatusListener = (event: StatusChangeEvent) => void;

// ── Constants ────────────────────────────────────

const CHECK_INTERVAL_MS = 45_000;          // Passive check interval (45s)
const HEALTH_ENDPOINT_TIMEOUT_MS = 8_000;  // Timeout for health ping (8s)
const OFFLINE_THRESHOLD = 3;               // Consecutive failures to declare offline
const DEGRADED_THRESHOLD = 1;              // Failures for degraded
const RECOVERY_CHECK_INTERVAL_MS = 15_000; // Faster checks when trying to recover (15s)
const MIN_CHECK_GAP_MS = 5_000;            // Don't check more often than every 5s

// ── State ────────────────────────────────────────

let _status: NetworkStatus = "online";
let _consecutiveFailures = 0;
let _lastCheckTime = 0;
let _lastOnlineTime = Date.now();
let _checkTimer: NodeJS.Timeout | null = null;
let _recoveryTimer: NodeJS.Timeout | null = null;
const _listeners: StatusListener[] = [];
let _userNotified = false;  // Avoid spamming notifications

// ── Quick Connectivity Check ─────────────────────
// Pings the Convex backend health endpoint (fast, lightweight)

async function checkConnectivity(): Promise<boolean> {
    try {
        const url = `${getConvexSiteUrl()}/api/health`;
        const response = await fetch(url, {
            method: "HEAD",
            signal: AbortSignal.timeout(HEALTH_ENDPOINT_TIMEOUT_MS),
        });
        return response.ok || response.status === 404; // 404 means server is up, just no route
    } catch {
        // Also try a DNS-only check as fallback
        try {
            await fetch("https://1.1.1.1/cdn-cgi/trace", {
                method: "HEAD",
                signal: AbortSignal.timeout(5000),
            });
            return true; // Internet works, maybe just Convex is down
        } catch {
            return false; // Truly offline
        }
    }
}

// ── Core Check Logic ─────────────────────────────

async function performCheck(): Promise<NetworkStatus> {
    const now = Date.now();
    if (now - _lastCheckTime < MIN_CHECK_GAP_MS) {
        return _status; // Too soon, return cached status
    }
    _lastCheckTime = now;

    const isConnected = await checkConnectivity();

    if (isConnected) {
        _consecutiveFailures = 0;
        _lastOnlineTime = now;
        return "online";
    } else {
        _consecutiveFailures++;
        if (_consecutiveFailures >= OFFLINE_THRESHOLD) {
            return "offline";
        } else if (_consecutiveFailures >= DEGRADED_THRESHOLD) {
            return "degraded";
        }
        return _status; // Keep current status on first failure
    }
}

function setStatus(newStatus: NetworkStatus): void {
    if (newStatus === _status) return;

    const event: StatusChangeEvent = {
        prev: _status,
        next: newStatus,
        timestamp: Date.now(),
    };

    const prev = _status;
    _status = newStatus;

    // Log state transition
    if (newStatus === "offline") {
        console.error(`[NETWORK] ❌ Internet connection LOST — suppressing network operations`);
        startRecoveryPolling();
    } else if (newStatus === "degraded") {
        console.warn(`[NETWORK] ⚠️ Internet connection degraded (${_consecutiveFailures} failures)`);
    } else if (newStatus === "online" && prev !== "online") {
        const downtime = Math.round((Date.now() - _lastOnlineTime) / 1000);
        console.log(`[NETWORK] ✅ Internet connection restored (was down for ~${downtime}s)`);
        _userNotified = false; // Reset notification flag for next outage
        stopRecoveryPolling();
    }

    // Notify listeners
    for (const listener of _listeners) {
        try { listener(event); } catch { /* */ }
    }
}

// ── Recovery Polling ─────────────────────────────
// When offline, check more frequently so we can resume quickly

function startRecoveryPolling(): void {
    if (_recoveryTimer) return;
    _recoveryTimer = setInterval(async () => {
        const newStatus = await performCheck();
        setStatus(newStatus);
    }, RECOVERY_CHECK_INTERVAL_MS);
}

function stopRecoveryPolling(): void {
    if (_recoveryTimer) {
        clearInterval(_recoveryTimer);
        _recoveryTimer = null;
    }
}

// ── Public API ───────────────────────────────────

/** Start the periodic health monitor */
export function startNetworkMonitor(): void {
    if (_checkTimer) return; // Already running

    // Initial check
    performCheck().then(status => setStatus(status));

    _checkTimer = setInterval(async () => {
        const newStatus = await performCheck();
        setStatus(newStatus);
    }, CHECK_INTERVAL_MS);
}

/** Stop the monitor */
export function stopNetworkMonitor(): void {
    if (_checkTimer) {
        clearInterval(_checkTimer);
        _checkTimer = null;
    }
    stopRecoveryPolling();
}

/** Quick check — returns cached status (no network call). Use before any network operation. */
export function isOnline(): boolean {
    return _status === "online";
}

/** Returns true if network is definitely down */
export function isOffline(): boolean {
    return _status === "offline";
}

/** Get current network status */
export function getNetworkStatus(): NetworkStatus {
    return _status;
}

/** Get seconds since last successful connectivity */
export function getSecondsSinceOnline(): number {
    return Math.round((Date.now() - _lastOnlineTime) / 1000);
}

/** Force an immediate check (e.g., after a network error in LLM client) */
export async function reportNetworkError(): Promise<NetworkStatus> {
    const newStatus = await performCheck();
    setStatus(newStatus);
    return newStatus;
}

/** Report a successful network call — resets failure counter */
export function reportNetworkSuccess(): void {
    if (_consecutiveFailures > 0 || _status !== "online") {
        _consecutiveFailures = 0;
        _lastOnlineTime = Date.now();
        setStatus("online");
    }
}

/** Register a listener for status changes */
export function onNetworkStatusChange(listener: StatusListener): void {
    _listeners.push(listener);
}

/** Check if user has been notified about current outage (to avoid spam) */
export function shouldNotifyUser(): boolean {
    if (_status !== "offline") return false;
    if (_userNotified) return false;
    _userNotified = true;
    return true;
}

/** Build a user-friendly notification message about network status */
export function getOfflineNotificationMessage(): string {
    const downtime = getSecondsSinceOnline();
    if (downtime < 60) {
        return "Your internet connection seems to be down. I'll keep trying and let you know when it's back.";
    } else {
        const mins = Math.round(downtime / 60);
        return `Internet has been down for ~${mins} minute${mins > 1 ? 's' : ''}. I've paused background tasks to save resources. I'll resume automatically when connectivity returns.`;
    }
}

/** Build the recovery notification */
export function getOnlineNotificationMessage(): string {
    return "Internet connection restored — resuming normal operations.";
}
