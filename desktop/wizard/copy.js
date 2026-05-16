// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Single source of truth for every user-visible string in the wizard.
// Step renderers MUST read through Copy.get(stepId, key). Inline literals
// in step files are a review-blocking finding.
//
// Wrapped in an IIFE so local `const COPY` / `const api` don't collide with
// identically-named globals in other top-level wizard modules (chips.js,
// cinematic.js) when this file is loaded as a classic <script>.
(function () {
"use strict";

const COPY = {
    "awakening": {
        // Greeting is built dynamically in steps/awakening.js (per-word reveal).
        // These are the rotating status phrases.
        "status1": "reading the room",
        "status2": "setting the table",
        "status3": "ready when you are",
        "cta": "Begin",
        "hint": "Press ESC to skip",
    },

    "terms": {
        "eyebrow": "Trust",
        "title": "Read once. We won't ask again.",
        "sub": "A short set of terms covering what A.T.L.A.S can do, what it stores, and how to back out.",
        "accept": "Accept",
        "check1": "I accept the Terms of service",
        "check2": "I accept the Privacy policy",
        "check3": "I accept the Acceptable use policy",
        "check4": "I accept the Disclaimer",
        "check5": "I accept the Refund terms",
    },

    "signin": {
        "eyebrow": "Identity",
        "title": "Make this yours.",
        "sub": "One tap to sync preferences and credits across your devices. No password to remember.",
        "email_cta": "Continue with email",
        "phone_cta": "Continue with phone",
        "fineprint": "You can sign in later from Settings.",
    },

    "profile": {
        "eyebrow": "You",
        "title": "What should I call you?",
        "sub": "Used in greetings and when I get your attention. You can change it anytime in Settings.",
        "label": "Your name",
        "placeholder": "Dheeraj",
    },

    "persona": {
        "eyebrow": "How you work",
        "title": "Pick a starting shape.",
        "sub": "Shapes the examples I show, the tools I prioritize, and the way I talk. You can change this anytime.",

        // Developer
        "developer_title":  "Developer",
        "developer_desc":   "Terminal-first. Code-aware. Speaks git.",
        "developer_cap_1":  "Codebase memory across sessions",
        "developer_cap_2":  "Shell + IDE awareness",
        "developer_cap_3":  "Debug, review, and ship faster",

        // Founder
        "founder_title":    "Founder",
        "founder_desc":     "Calendar, comms, decisions. Move fast.",
        "founder_cap_1":    "Meeting summaries + decision log",
        "founder_cap_2":    "Calendar + email orchestration",
        "founder_cap_3":    "Research → decision in minutes",

        // Creator
        "creator_title":    "Creator",
        "creator_desc":     "Ideas, media, drafts. Make things.",
        "creator_cap_1":    "References + mood organized",
        "creator_cap_2":    "Script + caption generation",
        "creator_cap_3":    "Asset corral across tools",

        // Researcher
        "researcher_title": "Researcher",
        "researcher_desc":  "Sources, citations, synthesis.",
        "researcher_cap_1": "Deep research across 500+ sources",
        "researcher_cap_2": "Credibility-scored citations",
        "researcher_cap_3": "Hypothesis tracking",

        // Explorer — the no-bias option
        "explorer_title":   "Explorer",
        "explorer_desc":    "Not sure yet — I'll learn as we go.",
        "explorer_cap_1":   "No bias applied",
        "explorer_cap_2":   "Adapts from your behavior",
        "explorer_cap_3":   "You can pick a path later",
    },

    "personalize": {
        "eyebrow": "Ritual",
        "title": "How A.T.L.A.S shows up.",
        "sub": "Small choices that shape every interaction — what summons it, how it sounds, the mood.",
        "label_hotkey": "Summon gesture",
        "label_theme": "Appearance",
        "label_voice": "Voice",
        "label_personality": "Tone",
        "label_wake": "Wake word",
        "wake_toggle": "Listen for a wake word",
        "wake_phrase_label": "Phrase",
    },

    "permissions": {
        "eyebrow": "Capabilities",
        "title": "Unlock what I can do.",
        "sub": "Each one is a capability, not a checkbox. Grant whatever feels right — you can revisit anytime.",
        "footnote": "Skipped a permission? No worries. We can still work together.",
        "skip_all": "Skip all",
        "name_accessibility": "Accessibility",
        "why_accessibility":  "So I can be summoned, anywhere.",
        "name_screen":        "Screen",
        "why_screen":         "So I can see what you see.",
        "name_microphone":    "Microphone",
        "why_microphone":     "So I can hear you naturally.",
        "name_location":      "Location",
        "why_location":       "So I remember where you are.",
    },

    "vision-tier": {
        "eyebrow": "Sight",
        "title": "How sharp should my eyes be?",
        "sub": "On-device vision lets me see your screen and reason about UI. Heavier tiers see more but take longer to install.",
        "tier_lite_name":     "Lite",
        "tier_lite_tag":      "Snappy",
        "tier_lite_desc":     "I'll read the text on your screen — enough to answer questions about what's there and act on the things I can identify by name. Runs anywhere.",
        "tier_standard_name": "Standard",
        "tier_standard_tag":  "Recommended",
        "tier_standard_desc": "I'll also understand layouts — which thing is a button, where the form is, what belongs to what. Smoother on most apps.",
        "tier_full_name":     "Full",
        "tier_full_tag":      "Heavy",
        "tier_full_desc":     "I'll see your screen pixel-precise — every icon, every widget, dense dashboards, custom interfaces. Most accurate. Needs a recent machine.",
    },

    "install": {
        "eyebrow": "Assembly",
        "title": "Setting things up.",
        "fact_eyebrow": "Did you know",
        // Phase labels (mapped to existing PHASE_IDS in steps/install.js)
        "phase_node":         "Core runtime",
        "phase_playwright":   "Browser awareness",
        "phase_embedding":    "Memory layer",
        "phase_sox":          "Hearing",
        "phase_ollama":       "On-device thinking",
        "phase_vision_model": "Sight",
        "phase_vision_deps":  "Sharper sight",
        "phase_data_dir":     "Personal vault",
        "phase_workspace":    "Workspace",
        "phase_finalize":     "Final touches",
        // ETA strings
        "eta_estimating":   "Estimating…",
        "eta_almost_done":  "Almost done",
    },

    "ready-hub": {
        "magic_eyebrow": "I noticed something",
        "try_heading":   "Try this",
        "launch":        "Launch A.T.L.A.S",
        "talk":          "Talk",
        "type":          "Type",
        // Title + dek are built dynamically from name + hotkey in ready-hub-body.js
    },
};

function get(stepId, key) {
    const step = COPY[stepId];
    if (!step) return null;
    const val = step[key];
    return val == null ? null : val;
}

const api = { get: get, _COPY: COPY };
if (typeof window !== "undefined") window.Copy = api;
if (typeof module !== "undefined" && module.exports) module.exports = { Copy: api, get: get };
})();
