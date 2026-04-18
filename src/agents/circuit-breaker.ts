// Copyright (c) 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── 3-State Circuit Breaker with No-Progress Detection ──────────
// Monitors the agent loop for consecutive failures, stalled progress,
// and time-based no-progress. States:
//   CLOSED  -> normal operation
//   OPEN    -> tripped, agent should stop and notify user
//   HALF-OPEN -> one probe attempt allowed after cooldown

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreaker {
    state: CircuitState;
    failureCount: number;
    noProgressCount: number;
    lastProgressAt: number;
    consecutiveNoProgress: number;
    /** Timestamp when the breaker was tripped to OPEN */
    openedAt: number;
    /** Number of times the breaker has tripped (for escalating cooldown) */
    tripCount: number;
    /** Whether the half-open probe has been consumed this cycle */
    halfOpenProbeUsed: boolean;
}

// ── Thresholds ──────────────────────────────────
const MAX_CONSECUTIVE_FAILURES = 5;
const MAX_CONSECUTIVE_NO_PROGRESS = 8;
const NO_PROGRESS_TIMEOUT_MS = 3 * 60_000; // 3 minutes
const INITIAL_COOLDOWN_MS = 30_000;         // 30 seconds before half-open
const ESCALATED_COOLDOWN_MS = 60_000;       // 60 seconds after half-open failure

/**
 * Create a fresh circuit breaker in CLOSED state.
 */
export function createCircuitBreaker(): CircuitBreaker {
    return {
        state: "closed",
        failureCount: 0,
        noProgressCount: 0,
        lastProgressAt: Date.now(),
        consecutiveNoProgress: 0,
        openedAt: 0,
        tripCount: 0,
        halfOpenProbeUsed: false,
    };
}

/**
 * Record meaningful progress — resets all failure/no-progress counters.
 * Called when the agent produces useful output or successfully completes tool calls.
 */
export function recordProgress(cb: CircuitBreaker): void {
    cb.lastProgressAt = Date.now();
    cb.failureCount = 0;
    cb.noProgressCount = 0;
    cb.consecutiveNoProgress = 0;

    // If we were in HALF-OPEN and the probe succeeded, transition back to CLOSED
    if (cb.state === "half-open") {
        cb.state = "closed";
        cb.halfOpenProbeUsed = false;
        cb.tripCount = 0; // Reset trip count on successful recovery
        console.log(`  [CIRCUIT-BREAKER] Half-open probe succeeded -- back to CLOSED`);
    }
}

/**
 * Record a failure (LLM error, tool crash, etc.).
 * Increments failure counter; does NOT reset no-progress.
 */
export function recordFailure(cb: CircuitBreaker): void {
    cb.failureCount++;

    // If we were in HALF-OPEN and the probe failed, go back to OPEN with escalated cooldown
    if (cb.state === "half-open") {
        cb.state = "open";
        cb.openedAt = Date.now();
        cb.halfOpenProbeUsed = false;
        cb.tripCount++;
        console.log(`  [CIRCUIT-BREAKER] Half-open probe FAILED -- back to OPEN (trip #${cb.tripCount}, ${ESCALATED_COOLDOWN_MS / 1000}s cooldown)`);
    }
}

/**
 * Record a no-progress iteration (empty response, unhelpful output).
 * Increments consecutive no-progress counter.
 */
export function recordNoProgress(cb: CircuitBreaker): void {
    cb.noProgressCount++;
    cb.consecutiveNoProgress++;
}

/**
 * Check whether the circuit breaker should trip to OPEN.
 * Returns { trip, reason } -- if trip is true, the caller should notify the user.
 */
export function shouldTrip(cb: CircuitBreaker): { trip: boolean; reason: string } {
    // Already open or half-open: don't re-trip
    if (cb.state === "open" || cb.state === "half-open") {
        return { trip: true, reason: `Circuit breaker is ${cb.state}` };
    }

    // Check consecutive failures
    if (cb.failureCount >= MAX_CONSECUTIVE_FAILURES) {
        cb.state = "open";
        cb.openedAt = Date.now();
        cb.tripCount++;
        const reason = `${cb.failureCount} consecutive failures (threshold: ${MAX_CONSECUTIVE_FAILURES})`;
        console.log(`  [CIRCUIT-BREAKER] TRIPPED: ${reason}`);
        return { trip: true, reason };
    }

    // Check consecutive no-progress iterations
    if (cb.consecutiveNoProgress >= MAX_CONSECUTIVE_NO_PROGRESS) {
        cb.state = "open";
        cb.openedAt = Date.now();
        cb.tripCount++;
        const reason = `${cb.consecutiveNoProgress} consecutive no-progress iterations (threshold: ${MAX_CONSECUTIVE_NO_PROGRESS})`;
        console.log(`  [CIRCUIT-BREAKER] TRIPPED: ${reason}`);
        return { trip: true, reason };
    }

    // Check time-based no-progress
    const timeSinceProgress = Date.now() - cb.lastProgressAt;
    if (timeSinceProgress >= NO_PROGRESS_TIMEOUT_MS) {
        cb.state = "open";
        cb.openedAt = Date.now();
        cb.tripCount++;
        const reason = `No progress for ${(timeSinceProgress / 1000).toFixed(0)}s (threshold: ${NO_PROGRESS_TIMEOUT_MS / 1000}s)`;
        console.log(`  [CIRCUIT-BREAKER] TRIPPED: ${reason}`);
        return { trip: true, reason };
    }

    return { trip: false, reason: "" };
}

/**
 * Attempt to transition from OPEN to HALF-OPEN after cooldown.
 * Returns true if the caller is allowed to make one probe attempt
 * with the highest-tier model.
 */
export function tryHalfOpen(cb: CircuitBreaker): boolean {
    if (cb.state !== "open") return false;

    // Determine cooldown based on trip count
    const cooldown = cb.tripCount > 1 ? ESCALATED_COOLDOWN_MS : INITIAL_COOLDOWN_MS;
    const elapsed = Date.now() - cb.openedAt;

    if (elapsed >= cooldown) {
        cb.state = "half-open";
        cb.halfOpenProbeUsed = true;
        console.log(`  [CIRCUIT-BREAKER] Transitioning to HALF-OPEN after ${(elapsed / 1000).toFixed(0)}s cooldown`);
        return true;
    }

    return false;
}

/**
 * Get a human-readable status message for the circuit breaker.
 * Used to notify the user when the breaker trips.
 */
export function getStatusMessage(cb: CircuitBreaker): string {
    if (cb.state === "closed") {
        return "Circuit breaker: CLOSED (normal operation)";
    }

    if (cb.state === "open") {
        const cooldown = cb.tripCount > 1 ? ESCALATED_COOLDOWN_MS : INITIAL_COOLDOWN_MS;
        const elapsed = Date.now() - cb.openedAt;
        const remaining = Math.max(0, cooldown - elapsed);
        return `Circuit breaker: OPEN -- The agent appears to be stuck or experiencing repeated failures. ` +
            `Will retry in ${(remaining / 1000).toFixed(0)}s. You can cancel this task if needed.`;
    }

    return "Circuit breaker: HALF-OPEN -- Making one probe attempt with the best available model.";
}

/**
 * Force-reset the breaker to CLOSED (e.g. user explicitly continues).
 */
export function resetCircuitBreaker(cb: CircuitBreaker): void {
    cb.state = "closed";
    cb.failureCount = 0;
    cb.noProgressCount = 0;
    cb.consecutiveNoProgress = 0;
    cb.lastProgressAt = Date.now();
    cb.openedAt = 0;
    cb.tripCount = 0;
    cb.halfOpenProbeUsed = false;
}
