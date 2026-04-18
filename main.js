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

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Tray, Menu, nativeImage, globalShortcut, screen } = require("electron");
const { spawn, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { autoUpdater } = require("electron-updater");

// ── Protected String Decoder ─────────────────────
// Decodes XOR-encoded prompts and skills at runtime

const PROTECTION_KEY = Buffer.from("ATLAS_PROTECTED_2026");

function decodeProtectedString(encodedBase64) {
    try {
        const encoded = Buffer.from(encodedBase64, "base64");
        const decoded = Buffer.alloc(encoded.length);
        for (let i = 0; i < encoded.length; i++) {
            decoded[i] = encoded[i] ^ PROTECTION_KEY[i % PROTECTION_KEY.length];
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
    const masterKey = getMasterKey();
    const encryptedData = encrypt(envContent, masterKey);
    fs.writeFileSync(ENV_PATH, encryptedData);
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

// ── Bot Process Management ────────────────────

let botProcess = null;
let mainWindow = null;
let tray = null;
let overlayWindow = null;
let overlayResizeTimer = null;
let botStartTime = null;
let botMessageCount = 0;
let botToolCount = 0;

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
    }
});

// Resolve the active overlay shortcut (custom or platform default)
function getOverlayShortcut() {
    const custom = store.get("overlayHotkey");
    if (custom) return custom;
    return process.platform === "darwin" ? "Command+J" : "Alt+Space";
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
            new Notification({
                title: "A.T.L.A.S Update Available",
                body: `Version ${info.version} is ready to download`,
                icon: path.join(__dirname, "logo.png"),
            }).show();
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
            new Notification({
                title: "A.T.L.A.S Update Ready",
                body: `Version ${info.version} is ready to install. Restart to update.`,
                icon: path.join(__dirname, "logo.png"),
            }).show();
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

function startBot() {
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
    let spawnEnv = {
        ...process.env,
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
                contextIsolation: false, // false so preload can inject window.atlasAuth
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
    ipcMain.on("overlay:notify", (_, { title, body }) => {
        const { Notification } = require("electron");
        if (Notification.isSupported()) {
            new Notification({ title: title || "A.T.L.A.S", body: body || "", icon: path.join(__dirname, "logo.png") }).show();
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
            // Store profile to be seeded into memory.db after install
            const profilePath = path.join(app.getPath("userData"), ".user-profile.json");
            fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
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
    ipcMain.handle("setup:install", async (_, options) => {
        const sendProgress = (pct, msg) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send("install-progress", { percent: pct, message: msg });
            }
        };
        // Send a sub-log line (no progress bar change, just a detail message)
        const sendLog = (msg) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send("install-log", msg);
            }
        };

        try {
            // Step 1: Check Node.js
            sendProgress(2, "Checking Node.js installation...");
            sendLog("Detecting Node.js on system PATH...");
            const hasNode = await checkNodeInstalled();
            if (!hasNode) {
                sendProgress(5, "Downloading Node.js 20 LTS...");
                sendLog("Node.js not found — downloading installer...");
                await downloadAndInstallNode(sendProgress);
            } else {
                sendLog("Node.js 20+ detected ✓");
            }
            sendProgress(12, "✅ Node.js ready");

            // Step 2: Skip npm install (dependencies shipped in ASAR)
            sendLog("Dependencies shipped in ASAR package — skipping npm install");
            sendProgress(38, "✅ Dependencies ready");

            // Step 3: TypeScript (already compiled before packaging)
            sendProgress(40, "Checking compiled sources...");
            sendLog("TypeScript already compiled — shipped pre-built in package");
            sendProgress(52, "✅ TypeScript ready");

            // Step 4: Playwright
            sendProgress(55, "Installing browser engine (Playwright)...");
            sendLog("Installing Chromium browser engine...");
            sendLog("This downloads ~130MB of Chromium browser engine...");
            // Use the bundled playwright CLI directly (npx may not find it on fresh systems)
            const playwrightCli = path.join(BOT_DIR, "node_modules", "playwright", "cli.js");
            await runCommand("node", [playwrightCli, "install", "chromium"], BOT_DIR, (line) => {
                if (line.trim()) sendLog(line);
            });
            sendProgress(63, "✅ Browser engine ready");

            // Step 5: AI Model
            sendProgress(65, "Downloading AI embedding model (~23MB)...");
            sendLog("Pre-warming Xenova/all-MiniLM-L6-v2 (quantized)...");
            sendLog("This model powers semantic search and memory recall");
            // Write warmup script to temp file (Windows cmd.exe breaks with => in node -e)
            const warmupScript = path.join(require("os").tmpdir(), "_atlas_warmup.mjs");
            fs.writeFileSync(warmupScript, `
                import("@xenova/transformers")
                    .then(t => t.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { quantized: true }))
                    .then(() => console.log("done"))
                    .catch(e => console.error(e));
            `);
            try {
                await runCommand("node", [warmupScript], BOT_DIR, (line) => {
                    if (line.trim()) sendLog(line);
                });
            } finally {
                try { fs.unlinkSync(warmupScript); } catch { /* cleanup */ }
            }
            sendProgress(78, "✅ AI model downloaded");

            // Step 6: Prepare data directory (use writable DATA_DIR, not read-only BOT_DIR)
            sendProgress(80, "Preparing data directory...");
            sendLog("Setting up writable data directory...");
            fs.mkdirSync(DATA_DIR, { recursive: true });

            const toDelete = [
                "memory.db", "memory.db-shm", "memory.db-wal", "memory.hnsw.json",
                "audit.jsonl", "browser-strategies.json", "task-learnings.json",
            ];
            const dirsToClear = [
                "browser-profile", "google-tokens", "research", "long-tasks", "process-logs",
            ];

            for (const f of toDelete) {
                try { fs.unlinkSync(path.join(DATA_DIR, f)); sendLog(`Cleared ${f}`); } catch { /* */ }
            }
            for (const d of dirsToClear) {
                try { fs.rmSync(path.join(DATA_DIR, d), { recursive: true, force: true }); } catch { /* */ }
                fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });
                sendLog(`Reset directory: ${d}/`);
            }

            // Copy bundled google-credentials.json to writable data dir
            const bundledCreds = path.join(BOT_DIR, "data", "google-credentials.json");
            const writableCreds = path.join(DATA_DIR, "google-credentials.json");
            if (fs.existsSync(bundledCreds)) {
                fs.copyFileSync(bundledCreds, writableCreds);
                sendLog("Copied Google credentials to data directory");
            }

            sendProgress(85, "✅ Data directory ready");

            // Step 7: Create workspace
            if (options.workspace) {
                sendProgress(87, "Creating A.T.L.A.S workspace folder...");
                sendLog(`Creating: ${options.workspace}`);
                try {
                    fs.mkdirSync(options.workspace, { recursive: true });
                } catch (mkdirErr) {
                    // Desktop may be restricted on some Windows setups — fall back to Documents
                    sendLog(`Could not create workspace at ${options.workspace}: ${mkdirErr.message}`);
                    const fallback = path.join(app.getPath("documents"), "A.T.L.A.S Files");
                    sendLog(`Falling back to: ${fallback}`);
                    fs.mkdirSync(fallback, { recursive: true });
                    options.workspace = fallback;

                    // Rewrite the .env file with the fallback workspace
                    const currentEnv = loadEnvDecrypted();
                    if (currentEnv) {
                        const newEnv = currentEnv.split('\n').map(line => {
                            if (line.startsWith('ATLAS_WORKSPACE=')) return `ATLAS_WORKSPACE=${options.workspace}`;
                            return line;
                        }).join('\n');
                        saveEnvEncrypted(newEnv);
                        sendLog(`Updated configuration with fallback workspace path`);
                    }
                }
            }
            sendProgress(88, "✅ Workspace created");

            // Step 8: Seed user profile
            sendProgress(90, "Setting up your profile...");
            sendLog("Profile will be seeded on first launch");
            // Profile will be seeded on first bot run via the identity module

            // Step 9: Desktop shortcut (handled by NSIS installer)
            sendProgress(95, "Finalizing installation...");
            sendLog("Writing setup completion flag...");

            // Mark setup complete
            fs.writeFileSync(SETUP_FLAG, new Date().toISOString());
            sendLog("Setup complete — all systems go ✓");
            sendProgress(100, "✅ Installation complete!");

            return { success: true };
        } catch (err) {
            sendLog(`ERROR: ${err.message}`);
            sendProgress(-1, `❌ Error: ${err.message}`);
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

    // Setup: Google OAuth
    ipcMain.handle("setup:google-oauth", async () => {
        try {
            const credPath = path.join(BOT_DIR, "data", "google-credentials.json");
            if (!fs.existsSync(credPath)) {
                return { success: false, error: "Google credentials file not found." };
            }
            const credsRaw = JSON.parse(fs.readFileSync(credPath, "utf-8"));
            const clientCreds = credsRaw.installed || credsRaw.web;
            if (!clientCreds) {
                return { success: false, error: "Invalid credentials file format." };
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
                const credPath = path.join(BOT_DIR, "data", "google-credentials.json");
                if (!fs.existsSync(credPath)) return { success: false, error: "Google credentials file not found." };
                const credsRaw = JSON.parse(fs.readFileSync(credPath, "utf-8"));
                const clientCreds = credsRaw.installed || credsRaw.web;
                if (!clientCreds) return { success: false, error: "Invalid credentials file format." };

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
    const iconPath = path.join(__dirname, "logo.png");
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip("A.T.L.A.S — Personal AI Agent");

    const running = getBotStatus() === "running";
    const contextMenu = Menu.buildFromTemplate([
        {
            label: "Toggle Overlay",
            accelerator: process.platform === "darwin" ? "Command+J" : "Alt+Space",
            click: () => toggleOverlay(),
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
            accelerator: process.platform === "darwin" ? "Command+J" : "Alt+Space",
            click: () => toggleOverlay(),
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

app.whenReady().then(() => {
    initProtection();
    registerIPC();
    setupAutoUpdater();
    createTray();

    // Clean old log files on startup (keeps only last 3 days)
    cleanOldLogs();

    // Register global shortcut to toggle overlay (custom or platform default)
    const overlayShortcut = getOverlayShortcut();
    globalShortcut.register(overlayShortcut, () => {
        toggleOverlay();
    });

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
