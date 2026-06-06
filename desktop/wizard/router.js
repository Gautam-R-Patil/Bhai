// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Pure CommonJS — shared main+renderer.
// Browser: attaches to window.WizardRouter. Main process: required from main.js.
"use strict";

// Order note: signin + permissions intentionally come AFTER install — the user
// completes setup/installation first, then signs in and grants permissions right
// before the Ready Hub. install has no dependency on either (buildPhaseList only
// needs the vision-tier choice, which still precedes install).
const ALL_STEPS = ["awakening", "welcome", "terms", "profile", "persona", "personalize", "vision-tier", "install", "signin", "permissions"];

function envFlag(name) {
    try { if (typeof process !== "undefined" && process.env && process.env[name] === "true") return true; }
    catch (_) { /* renderer — no process */ }
    return false;
}

function needsAwakening(s) {
    if (envFlag("ATLAS_NO_AWAKENING")) return false;
    if (s && s.isReconfigure) return false;
    if (s && s.account && s.account.signedIn) return false;
    return true;
}

// Bump when the legal documents (Terms / Privacy / Acceptable Use / Disclaimer /
// Refund) materially change. Users whose stored acceptance.version is older
// will be re-prompted to re-accept on next launch — including on reconfigure.
//
// 2.0.0 — Trust surface rewritten to per-document clickwrap with unchecked
//         boxes, links to the canonical https://tryatlasagi.com/legal hub,
//         separate age/authority consent, and document URLs recorded in the
//         audit record. 1.0.0 accepters re-confirm against the new surface.
const CURRENT_ACCEPTANCE_VERSION = "2.0.0";

function needsInstall(s) {
    const i = s.installed || {};
    if (!i.node || !i.playwright || !i.embeddingModel) return true;
    if (s.workspace && s.workspace.path && !s.workspace.exists) return true;
    return !s.setupFinalized;
}

function needsPersonalize(s) {
    if (s.hotkey && (s.hotkey.conflicts || []).length) return true;
    const p = s.personalize;
    return !p || !p.hotkey || !p.theme || !(p.voice && p.voice.backend) || !p.wakeWord;
}

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

    // First-install flow: show every step in order so users see the whole
    // cinematic, even when some state is already satisfied. Reconfigure
    // also shows every step (so chips can deep-link cleanly). The only
    // dynamic gate is awakening (returning users / signed-in skip the
    // cinematic; controlled by needsAwakening).
    if (needsAwakening(s)) out.push("awakening");
    if (needsTerms(s) || s.isReconfigure) out.push("terms");
    out.push("profile");
    out.push("persona");       // ← W2: persona specialization step
    out.push("personalize");
    out.push("vision-tier");
    if (s.isReconfigure || needsInstall(s)) out.push("install");
    // Post-install: sign in (required to finish — no skip) then grant permissions.
    // Permissions are macOS-only; Windows grants at OS level so the step is omitted.
    if (!signedIn || s.isReconfigure) out.push("signin");
    if (s.platform !== "win32") out.push("permissions");
    return { steps: out, header };
}

function needsVisionTierChoice(s) {
    // Show the step ONLY when the user hasn't picked a tier yet. Once they
    // pick, the install step (gated by needsInstall + getResumeList) handles
    // dep installation — including the case where the user quits mid-install
    // and relaunches. Re-prompting the user when their dep happens to be
    // pending creates a UX trap: they may change their mind and orphan the
    // partially-installed dep.
    return !s.visionTierChoice;
}

function next(i, s) { return (i + 1 < s.length ? i + 1 : -1); }
function prev(i) { return (i - 1 >= 0 ? i - 1 : -1); }

const api = { getSteps, next, prev, ALL_STEPS, CURRENT_ACCEPTANCE_VERSION, needsTerms, needsAwakening };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.WizardRouter = api;
