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
    // to <DATA_DIR>/atlas-account.enc; nothing ever writes prefs.account in
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

/**
 * Detect the maximum vision-nav tier the system can run.
 *
 *   lite     — AX-only.        Works everywhere. ~0 GB extra disk.
 *   standard — AX + OmniParser. Needs ≥ 8 GB RAM, Python + ~0.5 GB disk.
 *   full     — AX + OmniParser + UI-TARS-1.5-7B local grounding.
 *              Needs Apple-silicon or capable GPU + ≥ 12 GB RAM + ~6 GB disk.
 *
 * Returns { max, ramGB, gpuClass, platform } so the wizard can grey out cards
 * the system can't run and show a clear "needs more RAM" hint.
 */
function detectVisionTier(osMod, procMod) {
    try {
        const totalBytes = (osMod && osMod.totalmem && osMod.totalmem()) || 0;
        const ramGB = Math.round((totalBytes / (1024 ** 3)) * 10) / 10;
        const platform = (procMod && procMod.platform) || process.platform;
        const arch = (procMod && procMod.arch) || process.arch;
        let gpuClass = "none";
        if (platform === "darwin" && arch === "arm64") gpuClass = "apple-silicon";
        else if (platform === "linux" || platform === "win32") gpuClass = "unknown";

        let max = "lite";
        if (ramGB >= 8) max = "standard";
        if (ramGB >= 12 && (gpuClass === "apple-silicon" || (gpuClass === "unknown" && ramGB >= 16))) {
            max = "full";
        }
        return { max, ramGB, gpuClass, platform };
    } catch {
        return { max: "lite", ramGB: 0, gpuClass: "unknown", platform: process.platform };
    }
}

/**
 * Detect which optional vision-nav deps are already installed so the wizard
 * doesn't re-download them. Async because the OmniParser probe shells out to
 * `python3 -c "import ultralytics, PIL"` and the UI-TARS probe queries
 * `ollama list` (covers custom registries that a hardcoded manifest path
 * misses). `execFn` is the async exec helper from buildDetectionDeps — caller
 * wraps this in withTimeout so a stuck binary can't stall boot.
 *
 * Subprocess probes run in PARALLEL via Promise.all so a single timeout budget
 * isn't burned on serial waits (cold-disk python3 import can take 1-2s alone).
 */
async function detectVisionDeps(fsMod, execFn, homeDir) {
    const out = { ollama: false, uiTarsModel: false, omniparser: false };

    // (1) Ollama: binary present on disk (sync, cheap)
    try {
        const candidates = [
            "/opt/homebrew/bin/ollama",
            "/usr/local/bin/ollama",
            "/usr/bin/ollama",
            homeDir ? `${homeDir}\\AppData\\Local\\Programs\\Ollama\\ollama.exe` : null,
        ].filter(Boolean);
        for (const c of candidates) {
            if (fsMod && fsMod.existsSync && fsMod.existsSync(c)) {
                out.ollama = true;
                break;
            }
        }
    } catch { /* ignore */ }

    // (2) + (3): UI-TARS model probe + OmniParser probe in PARALLEL.
    // Track whether the live UI-TARS probe actually reached the daemon. The
    // offline manifest fallback must ONLY run when the daemon was unreachable —
    // not when `ollama show` explicitly determined the manifest is corrupt.
    let liveProbeRan = false;
    const probes = [];
    if (out.ollama && typeof execFn === "function") {
        probes.push((async () => {
            try {
                const r = await execFn("ollama list");
                liveProbeRan = true;
                const stdout = (r && (r.stdout || "")).toString();
                const hasTag = /\bui-tars[:-](?:1\.5-)?7b\b/.test(stdout);
                const isIncomplete = /\bui-tars[:-](?:1\.5-)?7b\b[^\n]*\(incomplete\)/i.test(stdout);
                if (hasTag && !isIncomplete) {
                    // Double-check with `ollama show` — confirms the manifest is
                    // readable, not just listed. Cheap (~50ms) and definitive.
                    try {
                        await execFn("ollama show ui-tars:7b");
                        out.uiTarsModel = true;
                    } catch { /* manifest corrupt — leave false; fallback must NOT override */ }
                }
            } catch { /* daemon down — liveProbeRan stays false */ }
        })());
    }
    if (typeof execFn === "function") {
        probes.push((async () => {
            // Prefer the wizard's venv python (~/Library/.../atlas-desktop/python-venv).
            // PEP 668 forbids system-level pip installs on Homebrew Python 3.11+,
            // so the wizard puts ultralytics+Pillow in a venv. If the venv path
            // doesn't exist yet (first install / legacy install), fall through
            // to system python3 to support users who installed deps manually.
            const path = require("path");
            const dataDir = process.env.ATLAS_DATA_DIR || path.resolve("data");
            const venvPy = process.platform === "win32"
                ? path.join(dataDir, "python-venv", "Scripts", "python.exe")
                : path.join(dataDir, "python-venv", "bin", "python");
            const candidates = [venvPy, process.platform === "win32" ? "python" : "python3"];
            for (const py of candidates) {
                try {
                    if (py !== "python" && py !== "python3" && !(fsMod && fsMod.existsSync && fsMod.existsSync(py))) continue;
                    await execFn(`"${py}" -c "import ultralytics, PIL"`);
                    out.omniparser = true;
                    return;
                } catch { /* try next */ }
            }
        })());
    }
    await Promise.all(probes);

    // (2b) Offline manifest fallback for UI-TARS. Only runs when the live
    // probe didn't reach the daemon (i.e., daemon was down). When the live
    // probe ran but found the model corrupt or absent, that verdict stands —
    // overriding it from the filesystem check would mask a broken manifest.
    if (!out.uiTarsModel && !liveProbeRan) {
        try {
            if (homeDir && fsMod && fsMod.existsSync) {
                const dir = `${homeDir}/.ollama/models/manifests/registry.ollama.ai/library/ui-tars`;
                if (fsMod.existsSync(dir) && fsMod.readdirSync) {
                    const entries = fsMod.readdirSync(dir);
                    if (entries.some((e) => e === "7b" || e === "1.5-7b")) out.uiTarsModel = true;
                }
            }
        } catch { /* ignore */ }
    }

    return out;
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
    detectVisionTier,
    detectVisionDeps,
};
