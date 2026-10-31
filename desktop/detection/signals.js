// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
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

function detectLegalAcceptance(fs, legalAcceptancePath) {
    try {
        if (!fs.existsSync(legalAcceptancePath)) return { accepted: false };
        // Defence-in-depth: refuse to follow a symlink. The acceptance file
        // is created by the install wizard and lives inside userData; if it
        // is ever a symlink, treat that as tampered and fail closed.
        const lst = fs.lstatSync(legalAcceptancePath);
        if (lst.isSymbolicLink()) return { accepted: false };
        if (!lst.isFile()) return { accepted: false };
        // Hard cap on size — a legitimate record is < 2 KB.
        if (lst.size > 65536) return { accepted: false };
        const raw = fs.readFileSync(legalAcceptancePath, "utf8");
        const data = JSON.parse(raw);
        if (!data || typeof data !== "object" || Array.isArray(data)) return { accepted: false };
        if (data.accepted !== true) return { accepted: false };
        return {
            accepted: true,
            acceptedAt: typeof data.acceptedAt === "string" ? data.acceptedAt : null,
            version: typeof data.version === "string" ? data.version : null,
        };
    } catch { return { accepted: false }; }
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

function detectOtplessSession(prefs, sessionFromFile) {
    // Two sources of truth, prefer the file-based one. saveAccountSession writes
    // to <DATA_DIR>/bhai-account.enc; nothing ever writes prefs.account in
    // electron-store, so reading prefs.account alone makes signin
    // mis-skip-or-re-prompt depending on which way the bug fires. The caller
    // passes the decrypted file contents (or null) so this function stays pure.
    if (sessionFromFile && sessionFromFile.userId && !/^(phone_|google_)/.test(sessionFromFile.userId)) {
        const out = { signedIn: true };
        if (sessionFromFile.email) out.email = sessionFromFile.email;
        if (sessionFromFile.phone) out.phone = sessionFromFile.phone;
        if (sessionFromFile.name) out.name = sessionFromFile.name;
        return out;
    }
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
    // Electron's getMediaAccessStatus returns "not-determined" for apps that have
    // never invoked the matching OS API, even when the user has manually granted
    // the permission in System Settings. We treat "not-determined" as "unknown"
    // (not "denied") so the UI doesn't falsely claim a denial.
    const normalize = (raw) => {
        if (raw === "granted") return "granted";
        if (raw === "denied" || raw === "restricted") return "denied";
        return "unknown"; // not-determined or unrecognized
    };
    try {
        // Accessibility: isTrustedAccessibilityClient returns boolean — granted/denied
        // (no "not-determined" — either the app is in the list or it isn't).
        const acc = systemPreferences.isTrustedAccessibilityClient
            ? systemPreferences.isTrustedAccessibilityClient(false)
            : false;

        // Microphone: supported media type on macOS.
        let mic = "unknown";
        try { mic = normalize(systemPreferences.getMediaAccessStatus("microphone")); } catch {}

        // Screen Recording: "screen" is the Electron media type on macOS 10.15+.
        let screen = "unknown";
        try { screen = normalize(systemPreferences.getMediaAccessStatus("screen")); } catch {}

        // Location: getMediaAccessStatus does NOT support "location". We call the
        // dedicated API when available, or fall back to "unknown" so the UI shows
        // "Not set" rather than a false denial.
        let loc = "unknown";
        try {
            if (typeof systemPreferences.getUserDefault === "function") {
                // macOS stores the CoreLocation authorization in a user-default.
                // Values: 0 = notDetermined, 1 = restricted, 2 = denied,
                // 3/4 = authorizedAlways / authorizedWhenInUse.
                const raw = systemPreferences.getUserDefault("LocationServicesEnabled", "boolean");
                if (raw === true) loc = "granted";
            }
        } catch {}

        return {
            accessibility: acc ? "granted" : "denied",
            screen: screen,
            microphone: mic,
            location: loc,
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

// ── Windows permission detection ──────────────────
/**
 * Detect Windows permission states via registry CapabilityAccessManager checks.
 * Returns "granted", "denied", or "unknown" for each permission.
 * The execFn parameter is accepted for API consistency but unused — we call
 * execSync directly so this stays synchronous (matching detectMacPermissions).
 */
function detectWindowsPermissions(_execFn) {
    const result = {
        accessibility: "granted", // Windows does not require explicit accessibility permission
        screen: "granted",        // Windows does not require screen recording permission
        microphone: "unknown",
        location: "unknown",
    };

    try {
        // Check microphone privacy setting via CapabilityAccessManager consent store.
        // Key: HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone
        // Value "Allow" = granted; "Deny" = denied.
        const micOut = require("node:child_process").execSync(
            'reg query "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone" /v Value 2>nul',
            { timeout: 2000, encoding: "utf8" },
        );
        if (micOut.includes("Allow")) result.microphone = "granted";
        else if (micOut.includes("Deny")) result.microphone = "denied";
    } catch {
        result.microphone = "unknown";
    }

    try {
        // Check location privacy setting via CapabilityAccessManager consent store.
        // Key: HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\location
        // Value "Allow" = granted; "Deny" = denied.
        const locOut = require("node:child_process").execSync(
            'reg query "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\location" /v Value 2>nul',
            { timeout: 2000, encoding: "utf8" },
        );
        if (locOut.includes("Allow")) result.location = "granted";
        else if (locOut.includes("Deny")) result.location = "denied";
    } catch {
        result.location = "unknown";
    }

    return result;
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
        wakeWord: { enabled: false, phrase: "Hey Bhai" },
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
        // Pass the saved tone through so the wizard (reconfigure) shows it.
        personality: stored.personality || undefined,
    };
}

module.exports = {
    detectPlatform,
    detectSetupFlag,
    detectLegalAcceptance,
    detectEnvPresent,
    detectGoogleTokens,
    detectOtplessSession,
    detectNodeInstalled,
    detectPlaywrightChromium,
    detectEmbeddingModel,
    detectMacPermissions,
    detectWindowsPermissions,
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
