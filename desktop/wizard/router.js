// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Pure CommonJS — shared main+renderer.
// Browser: attaches to window.WizardRouter. Main process: required from main.js.
"use strict";

// Order note: signin + permissions intentionally come AFTER install — the user
// completes setup/installation first, then signs in and grants permissions right
// before the Ready Hub. install has no dependency on either. (There is no
// vision-tier step: every install gets the same light desktop-control setup.)
// First run is three screens: sign in (terms inline) → connect Chrome (setup
// installs in the background meanwhile) → the Ready Hub (permissions live there).
// Name, persona, hotkey, theme and voice have defaults and live in Settings.
const ALL_STEPS = ["signin", "connect"];

// Bump when the legal documents (Terms / Privacy / Acceptable Use / Disclaimer /
// Refund) materially change. Users whose stored acceptance.version is older
// will be re-prompted to re-accept on next launch — including on reconfigure.
//
// 2.0.0 — Trust surface rewritten to per-document clickwrap with unchecked
//         boxes, links to the canonical https://tryatlasagi.com/legal hub,
//         separate age/authority consent, and document URLs recorded in the
//         audit record. 1.0.0 accepters re-confirm against the new surface.
const CURRENT_ACCEPTANCE_VERSION = "2.0.0";

function needsTerms(s) {
    const legal = s && s.legal;
    if (!legal || legal.accepted !== true) return true;
    if (legal.version !== CURRENT_ACCEPTANCE_VERSION) return true;
    return false;
}

function getSteps(state) {
    const s = state || {};
    const header = s.isReconfigure ? "Reconfigure" : "Welcome";
    const out = [];
    const signedIn = s.account && s.account.signedIn;

    // Sign-in carries the terms clickwrap, so it shows when either is missing.
    if (!signedIn || needsTerms(s)) out.push("signin");
    out.push("connect");
    return { steps: out, header };
}

function next(i, s) { return (i + 1 < s.length ? i + 1 : -1); }
function prev(i) { return (i - 1 >= 0 ? i - 1 : -1); }

const api = { getSteps, next, prev, ALL_STEPS, CURRENT_ACCEPTANCE_VERSION, needsTerms };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.WizardRouter = api;
