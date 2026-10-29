// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Pure merge helper for the wizard's Profile + Persona steps. Validates
// required fields, normalizes tone to the allowed set, and (W2) accepts an
// optional persona enum that flows through to the bot's identity store
// via src/setup/wizard-seed.ts.
"use strict";

const ALLOWED_TONES = ["friendly", "professional", "playful"];
const ALLOWED_PERSONAS = ["developer", "founder", "creator", "researcher", "explorer"];

function mergeProfile(existing, update) {
    const rawName = update && update.name ? String(update.name) : "";
    const name = rawName.trim();
    // Persona step submits the existing name unchanged. Only fail if BOTH
    // the update and the existing profile lack a name — otherwise this
    // would block the persona step on a returning user.
    const existingName = existing && typeof existing.name === "string" ? existing.name.trim() : "";
    if (!name && !existingName) throw new Error("Profile name is required");
    const finalName = name || existingName;

    const rawTone = update && update.tone ? String(update.tone) : "friendly";
    const tone = ALLOWED_TONES.indexOf(rawTone) >= 0 ? rawTone : "friendly";

    const out = Object.assign({}, existing || {}, { name: finalName, tone: tone });

    // ── W2: persona / personaConfidence / personaSelectedAt ──
    // Validated against the canonical enum so a bad payload can't poison
    // runtime tool-router weights. All three fields are additive; if not
    // supplied, existing values are preserved (via Object.assign above).
    if (update && typeof update.persona === "string"
        && ALLOWED_PERSONAS.indexOf(update.persona) >= 0) {
        out.persona = update.persona;
        out.personaConfidence = typeof update.personaConfidence === "number"
            ? Math.max(0, Math.min(1, update.personaConfidence))
            : 1.0;
        out.personaSelectedAt = typeof update.personaSelectedAt === "number"
            ? update.personaSelectedAt
            : Date.now();
    }

    return out;
}

module.exports = { mergeProfile, ALLOWED_TONES, ALLOWED_PERSONAS };
