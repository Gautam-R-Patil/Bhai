// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Pure tileModel(state, name) helper for the Ready Hub tiles. Returns
// {label, value, secondary?, status, onClickRoute} — or null if the
// tile should not render on this platform/state.
(function () {
    "use strict";

    const TILE_ORDER = ["account", "workspace", "hotkey", "voice", "persona", "permissions", "overlay", "google", "channels", "theme", "wakeWord"];

    function tileModel(state, name) {
        const s = state || {};
        switch (name) {
            case "account": {
                const a = s.account || {};
                if (!a.signedIn) {
                    return { label: "Account", value: "Not signed in", status: "amber", onClickRoute: "settings:account" };
                }
                const plan = a.plan || "free";
                const credits = typeof a.credits === "number" ? a.credits : 0;
                return {
                    label: "Account",
                    value: a.email || "signed in",
                    secondary: plan + " \u00B7 " + credits + " credits",
                    status: "green",
                    onClickRoute: "settings:account",
                };
            }
            case "overlay": {
                const h = s.hotkey || {};
                return { label: "Overlay", value: h.current || "Alt+Space", status: "green", onClickRoute: "wizard:hotkey" };
            }
            case "hotkey": {
                const pz = s.personalize || {};
                const h  = s.hotkey || {};
                return {
                    label: "Hotkey",
                    value: pz.hotkey || h.current || (s.platform === "win32" ? "Ctrl+Space" : "Alt+Space"),
                    status: "green",
                    onClickRoute: "settings:hotkey",
                };
            }
            case "workspace": {
                const w = s.workspace || {};
                const path = w.path || null;
                if (path) {
                    // Show only the trailing folder for readability.
                    const parts = String(path).split(/[\\/]/);
                    const tail = parts[parts.length - 1] || path;
                    return { label: "Workspace", value: tail, secondary: path, status: w.exists === false ? "amber" : "green", onClickRoute: "settings:workspace" };
                }
                return { label: "Workspace", value: "Default", status: "neutral", onClickRoute: "settings:workspace" };
            }
            case "persona": {
                const persona = s.profile && s.profile.persona;
                return {
                    label: "Persona",
                    value: persona ? (persona.charAt(0).toUpperCase() + persona.slice(1)) : "Explorer",
                    secondary: persona ? null : "Pick a shape in Settings",
                    status: persona ? "ok" : "neutral",
                    onClickRoute: persona ? null : "wizard:persona", // W2 wires this up
                };
            }
            case "permissions": {
                if (s.platform !== "darwin") return null;
                const p = s.permissions || {};
                const keys = ["accessibility", "screen", "microphone", "location"];
                let granted = 0;
                for (const k of keys) { if (p[k] === "granted") granted += 1; }
                const status = granted === 4 ? "green" : "amber";
                return { label: "Permissions", value: granted + " of 4 granted", status: status, onClickRoute: "wizard:permissions" };
            }
            case "google": {
                const g = s.google || {};
                if (g.connected) {
                    return { label: "Google", value: g.email || "connected", secondary: "Calendar + Gmail", status: "green", onClickRoute: "settings:google" };
                }
                return { label: "Google", value: "Not connected", status: "neutral", onClickRoute: "settings:google" };
            }
            case "channels": {
                const c = s.channels || {};
                let n = 0;
                for (const key of Object.keys(c)) {
                    if (c[key] && c[key].connected) n += 1;
                }
                return {
                    label: "Channels",
                    value: n > 0 ? (n + " connected") : "+ Add channel",
                    status: n > 0 ? "green" : "neutral",
                    onClickRoute: "channels",
                };
            }
            case "voice": {
                const v = s.voice || {};
                if (v.name) {
                    return { label: "Voice", value: v.name, secondary: v.backend || "", status: "green", onClickRoute: "settings:voice" };
                }
                return { label: "Voice", value: "Decide later", status: "neutral", onClickRoute: "settings:voice" };
            }
            case "theme": {
                return { label: "Theme", value: s.theme || "system", status: "green", onClickRoute: "settings:theme" };
            }
            case "wakeWord": {
                const w = s.wakeWord || {};
                if (w.enabled) {
                    return { label: "Wake word", value: w.phrase || "Hey Bhai", status: "green", onClickRoute: "settings:wake" };
                }
                return { label: "Wake word", value: "Off", status: "neutral", onClickRoute: "settings:wake" };
            }
            default:
                return null;
        }
    }

    const api = { tileModel: tileModel, TILE_ORDER: TILE_ORDER };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined") window.TileModel = api;
})();
