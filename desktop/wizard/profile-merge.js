// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Pure merge helper for the wizard's Profile step. Validates required fields,
// preserves legacy v1 fields (age, gender, extra) so a v1-profile.json can be
// upgraded without data loss, and normalizes tone to the allowed set.
"use strict";

const ALLOWED_TONES = ["friendly", "professional", "playful"];

function mergeProfile(existing, update) {
    const rawName = update && update.name ? String(update.name) : "";
    const name = rawName.trim();
    if (!name) throw new Error("Profile name is required");
    const rawTone = update && update.tone ? String(update.tone) : "friendly";
    const tone = ALLOWED_TONES.indexOf(rawTone) >= 0 ? rawTone : "friendly";
    return Object.assign({}, existing || {}, { name: name, tone: tone });
}

module.exports = { mergeProfile, ALLOWED_TONES };
