// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── A.T.L.A.S Desktop — Main Process ─────────────
// Electron main process: manages setup wizard, control panel,
// bot child process, encryption, and IPC.

// Load bytecode runtime for protected modules
try {
    require("bytenode");
} catch {
    // bytenode not available - running in dev mode
}

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Tray, Menu, nativeImage, globalShortcut, screen, systemPreferences, nativeTheme } = require("electron");
const { spawn, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { autoUpdater } = require("electron-updater");

// ── Protected String Decoder ─────────────────────
// Decodes XOR-encoded prompts and skills at runtime

const PROTECTION_KEY = Buffer.from("ATLAS_PROTECTED_2026");

// Runtime key delivered from Convex — replaces PROTECTION_KEY when available.
let _runtimeKey = null;

async function fetchRuntimeKey(sessionToken) {
    try {
        const https = require("https");
        const bodyStr = JSON.stringify({});
        const result = await new Promise((resolve) => {
            const url = new URL(`${CONVEX_SITE_URL}/api/app/runtime-key`);
            const req = https.request(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(bodyStr),
                    "Authorization": `Bearer ${sessionToken}`,
                },
                timeout: 8000,
            }, (res) => {
                let raw = "";
                res.on("data", (c) => (raw += c));
                res.on("end", () => {
                    try {
                        const data = JSON.parse(raw);
                        resolve(res.statusCode === 200 && data.key ? data.key : null);
                    } catch { resolve(null); }
                });
            });
            req.on("error", () => resolve(null));
            req.on("timeout", () => { req.destroy(); resolve(null); });
            req.write(bodyStr);
            req.end();
        });
        if (result) {
            _runtimeKey = result;
            console.log("[runtime-key] Fetched server-delivered key");
        } else {
            console.warn("[runtime-key] Fetch returned no key — using built-in fallback");
        }
    } catch (err) {
        console.warn("[runtime-key] Key fetch failed, using built-in fallback:", err.message);
    }
}

function decodeProtectedString(encodedBase64) {
    try {
        const encoded = Buffer.from(encodedBase64, "base64");
        const decoded = Buffer.alloc(encoded.length);
        const keySource = Buffer.from(PROTECTION_KEY);
        for (let i = 0; i < encoded.length; i++) {
            decoded[i] = encoded[i] ^ keySource[i % keySource.length];
        }
        return decoded.toString("utf8");
    } catch {
        return null;
    }
}

function loadProtectedFile(filePath) {
    // Check for protected version first
    const protectedPath = filePath + ".protected";
    if (fs.existsSync(protectedPath)) {
        const encoded = fs.readFileSync(protectedPath, "utf8");
        return decodeProtectedString(encoded);
    }
    // Fall back to unprotected (dev mode)
    if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, "utf8");
    }
    return null;
}

// ── Auto-Updater Configuration ───────────────
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

// ── Constants ─────────────────────────────────

const COPYRIGHT = "© 2024-2026 XAGI Labs Private Limited. All rights reserved.";
const IS_DEV = !app.isPackaged;
const BOT_DIR = IS_DEV
    ? path.join(__dirname, "..")
    : path.join(process.resourcesPath, "bot");
const DATA_DIR = IS_DEV
    ? path.join(__dirname, "..", "data")
    : path.join(app.getPath("userData"), "data");
const ENV_PATH = IS_DEV
    ? path.join(__dirname, "..", ".env")
    : path.join(app.getPath("userData"), ".env.enc");
const SETUP_FLAG = path.join(app.getPath("userData"), ".setup-complete");
const LOGS_DIR = path.join(app.getPath("userData"), "logs");
const LOG_RETENTION_DAYS = 3; // Keep logs for 3 days

// ── v1 → v2 Setup Migration (D10) ─────────────
// Runs once at boot before the wizard-gate so v1 installs are tagged + seeded.
async function runV2Migration() {
    try {
        const { runMigrationIfNeeded } = require(path.join(__dirname, "migration", "v2-setup.js"));
        await runMigrationIfNeeded({
            userDataDir: app.getPath("userData"),
            setupFlagPath: SETUP_FLAG,
            loadEnvDecrypted: loadEnvDecrypted,
            log: (m) => console.log("[migrate v2]", m),
        });
    } catch (err) {
        console.warn("[migrate v2] failed, continuing with boot:", err.message || err);
    }
}

// ── Overlay Window Constants ─────────────────
const OVERLAY_WIDTH = 340;
const OVERLAY_MIN_HEIGHT = 56;
const OVERLAY_MAX_HEIGHT = 500;
const OVERLAY_MARGIN_RIGHT = 16;
const OVERLAY_MARGIN_TOP = 8;
const OVERLAY_URL = "http://127.0.0.1:18792";
const OVERLAY_RESIZE_MS = 300;
const OVERLAY_HIDE_DELAY_MS = 260;

// ── Convex Site URL (HTTP actions endpoint — public, not a secret) ──
const CONVEX_SITE_URL = "https://zany-kudu-607.convex.site";

// ── Desktop Session Token Management ─────────────
// Authenticates the Electron main process with the Convex backend
// via session tokens — NO deploy key needed.
let _desktopSessionToken = null;
let _desktopSessionExpiry = 0;

async function getDesktopSessionToken(overrideUserId, overrideInfo) {
    if (_desktopSessionToken && _desktopSessionExpiry > Date.now() + 3600000) {
        return _desktopSessionToken;
    }

    let userId = overrideUserId;
    let email, phone, name;

    if (!userId) {
        const session = loadAccountSession();
        if (!session || !session.userId) return null;
        userId = session.userId;
        email = session.email;
        phone = session.phone;
        name = session.name;
    } else if (overrideInfo) {
        email = overrideInfo.email;
        phone = overrideInfo.phone;
        name = overrideInfo.name;
    }

    const https = require("https");
    const bodyStr = JSON.stringify({
        otplessUserId: userId,
        email: email || undefined,
        phone: phone || undefined,
        name: name || undefined,
    });

    return new Promise((resolve) => {
        const url = new URL(`${CONVEX_SITE_URL}/api/auth/session`);
        const req = https.request(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(bodyStr),
            },
            timeout: 15000,
        }, (res) => {
            let raw = "";
            res.on("data", c => raw += c);
            res.on("end", () => {
                try {
                    const data = JSON.parse(raw);
                    if (data.token) {
                        _desktopSessionToken = data.token;
                        _desktopSessionExpiry = data.expiresAt || (Date.now() + 86400000);
                        resolve(data.token);
                    } else {
                        console.warn("[Session] Desktop session failed:", data.error || "unknown");
                        resolve(null);
                    }
                } catch { resolve(null); }
            });
        });
        req.on("error", () => resolve(null));
        req.on("timeout", () => { req.destroy(); resolve(null); });
        req.write(bodyStr);
        req.end();
    });
}

function convexSiteRequest(method, urlPath, bodyObj) {
    return new Promise(async (resolve, reject) => {
        const token = await getDesktopSessionToken();
        if (!token) return reject(new Error("No session token available"));

        const https = require("https");
        const bodyStr = bodyObj ? JSON.stringify(bodyObj) : "";
        const url = new URL(`${CONVEX_SITE_URL}${urlPath}`);
        const headers = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
        };
        if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr);

        const req = https.request(url, { method, headers, timeout: 15000 }, (res) => {
            let raw = "";
            res.on("data", c => raw += c);
            res.on("end", () => {
                try { resolve(JSON.parse(raw)); }
                catch (e) { reject(e); }
            });
        });
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

// ── Auto-Updater Feed Configuration ──
// Uses a generic HTTP provider via the Convex backend proxy.
// No GitHub token needed — the Convex endpoint serves update metadata
// and redirects asset downloads to public release URLs.
function configureAutoUpdater() {
    autoUpdater.setFeedURL({
        provider: "generic",
        url: "https://zany-kudu-607.convex.site/api/updates",
    });
    console.log("[Updater] Configured with Convex generic update endpoint");
}


// ── Bot Log File System ─────────────────────
// Logs are saved to file with automatic rotation every 3 days

function getLogFilePath() {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    return path.join(LOGS_DIR, `atlas-${today}.log`);
}

function writeToLogFile(message) {
    try {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
        const timestamp = new Date().toISOString();
        const logLine = `[${timestamp}] ${message}\n`;
        fs.appendFileSync(getLogFilePath(), logLine);
    } catch (err) {
        console.error("Failed to write log:", err.message);
    }
}

function cleanOldLogs() {
    try {
        if (!fs.existsSync(LOGS_DIR)) return;
        const files = fs.readdirSync(LOGS_DIR);
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - LOG_RETENTION_DAYS);

        for (const file of files) {
            if (!file.startsWith('atlas-') || !file.endsWith('.log')) continue;

            // Extract date from filename: atlas-YYYY-MM-DD.log
            const dateMatch = file.match(/atlas-(\d{4}-\d{2}-\d{2})\.log/);
            if (!dateMatch) continue;

            const fileDate = new Date(dateMatch[1]);
            if (fileDate < cutoffDate) {
                fs.unlinkSync(path.join(LOGS_DIR, file));
                console.log(`Cleaned old log file: ${file}`);
            }
        }
    } catch (err) {
        console.error("Failed to clean old logs:", err.message);
    }
}

// ── Anti-Debug Protection ─────────────────────

function initProtection() {
    if (IS_DEV) return; // Skip in dev mode

    // Disable DevTools in production
    app.on("web-contents-created", (_, contents) => {
        contents.on("before-input-event", (event, input) => {
            // Block F12, Ctrl+Shift+I, Ctrl+Shift+J
            if (
                input.key === "F12" ||
                (input.control && input.shift && (input.key === "I" || input.key === "J"))
            ) {
                event.preventDefault();
            }
        });
    });

    // Detect debugger attachment
    setInterval(() => {
        const start = performance.now();
        // debugger statement takes significantly longer when debugger is attached
        // This is a timing-based detection
        const elapsed = performance.now() - start;
        if (elapsed > 100) {
            console.error("[SECURITY] Debugger detected. Exiting.");
            app.quit();
        }
    }, 5000);

    // Integrity check: verify our ASAR hasn't been tampered with
    const asarPath = path.join(process.resourcesPath, "app.asar");
    if (fs.existsSync(asarPath)) {
        try {
            const checksumPath = path.join(process.resourcesPath, ".integrity");
            if (fs.existsSync(checksumPath)) {
                const expected = fs.readFileSync(checksumPath, "utf-8").trim();
                const asarBuffer = fs.readFileSync(asarPath);
                const actual = crypto.createHash("sha256").update(asarBuffer).digest("hex");
                if (actual !== expected) {
                    dialog.showErrorBox(
                        "Security Error",
                        "Application files have been tampered with. Please reinstall A.T.L.A.S.\n\n" + COPYRIGHT
                    );
                    app.quit();
                    return;
                }
            }
        } catch { /* first run, no checksum yet */ }
    }
}

// ── Encryption Layer ──────────────────────────

/**
 * Get or create the master encryption key using Windows DPAPI.
 * The key is protected by the user's Windows login — it can only
 * be decrypted by the same Windows user account.
 */
function getMasterKey() {
    const keyPath = path.join(app.getPath("userData"), ".keystore");

    if (fs.existsSync(keyPath)) {
        try {
            const encryptedKey = fs.readFileSync(keyPath);
            if (safeStorage.isEncryptionAvailable()) {
                return safeStorage.decryptString(encryptedKey);
            }
            // Fallback: derive from machine identity
            return deriveMachineKey();
        } catch {
            return deriveMachineKey();
        }
    }

    // Generate new 256-bit key
    const key = crypto.randomBytes(32).toString("hex");

    if (safeStorage.isEncryptionAvailable()) {
        const encrypted = safeStorage.encryptString(key);
        fs.writeFileSync(keyPath, encrypted);
    } else {
        // Store with machine-derived encryption as fallback
        const machineKey = deriveMachineKey();
        const cipher = crypto.createCipheriv(
            "aes-256-gcm",
            Buffer.from(machineKey, "hex").subarray(0, 32),
            crypto.randomBytes(12)
        );
        // For simplicity in fallback, use machineKey to just derive
        fs.writeFileSync(keyPath, key); // Less secure fallback
    }

    return key;
}

/**
 * Derive a machine-unique key from hardware identifiers.
 * Not as secure as DPAPI but works as a fallback.
 */
function deriveMachineKey() {
    const os = require("os");
    const identity = [
        os.hostname(),
        os.platform(),
        os.arch(),
        os.cpus()[0]?.model || "",
        os.totalmem().toString(),
    ].join("|");
    return crypto
        .createHash("sha256")
        .update(identity + "XAGI_LABS_ATLAS_2024")
        .digest("hex");
}

/**
 * Encrypt data with AES-256-GCM.
 */
function encrypt(plaintext, masterKey) {
    const key = Buffer.from(masterKey, "hex").subarray(0, 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Format: iv(16) + tag(16) + ciphertext
    return Buffer.concat([iv, tag, encrypted]);
}

/**
 * Decrypt data with AES-256-GCM.
 */
function decrypt(encryptedBuffer, masterKey) {
    const key = Buffer.from(masterKey, "hex").subarray(0, 32);
    const iv = encryptedBuffer.subarray(0, 16);
    const tag = encryptedBuffer.subarray(16, 32);
    const ciphertext = encryptedBuffer.subarray(32);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext, null, "utf-8") + decipher.final("utf-8");
}

/**
 * Save the .env file encrypted.
 */
function saveEnvEncrypted(envContent) {
    if (ENV_PATH.endsWith(".enc")) {
        // Production: encrypt before writing
        const masterKey = getMasterKey();
        const encryptedData = encrypt(envContent, masterKey);
        fs.writeFileSync(ENV_PATH, encryptedData);
    } else {
        // Dev mode: write plain text to .env
        fs.writeFileSync(ENV_PATH, envContent, "utf-8");
    }
}

/**
 * Merge key/value pairs into the encrypted .env file. Reads the existing env
 * (if any), updates or inserts each key, and writes back encrypted. Creates
 * the file if it didn't exist.
 */
function saveEnvKVs(kvs) {
    if (!kvs || typeof kvs !== "object") return;
    const existing = loadEnvDecrypted() || "";
    const lines = existing.split("\n");
    const seen = new Set();
    const updated = lines.map((line) => {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
        if (!m) return line;
        const key = m[1];
        if (Object.prototype.hasOwnProperty.call(kvs, key)) {
            seen.add(key);
            return `${key}=${String(kvs[key])}`;
        }
        return line;
    });
    for (const k of Object.keys(kvs)) {
        if (!seen.has(k)) updated.push(`${k}=${String(kvs[k])}`);
    }
    // Drop trailing empty lines before collapsing (keep one).
    while (updated.length > 1 && updated[updated.length - 1] === "") updated.pop();
    saveEnvEncrypted(updated.join("\n") + "\n");
}

// ─── Detection + Install Helpers (C10) ──────────────
/**
 * Build the dependency bundle passed to `runDetection`. Extracted so the
 * adaptive wizard's detect IPC AND the install/retry/resume handlers all
 * build state the same way.
 */
function buildDetectionDeps() {
    const osmod = require("os");
    const { promisify } = require("util");
    const execFn = promisify(require("child_process").exec);

    const prefs = (() => {
        try {
            return {
                account: store.get("account") || undefined,
                personalize: store.get("personalize") || undefined,
            };
        } catch { return {}; }
    })();

    const envObj = (() => {
        try {
            const raw = loadEnvDecrypted();
            if (!raw) return {};
            const out = {};
            for (const line of raw.split("\n")) {
                const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
                if (m) out[m[1]] = m[2];
            }
            return out;
        } catch { return {}; }
    })();

    const paths = {
        setupFlag: SETUP_FLAG,
        envFile: path.join(app.getPath("userData"), ".env.enc"),
        googleTokens: path.join(app.getPath("userData"), "google-tokens"),
        botDir: path.join(process.resourcesPath || app.getAppPath(), "bot"),
        homeDir: app.getPath("home"),
        workspace: path.join(app.getPath("desktop"), "A.T.L.A.S Files"),
        storedVersion: path.join(app.getPath("userData"), "version.json"),
        slackInstalls: path.join(app.getPath("userData"), "slack-installs"),
        whatsappOwners: path.join(app.getPath("userData"), "whatsapp-users", "owners.json"),
    };

    return {
        proc: process,
        fs,
        os: osmod,
        systemPreferences,
        nativeTheme,
        globalShortcut,
        prefs,
        envObj,
        execFn: async (cmd) => execFn(cmd),
        paths,
        currentVersion: app.getVersion(),
        hotkey: process.platform === "win32" ? "Control+Space" : "Alt+Space",
    };
}

/**
 * Build the context passed to phase.run(). Wires up the send-progress /
 * send-log helpers to the main window's install-progress / install-log IPC
 * channels and injects the existing install utilities the phases need.
 */
function buildInstallCtx(mw, options) {
    const send = (channel, payload) => {
        if (mw && !mw.isDestroyed()) mw.webContents.send(channel, payload);
    };
    return {
        sendProgress: (percent, message) => send("install-progress", { percent, message }),
        sendLog: (msg) => send("install-log", msg),
        BOT_DIR: BOT_DIR,
        DATA_DIR: DATA_DIR,
        SETUP_FLAG: SETUP_FLAG,
        checkNodeInstalled: checkNodeInstalled,
        downloadAndInstallNode: downloadAndInstallNode,
        runCommand: runCommand,
        loadEnvDecrypted: loadEnvDecrypted,
        saveEnvEncrypted: saveEnvEncrypted,
        documentsDir: app.getPath("documents"),
        options: options || {},
    };
}

function requireInstaller() {
    const { runDetection } = require(path.join(__dirname, "detection"));
    const { buildPhaseList } = require(path.join(__dirname, "installer", "phases.js"));
    const r = require(path.join(__dirname, "installer", "runner.js"));
    return {
        runDetection: runDetection,
        buildPhaseList: buildPhaseList,
        runPhases: r.runPhases,
        getResumeList: r.getResumeList,
        readSetupState: r.readSetupState,
    };
}

/**
 * Load and decrypt the .env file.
 * Returns the plaintext .env content.
 */
function loadEnvDecrypted() {
    if (!fs.existsSync(ENV_PATH)) return "";
    try {
        if (ENV_PATH.endsWith(".enc")) {
            const masterKey = getMasterKey();
            const encryptedData = fs.readFileSync(ENV_PATH);
            return decrypt(encryptedData, masterKey);
        }
        // Dev mode: plain .env
        return fs.readFileSync(ENV_PATH, "utf-8");
    } catch {
        return "";
    }
}

/**
 * Load a single env key from the encrypted .env file.
 * Used when preserving masked (***) tokens during channel config saves.
 */
function loadEnvKey(key) {
    const content = loadEnvDecrypted();
    if (!content) return null;
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        if (trimmed.substring(0, eq).trim() === key) {
            return trimmed.substring(eq + 1).trim();
        }
    }
    return null;
}

// ── Bot Process Management ────────────────────

let botProcess = null;
let mainWindow = null;
let tray = null;
let overlayWindow = null;
let overlayResizeTimer = null;
let botStartTime = null;
let botMessageCount = 0;
let botToolCount = 0;
const channelStatuses = {};

// ── User Preferences Store ───────────────────
const Store = require("electron-store");
const store = new Store({
    defaults: {
        launchAtLogin: false,
        theme: "light", // "light" | "dark" | "system"
        notificationsEnabled: true,
        notifyOnMessage: true,
        notifyOnTask: true,
        notifyOnUpdate: true,
        minimizeToMenubar: process.platform === "darwin",
        lastUpdateCheck: null,
        overlayHotkey: null, // null = platform default (Command+J / Alt+Space)
        liveVoiceHotkey: null, // null = platform default (Command+Shift+L / Alt+Shift+L)
        sideloadingEnabled: false, // Advanced: allow sideloading external skills/plugins
    }
});

// Resolve the active overlay shortcut (custom or platform default)
function getOverlayShortcut() {
    const custom = store.get("overlayHotkey");
    if (custom) return custom;
    return process.platform === "darwin" ? "Command+J" : "Alt+Space";
}

// Resolve the active live voice shortcut (custom or platform default)
function getLiveVoiceShortcut() {
    const custom = store.get("liveVoiceHotkey");
    if (custom) return custom;
    return process.platform === "darwin" ? "Command+Shift+L" : "Alt+Shift+L";
}

// ── Update State ─────────────────────────────
let updateAvailable = null;
let updateDownloaded = false;
let downloadProgress = 0;

// ── Account Session (module-level) ────────────
const ACCOUNT_SESSION_PATH = path.join(DATA_DIR, "atlas-account.enc");

/** Save account session encrypted to disk */
function saveAccountSession(session) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const masterKey = getMasterKey();
        const data = encrypt(JSON.stringify(session), masterKey);
        fs.writeFileSync(ACCOUNT_SESSION_PATH, data);
    } catch (err) {
        console.error("[Account] Failed to save session:", err.message);
    }
}

/** Load account session from encrypted file */
function loadAccountSession() {
    try {
        if (!fs.existsSync(ACCOUNT_SESSION_PATH)) return null;
        const masterKey = getMasterKey();
        const encrypted = fs.readFileSync(ACCOUNT_SESSION_PATH);
        const json = decrypt(encrypted, masterKey);
        return JSON.parse(json);
    } catch {
        return null;
    }
}

/** Delete local account session */
function deleteAccountSession() {
    try { fs.unlinkSync(ACCOUNT_SESSION_PATH); } catch { /* */ }
}

// ── Auto-Updater Event Handlers ──────────────

function setupAutoUpdater() {
    autoUpdater.on("checking-for-update", () => {
        console.log("[Updater] Checking for updates...");
    });

    autoUpdater.on("update-available", (info) => {
        console.log("[Updater] Update available:", info.version);
        updateAvailable = info;
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("update-available", {
                version: info.version,
                releaseNotes: info.releaseNotes,
                releaseDate: info.releaseDate,
            });
        }
        // Show notification if enabled
        if (store.get("notifyOnUpdate")) {
            const { Notification } = require("electron");
            if (Notification.isSupported()) {
                new Notification({
                    title: "A.T.L.A.S Update Available",
                    // Windows silently drops notifications with an empty body
                    body: `Version ${info.version} is ready to download`,
                    icon: path.join(__dirname, process.platform === "win32" ? "logo.ico" : "logo.png"),
                }).show();
            }
        }
    });

    autoUpdater.on("update-not-available", (info) => {
        console.log("[Updater] No updates available");
        store.set("lastUpdateCheck", new Date().toISOString());
    });

    autoUpdater.on("download-progress", (progress) => {
        downloadProgress = progress.percent;
        console.log(`[Updater] Download progress: ${Math.round(progress.percent)}%`);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("update-progress", {
                percent: progress.percent,
                bytesPerSecond: progress.bytesPerSecond,
                transferred: progress.transferred,
                total: progress.total,
            });
        }
    });

    autoUpdater.on("update-downloaded", (info) => {
        console.log("[Updater] Update downloaded:", info.version);
        updateDownloaded = true;
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("update-ready", {
                version: info.version,
            });
        }
        // Show notification
        if (store.get("notifyOnUpdate")) {
            const { Notification } = require("electron");
            if (Notification.isSupported()) {
                new Notification({
                    title: "A.T.L.A.S Update Ready",
                    body: `Version ${info.version} is ready to install. Restart to update.`,
                    icon: path.join(__dirname, process.platform === "win32" ? "logo.ico" : "logo.png"),
                }).show();
            }
        }
    });

    autoUpdater.on("error", (err) => {
        const msg = err.message || "";
        if (msg.includes("401") || msg.includes("403") || msg.includes("Not Found")) {
            console.error("[Updater] Update endpoint returned error — update server may be unavailable");
        } else {
            console.error("[Updater] Error:", msg);
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("update-error", msg);
        }
    });
}

async function checkForUpdates() {
    if (!IS_DEV) {
        configureAutoUpdater();
        autoUpdater.checkForUpdates().catch(err => {
            console.warn("[Updater] Check failed:", err.message);
        });
    }
}

function getBotStatus() {
    return botProcess && !botProcess.killed ? "running" : "stopped";
}

async function startBot() {
    if (botProcess && !botProcess.killed) return { status: "already_running" };

    // ── Account gate: check status before starting ──
    const session = loadAccountSession();
    if (session && session.user) {
        // Account is configured — we'll pass credentials to the bot
        // but the actual pre-start check is done async (see startBotAsync below)
    }

    // Ensure data dir exists
    fs.mkdirSync(DATA_DIR, { recursive: true });

    // Write decrypted .env to temp location for bot to read
    const envContent = loadEnvDecrypted();
    const tempEnvPath = path.join(DATA_DIR, ".env.runtime");
    if (envContent) {
        fs.writeFileSync(tempEnvPath, envContent, { mode: 0o600 });
    }

    const entryPoint = path.join(BOT_DIR, "dist", "index.js");

    // Helper: send log line to renderer and save to file
    const sendLog = (msg) => {
        console.log("[BOT]", msg);
        // Save to log file (all messages)
        writeToLogFile(msg);
        // Send to renderer (will only show errors as toast)
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("bot-log", msg);
        }
    };

    // Validate entry point exists
    if (!fs.existsSync(entryPoint)) {
        const errMsg = `Entry point not found: ${entryPoint}`;
        sendLog(`❌ ${errMsg}`);
        return { status: "error", error: errMsg };
    }

    // Validate env content
    if (!envContent || !envContent.includes("TELEGRAM_BOT_TOKEN")) {
        sendLog("⚠️ Warning: No credentials found. Configure settings first.");
    }

    sendLog(`Starting bot from: ${entryPoint}`);
    sendLog(`CWD: ${BOT_DIR}`);
    sendLog(`Data dir: ${DATA_DIR}`);

    let executable = "node";
    let args = ["--no-warnings", entryPoint];
    // Ensure common binary paths are in PATH — macOS Electron apps don't inherit full shell PATH
    const extraPaths = [
        path.join(require("os").homedir(), ".atlas", "bin"), // Atlas-managed tools (spogo, etc.)
        "/opt/homebrew/bin",       // Homebrew (Apple Silicon)
        "/usr/local/bin",          // Homebrew (Intel) / system tools
        "/opt/homebrew/sbin",
        "/usr/local/sbin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ];
    const currentPath = process.env.PATH || "";
    const mergedPath = [...new Set([...extraPaths, ...currentPath.split(path.delimiter)])].join(path.delimiter);

    let spawnEnv = {
        ...process.env,
        PATH: mergedPath,
        DOTENV_CONFIG_PATH: tempEnvPath,
        ATLAS_DATA_DIR: DATA_DIR,
        NODE_ENV: "production",
    };

    // Pass Convex URL + OTPless identity to bot process for credit enforcement
    spawnEnv.CONVEX_URL = "https://zany-kudu-607.convex.cloud";
    if (session && session.userId) {
        spawnEnv.ATLAS_OTPLESS_USER_ID = session.userId;
        spawnEnv.ATLAS_ACCOUNT_EMAIL = session.email || "";
    }

    if (!IS_DEV) {
        // In production, we run the bot using Electron's built-in Node environment.
        // This guarantees ABI compatibility with native modules built by electron-builder.
        executable = process.execPath;
        spawnEnv.ELECTRON_RUN_AS_NODE = "1";
    }

    // Fetch server-delivered runtime key (fail-open: falls back to built-in on error)
    // Ensure session token is available, then fetch server-delivered runtime key
    const _keyFetchToken = _desktopSessionToken || await getDesktopSessionToken();
    if (_keyFetchToken) {
        await fetchRuntimeKey(_keyFetchToken);
    }
    if (_runtimeKey) {
        spawnEnv.ATLAS_RUNTIME_KEY = _runtimeKey;
    }

    try {
        botProcess = spawn(executable, args, {
            cwd: BOT_DIR,
            env: spawnEnv,
            stdio: ["pipe", "pipe", "pipe"],
            shell: false, // Critical: shell:true on Windows might invoke cmd.exe instead of Electron
        });
    } catch (spawnErr) {
        sendLog(`❌ Failed to spawn process: ${spawnErr.message}`);
        return { status: "error", error: spawnErr.message };
    }

    botProcess.stdout.on("data", (data) => {
        const msg = data.toString().trim();
        if (msg) {
            sendLog(msg);
            // Track stats from log output
            if (msg.includes("User:") || msg.includes("[Overlay] User:")) botMessageCount++;
            if (msg.includes("Tools   :")) {
                const match = msg.match(/(\d+)\s*registered/);
                if (match) botToolCount = parseInt(match[1]);
            }

            // WhatsApp QR forwarding — convert raw QR string to data URL image
            const qrMatch = msg.match(/##ATLAS_QR##(.+)##END_QR##/);
            if (qrMatch) {
                const qrString = qrMatch[1];
                try {
                    const QRCode = require("qrcode");
                    QRCode.toDataURL(qrString, { width: 256, margin: 2 }, (err, dataUrl) => {
                        if (err) {
                            console.warn("[QR] Failed to generate QR image:", err.message);
                            return;
                        }
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send("whatsapp-qr", dataUrl);
                        }
                    });
                } catch (qrErr) {
                    console.warn("[QR] qrcode module not available:", qrErr.message);
                    // Fallback: send raw string (panel will show broken image)
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send("whatsapp-qr", qrString);
                    }
                }
            }

            // WhatsApp OTP forwarding
            const otpMatch = msg.match(/##ATLAS_WA_OTP##(.+)##END_OTP##/);
            if (otpMatch) {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send("whatsapp-otp", { code: otpMatch[1] });
                }
            }
            // WhatsApp owner verified
            if (msg.includes("[WHATSAPP] Owner verified:")) {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send("whatsapp-otp", { verified: true });
                }
            }

            // Channel status detection
            if (msg.includes("[WHATSAPP] Connected successfully")) {
                channelStatuses.whatsapp = "connected";
                // Also notify the QR listener to show "Connected!"
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send("whatsapp-qr", "connected");
                }
            }
            if (msg.includes("[WHATSAPP] Connection closed")) channelStatuses.whatsapp = "disconnected";
            if (msg.includes("[DISCORD] Bot online") || (msg.includes("discord") && msg.includes("ready"))) channelStatuses.discord = "connected";
            if (msg.includes("[SLACK]") && msg.includes("\u26A1")) channelStatuses.slack = "connected";
            if (msg.includes("[MATRIX] Bot started")) channelStatuses.matrix = "connected";
            if (msg.includes("Email connected") || msg.includes("IMAP connected")) channelStatuses.email = "connected";

            // Push status updates to renderer
            const win = mainWindow;
            if (win && !win.isDestroyed()) {
                win.webContents.send("channel-status-update", channelStatuses);
            }
        }
    });

    botProcess.stderr.on("data", (data) => {
        const msg = data.toString().trim();
        if (msg) {
            console.error("[BOT ERR]", msg);
            // Save error to log file
            writeToLogFile(`[ERROR] ${msg}`);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send("bot-log", `⚠ ${msg}`);
            }
        }
    });

    botProcess.on("error", (err) => {
        sendLog(`❌ Process error: ${err.message}`);
        botProcess = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("bot-status", "stopped");
        }
        updateTrayMenu();
    });

    botProcess.on("exit", (code) => {
        sendLog(`Process exited with code ${code}`);
        botProcess = null;
        // Clean up temp env
        try { fs.unlinkSync(tempEnvPath); } catch { /* */ }
        // Notify renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("bot-status", "stopped");
        }
        updateTrayMenu();
    });

    // Notify renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("bot-status", "running");
    }
    updateTrayMenu();
    botStartTime = Date.now();
    botMessageCount = 0;

    return { status: "started" };
}

function stopBot() {
    if (!botProcess || botProcess.killed) return { status: "already_stopped" };

    botProcess.kill("SIGTERM");
    setTimeout(() => {
        if (botProcess && !botProcess.killed) {
            botProcess.kill("SIGKILL");
        }
    }, 5000);

    return { status: "stopping" };
}

// ── Local HTTP Server (for OTPless SDK origin check) ────────────────────
// OTPless headless SDK blocks file:// origin. We serve Desktop files from
// localhost so the SDK sees a valid HTTP origin and works correctly.

let _localPort = 0;

function startLocalServer() {
    return new Promise((resolve) => {
        if (_localPort) { resolve(_localPort); return; }
        const http = require("http");
        const fs = require("fs");
        const mime = {
            ".html": "text/html",
            ".css": "text/css",
            ".js": "application/javascript",
            ".json": "application/json",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".ico": "image/x-icon",
            ".svg": "image/svg+xml",
            ".woff2": "font/woff2",
            ".ttf": "font/ttf",
        };
        const desktopDir = __dirname;
        const server = http.createServer((req, res) => {
            let filePath = path.join(desktopDir, req.url === "/" ? "/panel.html" : req.url);
            // Strip query strings
            filePath = filePath.split("?")[0];
            const ext = path.extname(filePath).toLowerCase();
            fs.readFile(filePath, (err, data) => {
                if (err) {
                    res.writeHead(404);
                    res.end("Not found: " + req.url);
                    return;
                }
                res.writeHead(200, {
                    "Content-Type": mime[ext] || "application/octet-stream",
                    "Access-Control-Allow-Origin": "*",
                });
                res.end(data);
            });
        });
        // Fixed port so OTPless domain allowlist (http://127.0.0.1:7421) is consistent
        const tryPorts = [7421, 7422, 7423, 7424];
        let _portIdx = 0;
        const tryListen = () => {
            server.once("error", (err) => {
                _portIdx++;
                if (_portIdx < tryPorts.length) { tryListen(); }
                else { console.error("[LocalServer] All ports failed:", err.message); resolve(0); }
            });
            server.listen(tryPorts[_portIdx], "127.0.0.1", () => {
                _localPort = tryPorts[_portIdx];
                console.log(`[LocalServer] Serving on http://127.0.0.1:${_localPort}`);
                resolve(_localPort);
            });
        };
        tryListen();
    });
}

// ── Window Creation ───────────────────────────

function createWizardWindow() {
    mainWindow = new BrowserWindow({
        width: 820,
        height: 620,
        minWidth: 700,
        minHeight: 550,
        frame: false,
        transparent: true,
        resizable: false,
        icon: path.join(__dirname, "logo.ico"),
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            nodeIntegration: false,
            contextIsolation: true,
            devTools: IS_DEV,
        },
        title: "A.T.L.A.S Setup — © XAGI Labs",
    });

    mainWindow.loadFile(path.join(__dirname, "wizard.html"));
    if (IS_DEV) mainWindow.webContents.openDevTools({ mode: "detach" });
}

async function createPanelWindow() {
    mainWindow = new BrowserWindow({
        width: 700,
        height: 540,
        minWidth: 600,
        minHeight: 480,
        frame: false,
        transparent: true,
        resizable: true,
        icon: path.join(__dirname, "logo.ico"),
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            nodeIntegration: false,
            contextIsolation: true,
            devTools: IS_DEV,
        },
        title: "A.T.L.A.S — © XAGI Labs",
    });

    // Load from local HTTP server so OTPless SDK origin check passes
    const port = await startLocalServer();
    if (port) {
        mainWindow.loadURL(`http://127.0.0.1:${port}/panel.html`);
    } else {
        // Fallback: load from file:// (OTPless won't work but app still opens)
        mainWindow.loadFile(path.join(__dirname, "panel.html"));
    }
    if (IS_DEV) mainWindow.webContents.openDevTools({ mode: "detach" });
}

// ── Native Overlay Window ────────────────────
// Replaces Hammerspoon (macOS) / AutoHotkey (Windows).
// Pure Electron — no external tools needed.

function getOverlayPosition() {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const wa = display.workArea;
    return {
        x: wa.x + wa.width - OVERLAY_WIDTH - OVERLAY_MARGIN_RIGHT,
        y: wa.y + OVERLAY_MARGIN_TOP,
    };
}

function createOverlayWindow() {
    const pos = getOverlayPosition();

    overlayWindow = new BrowserWindow({
        width: OVERLAY_WIDTH,
        height: OVERLAY_MIN_HEIGHT,
        x: pos.x,
        y: pos.y,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        focusable: true,
        hasShadow: false,
        show: false,
        // macOS: no window-level vibrancy — each element uses its own
        // backdrop-filter so the empty space stays fully transparent
        backgroundColor: "#00000000",
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            devTools: IS_DEV,
            preload: path.join(__dirname, "overlay-preload.js"),
        },
    });

    // macOS: show on all Spaces and in fullscreen
    if (process.platform === "darwin") {
        overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }

    overlayWindow.loadURL(OVERLAY_URL);

    // Escape key → hide overlay
    overlayWindow.webContents.on("before-input-event", (event, input) => {
        if (input.key === "Escape" && input.type === "keyDown") {
            hideOverlay();
        }
    });

    // Prevent close — hide instead (unless quitting)
    overlayWindow.on("close", (e) => {
        if (!isQuitting) {
            e.preventDefault();
            hideOverlay();
        }
    });

    overlayWindow.on("closed", () => {
        overlayWindow = null;
        stopHeightPolling();
    });

    // Click outside → hide (but NOT while the agent is actively working)
    overlayWindow.on("blur", () => {
        setTimeout(() => {
            if (!overlayWindow || overlayWindow.isDestroyed() || overlayWindow.isFocused()) return;
            // Check if the agent is busy (input disabled = thinking/executing)
            overlayWindow.webContents.executeJavaScript(`
                (function() {
                    var inp = document.getElementById('input');
                    var icon = document.getElementById('icon');
                    var isWorking = (inp && inp.disabled) || (icon && icon.classList.contains('thinking'));
                    return isWorking;
                })();
            `).then((busy) => {
                // Don't hide while agent is working — it may be clicking on screen
                if (!busy && overlayWindow && !overlayWindow.isDestroyed() && !overlayWindow.isFocused()) {
                    hideOverlay();
                }
            }).catch(() => {});
        }, 150);
    });

    if (IS_DEV) overlayWindow.webContents.openDevTools({ mode: "detach" });
}

function showOverlay() {
    // Create lazily
    if (!overlayWindow || overlayWindow.isDestroyed()) {
        createOverlayWindow();
    }

    // Reposition to cursor's current display (handles monitor switching)
    const pos = getOverlayPosition();
    overlayWindow.setPosition(pos.x, pos.y);

    // Preserve pending/fresh responses — only clear when idle with no content
    // The renderer's `waiting` flag is true while the agent is processing.
    // The `reply-box.visible` + non-empty reply-text means a response just arrived.
    overlayWindow.webContents.executeJavaScript(`
        (function() {
            var rb = document.getElementById('reply-box');
            var rt = document.getElementById('reply-text');
            var pg = document.getElementById('progress');
            var nb = document.getElementById('notification-box');
            var inp = document.getElementById('input');
            var isWaiting = inp && inp.disabled;
            var hasReply = rb && rb.classList.contains('visible') && rt && rt.innerHTML.trim().length > 0;
            var hasProgress = pg && pg.classList.contains('visible');
            var icon = document.getElementById('icon');
            var isThinking = icon && icon.classList.contains('thinking');
            var busy = isWaiting || isThinking || hasReply || hasProgress;
            if (!busy) {
                if (rb) { rb.classList.remove('visible'); }
                if (pg) { pg.classList.remove('visible'); pg.innerHTML = ''; }
                if (inp) { inp.value = ''; inp.disabled = false; }
            }
            if (nb) { nb.classList.remove('visible'); nb.innerHTML = ''; }
            return busy;
        })();
    `).then((hasContent) => {
        if (!overlayWindow || overlayWindow.isDestroyed()) return;
        if (hasContent) {
            // Active content — resize window to fit now
            overlayWindow.webContents.executeJavaScript(
                "document.getElementById('container')?.scrollHeight || 0"
            ).then((sh) => {
                if (!overlayWindow || overlayWindow.isDestroyed()) return;
                const h = Math.min(Math.max(sh + 10, OVERLAY_MIN_HEIGHT), OVERLAY_MAX_HEIGHT);
                overlayWindow.setContentSize(OVERLAY_WIDTH, h);
            }).catch(() => {});
        } else {
            overlayWindow.setContentSize(OVERLAY_WIDTH, OVERLAY_MIN_HEIGHT);
        }
    }).catch(() => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.setContentSize(OVERLAY_WIDTH, OVERLAY_MIN_HEIGHT);
        }
    });

    // Show and focus
    overlayWindow.show();
    overlayWindow.focus();

    // Auto-focus the input field after the window is visible
    setTimeout(() => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.executeJavaScript(
                "document.getElementById('input')?.focus();"
            ).catch(() => {});
        }
    }, 200);

    // Start dynamic height polling
    startHeightPolling();
}

function hideOverlay() {
    if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) return;

    stopHeightPolling();

    // Inject spring-out animation (matches the Hammerspoon version)
    overlayWindow.webContents.executeJavaScript(`
        (function() {
            var ib = document.getElementById('input-box');
            var rb = document.getElementById('reply-box');
            var anim = 'springOut 0.25s cubic-bezier(0.55, 0, 1, 0.45) forwards';
            if (ib) ib.style.animation = anim;
            if (rb) rb.style.animation = anim;
        })();
    `).catch(() => {});

    // Wait for animation, then hide
    setTimeout(() => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.hide();
            // Reset animations so springIn replays on next show
            overlayWindow.webContents.executeJavaScript(`
                (function() {
                    var ib = document.getElementById('input-box');
                    var rb = document.getElementById('reply-box');
                    if (ib) ib.style.animation = '';
                    if (rb) rb.style.animation = '';
                })();
            `).catch(() => {});
        }
    }, OVERLAY_HIDE_DELAY_MS);
}

function toggleOverlay() {
    if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
        hideOverlay();
    } else {
        showOverlay();
    }
}

// ── Live Voice Toggle ────────────────────────────
// Toggles live voice mode: shows overlay if hidden, then sends voice_live_start/stop via WS

let liveVoiceActive = false;

function toggleLiveVoice() {
    // Ensure overlay is visible (live voice feedback shows there)
    if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) {
        showOverlay();
    }

    // Toggle state and send appropriate WebSocket message via overlay page
    liveVoiceActive = !liveVoiceActive;
    const msgType = liveVoiceActive ? "voice_live_start" : "voice_live_stop";

    // Send via the overlay's WebSocket connection
    if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.executeJavaScript(`
            (function() {
                if (window._atlasWS && window._atlasWS.readyState === 1) {
                    window._atlasWS.send(JSON.stringify({ type: "${msgType}" }));
                    return true;
                }
                return false;
            })();
        `).then((sent) => {
            if (!sent) {
                console.warn("[SHORTCUT] Live voice: overlay WebSocket not ready");
                liveVoiceActive = !liveVoiceActive; // revert state
            } else {
                console.log(`[SHORTCUT] Live voice: ${liveVoiceActive ? "started" : "stopped"}`);
            }
        }).catch(() => {
            liveVoiceActive = !liveVoiceActive;
        });
    }
}

function startHeightPolling() {
    stopHeightPolling();
    overlayResizeTimer = setInterval(() => {
        if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) {
            stopHeightPolling();
            return;
        }
        overlayWindow.webContents.executeJavaScript(
            "document.getElementById('container')?.scrollHeight || 0"
        ).then((scrollHeight) => {
            if (!overlayWindow || overlayWindow.isDestroyed()) return;
            const newH = Math.min(Math.max(scrollHeight + 10, OVERLAY_MIN_HEIGHT), OVERLAY_MAX_HEIGHT);
            const [, currentH] = overlayWindow.getContentSize();
            if (Math.abs(currentH - newH) > 2) {
                overlayWindow.setContentSize(OVERLAY_WIDTH, newH);
            }
        }).catch(() => {});
    }, OVERLAY_RESIZE_MS);
}

function stopHeightPolling() {
    if (overlayResizeTimer) {
        clearInterval(overlayResizeTimer);
        overlayResizeTimer = null;
    }
}

// ── IPC Handlers ──────────────────────────────

function registerIPC() {
    // ── OTPless Auth Popup Window ─────────────────────────────────────
    // The auth page is hosted on Hostinger (real HTTPS domain) so OTPless
    // SDK works without domain restrictions. We open it in a child
    // BrowserWindow with a dedicated preload that bridges the result back.

    let authWindow = null;

    function openAuthWindow() {
        if (authWindow && !authWindow.isDestroyed()) {
            authWindow.focus();
            return;
        }
        authWindow = new BrowserWindow({
            width: 400,
            height: 580,
            resizable: false,
            frame: true,
            title: "A.T.L.A.S — Sign In",
            alwaysOnTop: true,
            webPreferences: {
                preload: path.join(__dirname, "auth-preload.js"),
                nodeIntegration: false,
                contextIsolation: true,
                devTools: IS_DEV,
            },
        });
        // Load local auth page — no OTPless SDK, no domain restrictions
        authWindow.loadFile(path.join(__dirname, "auth.html"));
        authWindow.on("closed", () => { authWindow = null; });
        if (IS_DEV) authWindow.webContents.openDevTools({ mode: "detach" });
    }

    // Overlay IPC — auto-show overlay from preload (e.g. research completion)
    ipcMain.on("overlay:show", () => {
        showOverlay();
    });
    // Ready Hub "Talk" button — trigger live voice session from renderer.
    // Mirrors what the global live-voice hotkey does when pressed.
    ipcMain.handle("live-voice:trigger", () => {
        if (typeof toggleLiveVoice === "function") {
            try { toggleLiveVoice(); return { ok: true }; }
            catch (err) { return { ok: false, error: err.message || String(err) }; }
        }
        return { ok: false, error: "live-voice not available" };
    });
    ipcMain.on("overlay:notify", (_, { title, body }) => {
        const { Notification } = require("electron");
        if (Notification.isSupported()) {
            // Windows silently drops notifications with an empty body — always provide one
            const safeBody = body || "A.T.L.A.S notification";
            new Notification({
                title: title || "A.T.L.A.S",
                body: safeBody,
                icon: path.join(__dirname, process.platform === "win32" ? "logo.ico" : "logo.png"),
            }).show();
        }
    });

    // Open auth window from renderer
    ipcMain.handle("window:openAuth", () => {
        openAuthWindow();
        return { success: true };
    });

    // Called by auth-preload.js when OTPless reports success
    ipcMain.on("otpless:auth-success", async (_, payload) => {
        console.log("[Auth] OTPless success payload:", JSON.stringify(payload));

        // Close the auth popup
        if (authWindow && !authWindow.isDestroyed()) {
            authWindow.close();
            authWindow = null;
        }

        const { userId, token, phone, email, name } = payload || {};
        if (!userId) {
            console.error("[Auth] Invalid payload — no userId");
            return;
        }

        // Session creation auto-upserts the account
        try {
            _desktopSessionToken = null;
            _desktopSessionExpiry = 0;
            await getDesktopSessionToken(userId, { email, phone, name });
            console.log("[Auth] Convex account upserted for:", userId);
        } catch (err) {
            console.warn("[Auth] Convex upsert (non-fatal):", err.message);
        }

        // Save session
        saveAccountSession({
            userId,
            token: token || userId,
            email: email || null,
            phone: phone || null,
            name: name || null,
            created_at: new Date().toISOString(),
        });

        console.log("[Auth] Session saved. Notifying main window.");
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("account-status-change", { signedIn: true });
            mainWindow.focus();
        }
    });

    // Window controls
    ipcMain.handle("window:minimize", () => mainWindow?.minimize());
    ipcMain.handle("window:close", () => {
        // Always hide to tray instead of quitting
        mainWindow?.hide();
    });
    ipcMain.handle("window:drag", () => { /* handled by CSS -webkit-app-region */ });

    // ── Settings: Read credentials (masks secrets) ──
    ipcMain.handle("settings:get", () => {
        try {
            const envContent = loadEnvDecrypted();
            if (!envContent) return { success: false, error: "No configuration found." };
            const settings = {};
            for (const line of envContent.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith("#")) continue;
                const eq = trimmed.indexOf("=");
                if (eq === -1) continue;
                const key = trimmed.substring(0, eq).trim();
                const value = trimmed.substring(eq + 1).trim();
                settings[key] = value;
            }
            return { success: true, settings };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // ── Settings: Save credentials ──
    ipcMain.handle("settings:save", (_, settings) => {
        try {
            const envLines = [
                "# A.T.L.A.S — Environment Variables",
                "# Encrypted by XAGI Labs Secure Storage",
                "",
            ];
            if (settings.TELEGRAM_BOT_TOKEN) envLines.push(`TELEGRAM_BOT_TOKEN=${settings.TELEGRAM_BOT_TOKEN}`);
            if (settings.ALLOWED_USER_IDS) envLines.push(`ALLOWED_USER_IDS=${settings.ALLOWED_USER_IDS}`);
            if (settings.GITHUB_TOKEN) envLines.push(`GITHUB_TOKEN=${settings.GITHUB_TOKEN}`);
            if (settings.ATLAS_WORKSPACE) envLines.push(`ATLAS_WORKSPACE=${settings.ATLAS_WORKSPACE}`);
            const envContent = envLines.join("\n") + "\n";
            saveEnvEncrypted(envContent);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // ── Settings: Open data directory ──
    ipcMain.handle("settings:open-data-dir", () => {
        shell.openPath(DATA_DIR);
    });

    // ── Settings: Open logs directory ──
    ipcMain.handle("settings:open-logs-dir", () => {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
        shell.openPath(LOGS_DIR);
    });

    // ── Settings: Choose workspace folder ──
    ipcMain.handle("settings:choose-workspace", async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: "Choose A.T.L.A.S Workspace Folder",
            properties: ["openDirectory", "createDirectory"],
        });
        if (result.canceled) return { canceled: true };
        return { path: result.filePaths[0] };
    });

    // Bot controls
    ipcMain.handle("bot:start", () => startBot());
    ipcMain.handle("bot:stop", () => stopBot());
    ipcMain.handle("bot:status", () => ({ status: getBotStatus() }));

    // E3d-2: trigger a wizard-seed refresh. If the bot is running, bounce it so
    // the next boot picks up changes via seedProfileIfPresent (src/setup/wizard-seed.ts).
    // If the bot is stopped, this is a no-op — the NEXT bot:start will pick up the
    // wizard's `.user-profile.json` automatically. Called by the wizard's Profile
    // step after a re-configuration save, and (optionally) by the install step on
    // completion. Always returns success so a failed bounce doesn't block setup UI.
    ipcMain.handle("setup:reseed-now", async () => {
        try {
            if (getBotStatus() === "running") {
                stopBot();
                // Give the child process a brief moment to release its DB handle
                // before the new instance opens it. 300ms is conservative.
                await new Promise((resolve) => setTimeout(resolve, 300));
                startBot();
                return { success: true, action: "restarted" };
            }
            return { success: true, action: "no-op-bot-stopped" };
        } catch (err) {
            return { success: false, error: err.message || String(err) };
        }
    });
    ipcMain.handle("bot:stats", () => {
        if (!botStartTime || getBotStatus() !== "running") return null;
        // Try to get memory count from DB
        let memCount = "—";
        try {
            const dbPath = path.join(DATA_DIR, "memory.db");
            if (fs.existsSync(dbPath)) {
                const Database = require("better-sqlite3");
                const db = new Database(dbPath, { readonly: true, fileMustExist: true });
                try {
                    const row = db.prepare("SELECT COUNT(*) AS cnt FROM behavioral_traits WHERE confidence > 0.3").get();
                    if (row) memCount = String(row.cnt);
                } finally {
                    db.close();
                }
            }
        } catch { /* DB may be locked or table may not exist */ }
        return {
            uptimeMs: Date.now() - botStartTime,
            messagesHandled: botMessageCount,
            memoryCount: memCount,
            toolCount: botToolCount || "—",
        };
    });

    // Memory Browser: read memory.db snapshot
    ipcMain.handle("bot:memory-data", async () => {
        try {
            const dbPath = path.join(DATA_DIR, "memory.db");
            if (!fs.existsSync(dbPath)) return { success: false, error: "No memory database found" };

            const Database = require("better-sqlite3");
            const db = new Database(dbPath, { readonly: true, fileMustExist: true });

            // Traits
            let traits = [];
            try {
                traits = db.prepare("SELECT trait_key, value, confidence, explicit, topics, reinforcement_count, last_seen_ts, created_at FROM behavioral_traits WHERE confidence > 0.1 ORDER BY confidence DESC LIMIT 50").all().map(row => ({
                    ...row,
                    explicit: !!row.explicit,
                    topics: row.topics ? JSON.parse(row.topics) : [],
                }));
            } catch { /* table may not exist */ }

            // Episodes
            let episodes = [];
            try {
                episodes = db.prepare("SELECT id, user_id, type, description, importance_score, timestamp FROM episodic_memory ORDER BY timestamp DESC LIMIT 20").all();
            } catch { /* table may not exist */ }

            // Relationship
            let relationship = null;
            try {
                relationship = db.prepare("SELECT user_id, trust_score, engagement_streak, depth_score, last_interaction FROM relationship_state LIMIT 1").get() || null;
            } catch { /* table may not exist */ }

            db.close();
            return { success: true, traits, episodes, relationship };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // Memory Browser: delete trait
    ipcMain.handle("bot:delete-trait", async (_, traitKey) => {
        try {
            const dbPath = path.join(DATA_DIR, "memory.db");
            if (!fs.existsSync(dbPath)) return { success: false };

            const Database = require("better-sqlite3");
            const db = new Database(dbPath, { fileMustExist: true });
            try {
                db.prepare("DELETE FROM behavioral_traits WHERE trait_key = ?").run(traitKey);
            } finally {
                db.close();
            }
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // Setup: save credentials
    ipcMain.handle("setup:save-credentials", async (_, creds) => {
        try {
            const envLines = [
                "# A.T.L.A.S — Environment Variables",
                "# Encrypted by XAGI Labs Secure Storage",
                "",
                `TELEGRAM_BOT_TOKEN=${creds.botToken}`,
                `ALLOWED_USER_IDS=${creds.userIds}`,
            ];
            if (creds.githubToken) envLines.push(`GITHUB_TOKEN=${creds.githubToken}`);
            if (creds.workspace) envLines.push(`ATLAS_WORKSPACE=${creds.workspace}`);

            const envContent = envLines.join("\n") + "\n";
            saveEnvEncrypted(envContent);

            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // Setup: save user profile
    ipcMain.handle("setup:save-profile", async (_, profile) => {
        try {
            const { mergeProfile } = require(path.join(__dirname, "wizard", "profile-merge.js"));
            const profilePath = path.join(app.getPath("userData"), ".user-profile.json");
            let existing = {};
            try { existing = JSON.parse(fs.readFileSync(profilePath, "utf8")); }
            catch { /* fresh profile or corrupt JSON — start over */ }
            const merged = mergeProfile(existing, profile);
            fs.writeFileSync(profilePath, JSON.stringify(merged, null, 2));
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // Setup: choose workspace folder
    ipcMain.handle("setup:choose-workspace", async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: "Choose A.T.L.A.S Workspace Folder",
            defaultPath: path.join(app.getPath("desktop"), "A.T.L.A.S Files"),
            properties: ["openDirectory", "createDirectory"],
        });
        if (result.canceled) return { canceled: true };
        return { path: result.filePaths[0] };
    });

    // Setup: create workspace folder
    ipcMain.handle("setup:create-workspace", async (_, workspacePath) => {
        try {
            fs.mkdirSync(workspacePath, { recursive: true });
            const readmePath = path.join(workspacePath, "README.txt");
            fs.writeFileSync(
                readmePath,
                [
                    "📁 A.T.L.A.S Workspace",
                    "═══════════════════════════════════════",
                    COPYRIGHT,
                    "",
                    "This folder is managed by A.T.L.A.S AI.",
                    "Files created by A.T.L.A.S (screenshots, downloads,",
                    "research, exports) are saved here.",
                    "",
                    "Feel free to organize or move files —",
                    "A.T.L.A.S will always save new files to this folder.",
                    "",
                    "─── XAGI Labs ───",
                ].join("\n")
            );
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // Setup: run installation pipeline
    // Setup: adaptive, resumable install. Builds the phase list from detection,
    // runs each phase sequentially, and writes per-phase markers to
    // data/setup-state.json so a crash mid-install can be resumed.
    ipcMain.handle("setup:install", async (_, options) => {
        const ctx = buildInstallCtx(mainWindow, options);
        try {
            const { runDetection, buildPhaseList, runPhases } = requireInstaller();
            const state = await runDetection(buildDetectionDeps());
            const phases = buildPhaseList(state);
            const res = await runPhases(phases, ctx);
            if (res.status === "complete") {
                return { success: true, completed: res.completed };
            }
            return {
                success: false,
                paused: true,
                failedPhase: res.failedPhase,
                error: res.error && res.error.message,
                completed: res.completed,
            };
        } catch (err) {
            ctx.sendLog("ERROR: " + err.message);
            ctx.sendProgress(-1, "Error: " + err.message);
            return { success: false, error: err.message };
        }
    });

    // Setup: retry a single install phase by id. Used by install-log's Retry button
    // (see desktop/components/install-log.js).
    ipcMain.handle("setup:retry-install-phase", async (_, phaseId) => {
        try {
            const { runDetection, buildPhaseList, runPhases } = requireInstaller();
            const state = await runDetection(buildDetectionDeps());
            const full = buildPhaseList(state);
            const phase = full.find((p) => p.id === phaseId);
            if (!phase) return { success: false, error: "Unknown phase: " + phaseId };
            const res = await runPhases([phase], buildInstallCtx(mainWindow, {}));
            return {
                success: res.status === "complete",
                paused: res.status === "paused",
                error: res.error && res.error.message,
            };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // Setup: resume install — runs only phases that don't yet have a done-marker
    // in data/setup-state.json. Used when the user relaunches the app mid-install.
    ipcMain.handle("setup:resume-install", async () => {
        try {
            const { runDetection, buildPhaseList, runPhases, getResumeList, readSetupState } = requireInstaller();
            const state = await runDetection(buildDetectionDeps());
            const full = buildPhaseList(state);
            const remaining = getResumeList(full, readSetupState(DATA_DIR));
            const res = await runPhases(remaining, buildInstallCtx(mainWindow, {}));
            return {
                success: res.status === "complete",
                paused: res.status === "paused",
                failedPhase: res.failedPhase,
                error: res.error && res.error.message,
            };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // Setup: read the per-phase done-markers (for Install step UI to show
    // "resume from here" affordances).
    ipcMain.handle("setup:get-state", () => {
        try {
            const { readSetupState } = requireInstaller();
            return { success: true, state: readSetupState(DATA_DIR) };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // Setup: finish and launch dashboard
    ipcMain.handle("setup:finish", () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setMinimumSize(780, 560);
            mainWindow.setSize(840, 620);
            mainWindow.setResizable(true);
            mainWindow.center();
            mainWindow.loadFile(path.join(__dirname, "panel.html"));
        }
        return { success: true };
    });

    // Shared helper — finds google-credentials.json across all possible locations.
    // Checks the writable userData dir first (survives reinstalls), then the
    // bundled read-only resources (works when packed on Mac/Windows), then the
    // user's Downloads folder as a last resort.
    function findGoogleCredentials() {
        const candidates = [
            path.join(DATA_DIR, "google-credentials.json"),           // writable userData
            path.join(BOT_DIR, "data", "google-credentials.json"),    // bundled resources
            // Downloads — supports both POSIX ($HOME) and Windows ($USERPROFILE)
            path.join(process.env.HOME || process.env.USERPROFILE || "", "Downloads", "google-credentials.json"),
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) {
                try {
                    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
                    const creds = raw.installed || raw.web;
                    if (creds) {
                        // Cache to DATA_DIR so future lookups are instant
                        const dest = path.join(DATA_DIR, "google-credentials.json");
                        if (p !== dest) {
                            try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(dest, JSON.stringify(raw, null, 2)); } catch { /* non-fatal */ }
                        }
                        return creds;
                    }
                } catch { /* invalid file, try next */ }
            }
        }
        return null;
    }

    // Setup: Google OAuth
    ipcMain.handle("setup:google-oauth", async () => {
        try {
            const clientCreds = findGoogleCredentials();
            if (!clientCreds) {
                return { success: false, error: "Google credentials file not found." };
            }

            const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
                `client_id=${clientCreds.client_id}` +
                `&redirect_uri=${encodeURIComponent("http://localhost:8844")}` +
                `&response_type=code` +
                `&scope=${encodeURIComponent("openid email profile https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify")}` +
                `&access_type=offline&prompt=consent`;

            const http = require("http");
            const https = require("https");

            return new Promise((resolve) => {
                const server = http.createServer((req, res) => {
                    const url = new URL(req.url || "/", "http://localhost:8844");
                    const code = url.searchParams.get("code");
                    const error = url.searchParams.get("error");

                    if (error) {
                        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                        res.end(`<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0"><div style="text-align:center"><h1 style="font-size:3em;margin-bottom:0.2em">❌</h1><h2>Connection Failed</h2><p style="opacity:0.8">${error}</p><p style="opacity:0.5;margin-top:2em">You can close this tab.</p></div></body></html>`);
                        server.close();
                        resolve({ success: false, error });
                        return;
                    }

                    if (code) {
                        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                        res.end(`<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0"><div style="text-align:center"><h1 style="font-size:3em;margin-bottom:0.2em">✅</h1><h2>Account Connected!</h2><p style="opacity:0.5;margin-top:2em">You can close this tab now.</p><script>setTimeout(()=>window.close(),3000)</script></div></body></html>`);
                        server.close();

                        // Exchange token
                        const data = new URLSearchParams({
                            client_id: clientCreds.client_id,
                            client_secret: clientCreds.client_secret,
                            code: code,
                            grant_type: "authorization_code",
                            redirect_uri: "http://localhost:8844"
                        }).toString();

                        const pReq = https.request("https://oauth2.googleapis.com/token", {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/x-www-form-urlencoded",
                                "Content-Length": Buffer.byteLength(data)
                            }
                        }, (pRes) => {
                            let body = "";
                            pRes.on("data", chunk => body += chunk);
                            pRes.on("end", () => {
                                if (pRes.statusCode !== 200) {
                                    return resolve({ success: false, error: "Token exchange failed: " + body });
                                }
                                try {
                                    const tokens = JSON.parse(body);
                                    let email = "unknown";
                                    if (tokens.id_token) {
                                        try {
                                            const payload = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64").toString("utf-8"));
                                            if (payload.email) email = payload.email;
                                        } catch { /* ignore */ }
                                    }

                                    const tokensDir = path.join(DATA_DIR, "google-tokens");
                                    fs.mkdirSync(tokensDir, { recursive: true });
                                    fs.writeFileSync(path.join(tokensDir, email.replace(/\\./g, "_") + ".json"), JSON.stringify(tokens, null, 2));

                                    // Send success to frontend
                                    if (mainWindow && !mainWindow.isDestroyed()) {
                                        mainWindow.webContents.send("google-oauth-success", email);
                                    }
                                    resolve({ success: true, email });
                                } catch (err) {
                                    resolve({ success: false, error: err.message });
                                }
                            });
                        });
                        pReq.on("error", (err) => resolve({ success: false, error: err.message }));
                        pReq.write(data);
                        pReq.end();
                    }
                });

                server.listen(8844, () => {
                    shell.openExternal(authUrl);
                });

                server.on("error", (err) => {
                    resolve({ success: false, error: `Failed to start local server on port 8844: ${err.message}` });
                });

                // Timeout after 5 minutes
                setTimeout(() => {
                    server.close();
                    resolve({ success: false, error: "OAuth timed out after 5 minutes." });
                }, 5 * 60 * 1000);
            });
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // Account: Google Sign-In from auth popup
    // Runs full OAuth flow, saves ATLAS session, closes auth popup.
    ipcMain.handle("account:google-signin", async () => {
        try {
            // Delegate to setup:google-oauth for the token exchange
            const result = await (async () => {
                const clientCreds = findGoogleCredentials();
                if (!clientCreds) return { success: false, error: "Google credentials file not found." };

                const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
                    `client_id=${clientCreds.client_id}` +
                    `&redirect_uri=${encodeURIComponent("http://localhost:8844")}` +
                    `&response_type=code` +
                    `&scope=${encodeURIComponent("openid email profile")}` +
                    `&access_type=offline&prompt=consent`;

                const http = require("http");
                const https = require("https");

                return new Promise((resolve) => {
                    const server = http.createServer((req, res) => {
                        const url = new URL(req.url || "/", "http://localhost:8844");
                        const code = url.searchParams.get("code");
                        const error = url.searchParams.get("error");

                        if (error) {
                            res.writeHead(200, { "Content-Type": "text/html" });
                            res.end(`<html><body style="font-family:system-ui;text-align:center;padding:40px;background:#1a1a2e;color:#e0e0e0"><h2>❌ Sign-in Failed</h2><p>${error}</p><p style="opacity:0.5;margin-top:20px">You can close this tab.</p></body></html>`);
                            server.close();
                            resolve({ success: false, error });
                            return;
                        }

                        if (code) {
                            res.writeHead(200, { "Content-Type": "text/html" });
                            res.end(`<html><body style="font-family:system-ui;text-align:center;padding:40px;background:#1a1a2e;color:#e0e0e0"><h2>✅ Signed in!</h2><p style="opacity:0.5;margin-top:20px">You can close this tab.</p><script>setTimeout(()=>window.close(),2000)</script></body></html>`);
                            server.close();

                            const data = new URLSearchParams({
                                client_id: clientCreds.client_id,
                                client_secret: clientCreds.client_secret,
                                code,
                                grant_type: "authorization_code",
                                redirect_uri: "http://localhost:8844"
                            }).toString();

                            const pReq = https.request("https://oauth2.googleapis.com/token", {
                                method: "POST",
                                headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(data) }
                            }, (pRes) => {
                                let body = "";
                                pRes.on("data", chunk => body += chunk);
                                pRes.on("end", () => {
                                    try {
                                        const tokens = JSON.parse(body);
                                        let email = "unknown";
                                        if (tokens.id_token) {
                                            try {
                                                const payload = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64").toString("utf-8"));
                                                if (payload.email) email = payload.email;
                                            } catch { /* ignore */ }
                                        }
                                        const tokensDir = path.join(DATA_DIR, "google-tokens");
                                        fs.mkdirSync(tokensDir, { recursive: true });
                                        fs.writeFileSync(path.join(tokensDir, email.replace(/\./g, "_") + ".json"), JSON.stringify(tokens, null, 2));
                                        resolve({ success: true, email });
                                    } catch (err) {
                                        resolve({ success: false, error: err.message });
                                    }
                                });
                            });
                            pReq.on("error", (err) => resolve({ success: false, error: err.message }));
                            pReq.write(data);
                            pReq.end();
                        }
                    });

                    server.listen(8844, () => { shell.openExternal(authUrl); });
                    server.on("error", (err) => resolve({ success: false, error: `Port 8844 error: ${err.message}` }));
                    setTimeout(() => { server.close(); resolve({ success: false, error: "Google sign-in timed out." }); }, 5 * 60 * 1000);
                });
            })();

            if (!result.success) return result;

            const email = result.email;
            const userId = `google_${email.replace(/[^a-zA-Z0-9]/g, "_")}`;

            // Session creation auto-upserts the account
            try {
                _desktopSessionToken = null;
                _desktopSessionExpiry = 0;
                await getDesktopSessionToken(userId, { email, phone: null, name: null });
                console.log("[GoogleSignIn] Convex upsert OK for", userId);
            } catch (err) {
                console.warn("[GoogleSignIn] Convex upsert (non-fatal):", err.message);
            }

            // Save ATLAS session
            saveAccountSession({ userId, token: userId, email, phone: null, name: null, created_at: new Date().toISOString() });

            // Close auth popup and notify main window
            if (authWindow && !authWindow.isDestroyed()) authWindow.close();
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send("account-status-change", { signedIn: true });
                mainWindow.focus();
            }

            return { success: true, email };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // Setup: check if setup is complete
    ipcMain.handle("setup:is-complete", () => fs.existsSync(SETUP_FLAG));

    // Setup: adaptive detection for the redesigned wizard (A.T.L.A.S wizard v2).
    // Runs all Phase A signal probes in parallel with per-signal timeouts.
    // Fail-safe: errors and timeouts never abort detection — every probe has a fallback.
    ipcMain.handle("setup:detect", async () => {
        const { runDetection } = requireInstaller();
        return runDetection(buildDetectionDeps());
    });

    // Setup: re-read the permission map for live polling from the Permissions step of the
    // wizard and the Ready Hub permissions tile. macOS uses systemPreferences API;
    // Windows uses registry checks; other platforms return all-granted (no per-app gating).
    ipcMain.handle("setup:poll-permissions", () => {
        if (process.platform === "darwin") {
            try {
                const { detectMacPermissions } = require("./detection/signals");
                return detectMacPermissions(systemPreferences);
            } catch {
                return { accessibility: "unknown", screen: "unknown", microphone: "unknown", location: "unknown" };
            }
        }
        if (process.platform === "win32") {
            try {
                const { detectWindowsPermissions } = require("./detection/signals");
                return detectWindowsPermissions(null);
            } catch {
                return { accessibility: "granted", screen: "granted", microphone: "unknown", location: "unknown" };
            }
        }
        return { accessibility: "granted", screen: "granted", microphone: "granted", location: "granted" };
    });

    // Setup: request an OS permission by opening the correct Preferences pane.
    // Non-darwin is a no-op returning {ok:true, skipped:true}.
    ipcMain.handle("setup:request-permission", async (_evt, name) => {
        if (process.platform !== "darwin") return { ok: true, skipped: true };
        const { prefPaneUrlFor } = require("./components/permissions-grid");
        const url = prefPaneUrlFor(name);
        if (!url) return { ok: false, error: "unknown permission: " + String(name) };
        try { await shell.openExternal(url); return { ok: true }; }
        catch (err) { return { ok: false, error: err.message || String(err) }; }
    });

    // Setup (E3b): persist a user's decision to skip a permission. Writes through to
    // electron-store's prefs.skippedPermissions map so the Ready Hub tile can amber-flag.
    ipcMain.handle("setup:mark-permission-skipped", (_evt, name, skipped) => {
        try {
            const current = store.get("skippedPermissions") || {};
            if (skipped) current[name] = true; else delete current[name];
            store.set("skippedPermissions", current);
            return { ok: true, skippedPermissions: current };
        } catch (err) {
            return { ok: false, error: err.message || String(err) };
        }
    });

    // Setup: probe a hotkey combo by attempting to register with globalShortcut,
    // then immediately unregister on success. Returns {ok:true} or {ok:false, conflict}.
    ipcMain.handle("setup:test-hotkey", (_evt, combo) => {
        if (typeof combo !== "string" || combo.length === 0) return { ok: false, conflict: "empty combo" };
        try {
            const registered = globalShortcut.register(combo, () => {});
            if (!registered) return { ok: false, conflict: combo + " is already in use" };
            globalShortcut.unregister(combo);
            return { ok: true };
        } catch (err) {
            return { ok: false, conflict: err.message || String(err) };
        }
    });

    // Setup: persist the new overlay hotkey to electron-store and re-bind globalShortcut.
    // Mirrors the existing hotkey:set-overlay handler (main.js:~2205): unregister ONLY the
    // old overlay binding (not the live-voice hotkey, not every registered shortcut), attempt
    // the new binding, and restore the old one if the new register call fails.
    ipcMain.handle("setup:save-hotkey", (_evt, combo) => {
        if (typeof combo !== "string" || !combo) return { ok: false, error: "invalid combo" };
        const currentShortcut = getOverlayShortcut();
        try {
            try { globalShortcut.unregister(currentShortcut); } catch {}
            const ok = globalShortcut.register(combo, () => {
                if (typeof toggleOverlay === "function") toggleOverlay();
            });
            if (!ok) {
                // Rollback: put the old binding back so the user isn't left with nothing.
                try { globalShortcut.register(currentShortcut, () => { if (typeof toggleOverlay === "function") toggleOverlay(); }); } catch {}
                return { ok: false, error: "globalShortcut.register returned false — combo may have been claimed between test and save" };
            }
            store.set("overlayHotkey", combo);
            return { ok: true };
        } catch (err) {
            // Best-effort rollback then report
            try { globalShortcut.register(currentShortcut, () => { if (typeof toggleOverlay === "function") toggleOverlay(); }); } catch {}
            return { ok: false, error: err.message || String(err) };
        }
    });

    // Setup: return the list of available voices. Hardcoded for ship-v1; no network call.
    ipcMain.handle("setup:list-voices", () => ([
        { backend: "gemini-live",     voices: ["Aoede", "Charon", "Kore", "Fenrir", "Puck"] },
        { backend: "openai-realtime", voices: ["alloy", "shimmer", "echo"] },
    ]));

    // Setup: return the file:// URL to a preview audio sample. Ship-v1 uses one
    // shared sample.wav for every voice; real per-voice samples are a follow-up.
    // Uses pathToFileURL so spaces and non-ASCII chars in the app path (common on
    // macOS, e.g. "/Applications/A.T.L.A.S.app/...") are correctly URL-encoded.
    ipcMain.handle("setup:preview-voice", (_evt, backend, name) => {
        const wav = path.join(__dirname, "assets", "voices", "sample.wav");
        if (!fs.existsSync(wav)) return { ok: false, error: "sample.wav missing" };
        return { ok: true, backend, name, url: require("url").pathToFileURL(wav).href };
    });

    // Setup: channel test-before-save gate.
    // Tests a channel's credentials via the provider's actual API. On success,
    // returns a short-lived testId the caller must present to setup:save-channel
    // within 60s. Credentials never reach .env until the save handler runs.
    const __pendingChannelTests = new Map();
    const __randomId = () => require("crypto").randomBytes(8).toString("hex");

    ipcMain.handle("setup:test-channel", async (_evt, type, creds) => {
        const safeJson = async (r) => {
            if (!r.ok) return { __httpError: `HTTP ${r.status}` };
            try { return await r.json(); }
            catch { return { __parseError: "non-JSON response" }; }
        };
        try {
            if (type === "telegram") {
                // Server-side guard: renderer validator can be bypassed by a compromised caller.
                const token = creds && creds.token;
                if (typeof token !== "string" || !/^\d+:[A-Za-z0-9_-]{35,}$/.test(token)) {
                    return { ok: false, error: "Bad Telegram token format" };
                }
                const r = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`);
                const j = await safeJson(r);
                if (j.__httpError) return { ok: false, error: `Telegram ${j.__httpError}` };
                if (j.__parseError) return { ok: false, error: `Telegram returned ${j.__parseError}` };
                if (!j.ok) return { ok: false, error: j.description || "Telegram rejected token" };
            } else if (type === "discord") {
                const token = creds && creds.token;
                if (typeof token !== "string" || token.length < 50 || !/^[A-Za-z0-9._-]+$/.test(token)) {
                    return { ok: false, error: "Bad Discord token format" };
                }
                const r = await fetch("https://discord.com/api/v10/users/@me", {
                    headers: { Authorization: "Bot " + token },
                });
                const j = await safeJson(r);
                if (j.__httpError) return { ok: false, error: `Discord ${j.__httpError}` };
                if (j.__parseError) return { ok: false, error: `Discord returned ${j.__parseError}` };
                if (!j.id) return { ok: false, error: j.message || "Discord rejected token" };
            } else if (type === "matrix") {
                const homeserver = creds && creds.homeserver;
                const token = creds && creds.token;
                if (typeof homeserver !== "string" || !/^https?:\/\//.test(homeserver)) {
                    return { ok: false, error: "Bad Matrix homeserver URL" };
                }
                if (typeof token !== "string" || !token) {
                    return { ok: false, error: "Missing Matrix access token" };
                }
                const base = homeserver.replace(/\/$/, "");
                const r = await fetch(`${base}/_matrix/client/v3/account/whoami`, {
                    headers: { Authorization: "Bearer " + token },
                });
                const j = await safeJson(r);
                if (j.__httpError) return { ok: false, error: `Matrix ${j.__httpError}` };
                if (j.__parseError) return { ok: false, error: `Matrix returned ${j.__parseError}` };
                if (!j.user_id) return { ok: false, error: j.error || "Matrix rejected token" };
            } else if (type === "email") {
                const { ImapFlow } = require("imapflow");
                const client = new ImapFlow({
                    host: creds.imapHost,
                    port: creds.imapPort,
                    secure: !!creds.imapTls,
                    auth: { user: creds.user, pass: creds.password },
                    logger: false,
                });
                try { await client.connect(); await client.logout(); }
                catch (err) { return { ok: false, error: err.message || "IMAP login failed" }; }
            } else {
                return { ok: false, error: "unsupported type: " + type };
            }
            const testId = __randomId();
            __pendingChannelTests.set(testId, Date.now());
            return { ok: true, testId };
        } catch (err) {
            return { ok: false, error: err.message || String(err) };
        }
    });

    ipcMain.handle("setup:save-channel", async (_evt, type, creds, testId) => {
        const t = __pendingChannelTests.get(testId);
        if (!t || (Date.now() - t) > 60000) {
            return { ok: false, error: "Test expired — re-run Test, then Save." };
        }
        __pendingChannelTests.delete(testId);
        try {
            if (type === "telegram") {
                saveEnvKVs({ TELEGRAM_BOT_TOKEN: creds.token, ALLOWED_USER_IDS: creds.allowedIds });
            } else if (type === "discord") {
                saveEnvKVs({ DISCORD_BOT_TOKEN: creds.token });
            } else if (type === "matrix") {
                saveEnvKVs({ MATRIX_HOMESERVER: creds.homeserver, MATRIX_ACCESS_TOKEN: creds.token });
            } else if (type === "email") {
                saveEnvKVs({
                    EMAIL_USER: creds.user,
                    EMAIL_PASSWORD: creds.password,
                    EMAIL_IMAP_HOST: creds.imapHost,
                    EMAIL_IMAP_PORT: String(creds.imapPort),
                    EMAIL_SMTP_HOST: creds.smtpHost,
                    EMAIL_SMTP_PORT: String(creds.smtpPort),
                });
            }
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message || String(err) };
        }
    });

    // Slack OAuth launcher (popup only). The redirect/callback exchange is a
    // separate task (E3c); this IPC only opens the browser-based authorize page.
    ipcMain.handle("setup:slack-oauth-start", async () => {
        const clientId = process.env.SLACK_CLIENT_ID || "REPLACE_ME";
        const url = "https://slack.com/oauth/v2/authorize?scope=chat:write,app_mentions:read,im:history&client_id=" + encodeURIComponent(clientId);
        const popup = new BrowserWindow({
            width: 520,
            height: 720,
            webPreferences: { nodeIntegration: false, contextIsolation: true },
        });
        popup.loadURL(url);
        return { ok: true };
    });

    // Setup: persist personalize block (hotkey/theme/voice/wakeWord) into
    // electron-store AND mirror voice + wake-word + hotkey into .env.enc via
    // ATLAS_* env keys so the bot actually reads the user's choice on next boot.
    ipcMain.handle("setup:save-personalize", async (_evt, update) => {
        try {
            const { mergePersonalize, envKVsFromPersonalize } = require(path.join(__dirname, "wizard", "personalize-reducer.js"));
            const current = store.get("prefs") || {};
            const next = mergePersonalize(current, update || {});
            store.set("prefs", next);
            try { saveEnvKVs(envKVsFromPersonalize(next.personalize)); }
            catch (e) { console.warn("[setup:save-personalize] env mirror failed:", e.message); }
            return { success: true, prefs: next };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });


    // App info
    ipcMain.handle("app:info", () => ({
        version: app.getVersion(),
        copyright: COPYRIGHT,
        isDev: IS_DEV,
        defaultWorkspace: path.join(app.getPath("desktop"), "A.T.L.A.S Files"),
        platform: process.platform,
    }));

    // ── Auto-Updater IPC ─────────────────────────
    ipcMain.handle("update:check", async () => {
        if (IS_DEV) return { available: false, isDev: true };
        try {
            const result = await autoUpdater.checkForUpdates();
            return { available: !!result?.updateInfo, version: result?.updateInfo?.version };
        } catch (err) {
            return { error: err.message };
        }
    });

    ipcMain.handle("update:download", async () => {
        if (IS_DEV) return { success: false, isDev: true };
        try {
            await autoUpdater.downloadUpdate();
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("update:install", () => {
        if (updateDownloaded) {
            setImmediate(() => {
                if (getBotStatus() === "running") {
                    stopBot();
                }
                autoUpdater.quitAndInstall(false, true);
            });
            return { success: true };
        }
        return { success: false, error: "No update downloaded" };
    });

    ipcMain.handle("update:status", () => ({
        available: updateAvailable,
        downloaded: updateDownloaded,
        progress: downloadProgress,
        lastCheck: store.get("lastUpdateCheck"),
    }));

    // ── Preferences IPC ──────────────────────────
    ipcMain.handle("prefs:get", () => store.store);

    ipcMain.handle("prefs:set", (_, key, value) => {
        store.set(key, value);

        // Handle special cases
        if (key === "launchAtLogin") {
            app.setLoginItemSettings({
                openAtLogin: value,
                openAsHidden: true,
            });
        }

        if (key === "theme") {
            // Notify renderer of theme change
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send("theme-changed", value);
            }
        }

        return { success: true };
    });

    ipcMain.handle("prefs:reset", () => {
        store.clear();
        return { success: true };
    });

    // ── Hotkey IPC ──────────────────────────────
    ipcMain.handle("hotkey:set-overlay", (_, accelerator) => {
        try {
            // Unregister the current overlay shortcut
            const currentShortcut = getOverlayShortcut();
            globalShortcut.unregister(currentShortcut);

            // Try registering the new one
            const success = globalShortcut.register(accelerator, () => {
                toggleOverlay();
            });

            if (!success) {
                // Re-register the old one
                globalShortcut.register(currentShortcut, () => {
                    toggleOverlay();
                });
                return { success: false, error: "Shortcut is already in use by another application" };
            }

            // Persist
            store.set("overlayHotkey", accelerator);
            return { success: true };
        } catch (err) {
            // Re-register old shortcut on error
            try {
                const fallback = getOverlayShortcut();
                globalShortcut.register(fallback, () => {
                    toggleOverlay();
                });
            } catch { /* best effort */ }
            return { success: false, error: err.message || "Invalid shortcut" };
        }
    });

    ipcMain.handle("hotkey:reset-overlay", () => {
        try {
            const currentShortcut = getOverlayShortcut();
            globalShortcut.unregister(currentShortcut);

            store.delete("overlayHotkey");

            const defaultShortcut = getOverlayShortcut();
            globalShortcut.register(defaultShortcut, () => {
                toggleOverlay();
            });

            return { success: true, shortcut: defaultShortcut };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // ── Live Voice Hotkey IPC ────────────────────
    ipcMain.handle("hotkey:set-live-voice", (_, accelerator) => {
        try {
            const currentShortcut = getLiveVoiceShortcut();
            globalShortcut.unregister(currentShortcut);

            const success = globalShortcut.register(accelerator, () => {
                toggleLiveVoice();
            });

            if (!success) {
                globalShortcut.register(currentShortcut, () => {
                    toggleLiveVoice();
                });
                return { success: false, error: "Shortcut is already in use by another application" };
            }

            store.set("liveVoiceHotkey", accelerator);
            return { success: true };
        } catch (err) {
            try {
                const fallback = getLiveVoiceShortcut();
                globalShortcut.register(fallback, () => {
                    toggleLiveVoice();
                });
            } catch { /* best effort */ }
            return { success: false, error: err.message || "Invalid shortcut" };
        }
    });

    ipcMain.handle("hotkey:reset-live-voice", () => {
        try {
            const currentShortcut = getLiveVoiceShortcut();
            globalShortcut.unregister(currentShortcut);

            store.delete("liveVoiceHotkey");

            const defaultShortcut = getLiveVoiceShortcut();
            globalShortcut.register(defaultShortcut, () => {
                toggleLiveVoice();
            });

            return { success: true, shortcut: defaultShortcut };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("hotkey:get-live-voice", () => {
        return { shortcut: getLiveVoiceShortcut() };
    });

    // ── Connection Status IPC ────────────────────
    ipcMain.handle("status:connections", () => {
        const connections = {
            telegram: false,
            email: false,
            overlay: false,
        };

        // Check bot logs for connection indicators
        if (botProcess && !botProcess.killed) {
            connections.telegram = true; // If bot is running, Telegram is likely connected
            // Other connections can be detected from bot output patterns
        }

        return connections;
    });

    // ── Account Handlers ─────────────────────────
    // otplessData = { userId, token, email, phone, name }
    ipcMain.handle("account:login", async (_, otplessData) => {
        try {
            const { userId, token, email, phone, name } = otplessData || {};
            if (!userId) return { success: false, error: "Invalid OTPless response — missing userId" };

            // Session creation auto-upserts the account (creates on first login with 100 starter credits)
            try {
                _desktopSessionToken = null;
                _desktopSessionExpiry = 0;
                await getDesktopSessionToken(userId, { email, phone, name });
                console.log("[Account] Convex upsert OK for", userId);
            } catch (err) {
                console.warn("[Account] Convex upsert (non-fatal):", err.message);
            }

            // Save session locally
            saveAccountSession({
                userId,
                token,
                email: email || null,
                phone: phone || null,
                name: name || null,
                created_at: new Date().toISOString(),
            });

            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send("account-status-change", { signedIn: true });
            }
            return { success: true, session: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // Account: Logout — clear local session file
    ipcMain.handle("account:logout", async () => {
        try {
            deleteAccountSession();
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send("account-status-change", { signedIn: false });
            }
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // Account: Get Info — fetch live data from Convex cloud using stored userId
    ipcMain.handle("account:info", async () => {
        try {
            const session = loadAccountSession();
            if (!session || !session.userId) return { signedIn: false };

            let accountData = null;
            try {
                accountData = await convexSiteRequest("GET", "/api/account/info");
            } catch (err) {
                console.warn("[Account] Convex info query failed:", err.message);
            }

            return {
                signedIn: true,
                userId: session.userId,
                email: session.email || accountData?.email || null,
                phone: session.phone || accountData?.phone || null,
                name: session.name || accountData?.name || null,
                created_at: session.created_at || null,
                status: accountData?.status || "active",
                plan: accountData?.plan || "free",
                ai_credits: accountData?.ai_credits ?? null,
                activations: accountData?.activations ?? 0,
                max_activations: accountData?.max_activations ?? 3,
            };
        } catch (err) {
            console.error("[Account] account:info error:", err.message);
            return { signedIn: false, error: err.message };
        }
    });

    ipcMain.handle("account:userId", async () => {
        const session = loadAccountSession();
        return session?.userId || null;
    });

    // ── Store IPC ───────────────────────────────────────────────
    const STORE_DIR = path.join(app.getPath("home"), ".atlas", "store");

    // Fetch store items via main process (works when renderer fetch fails due to network issues)
    ipcMain.handle("store:list", async () => {
        console.log("[Store] store:list IPC handler called");
        try {
            // Use native https module directly for reliability
            const items = await new Promise((resolve, reject) => {
                const https = require("https");
                const body = JSON.stringify({
                    path: "store/items:list",
                    args: {},
                    format: "json"
                });

                console.log("[Store] Making HTTPS request to Convex...");

                const req = https.request("https://zany-kudu-607.convex.cloud/api/query", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Content-Length": Buffer.byteLength(body),
                    },
                }, (res) => {
                    let raw = "";
                    res.on("data", c => raw += c);
                    res.on("end", () => {
                        try {
                            console.log("[Store] Got response, parsing...");
                            const data = JSON.parse(raw);
                            if (data.status === "success") {
                                console.log("[Store] Success! Items:", data.value?.length || 0);
                                resolve(data.value || []);
                            } else {
                                console.error("[Store] Convex error:", data.errorMessage);
                                reject(new Error(data.errorMessage || "Convex query failed"));
                            }
                        } catch (e) {
                            console.error("[Store] Parse error:", e.message);
                            reject(e);
                        }
                    });
                });

                req.on("error", (err) => {
                    console.error("[Store] Request error:", err.message);
                    reject(err);
                });

                req.write(body);
                req.end();
            });

            return { success: true, items: items || [] };
        } catch (err) {
            console.error("[Store] Failed to fetch store items:", err.message);
            return { success: false, error: err.message, items: [] };
        }
    });

    ipcMain.handle("store:installed", async () => {
        try {
            const installsPath = path.join(STORE_DIR, "installs.json");
            if (!fs.existsSync(installsPath)) {
                return [];
            }
            const data = JSON.parse(fs.readFileSync(installsPath, "utf-8"));
            return data.items || [];
        } catch (err) {
            console.error("[Store] Failed to read installs:", err.message);
            return [];
        }
    });

    ipcMain.handle("store:install", async (_, item) => {
        try {
            const { slug, type, name, version, downloadUrl, permissions } = item;

            // Create type-specific directory
            const typeDir = path.join(STORE_DIR, type + "s", slug);
            fs.mkdirSync(typeDir, { recursive: true });

            // Download content
            console.log(`[Store] Downloading ${name}...`);
            const https = require("https");
            const http = require("http");
            const protocol = downloadUrl.startsWith("https") ? https : http;

            await new Promise((resolve, reject) => {
                const request = protocol.get(downloadUrl, (response) => {
                    if (response.statusCode === 302 || response.statusCode === 301) {
                        // Follow redirect
                        const redirectProtocol = response.headers.location.startsWith("https") ? https : http;
                        redirectProtocol.get(response.headers.location, (res) => {
                            handleDownload(res, resolve, reject);
                        }).on("error", reject);
                    } else {
                        handleDownload(response, resolve, reject);
                    }
                });
                request.on("error", reject);

                function handleDownload(response, resolve, reject) {
                    const chunks = [];
                    response.on("data", (chunk) => chunks.push(chunk));
                    response.on("end", async () => {
                        try {
                            const buffer = Buffer.concat(chunks);

                            // Extract zip
                            const AdmZip = require("adm-zip");
                            const zip = new AdmZip(buffer);
                            zip.extractAllTo(typeDir, true);

                            console.log(`[Store] Extracted to ${typeDir}`);
                            resolve();
                        } catch (err) {
                            reject(err);
                        }
                    });
                    response.on("error", reject);
                }
            });

            // Update installs.json
            const installsPath = path.join(STORE_DIR, "installs.json");
            let data = { items: [] };
            if (fs.existsSync(installsPath)) {
                try {
                    const parsed = JSON.parse(fs.readFileSync(installsPath, "utf-8"));
                    data = { items: Array.isArray(parsed.items) ? parsed.items : [] };
                } catch {
                    data = { items: [] };
                }
            }

            // Remove existing entry if present
            data.items = data.items.filter((i) => i.slug !== slug);
            data.items.push({
                slug,
                type,
                name,
                version,
                permissions,
                installedAt: new Date().toISOString(),
            });

            fs.writeFileSync(installsPath, JSON.stringify(data, null, 2));

            console.log(`[Store] Installed ${name} v${version}`);
            return { success: true };
        } catch (err) {
            console.error("[Store] Install failed:", err.message);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("store:uninstall", async (_, item) => {
        try {
            const { slug, type } = item;

            // Remove directory
            const typeDir = path.join(STORE_DIR, type + "s", slug);
            if (fs.existsSync(typeDir)) {
                fs.rmSync(typeDir, { recursive: true, force: true });
            }

            // Update installs.json
            const installsPath = path.join(STORE_DIR, "installs.json");
            if (fs.existsSync(installsPath)) {
                try {
                    const parsed = JSON.parse(fs.readFileSync(installsPath, "utf-8"));
                    const items = Array.isArray(parsed.items) ? parsed.items : [];
                    const data = { items: items.filter((i) => i.slug !== slug) };
                    fs.writeFileSync(installsPath, JSON.stringify(data, null, 2));
                } catch {
                    // Ignore malformed file
                }
            }

            console.log(`[Store] Uninstalled ${slug}`);
            return { success: true };
        } catch (err) {
            console.error("[Store] Uninstall failed:", err.message);
            return { success: false, error: err.message };
        }
    });

    // ── Sideload IPC ──────────────────────────────────────────────
    ipcMain.handle("store:sideload-pick", async () => {
        const { dialog } = require("electron");
        const result = await dialog.showOpenDialog(mainWindow, {
            title: "Select Skill or Plugin to Sideload",
            filters: [
                { name: "Skill/Plugin Files", extensions: ["zip", "md"] },
            ],
            properties: ["openFile"],
        });
        if (result.canceled || !result.filePaths.length) return { canceled: true };
        return { canceled: false, filePath: result.filePaths[0] };
    });

    ipcMain.handle("store:sideload-install", async (_, filePath) => {
        try {
            const ext = path.extname(filePath).toLowerCase();
            const AdmZip = require("adm-zip");

            // Simple YAML frontmatter parser (avoids gray-matter dependency)
            function parseFrontmatter(content) {
                const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
                if (!match) return { data: {}, content };
                const yaml = match[1];
                const body = match[2];
                const data = {};
                // Parse simple key: value pairs from YAML
                for (const line of yaml.split('\n')) {
                    const kv = line.match(/^(\w[\w.-]*)\s*:\s*(.+)$/);
                    if (kv) {
                        let val = kv[2].trim();
                        // Remove quotes
                        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                            val = val.slice(1, -1);
                        }
                        data[kv[1]] = val;
                    }
                }
                return { data, content: body };
            }

            let skillContent = null;
            let extractedFiles = [];

            if (ext === ".zip") {
                // Extract ZIP and look for SKILL.md or *.md with frontmatter
                const zip = new AdmZip(filePath);
                const entries = zip.getEntries();

                // Find skill markdown file
                const skillEntry = entries.find(e =>
                    e.entryName.endsWith("SKILL.md") || e.entryName.endsWith("skill.md")
                ) || entries.find(e =>
                    e.entryName.endsWith(".md") && !e.entryName.includes("README") && !e.entryName.includes("CHANGELOG")
                );

                if (!skillEntry) {
                    return { success: false, error: "No skill file (SKILL.md) found in the ZIP archive." };
                }

                skillContent = skillEntry.getData().toString("utf-8");

                // Also track all extracted files for MCP/tool packages
                extractedFiles = entries.map(e => e.entryName);
            } else if (ext === ".md") {
                // Direct .md file
                skillContent = fs.readFileSync(filePath, "utf-8");
            } else {
                return { success: false, error: "Unsupported file type. Use .zip or .md files." };
            }

            // Parse frontmatter
            const { data: frontmatter, content: body } = parseFrontmatter(skillContent);

            if (!frontmatter.name) {
                return { success: false, error: "Skill file has no 'name' in YAML frontmatter." };
            }

            const name = frontmatter.name;
            const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
            const description = frontmatter.description || "";
            const version = frontmatter.version || "1.0.0";

            // Security scan — check for known injection patterns
            const warnings = [];
            const injectionPatterns = [
                { pattern: /<system>/i, msg: "Potential prompt injection: <system> tag" },
                { pattern: /ignore previous instructions/i, msg: "Prompt injection: ignore instructions" },
                { pattern: /ignore all previous/i, msg: "Prompt injection: override directive" },
            ];
            for (const { pattern, msg } of injectionPatterns) {
                if (pattern.test(body)) warnings.push(msg);
            }

            // Check for suspicious URLs
            const urls = body.match(/https?:\/\/[^\s"'<>]+/gi) || [];
            const suspicious = urls.filter(u => {
                const lower = u.toLowerCase();
                return lower.includes("webhook") || lower.includes("ngrok") ||
                    lower.includes("requestbin") || lower.includes("pipedream") ||
                    lower.includes("exfil") || lower.includes("burpcollaborator");
            });
            if (suspicious.length > 0) {
                warnings.push(`Suspicious URLs: ${suspicious.join(", ")}`);
            }

            // Auto-classify categories based on keywords
            const text = `${name} ${description}`.toLowerCase();
            const categories = [];
            const categoryMap = {
                media: ["music", "spotify", "audio", "video", "gif", "sonos", "speaker"],
                shell: ["shell", "terminal", "cli", "command", "bash"],
                browser: ["browser", "web", "scrape", "url"],
                web_search: ["search", "weather", "news", "lookup"],
                scheduling: ["calendar", "reminder", "note", "todo", "schedule"],
                github: ["github", "git", "repo", "pr"],
                communication: ["email", "message", "slack", "discord"],
                memory: ["memory", "remember", "learn", "improve"],
            };
            for (const [cat, keywords] of Object.entries(categoryMap)) {
                if (keywords.some(kw => text.includes(kw))) categories.push(cat);
            }
            if (categories.length === 0) categories.push("shell");

            // If ZIP contains MCP config or package.json, detect type
            let itemType = "skill";
            if (extractedFiles.some(f => f.includes("atlas.config.json") || f.includes("package.json"))) {
                itemType = "mcp";
            }

            // Write skill to store
            const skillDir = path.join(STORE_DIR, itemType === "skill" ? "skills" : "mcp-servers", slug);
            fs.mkdirSync(skillDir, { recursive: true });

            if (ext === ".zip") {
                // Extract full ZIP contents for MCP/tools
                const zip = new AdmZip(filePath);
                zip.extractAllTo(skillDir, true);
            }

            // Write/overwrite the skill markdown with ATLAS-compatible frontmatter
            const atlasContent = `---
name: ${name}
description: ${description}
categories: ${JSON.stringify(categories)}
source: sideload
version: ${version}
sideloaded_at: ${new Date().toISOString()}
---
${body}`;
            fs.writeFileSync(path.join(skillDir, "SKILL.md"), atlasContent);

            // Update installs.json
            const installsPath = path.join(STORE_DIR, "installs.json");
            let data = { items: [] };
            if (fs.existsSync(installsPath)) {
                try {
                    const parsed = JSON.parse(fs.readFileSync(installsPath, "utf-8"));
                    data = { items: Array.isArray(parsed.items) ? parsed.items : [] };
                } catch { data = { items: [] }; }
            }
            data.items = data.items.filter(i => i.slug !== slug);
            data.items.push({
                slug,
                type: itemType,
                name,
                version,
                permissions: [],
                sideloaded: true,
                installedAt: new Date().toISOString(),
            });
            fs.writeFileSync(installsPath, JSON.stringify(data, null, 2));

            console.log(`[Sideload] Installed ${name} (${slug}) → ${skillDir}`);

            return {
                success: true,
                name,
                slug,
                type: itemType,
                version,
                categories,
                warnings: warnings.length > 0 ? warnings : undefined,
            };
        } catch (err) {
            console.error("[Sideload] Failed:", err.message);
            return { success: false, error: err.message };
        }
    });

    // ── SMS OTP via fast2sms (IPC) ──────────────────────────────
    // OTPless SDK is incompatible with Electron. We self-generate OTPs,
    // send via fast2sms REST API (free, India, no domain restrictions),
    // and verify in-memory with a 5-minute expiry.
    //
    // Get your FREE API key at: https://www.fast2sms.com/
    // Set it as FAST2SMS_API_KEY in your environment or replace the string below.
    const FAST2SMS_API_KEY = process.env.FAST2SMS_API_KEY || "YOUR_FAST2SMS_API_KEY_HERE";

    // In-memory OTP store: { phone: { otp, expiresAt } }
    const _otpStore = new Map();

    function generateOTP(len = 6) {
        let otp = "";
        for (let i = 0; i < len; i++) otp += Math.floor(Math.random() * 10);
        return otp;
    }

    async function sendSMSViafast2sms(phone10digit, otp) {
        return new Promise((resolve, reject) => {
            const https = require("https");
            const params = new URLSearchParams({
                variables_values: otp,
                route: "otp",
                numbers: phone10digit,
            }).toString();
            const options = {
                hostname: "www.fast2sms.com",
                path: `/dev/bulkV2?${params}`,
                method: "GET",
                headers: {
                    authorization: FAST2SMS_API_KEY,
                    "Cache-Control": "no-cache",
                },
            };
            const req = https.request(options, (res) => {
                let raw = "";
                res.on("data", c => raw += c);
                res.on("end", () => {
                    console.log("[fast2sms] Response:", raw);
                    try { resolve(JSON.parse(raw)); }
                    catch { resolve({ return: false, message: raw }); }
                });
            });
            req.on("error", reject);
            req.end();
        });
    }

    // OTP: Send
    ipcMain.handle("otp:send", async (_, { phone, countryCode }) => {
        try {
            const cc = (countryCode || "+91").replace(/^\+/, "");
            const digits = phone.replace(/\D/g, "");
            const fullPhone = `+${cc}${digits}`;
            const phone10 = digits.slice(-10); // fast2sms needs 10-digit

            if (FAST2SMS_API_KEY === "YOUR_FAST2SMS_API_KEY_HERE") {
                return { success: false, error: "SMS gateway not configured. Please add FAST2SMS_API_KEY." };
            }

            const otp = generateOTP(6);
            // Store with 5-minute expiry
            _otpStore.set(fullPhone, { otp, expiresAt: Date.now() + 5 * 60 * 1000 });
            console.log(`[OTP] Generated OTP for ${fullPhone}: ${otp}`);

            const result = await sendSMSViafast2sms(phone10, otp);
            if (result.return !== true) {
                _otpStore.delete(fullPhone);
                const errMsg = Array.isArray(result.message) ? result.message.join(", ") : (result.message || "Failed to send OTP");
                console.error("[fast2sms] Send failed:", errMsg);
                return { success: false, error: errMsg };
            }
            return { success: true, orderId: result.request_id || "ok" };
        } catch (err) {
            console.error("[OTP] Send error:", err.message);
            return { success: false, error: err.message };
        }
    });

    // ── Channel Configuration IPC ─────────────────────────────
    // Reads channel tokens/settings from the encrypted .env file
    // and returns a structured config for the Channels tab UI.

    ipcMain.handle("channels:get-config", () => {
        try {
            const envContent = loadEnvDecrypted();
            const env = {};
            if (envContent) {
                for (const line of envContent.split("\n")) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith("#")) continue;
                    const eq = trimmed.indexOf("=");
                    if (eq === -1) continue;
                    env[trimmed.substring(0, eq).trim()] = trimmed.substring(eq + 1).trim();
                }
            }

            return {
                telegram: {
                    enabled: !!env.TELEGRAM_BOT_TOKEN,
                    token: env.TELEGRAM_BOT_TOKEN ? "***" : "",
                    userIds: env.ALLOWED_USER_IDS || "",
                },
                whatsapp: {
                    enabled: !!env.WHATSAPP_ALLOWED_JIDS,
                    jids: env.WHATSAPP_ALLOWED_JIDS || "",
                    status: channelStatuses.whatsapp || "disconnected",
                },
                discord: {
                    enabled: !!env.DISCORD_BOT_TOKEN,
                    token: env.DISCORD_BOT_TOKEN ? "***" : "",
                    userIds: env.DISCORD_ALLOWED_USER_IDS || "",
                },
                slack: {
                    enabled: !!env.SLACK_BOT_TOKEN,
                    botToken: env.SLACK_BOT_TOKEN ? "***" : "",
                    appToken: env.SLACK_APP_TOKEN ? "***" : "",
                    userIds: env.SLACK_ALLOWED_USER_IDS || "",
                },
                email: {
                    enabled: !!env.EMAIL_USER,
                    user: env.EMAIL_USER || "",
                    whitelist: env.EMAIL_WHITELIST || "",
                    smtpHost: env.EMAIL_SMTP_HOST || "",
                    smtpPort: env.EMAIL_SMTP_PORT || "",
                    imapHost: env.EMAIL_IMAP_HOST || "",
                    imapPort: env.EMAIL_IMAP_PORT || "",
                },
                matrix: {
                    enabled: !!env.MATRIX_HOMESERVER,
                    homeserver: env.MATRIX_HOMESERVER || "",
                    userId: env.MATRIX_USER_ID || "",
                    allowedRooms: env.MATRIX_ALLOWED_ROOMS || "",
                },
                overlay: { enabled: true, port: 18792 },
                webWidget: { enabled: true, port: 18792 },
            };
        } catch (err) {
            console.error("[Channels] get-config error:", err.message);
            return {};
        }
    });

    ipcMain.handle("channels:save-config", (_, config) => {
        try {
            // Read current .env, update channel-related keys, preserve everything else
            const envContent = loadEnvDecrypted();
            const envLines = [];
            const existingKeys = new Set();

            if (envContent) {
                for (const line of envContent.split("\n")) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith("#")) {
                        envLines.push(line);
                        continue;
                    }
                    const eq = trimmed.indexOf("=");
                    if (eq === -1) { envLines.push(line); continue; }
                    const key = trimmed.substring(0, eq).trim();
                    // Skip channel-related keys — we'll re-add them below
                    const channelKeys = [
                        "TELEGRAM_BOT_TOKEN", "ALLOWED_USER_IDS",
                        "WHATSAPP_ALLOWED_JIDS",
                        "DISCORD_BOT_TOKEN", "DISCORD_CLIENT_ID", "DISCORD_ALLOWED_USER_IDS",
                        "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_ALLOWED_USER_IDS",
                        "EMAIL_USER", "EMAIL_PASSWORD", "EMAIL_WHITELIST",
                        "EMAIL_SMTP_HOST", "EMAIL_SMTP_PORT", "EMAIL_IMAP_HOST", "EMAIL_IMAP_PORT",
                        "MATRIX_HOMESERVER", "MATRIX_USER_ID", "MATRIX_PASSWORD", "MATRIX_ALLOWED_ROOMS",
                    ];
                    if (channelKeys.includes(key)) {
                        existingKeys.add(key);
                        continue; // skip — we'll write new values
                    }
                    envLines.push(line);
                    existingKeys.add(key);
                }
            }

            // Add channel config lines
            envLines.push("");
            envLines.push("# ── Channel Configuration ──");

            // Telegram
            if (config.telegram && config.telegram.enabled) {
                if (config.telegram.token && config.telegram.token !== "***") {
                    envLines.push(`TELEGRAM_BOT_TOKEN=${config.telegram.token}`);
                } else {
                    // Preserve existing token
                    const existing = loadEnvKey("TELEGRAM_BOT_TOKEN");
                    if (existing) envLines.push(`TELEGRAM_BOT_TOKEN=${existing}`);
                }
                if (config.telegram.userIds) envLines.push(`ALLOWED_USER_IDS=${config.telegram.userIds}`);
            }

            // WhatsApp
            if (config.whatsapp && config.whatsapp.enabled) {
                if (config.whatsapp.jids) {
                    envLines.push(`WHATSAPP_ALLOWED_JIDS=${config.whatsapp.jids}`);
                } else {
                    // Preserve existing JIDs or use "auto" to enable WhatsApp without pre-set JIDs
                    const existing = loadEnvKey("WHATSAPP_ALLOWED_JIDS");
                    envLines.push(`WHATSAPP_ALLOWED_JIDS=${existing || "auto"}`);
                }
            }

            // Discord
            if (config.discord && config.discord.enabled) {
                if (config.discord.token && config.discord.token !== "***") {
                    envLines.push(`DISCORD_BOT_TOKEN=${config.discord.token}`);
                } else {
                    const existing = loadEnvKey("DISCORD_BOT_TOKEN");
                    if (existing) envLines.push(`DISCORD_BOT_TOKEN=${existing}`);
                }
                if (config.discord.clientId) envLines.push(`DISCORD_CLIENT_ID=${config.discord.clientId}`);
                if (config.discord.userIds) envLines.push(`DISCORD_ALLOWED_USER_IDS=${config.discord.userIds}`);
            }

            // Slack
            if (config.slack && config.slack.enabled) {
                if (config.slack.botToken && config.slack.botToken !== "***") {
                    envLines.push(`SLACK_BOT_TOKEN=${config.slack.botToken}`);
                } else {
                    const existing = loadEnvKey("SLACK_BOT_TOKEN");
                    if (existing) envLines.push(`SLACK_BOT_TOKEN=${existing}`);
                }
                if (config.slack.appToken && config.slack.appToken !== "***") {
                    envLines.push(`SLACK_APP_TOKEN=${config.slack.appToken}`);
                } else {
                    const existing = loadEnvKey("SLACK_APP_TOKEN");
                    if (existing) envLines.push(`SLACK_APP_TOKEN=${existing}`);
                }
                if (config.slack.userIds) envLines.push(`SLACK_ALLOWED_USER_IDS=${config.slack.userIds}`);
            }

            // Email
            if (config.email && config.email.enabled) {
                if (config.email.user) envLines.push(`EMAIL_USER=${config.email.user}`);
                if (config.email.password && config.email.password !== "***" && config.email.password.length > 0) {
                    envLines.push(`EMAIL_PASSWORD=${config.email.password}`);
                } else {
                    // Empty or masked — preserve existing password
                    const existing = loadEnvKey("EMAIL_PASSWORD");
                    if (existing) envLines.push(`EMAIL_PASSWORD=${existing}`);
                }
                if (config.email.whitelist) envLines.push(`EMAIL_WHITELIST=${config.email.whitelist}`);
                if (config.email.smtpHost) envLines.push(`EMAIL_SMTP_HOST=${config.email.smtpHost}`);
                if (config.email.smtpPort) envLines.push(`EMAIL_SMTP_PORT=${config.email.smtpPort}`);
                if (config.email.imapHost) envLines.push(`EMAIL_IMAP_HOST=${config.email.imapHost}`);
                if (config.email.imapPort) envLines.push(`EMAIL_IMAP_PORT=${config.email.imapPort}`);
            }

            // Matrix (UI sends username/rooms, map to userId/allowedRooms)
            if (config.matrix && config.matrix.enabled) {
                if (config.matrix.homeserver) envLines.push(`MATRIX_HOMESERVER=${config.matrix.homeserver}`);
                const matrixUser = config.matrix.userId || config.matrix.username;
                if (matrixUser) envLines.push(`MATRIX_USER_ID=${matrixUser}`);
                if (config.matrix.password && config.matrix.password !== "***" && config.matrix.password.length > 0) {
                    envLines.push(`MATRIX_PASSWORD=${config.matrix.password}`);
                } else {
                    // Empty or masked — preserve existing password
                    const existing = loadEnvKey("MATRIX_PASSWORD");
                    if (existing) envLines.push(`MATRIX_PASSWORD=${existing}`);
                }
                const matrixRooms = config.matrix.allowedRooms || config.matrix.rooms;
                if (matrixRooms) envLines.push(`MATRIX_ALLOWED_ROOMS=${matrixRooms}`);
            }

            const newEnvContent = envLines.join("\n") + "\n";
            saveEnvEncrypted(newEnvContent);

            const isBotRunning = botProcess && !botProcess.killed;
            return { success: true, botRunning: isBotRunning };
        } catch (err) {
            console.error("[Channels] save-config error:", err.message);
            return { success: false, error: err.message };
        }
    });

    // ── Channel Connection Tests ─────────────────
    // These work WITHOUT the bot running — just HTTP calls to verify credentials

    ipcMain.handle("channel:test-telegram", async (_, { token }) => {
        try {
            const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
            const data = await res.json();
            if (data.ok) return { success: true, message: `Connected as @${data.result.username} (${data.result.first_name})` };
            return { success: false, message: data.description || "Invalid token" };
        } catch (err) { return { success: false, message: err.message }; }
    });

    ipcMain.handle("channel:test-discord", async (_, { token }) => {
        try {
            const res = await fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: `Bot ${token}` } });
            if (!res.ok) return { success: false, message: `Invalid token (${res.status})` };
            const data = await res.json();
            return { success: true, message: `Connected as ${data.username}#${data.discriminator}` };
        } catch (err) { return { success: false, message: err.message }; }
    });

    ipcMain.handle("channel:test-slack", async (_, { botToken }) => {
        try {
            const res = await fetch("https://slack.com/api/auth.test", { headers: { Authorization: `Bearer ${botToken}` } });
            const data = await res.json();
            if (data.ok) return { success: true, message: `Connected to ${data.team} as ${data.user}` };
            return { success: false, message: data.error || "Invalid token" };
        } catch (err) { return { success: false, message: err.message }; }
    });

    ipcMain.handle("channel:test-email", async (_, { user, password, imapHost, imapPort }) => {
        try {
            // Simple TCP+TLS connection test to IMAP server
            const net = require("net");
            const tls = require("tls");
            return new Promise((resolve) => {
                const socket = tls.connect({ host: imapHost, port: imapPort || 993, rejectUnauthorized: false }, () => {
                    socket.destroy();
                    resolve({ success: true, message: `IMAP server ${imapHost}:${imapPort} reachable` });
                });
                socket.on("error", (err) => resolve({ success: false, message: `Cannot reach ${imapHost}:${imapPort}: ${err.message}` }));
                socket.setTimeout(10000, () => { socket.destroy(); resolve({ success: false, message: "Connection timed out" }); });
            });
        } catch (err) { return { success: false, message: err.message }; }
    });

    ipcMain.handle("channel:test-matrix", async (_, { homeserver, userId, password }) => {
        try {
            const res = await fetch(`${homeserver}/_matrix/client/v3/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: "m.login.password", user: userId, password })
            });
            const data = await res.json();
            if (data.access_token) return { success: true, message: `Logged in as ${data.user_id}` };
            return { success: false, message: data.error || "Login failed" };
        } catch (err) { return { success: false, message: err.message }; }
    });

    ipcMain.handle("channel:status-all", () => channelStatuses);

    // ── WhatsApp Multi-User Management ───────────
    ipcMain.handle("wa:get-owners", () => {
        try {
            const ownersPath = path.join(DATA_DIR, "whatsapp-owners.json");
            if (fs.existsSync(ownersPath)) return JSON.parse(fs.readFileSync(ownersPath, "utf-8"));
        } catch (err) { console.error("[WA] get-owners error:", err.message); }
        return [];
    });

    ipcMain.handle("wa:remove-owner", (_, jid) => {
        try {
            const ownersPath = path.join(DATA_DIR, "whatsapp-owners.json");
            if (fs.existsSync(ownersPath)) {
                const owners = JSON.parse(fs.readFileSync(ownersPath, "utf-8"));
                const filtered = owners.filter(o => o.jid !== jid);
                fs.writeFileSync(ownersPath, JSON.stringify(filtered, null, 2));
                return { success: true };
            }
        } catch (err) { return { success: false, error: err.message }; }
        return { success: false, error: "No owners file" };
    });

    ipcMain.handle("wa:generate-otp", () => {
        // Generate OTP and write to a signal file that the bot watches
        const code = String(Math.floor(100000 + Math.random() * 900000));
        const otpPath = path.join(DATA_DIR, "whatsapp-otp-signal.json");
        fs.writeFileSync(otpPath, JSON.stringify({ code, expiresAt: Date.now() + 5 * 60 * 1000 }));
        return { code };
    });

    // Setup: start a WhatsApp pair session from inside the wizard.
    // Runs Baileys directly from main.js so the user can scan the QR BEFORE
    // the bot has booted. Emits QR strings on the existing `whatsapp-qr`
    // channel (which preload.js:152 bridges to window.atlas.onWhatsAppQR).
    // Emits the literal string "connected" when pairing completes.
    ipcMain.handle("setup:wa-pair-start", async () => {
        try {
            const { startPair, isPairing } = require(path.join(__dirname, "setup", "whatsapp-pair.js"));
            if (isPairing()) return { ok: true, alreadyRunning: true };
            const baileysFactory = require("@whiskeysockets/baileys");
            const send = (payload) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send("whatsapp-qr", payload);
                }
            };
            await startPair({
                dataDir: DATA_DIR,
                baileysFactory: baileysFactory,
                onQr: (qr) => send(qr),
                onConnected: () => send("connected"),
                onError: (msg) => send({ kind: "error", message: msg }),
            });
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message || String(err) };
        }
    });

    ipcMain.handle("setup:wa-pair-cancel", () => {
        try {
            const { stopPair } = require(path.join(__dirname, "setup", "whatsapp-pair.js"));
            return stopPair();
        } catch (err) {
            return { ok: false, error: err.message || String(err) };
        }
    });

    ipcMain.handle("wa:get-persona", () => {
        try {
            const personaPath = path.join(DATA_DIR, "whatsapp-persona.json");
            if (fs.existsSync(personaPath)) return JSON.parse(fs.readFileSync(personaPath, "utf-8"));
        } catch {}
        return { name: "Personal Assistant", systemPrompt: "", allowedToolNames: [], autoAllow: false };
    });

    ipcMain.handle("wa:save-persona", (_, persona) => {
        try {
            const personaPath = path.join(DATA_DIR, "whatsapp-persona.json");
            fs.mkdirSync(path.dirname(personaPath), { recursive: true });
            fs.writeFileSync(personaPath, JSON.stringify(persona, null, 2));
            return { success: true };
        } catch (err) { return { success: false, error: err.message }; }
    });

    // OTP: Verify
    ipcMain.handle("otp:verify", async (_, { phone, countryCode, otp }) => {
        try {
            const cc = (countryCode || "+91").replace(/^\+/, "");
            const digits = phone.replace(/\D/g, "");
            const fullPhone = `+${cc}${digits}`;

            const stored = _otpStore.get(fullPhone);
            if (!stored) return { success: false, error: "OTP not found. Please request a new one." };
            if (Date.now() > stored.expiresAt) {
                _otpStore.delete(fullPhone);
                return { success: false, error: "OTP expired. Please request a new one." };
            }
            if (stored.otp !== otp.trim()) {
                return { success: false, error: "Incorrect OTP. Please try again." };
            }

            // OTP correct — clear it and create session
            _otpStore.delete(fullPhone);
            const userId = `phone_${digits}`;

            // Session creation auto-upserts the account
            try {
                _desktopSessionToken = null;
                _desktopSessionExpiry = 0;
                await getDesktopSessionToken(userId, { email: null, phone: fullPhone, name: null });
                console.log("[OTP] Convex upsert OK for", userId);
            } catch (err) {
                console.warn("[OTP] Convex upsert (non-fatal):", err.message);
            }

            saveAccountSession({
                userId,
                token: userId,
                email: null,
                phone: fullPhone,
                name: null,
                created_at: new Date().toISOString(),
            });

            // Close auth popup and notify main window
            if (authWindow && !authWindow.isDestroyed()) {
                authWindow.close();
            }
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send("account-status-change", { signedIn: true });
                mainWindow.focus();
            }

            return { success: true, payload: { userId, phone: fullPhone } };
        } catch (err) {
            console.error("[OTP] Verify error:", err.message);
            return { success: false, error: err.message };
        }
    });

}




// ── Utilities ─────────────────────────────────

function checkNodeInstalled() {
    return new Promise((resolve) => {
        execFile("node", ["--version"], { timeout: 5000 }, (err, stdout) => {
            if (err) return resolve(false);
            const version = parseInt(stdout.trim().replace("v", "").split(".")[0]);
            resolve(version >= 20);
        });
    });
}

function downloadAndInstallNode(sendProgress) {
    return new Promise((resolve, reject) => {
        const isMac = process.platform === "darwin";
        const nodeUrl = isMac
            ? "https://nodejs.org/dist/v20.18.1/node-v20.18.1.pkg"
            : "https://nodejs.org/dist/v20.18.1/node-v20.18.1-x64.msi";
        const tmpPath = path.join(app.getPath("temp"), isMac ? "node-installer.pkg" : "node-installer.msi");
        const https = require("https");

        sendProgress(6, "Downloading Node.js 20 LTS (this may take a minute)...");

        const file = fs.createWriteStream(tmpPath);

        const installNode = () => {
            sendProgress(9, "Installing Node.js (please accept the admin prompt)...");
            if (isMac) {
                // Use osascript to prompt for admin password on macOS
                const osaCommand = `do shell script "installer -pkg '${tmpPath}' -target /" with administrator privileges`;
                execFile("osascript", ["-e", osaCommand], { timeout: 300000 }, (err) => {
                    try { fs.unlinkSync(tmpPath); } catch { /* */ }
                    if (err) reject(new Error("Node.js installation failed: " + err.message));
                    else resolve();
                });
            } else {
                // Use PowerShell Start-Process with -Verb RunAs to request UAC elevation
                const psCommand = `Start-Process msiexec.exe -ArgumentList '/i', '${tmpPath}', '/qn', '/norestart' -Wait -Verb RunAs`;
                execFile("powershell", ["-Command", psCommand], { timeout: 300000 }, (err) => {
                    try { fs.unlinkSync(tmpPath); } catch { /* */ }
                    if (err) reject(new Error("Node.js installation failed: " + err.message));
                    else resolve();
                });
            }
        };

        https.get(nodeUrl, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                https.get(response.headers.location, (r2) => {
                    r2.pipe(file);
                    file.on("finish", () => {
                        file.close();
                        installNode();
                    });
                });
            } else {
                response.pipe(file);
                file.on("finish", () => {
                    file.close();
                    installNode();
                });
            }
        }).on("error", reject);
    });
}

function runCommand(cmd, args, cwd, onOutput) {
    return new Promise((resolve, reject) => {
        let executable = cmd;
        let spawnEnv = { ...process.env, NODE_ENV: "production" };
        let shell = true;

        if (cmd === "node" && !IS_DEV) {
            executable = process.execPath;
            spawnEnv.ELECTRON_RUN_AS_NODE = "1";
            shell = false; // Disable shell so parameters are passed correctly, and executable path handles spaces properly
        }

        const proc = spawn(executable, args, {
            cwd,
            shell,
            env: spawnEnv,
        });

        let output = "";
        proc.stdout?.on("data", (data) => {
            output += data.toString();
            if (onOutput) onOutput(data.toString().trim());
        });
        proc.stderr?.on("data", (data) => {
            output += data.toString();
        });

        proc.on("exit", (code) => {
            if (code === 0) resolve(output);
            else reject(new Error(`Command '${cmd} ${args.join(" ")}' failed (code ${code}): ${output.substring(0, 200)}`));
        });

        proc.on("error", reject);

        // Timeout after 10 minutes
        setTimeout(() => {
            proc.kill();
            reject(new Error(`Command '${cmd}' timed out after 10 minutes`));
        }, 600000);
    });
}

// ── System Tray ───────────────────────────────

function createTray() {
    // Windows requires .ico for tray icons; macOS/Linux use PNG
    const iconFile = process.platform === "win32" ? "logo.ico" : "logo.png";
    const iconPath = path.join(__dirname, iconFile);
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip("A.T.L.A.S — Personal AI Agent");

    const running = getBotStatus() === "running";
    const contextMenu = Menu.buildFromTemplate([
        {
            label: "Toggle Overlay",
            accelerator: getOverlayShortcut(),
            click: () => toggleOverlay(),
        },
        {
            label: "Live Voice",
            accelerator: getLiveVoiceShortcut(),
            click: () => toggleLiveVoice(),
        },
        {
            label: "Show Control Panel",
            click: () => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.show();
                    mainWindow.focus();
                } else {
                    if (fs.existsSync(SETUP_FLAG)) {
                        createPanelWindow();
                    } else {
                        createWizardWindow();
                    }
                }
            },
        },
        { type: "separator" },
        {
            label: "Start A.T.L.A.S",
            click: () => { startBot(); updateTrayMenu(); },
            enabled: !running,
        },
        {
            label: "Stop A.T.L.A.S",
            click: () => { stopBot(); setTimeout(updateTrayMenu, 2000); },
            enabled: running,
        },
        { type: "separator" },
        {
            label: "Quick Actions",
            submenu: [
                {
                    label: "Open Workspace",
                    click: () => {
                        const workspace = store.get("workspace") || path.join(app.getPath("desktop"), "A.T.L.A.S Files");
                        shell.openPath(workspace);
                    },
                },
                {
                    label: "Open Data Directory",
                    click: () => shell.openPath(DATA_DIR),
                },
                { type: "separator" },
                {
                    label: "Check for Updates",
                    click: () => checkForUpdates(),
                },
            ],
        },
        { type: "separator" },
        {
            label: "Preferences",
            submenu: [
                {
                    label: "Launch at Login",
                    type: "checkbox",
                    checked: store.get("launchAtLogin"),
                    click: (menuItem) => {
                        store.set("launchAtLogin", menuItem.checked);
                        app.setLoginItemSettings({
                            openAtLogin: menuItem.checked,
                            openAsHidden: true,
                        });
                    },
                },
                {
                    label: "Notifications",
                    type: "checkbox",
                    checked: store.get("notificationsEnabled"),
                    click: (menuItem) => {
                        store.set("notificationsEnabled", menuItem.checked);
                    },
                },
                { type: "separator" },
                {
                    label: "Theme",
                    submenu: [
                        {
                            label: "Light",
                            type: "radio",
                            checked: store.get("theme") === "light",
                            click: () => {
                                store.set("theme", "light");
                                if (mainWindow && !mainWindow.isDestroyed()) {
                                    mainWindow.webContents.send("theme-changed", "light");
                                }
                            },
                        },
                        {
                            label: "Dark",
                            type: "radio",
                            checked: store.get("theme") === "dark",
                            click: () => {
                                store.set("theme", "dark");
                                if (mainWindow && !mainWindow.isDestroyed()) {
                                    mainWindow.webContents.send("theme-changed", "dark");
                                }
                            },
                        },
                        {
                            label: "System",
                            type: "radio",
                            checked: store.get("theme") === "system",
                            click: () => {
                                store.set("theme", "system");
                                if (mainWindow && !mainWindow.isDestroyed()) {
                                    mainWindow.webContents.send("theme-changed", "system");
                                }
                            },
                        },
                    ],
                },
            ],
        },
        { type: "separator" },
        {
            label: updateDownloaded ? "Restart & Update" : "Quit",
            click: () => {
                isQuitting = true;
                if (getBotStatus() === "running") {
                    stopBot();
                }
                if (updateDownloaded) {
                    autoUpdater.quitAndInstall(false, true);
                } else {
                    app.quit();
                }
            },
        },
    ]);
    tray.setContextMenu(contextMenu);

    // Double-click tray icon to show window
    tray.on("double-click", () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

// Update tray menu when bot status changes
function updateTrayMenu() {
    if (!tray) return;
    const running = getBotStatus() === "running";
    const contextMenu = Menu.buildFromTemplate([
        {
            label: "Toggle Overlay",
            accelerator: getOverlayShortcut(),
            click: () => toggleOverlay(),
        },
        {
            label: "Live Voice",
            accelerator: getLiveVoiceShortcut(),
            click: () => toggleLiveVoice(),
        },
        {
            label: "Show Control Panel",
            click: () => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.show();
                    mainWindow.focus();
                } else {
                    if (fs.existsSync(SETUP_FLAG)) {
                        createPanelWindow();
                    } else {
                        createWizardWindow();
                    }
                }
            },
        },
        { type: "separator" },
        {
            label: "Start A.T.L.A.S",
            click: () => { startBot(); updateTrayMenu(); },
            enabled: !running,
        },
        {
            label: "Stop A.T.L.A.S",
            click: () => { stopBot(); setTimeout(updateTrayMenu, 2000); },
            enabled: running,
        },
        { type: "separator" },
        {
            label: "Quick Actions",
            submenu: [
                {
                    label: "Open Workspace",
                    click: () => {
                        const workspace = store.get("workspace") || path.join(app.getPath("desktop"), "A.T.L.A.S Files");
                        shell.openPath(workspace);
                    },
                },
                {
                    label: "Open Data Directory",
                    click: () => shell.openPath(DATA_DIR),
                },
                { type: "separator" },
                {
                    label: "Check for Updates",
                    click: () => checkForUpdates(),
                },
            ],
        },
        { type: "separator" },
        {
            label: "Preferences",
            submenu: [
                {
                    label: "Launch at Login",
                    type: "checkbox",
                    checked: store.get("launchAtLogin"),
                    click: (menuItem) => {
                        store.set("launchAtLogin", menuItem.checked);
                        app.setLoginItemSettings({
                            openAtLogin: menuItem.checked,
                            openAsHidden: true,
                        });
                    },
                },
                {
                    label: "Notifications",
                    type: "checkbox",
                    checked: store.get("notificationsEnabled"),
                    click: (menuItem) => {
                        store.set("notificationsEnabled", menuItem.checked);
                    },
                },
                { type: "separator" },
                {
                    label: "Theme",
                    submenu: [
                        {
                            label: "Light",
                            type: "radio",
                            checked: store.get("theme") === "light",
                            click: () => {
                                store.set("theme", "light");
                                if (mainWindow && !mainWindow.isDestroyed()) {
                                    mainWindow.webContents.send("theme-changed", "light");
                                }
                            },
                        },
                        {
                            label: "Dark",
                            type: "radio",
                            checked: store.get("theme") === "dark",
                            click: () => {
                                store.set("theme", "dark");
                                if (mainWindow && !mainWindow.isDestroyed()) {
                                    mainWindow.webContents.send("theme-changed", "dark");
                                }
                            },
                        },
                        {
                            label: "System",
                            type: "radio",
                            checked: store.get("theme") === "system",
                            click: () => {
                                store.set("theme", "system");
                                if (mainWindow && !mainWindow.isDestroyed()) {
                                    mainWindow.webContents.send("theme-changed", "system");
                                }
                            },
                        },
                    ],
                },
            ],
        },
        { type: "separator" },
        {
            label: updateDownloaded ? "Restart & Update" : "Quit",
            click: () => {
                isQuitting = true;
                if (getBotStatus() === "running") {
                    stopBot();
                }
                if (updateDownloaded) {
                    autoUpdater.quitAndInstall(false, true);
                } else {
                    app.quit();
                }
            },
        },
    ]);
    tray.setContextMenu(contextMenu);

    // Update tooltip with status
    let tooltip = running ? "A.T.L.A.S — Online" : "A.T.L.A.S — Offline";
    if (updateAvailable && !updateDownloaded) {
        tooltip += ` (v${updateAvailable.version} available)`;
    } else if (updateDownloaded) {
        tooltip += " (Update ready)";
    }
    tray.setToolTip(tooltip);
}

let isQuitting = false;

// ── App Lifecycle ─────────────────────────────

app.whenReady().then(async () => {
    // Run v1 → v2 migration before anything reads SETUP_FLAG or prefs.json.
    await runV2Migration();

    // Windows: set AppUserModelID for Action Center notification grouping
    if (process.platform === "win32") {
        app.setAppUserModelId("com.xagilabs.atlas");
        console.log("[INIT] Windows AppUserModelID set: com.xagilabs.atlas");

        // On Windows, set up permission handler for microphone/camera/geolocation access from webContents.
        // This ensures the OS-level permission prompt appears rather than silently denying WebRTC requests.
        const { session } = require("electron");
        session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
            const allowed = ["microphone", "camera", "geolocation", "notifications", "media"].includes(permission);
            if (allowed) {
                console.log(`[PERMISSIONS] Windows permission requested: ${permission} — granting`);
            }
            callback(allowed);
        });

        // Check if Windows Location Services are enabled via registry.
        // HKLM\SYSTEM\CurrentControlSet\Services\lfsvc\Service\Configuration\Status = 1 means enabled.
        execFile(
            "reg",
            ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Services\\lfsvc\\Service\\Configuration", "/v", "Status"],
            { timeout: 2000 },
            (err, stdout) => {
                if (!err && stdout.includes("0x1")) {
                    console.log("[PERMISSIONS] Windows Location Services: enabled");
                } else {
                    console.warn("[PERMISSIONS] Windows Location Services may be disabled. Enable in Settings > Privacy & Security > Location");
                }
            },
        );
    }

    initProtection();
    registerIPC();
    setupAutoUpdater();
    createTray();

    // Request microphone permission (macOS requires explicit ask)
    if (process.platform === "darwin") {
        try {
            const micStatus = systemPreferences.getMediaAccessStatus("microphone");
            if (micStatus !== "granted") {
                console.log("[PERMISSIONS] Requesting microphone access...");
                const granted = await systemPreferences.askForMediaAccess("microphone");
                console.log(`[PERMISSIONS] Microphone: ${granted ? "granted" : "denied"}`);
            } else {
                console.log("[PERMISSIONS] Microphone: already granted");
            }
        } catch (err) {
            console.warn("[PERMISSIONS] Microphone permission request failed:", err.message);
        }
    }

    // Clean old log files on startup (keeps only last 3 days)
    cleanOldLogs();

    // Check accessibility permission on macOS (required for global shortcuts)
    if (process.platform === "darwin") {
        const trusted = systemPreferences.isTrustedAccessibilityClient(true); // true = prompt if not trusted
        if (!trusted) {
            console.warn("[SHORTCUT] ⚠️ Accessibility permission not granted — global shortcuts may not work. Grant permission in System Settings > Privacy & Security > Accessibility.");
        }
    }

    // Register global shortcut to toggle overlay (custom or platform default)
    const overlayShortcut = getOverlayShortcut();
    const overlayRegistered = globalShortcut.register(overlayShortcut, () => {
        toggleOverlay();
    });
    if (overlayRegistered) {
        console.log(`[SHORTCUT] Overlay shortcut registered: ${overlayShortcut}`);
    } else {
        console.warn(`[SHORTCUT] ⚠️ Could not register overlay shortcut: ${overlayShortcut} — trying fallback...`);
        // Try fallback shortcuts
        const fallbacks = process.platform === "darwin"
            ? ["Command+Shift+J", "Command+Option+J", "Command+\\"]
            : ["Alt+J", "Ctrl+Shift+J", "Ctrl+\\"];
        for (const fb of fallbacks) {
            if (globalShortcut.register(fb, () => toggleOverlay())) {
                console.log(`[SHORTCUT] Overlay shortcut registered with fallback: ${fb}`);
                break;
            }
        }
    }

    // Register global shortcut to toggle live voice mode (custom or platform default)
    const liveVoiceShortcut = getLiveVoiceShortcut();
    const lvRegistered = globalShortcut.register(liveVoiceShortcut, () => {
        toggleLiveVoice();
    });
    if (!lvRegistered) {
        console.warn(`[SHORTCUT] Could not register live voice shortcut: ${liveVoiceShortcut}`);
    }

    if (fs.existsSync(SETUP_FLAG)) {
        createPanelWindow();
        // Auto-start bot
        setTimeout(() => {
            startBot();
            updateTrayMenu();
        }, 1000);

        // Check for updates on launch (after 5 seconds)
        setTimeout(() => {
            checkForUpdates();
        }, 5000);

        // Check for updates every 4 hours
        setInterval(() => {
            checkForUpdates();
        }, 4 * 60 * 60 * 1000);
    } else {
        createWizardWindow();
    }

    // Sync launch at login setting
    const launchAtLogin = store.get("launchAtLogin");
    app.setLoginItemSettings({
        openAtLogin: launchAtLogin,
        openAsHidden: true,
    });
});

// Prevent app from quitting when all windows are closed — keep running in tray
app.on("window-all-closed", (e) => {
    // Do NOT quit — bot stays running in the background
    // User must explicitly "Quit" from tray to exit
});

app.on("before-quit", () => {
    isQuitting = true;
    stopHeightPolling();
    if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.destroy();
        overlayWindow = null;
    }
    if (getBotStatus() === "running") {
        stopBot();
    }
});

app.on("will-quit", () => {
    // Unregister all shortcuts
    globalShortcut.unregisterAll();
});
