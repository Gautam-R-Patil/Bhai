// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Pure CommonJS — shared main+renderer.
// Browser: attaches to window.WizardRouter. Main process: required from main.js.
"use strict";

const ALL_STEPS = ["welcome", "signin", "profile", "personalize", "permissions", "install"];

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

function getSteps(state) {
    const s = state || {};
    const header = s.isReconfigure ? "Reconfigure" : "Welcome";
    const out = [];
    const signedIn = s.account && s.account.signedIn;
    if (!s.isReconfigure && !signedIn) out.push("welcome");
    if (!signedIn) out.push("signin");
    if (s.isReconfigure || !(s.profile && s.profile.name && s.profile.tone)) out.push("profile");
    if (s.isReconfigure || needsPersonalize(s)) out.push("personalize");
    if (s.platform !== "win32") {
        const perms = s.permissions || {};
        const all = ["accessibility", "screen", "microphone", "location"].every((k) => perms[k] === "granted");
        if (s.isReconfigure || !all) out.push("permissions");
    }
    if (s.isReconfigure || needsInstall(s)) out.push("install");
    return { steps: out, header };
}

function next(i, s) { return (i + 1 < s.length ? i + 1 : -1); }
function prev(i) { return (i - 1 >= 0 ? i - 1 : -1); }

const api = { getSteps, next, prev, ALL_STEPS };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.WizardRouter = api;
