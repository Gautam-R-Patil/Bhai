// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Magic Moment ranker — maps an AppSnapshot + persona + best-effort signals
// into a small ordered list of MagicMomentSignal observations. Pure
// function; no IPC, no DOM. Consumed by desktop/components/magic-moment.js.
//
// Patterns are ordered by specificity (most specific first); the first
// matching cluster wins, then weaker signals (persona, time-of-day,
// monitor count, etc.) round out the list up to 4 entries.
"use strict";

/* AppSnapshot.names is lowercased. These helpers do substring-match
   so "google chrome" and "chrome" both count as chrome. */
function hasAny(names, needles) {
    for (const need of needles) {
        for (const n of names) {
            if (n.indexOf(need) >= 0) return true;
        }
    }
    return false;
}

function hasAll(names, needles) {
    for (const need of needles) {
        let ok = false;
        for (const n of names) {
            if (n.indexOf(need) >= 0) { ok = true; break; }
        }
        if (!ok) return false;
    }
    return true;
}

/* Clusters in priority order. Each emits at most one observation. */
const CLUSTERS = [
    {
        id: "dev-cluster",
        match: function (names) {
            return hasAny(names, ["cursor", "visual studio code", "vscode", "code", "terminal", "iterm", "alacritty"])
                && hasAny(names, ["chrome", "firefox", "safari", "arc", "brave"]);
        },
        signal: {
            observation: "Looks like you're building something.",
            followup: "I'll prioritize code, terminal, and git context.",
            confidence: 0.9,
            source: "running-apps",
        },
    },
    {
        id: "creator-cluster",
        match: function (names) {
            return hasAny(names, [
                "figma", "photoshop", "premiere", "davinci", "ableton",
                "logic", "final cut", "after effects", "blender", "procreate",
            ]);
        },
        signal: {
            observation: "Creative tools open. I can keep references organized.",
            followup: "Drop a link or asset anytime — I'll file it.",
            confidence: 0.85,
            source: "running-apps",
        },
    },
    {
        id: "coord-cluster",
        match: function (names) {
            return hasAny(names, ["slack", "notion", "linear", "asana", "jira"])
                && hasAny(names, ["calendar", "gmail", "outlook", "mail"]);
        },
        signal: {
            observation: "You're in coordination mode.",
            followup: "I'll watch your calendar and surface what needs a decision.",
            confidence: 0.85,
            source: "running-apps",
        },
    },
    {
        id: "research-cluster",
        match: function (names) {
            return hasAny(names, ["zotero", "obsidian", "notion", "logseq"])
                && hasAny(names, ["chrome", "firefox", "safari", "arc", "brave"]);
        },
        signal: {
            observation: "Sources on screen. I can chase the citations.",
            followup: "Tell me what you're investigating and I'll widen the net.",
            confidence: 0.8,
            source: "running-apps",
        },
    },
    {
        id: "comm-cluster",
        match: function (names) {
            return hasAny(names, ["slack", "discord", "telegram", "whatsapp", "messages"]);
        },
        signal: {
            observation: "Lots of channels open.",
            followup: "I can summarize the noise so you don't have to scroll.",
            confidence: 0.65,
            source: "running-apps",
        },
    },
];

/* Generic fallback — always last, always one signal. */
const AMBIENT_SIGNAL = {
    id: "ambient",
    observation: "Workspace mapped. Ready when you are.",
    followup: "Talk to me however feels right — I'll learn.",
    confidence: 0.5,
    source: "ambient",
};

/* Persona-aware fillers — added after the cluster match (or after
   the ambient signal) to deepen the rotation. Each persona maps to a
   single line; explorer is empty so we don't double-tip. */
const PERSONA_LINES = {
    developer:   { observation: "I'll prioritize codebase context.",     followup: "Ask 'explain this codebase' any time.",     source: "ambient", confidence: 0.6 },
    founder:     { observation: "I'll watch your calendar and inbox.",   followup: "Say 'prep me for my 10am' any time.",       source: "ambient", confidence: 0.6 },
    creator:     { observation: "I'll keep references organized.",        followup: "Drop a link and I'll file it.",             source: "ambient", confidence: 0.6 },
    researcher:  { observation: "I'll chase citations for you.",          followup: "Say 'find the strongest sources on X'.",    source: "ambient", confidence: 0.6 },
    explorer:    null,
};

/* Time-of-day signals. */
function timeSignal(hourOfDay) {
    if (hourOfDay === "late-night") {
        return {
            observation: "Late-night session. I'll keep things minimal.",
            followup:    "Voice off by default. Hotkey-quiet mode.",
            confidence: 0.55,
            source: "ambient",
        };
    }
    if (hourOfDay === "morning") {
        return {
            observation: "Fresh start. Want me to brief the day?",
            followup:    "Calendar, inbox, what's overdue — in under ninety seconds.",
            confidence: 0.6,
            source: "ambient",
        };
    }
    return null;
}

/* Main entry — returns up to 4 observations. */
function rankSignals(state) {
    const snapshot = (state && state.snapshot) || { names: [] };
    const persona = (state && state.persona) || null;
    const hourOfDay = (state && state.hourOfDay) || null;
    const monitorCount = (state && state.monitorCount) || 0;

    const out = [];

    // First: highest-priority cluster (if any).
    for (const cluster of CLUSTERS) {
        if (cluster.match(snapshot.names)) {
            out.push(Object.assign({ id: cluster.id }, cluster.signal));
            break;
        }
    }

    // If no cluster matched, lead with ambient.
    if (out.length === 0) {
        out.push(AMBIENT_SIGNAL);
    }

    // Persona-aware filler (skip explorer).
    if (persona && PERSONA_LINES[persona]) {
        out.push(Object.assign({ id: "persona-" + persona }, PERSONA_LINES[persona]));
    }

    // Time-of-day signal.
    const ts = timeSignal(hourOfDay);
    if (ts) out.push(Object.assign({ id: "tod-" + hourOfDay }, ts));

    // Monitor count, if multi-monitor.
    if (monitorCount >= 2) {
        out.push({
            id: "monitors",
            observation: monitorCount + " monitors detected. I'll spread out when I need to.",
            followup:    "Drag me to whichever screen feels right.",
            confidence: 0.55,
            source: "ambient",
        });
    }

    return out.slice(0, 4);
}

const api = { rankSignals, _internals: { CLUSTERS, AMBIENT_SIGNAL, PERSONA_LINES, hasAny, hasAll, timeSignal } };
if (typeof window !== "undefined") window.MagicMomentRanker = api;
if (typeof module !== "undefined" && module.exports) module.exports = api;
