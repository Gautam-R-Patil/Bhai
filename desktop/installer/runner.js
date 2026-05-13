// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Sequential phase runner with resume + paused states.
// Writes per-phase markers to <DATA_DIR>/setup-state.json so a crash-and-reopen
// can skip already-completed phases via getResumeList().
// redactSecrets() is applied to every log line so tokens never hit the install-log UI.
"use strict";

const path = require("path");
const fs = require("fs");

// Redaction patterns. Each matches a known secret shape and replaces it with ***.
// KEY=value patterns keep the key and redact the value so the log still communicates
// "we wrote the telegram token" without spilling it.
const SECRET_PATTERNS = [
    // KEY=value forms (case-insensitive key, token-like value)
    /TELEGRAM_BOT_TOKEN\s*=\s*\S+/gi,
    /DISCORD_BOT_TOKEN\s*=\s*\S+/gi,
    /MATRIX_ACCESS_TOKEN\s*=\s*\S+/gi,
    /EMAIL_PASSWORD\s*=\s*\S+/gi,
    /SLACK_CLIENT_SECRET\s*=\s*\S+/gi,
    /OLLAMA_API_KEY\s*=\s*\S+/gi,
    /HF_TOKEN\s*=\s*\S+/gi,
    /OPENAI_API_KEY\s*=\s*\S+/gi,
    /ANTHROPIC_API_KEY\s*=\s*\S+/gi,
    // Standalone Telegram bot token shape: <digits>:<35+ base64-url chars>
    /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g,
    // "Bot <token>" HTTP header form
    /\b[Bb]ot\s+[A-Za-z0-9._-]{30,}/g,
    // URL-embedded credentials: https://user:pass@host  (pip --extra-index-url etc)
    /\bhttps?:\/\/[^:/\s@]+:[^@/\s]+@/g,
];

function redactSecrets(line) {
    if (line == null) return "";
    let out = String(line);
    for (const re of SECRET_PATTERNS) {
        out = out.replace(re, function (match) {
            if (match.indexOf("=") >= 0) {
                const eq = match.indexOf("=");
                return match.slice(0, eq + 1) + "***";
            }
            if (/^bot\s/i.test(match)) return match.replace(/(\s+).*$/, "$1***");
            // URL-embedded credentials: keep scheme + host, redact user:pass.
            const urlAuth = match.match(/^(https?:\/\/)([^:/\s@]+):([^@/\s]+)@/);
            if (urlAuth) return urlAuth[1] + urlAuth[2] + ":***@";
            return "***";
        });
    }
    return out;
}

function setupStatePath(dataDir) { return path.join(dataDir, "setup-state.json"); }

function readSetupState(dataDir) {
    try { return JSON.parse(fs.readFileSync(setupStatePath(dataDir), "utf8")); }
    catch { return {}; }
}

function writeSetupState(dataDir, state) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(setupStatePath(dataDir), JSON.stringify(state, null, 2));
}

function getResumeList(phaseList, state) {
    const s = state || {};
    return phaseList.filter(function (p) {
        const marker = s[p.id];
        return !(marker && marker.completedAt);
    });
}

async function runPhases(phaseList, ctx) {
    const total = phaseList.length;
    const state = readSetupState(ctx.DATA_DIR);
    const log = function (msg) {
        if (ctx.sendLog) ctx.sendLog(redactSecrets(msg));
    };
    for (let i = 0; i < total; i++) {
        const ph = phaseList[i];
        if (ctx.sendProgress) {
            // Send the phase ID so the UI doesn't depend on label-string parity.
            // Old format was "Running: <label>" which broke whenever phases.js
            // and install.js labels drifted (e.g. "Audio toolkit (sox)" vs
            // "Audio toolkit") — the UI's reverse-label-lookup silently failed
            // and the spinner stuck on the previous phase.
            ctx.sendProgress(Math.floor((i / total) * 100), "Running: id=" + ph.id);
        }
        const t0 = Date.now();
        try {
            await ph.run(ctx, log);
            state[ph.id] = { completedAt: new Date().toISOString(), durationMs: Date.now() - t0 };
            try { writeSetupState(ctx.DATA_DIR, state); } catch (persistErr) {
                // Disk full or perms error during marker persist. Log it but
                // continue — the phase itself succeeded, so we'd rather report
                // success and lose the marker than fail the whole install.
                log("Warning: could not persist setup-state.json (" + (persistErr && persistErr.message) + ")");
            }
        } catch (err) {
            // Persist anything that did complete so a subsequent resume works.
            // Wrap in try/catch — disk-full here must not double-fault and
            // produce an unhandled rejection that hides the original error.
            try { writeSetupState(ctx.DATA_DIR, state); } catch { /* best-effort */ }
            if (ctx.sendProgress) ctx.sendProgress(-1, "Paused at " + ph.label);
            log("ERROR in phase " + ph.id + ": " + (err && err.message ? err.message : String(err)));
            return {
                status: "paused",
                failedPhase: { id: ph.id, label: ph.label },
                error: { message: err && err.message ? err.message : String(err), stack: err && err.stack ? err.stack : null },
                completed: Object.keys(state).filter(function (k) { return !k.startsWith("__"); }),
            };
        }
    }
    if (ctx.sendProgress) ctx.sendProgress(100, "Install complete");
    return {
        status: "complete",
        completed: Object.keys(state).filter(function (k) { return !k.startsWith("__"); }),
    };
}

module.exports = { runPhases, getResumeList, readSetupState, writeSetupState, redactSecrets, setupStatePath };
