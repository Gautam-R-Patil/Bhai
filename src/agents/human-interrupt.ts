// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Human-in-the-Loop Interrupt System ──────
// Pauses agent execution to request human approval for dangerous
// or sensitive operations. Supports timeout with default action.
// The channel layer (Telegram, overlay, etc.) calls resolveInterrupt()
// when the user responds.

import { randomBytes } from "node:crypto";

// ── Types ────────────────────────────────────

export interface InterruptRequest {
    question: string;
    options?: string[];       // Optional predefined choices
    timeout?: number;         // ms to wait before auto-proceeding (default: 5 min)
    defaultAction?: string;   // What to do if timeout expires
}

export interface InterruptResponse {
    answer: string;
    timedOut: boolean;
}

// ── Pending Interrupt Storage ────────────────

interface PendingInterrupt {
    resolve: (response: InterruptResponse) => void;
    timer: ReturnType<typeof setTimeout>;
    question: string;
    options?: string[];
    createdAt: number;
}

/** Module-level map of pending interrupts. */
const pendingInterrupts = new Map<string, PendingInterrupt>();

// ── Core API ─────────────────────────────────

/**
 * Request human approval/input. Sends the question to the user via
 * notifyFn, then waits for resolveInterrupt() to be called by the
 * channel layer, or times out with the default action.
 */
export async function requestHumanApproval(
    request: InterruptRequest,
    notifyFn: (message: string) => Promise<void>,
): Promise<InterruptResponse> {
    const interruptId = randomBytes(8).toString("hex");
    const timeoutMs = request.timeout ?? 300000; // 5 min default
    const defaultAction = request.defaultAction ?? "Skip";

    return new Promise<InterruptResponse>((resolve) => {
        // Set up timeout — auto-resolve with default action
        const timer = setTimeout(() => {
            pendingInterrupts.delete(interruptId);
            console.log(`  ⏰ Interrupt ${interruptId} timed out — using default: ${defaultAction}`);
            resolve({ answer: defaultAction, timedOut: true });
        }, timeoutMs);

        // Store the pending interrupt
        pendingInterrupts.set(interruptId, {
            resolve,
            timer,
            question: request.question,
            options: request.options,
            createdAt: Date.now(),
        });

        // Notify the user via the channel
        const optionText = request.options
            ? `\nOptions: ${request.options.join(" | ")}`
            : "";
        const timeoutNote = `\n(Auto-${defaultAction.toLowerCase()} in ${Math.round(timeoutMs / 1000)}s)`;

        const message = `🛑 **Approval Required** [id:${interruptId}]\n${request.question}${optionText}${timeoutNote}`;

        notifyFn(message).catch((err) => {
            console.warn(`[INTERRUPT] Failed to notify user:`, (err as Error).message);
        });
    });
}

/**
 * Resolve a pending interrupt. Called by the channel layer (Telegram,
 * overlay, etc.) when the user responds.
 *
 * Returns true if the interrupt was found and resolved, false if it
 * had already timed out or doesn't exist.
 */
export function resolveInterrupt(interruptId: string, answer: string): boolean {
    const pending = pendingInterrupts.get(interruptId);
    if (!pending) return false;

    clearTimeout(pending.timer);
    pendingInterrupts.delete(interruptId);
    console.log(`  ✅ Interrupt ${interruptId} resolved by user: ${answer}`);
    pending.resolve({ answer, timedOut: false });
    return true;
}

/**
 * Get all currently pending interrupts. Useful for the channel layer
 * to check if there are any outstanding approval requests.
 */
export function getPendingInterrupts(): Array<{ id: string; question: string; options?: string[]; createdAt: number }> {
    const result: Array<{ id: string; question: string; options?: string[]; createdAt: number }> = [];
    for (const [id, pending] of pendingInterrupts) {
        result.push({
            id,
            question: pending.question,
            options: pending.options,
            createdAt: pending.createdAt,
        });
    }
    return result;
}

/**
 * Cancel all pending interrupts (e.g., on shutdown or task abort).
 * Each interrupt resolves with the given fallback action.
 */
export function cancelAllInterrupts(fallbackAction = "Cancel"): void {
    for (const [id, pending] of pendingInterrupts) {
        clearTimeout(pending.timer);
        pending.resolve({ answer: fallbackAction, timedOut: true });
    }
    pendingInterrupts.clear();
}
