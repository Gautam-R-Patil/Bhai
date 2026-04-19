// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
//
// Pure-logic detection probes. Each takes injected dependencies so it can be
// unit-tested without Electron or the real filesystem. The orchestrator in
// ./index.js wires the real fs/electron APIs and applies a timeout wrapper.
//
// Privacy: probes NEVER return credential or token contents. They report
// presence/absence, or an email extracted from a filename.

"use strict";

const path = require("path");

function detectPlatform(proc) {
    const p = proc && proc.platform;
    if (p === "darwin" || p === "win32" || p === "linux") return p;
    return "linux";
}

function detectSetupFlag(fs, setupFlagPath) {
    try { return !!fs.existsSync(setupFlagPath); } catch { return false; }
}

function detectEnvPresent(fs, envPath) {
    // Presence-only. We do NOT read, parse, or return the file content here.
    try { return !!fs.existsSync(envPath); } catch { return false; }
}

async function detectGoogleTokens(fs, tokenDir) {
    try {
        if (!fs.existsSync(tokenDir)) return { connected: false };
        const entries = await fs.promises.readdir(tokenDir);
        const tokens = entries.filter((n) => n.endsWith(".json") && !n.startsWith("."));
        if (tokens.length === 0) return { connected: false };
        // Filename convention: <email>.json — only expose email if it actually looks like one.
        const stem = tokens[0].replace(/\.json$/, "");
        return /@/.test(stem) ? { connected: true, email: stem } : { connected: true };
    } catch {
        return { connected: false };
    }
}

function detectOtplessSession(prefs) {
    const acct = prefs && prefs.account;
    if (!acct || !acct.signedIn) return { signedIn: false };
    // Falsy expiresAt (0, null, undefined) → treated as "no expiry stored", not "expired at epoch".
    if (acct.expiresAt && typeof acct.expiresAt === "number" && acct.expiresAt < Date.now()) {
        return { signedIn: false };
    }
    const out = { signedIn: true };
    if (acct.email) out.email = acct.email;
    if (acct.plan) out.plan = acct.plan;
    if (typeof acct.credits === "number") out.credits = acct.credits;
    return out;
}

async function detectNodeInstalled(execFn) {
    try {
        const res = await execFn("node --version");
        const stdout = (res && res.stdout) || "";
        const m = stdout.match(/v(\d+)\.(\d+)\.(\d+)/);
        if (!m) return false;
        return parseInt(m[1], 10) >= 20;
    } catch {
        return false;
    }
}

function detectPlaywrightChromium(fs, botDir) {
    try {
        const p = path.join(botDir, "node_modules", "playwright-core", ".local-browsers");
        return !!fs.existsSync(p);
    } catch {
        return false;
    }
}

async function detectEmbeddingModel(fs, homeDir) {
    try {
        const cacheDir = path.join(homeDir, ".cache", "huggingface", "transformers");
        if (!fs.existsSync(cacheDir)) return false;
        const entries = await fs.promises.readdir(cacheDir);
        return entries.some((n) => /MiniLM/i.test(n));
    } catch {
        return false;
    }
}

function detectMacPermissions(systemPreferences) {
    const normalize = (raw) => {
        if (raw === "granted") return "granted";
        if (raw === "denied" || raw === "restricted") return "denied";
        return "unknown";
    };
    try {
        const acc = systemPreferences.isTrustedAccessibilityClient
            ? systemPreferences.isTrustedAccessibilityClient(false)
            : false;
        return {
            accessibility: acc ? "granted" : "unknown",
            screen: normalize(systemPreferences.getMediaAccessStatus("screen")),
            microphone: normalize(systemPreferences.getMediaAccessStatus("microphone")),
            location: normalize(systemPreferences.getMediaAccessStatus("location")),
        };
    } catch {
        return { accessibility: "unknown", screen: "unknown", microphone: "unknown", location: "unknown" };
    }
}

function detectTheme(nativeTheme) {
    return nativeTheme && nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

function detectWorkspace(fs, workspacePath) {
    let exists = false;
    try { exists = !!fs.existsSync(workspacePath); } catch { exists = false; }
    return { path: workspacePath, exists };
}

function detectHotkeyConflict(globalShortcut, combo) {
    const conflicts = [];
    let registered = false;
    try {
        registered = globalShortcut.register(combo, () => {});
        if (!registered) {
            conflicts.push(`${combo} is already registered by another application`);
        }
    } catch (err) {
        conflicts.push(`Hotkey probe failed for ${combo}: ${err.message || err}`);
    } finally {
        if (registered) {
            try { globalShortcut.unregister(combo); } catch { /* best-effort cleanup */ }
        }
    }
    return conflicts;
}

function detectAppVersion(fs, currentVersion, storedVersionPath) {
    try {
        if (!fs.existsSync(storedVersionPath)) return { current: currentVersion };
        const raw = fs.readFileSync(storedVersionPath, "utf8") || "";
        const parsed = JSON.parse(raw || "{}");
        if (parsed && parsed.version && parsed.version !== currentVersion) {
            return { current: currentVersion, previous: parsed.version };
        }
        return { current: currentVersion };
    } catch {
        return { current: currentVersion };
    }
}

// ── Channel probes ─────────────────────────────────
function detectTelegram(envObj) {
    const e = envObj || {};
    if (e.TELEGRAM_BOT_TOKEN && e.ALLOWED_USER_IDS) return { connected: true };
    return undefined;
}

function detectDiscord(envObj) {
    if (envObj && envObj.DISCORD_BOT_TOKEN) return { connected: true };
    return undefined;
}

async function detectSlack(fs, slackInstallsDir) {
    try {
        if (!fs.existsSync(slackInstallsDir)) return undefined;
        const entries = await fs.promises.readdir(slackInstallsDir);
        const files = entries.filter((n) => n.endsWith(".json") && !n.startsWith("."));
        if (files.length === 0) return undefined;
        try {
            const raw = await fs.promises.readFile(path.join(slackInstallsDir, files[0]), "utf8");
            const parsed = JSON.parse(raw);
            const name = (parsed && parsed.team && parsed.team.name) || files[0].replace(/\.json$/, "");
            return { connected: true, workspace: name };
        } catch {
            return { connected: true, workspace: files[0].replace(/\.json$/, "") };
        }
    } catch {
        return undefined;
    }
}

async function detectWhatsApp(fs, ownersFile) {
    try {
        if (!fs.existsSync(ownersFile)) return undefined;
        const raw = await fs.promises.readFile(ownersFile, "utf8");
        const parsed = JSON.parse(raw || "[]");
        if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
        const first = parsed[0];
        const owner = (first && (first.jid || first.id)) || "unknown";
        return { connected: true, owner };
    } catch {
        return undefined;
    }
}

function detectMatrix(envObj) {
    const e = envObj || {};
    if (e.MATRIX_HOMESERVER && e.MATRIX_ACCESS_TOKEN) {
        return { connected: true, homeserver: e.MATRIX_HOMESERVER };
    }
    return undefined;
}

function detectEmail(envObj) {
    const e = envObj || {};
    if (e.EMAIL_USER && e.EMAIL_PASSWORD) {
        return { connected: true, address: e.EMAIL_USER };
    }
    return undefined;
}

// ── Phase E additions ──────────────────────────────
function detectOsUserName(os) {
    try {
        const info = os.userInfo();
        return (info && info.username) || "";
    } catch {
        return "";
    }
}

function detectPersonalize(prefs, platform) {
    const defaults = {
        hotkey: platform === "win32" ? "Ctrl+Space" : "Alt+Space",
        theme: "system",
        voice: { backend: "gemini-live", name: "Aoede" },
        wakeWord: { enabled: false, phrase: "Hey Atlas" },
    };
    const stored = (prefs && prefs.personalize) || {};
    return {
        hotkey: stored.hotkey || defaults.hotkey,
        theme: stored.theme || defaults.theme,
        voice: stored.voice
            ? { backend: stored.voice.backend || defaults.voice.backend, name: stored.voice.name || defaults.voice.name }
            : defaults.voice,
        wakeWord: stored.wakeWord
            ? { enabled: !!stored.wakeWord.enabled, phrase: stored.wakeWord.phrase || defaults.wakeWord.phrase }
            : defaults.wakeWord,
    };
}

module.exports = {
    detectPlatform,
    detectSetupFlag,
    detectEnvPresent,
    detectGoogleTokens,
    detectOtplessSession,
    detectNodeInstalled,
    detectPlaywrightChromium,
    detectEmbeddingModel,
    detectMacPermissions,
    detectTheme,
    detectWorkspace,
    detectHotkeyConflict,
    detectAppVersion,
    detectTelegram,
    detectDiscord,
    detectSlack,
    detectWhatsApp,
    detectMatrix,
    detectEmail,
    detectOsUserName,
    detectPersonalize,
};
