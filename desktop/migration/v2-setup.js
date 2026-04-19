// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// v1 → v2 migration for existing A.T.L.A.S installs. Runs once at app boot
// BEFORE the wizard gate. Tasks:
//   - Tag prefs with {"setup-version": 2}
//   - Preserve legacy v1 profile fields (age, gender) — new wizard collects
//     name + tone only, but we don't want to lose data on upgrade.
//   - Seed a setup-state.json with phase done-markers so the new installer's
//     resume logic sees "nothing left to do" on a v1 machine.
//   - Idempotent: safe to call multiple times.
"use strict";

const fs = require("fs");
const path = require("path");

function migrateLegacySetup(prefs) {
    if (prefs && prefs["setup-version"] === 2) return prefs;
    const out = Object.assign({}, prefs || {});
    out["setup-version"] = 2;
    out.profile = Object.assign({}, out.profile || {});
    out.channels = out.channels || {};
    out.permissions = out.permissions || {
        accessibility: "unknown",
        screen: "unknown",
        microphone: "unknown",
        location: "unknown",
    };
    return out;
}

async function runMigrationIfNeeded(opts) {
    const { userDataDir, setupFlagPath, loadEnvDecrypted, log } = opts || {};
    const logFn = typeof log === "function" ? log : function () {};

    if (!userDataDir || !setupFlagPath) {
        logFn("runMigrationIfNeeded: missing userDataDir or setupFlagPath — skipping");
        return { ran: false, reason: "missing-paths" };
    }
    if (!fs.existsSync(setupFlagPath)) {
        return { ran: false, reason: "no-setup-flag" };
    }

    const prefsPath = path.join(userDataDir, "prefs.json");
    const statePath = path.join(userDataDir, "setup-state.json");
    let prefs = {};
    try { prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8")); }
    catch { prefs = {}; }

    if (prefs["setup-version"] === 2) return { ran: false, reason: "already-v2" };

    const next = migrateLegacySetup(prefs);

    // Best-effort env decrypt — just to surface any env-key rotation problems early.
    if (typeof loadEnvDecrypted === "function") {
        try { loadEnvDecrypted(); }
        catch (err) { logFn("env decrypt warn: " + (err.message || err)); }
    }

    // Seed setup-state.json with all phases complete so the new installer
    // (runner.js) doesn't try to re-install anything on a v1 machine.
    if (!fs.existsSync(statePath)) {
        const now = new Date().toISOString();
        const allPhases = ["node", "playwright-chromium", "embedding-model", "sox", "data-dir", "workspace", "setup-state-finalize"];
        const seeded = { __version: 2, __finalizedAt: now };
        for (const id of allPhases) seeded[id] = { completedAt: now, durationMs: 0 };
        fs.writeFileSync(statePath, JSON.stringify(seeded, null, 2));
    }

    fs.writeFileSync(prefsPath, JSON.stringify(next, null, 2));
    logFn("migrated v1 → v2 setup prefs");
    return { ran: true };
}

module.exports = { migrateLegacySetup, runMigrationIfNeeded };
