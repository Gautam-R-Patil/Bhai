// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Builds the "Already set" chip row shown at the top of each wizard step.
// Pure function of SystemState; each chip is {id, label, value, stepTarget}.
"use strict";

const CHIP_ORDER = [
    "account", "google",
    "telegram", "discord", "slack", "whatsapp", "matrix", "email",
    "workspace", "hotkey", "theme", "voice",
];

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function buildChips(state) {
    const s = state || {};
    const ch = s.channels || {};
    const p = s.personalize || {};
    const out = [];
    const push = function (id, label, value, stepTarget) {
        out.push({
            id: String(id),
            label: String(label),
            value: String(value == null ? "" : value),
            stepTarget: String(stepTarget),
        });
    };

    if (s.account && s.account.signedIn) {
        push("account", "Account", s.account.email || "signed in", "signin");
    }
    if (s.google && s.google.connected) {
        push("google", "Google", s.google.email || "connected", "step:manage-google");
    }
    for (const k of ["telegram", "discord", "slack", "whatsapp", "matrix", "email"]) {
        if (ch[k] && ch[k].connected) {
            push(k, capitalize(k), "connected", "step:manage-" + k);
        }
    }
    if (s.workspace && s.workspace.path) {
        push("workspace", "Workspace", s.workspace.path, "install");
    }
    if (p.hotkey) {
        push("hotkey", "Hotkey", p.hotkey, "personalize");
    }
    if (p.theme) {
        push("theme", "Theme", p.theme, "personalize");
    }
    if (p.voice && p.voice.name) {
        const backend = p.voice.backend || "";
        const name = p.voice.name;
        push("voice", "Voice", backend ? (backend + " \u00b7 " + name) : name, "personalize");
    }

    out.sort(function (a, b) { return CHIP_ORDER.indexOf(a.id) - CHIP_ORDER.indexOf(b.id); });
    return out;
}

const api = { buildChips: buildChips, CHIP_ORDER: CHIP_ORDER };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.WizardChips = api;
