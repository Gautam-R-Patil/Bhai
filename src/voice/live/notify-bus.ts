// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Live Voice Notification Bus ──────────────────
// When the live voice session is active and a background task (swarm,
// long-task, deep research) completes, the result should be SPOKEN by the
// model — not just posted to the overlay. This bridge lets any tool push
// a short text update into the active Gemini Live session, which the model
// will weave into its next turn.
//
// Usage from anywhere:
//   import { notifyLiveVoiceIfActive } from "../voice/live/notify-bus.js";
//   notifyLiveVoiceIfActive("swarm finished the PPT: <link>");

import { getActiveLiveSession } from "./integration.js";

/**
 * Push a short update into the active live voice session. Returns true if
 * the session was active and the message was sent, false otherwise.
 *
 * The message is delivered as a synthetic user turn (`sendClientContent`),
 * prefixed with a marker so the model treats it as an ATLAS-internal status
 * update rather than direct user speech.
 */
export function notifyLiveVoiceIfActive(text: string): boolean {
    if (!text || !text.trim()) return false;
    const session = getActiveLiveSession();
    if (!session?.isActive) return false;
    // Don't inject while a tool is in-flight — Gemini Live treats realtime
    // text as user speech and may cancel the pending tool call. Wait one
    // tick; if the call finishes, the session prompt already instructs
    // Gemini to surface async updates, so a few ms of delay is safe.
    if (session.hasToolsInFlight) {
        setTimeout(() => notifyLiveVoiceIfActive(text), 400);
        return false;
    }
    try {
        // Prefix makes the provenance obvious to the model so it speaks
        // the result casually instead of reading the raw payload verbatim.
        session.sendTextInput(
            `[BHAI SYSTEM — background task update, speak this to the user conversationally]\n${text}`,
        );
        return true;
    } catch {
        return false;
    }
}
