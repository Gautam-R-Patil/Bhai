// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Bhai Desktop — Main Process ─────────────
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
// One native-glass panel (input bar + replies); the window is the panel.
const OVERLAY_WIDTH = 640;
const OVERLAY_MIN_HEIGHT = 68;
const OVERLAY_MAX_HEIGHT = 600;
const OVERLAY_MARGIN_RIGHT = 16;
const OVERLAY_MARGIN_TOP = 8;
const OVERLAY_URL = "http://127.0.0.1:18792";
// Shown while the bot boots; the ##ATLAS_READY## reload swaps in the real overlay.
// With a message instead when the bot won't come up (see botDownMessage).
const overlaySplash = (text = "Bhai is waking up…") =>
    "data:text/html," +
    encodeURIComponent(
        `<meta charset="utf-8"><style>:root{--bg-panel:rgba(252,251,249,.97);color:#1d1d1f}@media(prefers-color-scheme:dark){:root{--bg-panel:rgba(30,28,26,.97);color:#f5f5f7}}body{margin:0;padding:0 24px;height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;font:500 15px -apple-system,BlinkMacSystemFont,system-ui,sans-serif}</style>${text}`,
    );
// The overlay page embeds the owner token only for a request that proves it holds it
// (src/overlay/overlay-chat.ts): this app's own requests add it, read from the 0600 file
// the bot writes, so another local process or a browser tab opening the page gets none.
const OVERLAY_TOKEN_FILE = path.join(require("node:os").homedir(), ".atlas", "overlay-local-token");
let overlayTokenHooked = false;
function hookOverlayToken(ses) {
    if (overlayTokenHooked) return;
    overlayTokenHooked = true;
    ses.webRequest.onBeforeSendHeaders({ urls: [`${OVERLAY_URL}/*`] }, (details, cb) => {
        try {
            const tok = fs.readFileSync(OVERLAY_TOKEN_FILE, "utf8").trim();
            if (tok) details.requestHeaders["X-Bhai-Overlay"] = tok;
        } catch {
            /* bot hasn't written it yet: the page loads token-less and is reloaded on ##ATLAS_READY## */
        }
        cb({ requestHeaders: details.requestHeaders });
    });
}
const OVERLAY_RESIZE_MS = 500;
const OVERLAY_HIDE_DELAY_MS = 260;
// macOS 26 Spotlight-style corners; keep in sync with --panel-radius in src/overlay/overlay.html.
const OVERLAY_CORNER_RADIUS = 26;
const OVERLAY_DARK_TINT = "#1C1A18E0";

// ── Convex deployment selector ─────────────────────────────────────
// Packaged DMG → prod by default. `npm start` (dev) → dev. Override either
// via `ATLAS_ENV=prod|dev` or per-URL via `CONVEX_URL` / `CONVEX_SITE_URL`.
const _ATLAS_IS_PROD = process.env.ATLAS_ENV
    ? process.env.ATLAS_ENV === "prod"
    : app.isPackaged;
const _CONVEX_DEPLOY_NAME = _ATLAS_IS_PROD ? "avid-finch-726" : "avid-finch-726";
const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL || `https://${_CONVEX_DEPLOY_NAME}.convex.site`;
const CONVEX_API_URL = process.env.CONVEX_URL || `https://${_CONVEX_DEPLOY_NAME}.convex.cloud`;

const { parseOtplessVerifyResponse, isLegacyUserId, isLoopbackHost } = require("./auth-helpers");
const { createAgentCursor, parseCursorLine } = require("./agent-cursor");
const { readVault, registerVaultIpc } = require("./vault-store");

// ── Desktop Session Token Management ─────────────
// Authenticates the Electron main process with the Convex backend via
// session tokens — NO deploy key needed.
//
// IMPORTANT: This session is **plaintext-over-HTTPS only**. We do NOT
// derive an ECDH shared key here (no clientPublicKey is sent). Every
// outbound call from main.js uses bare https.request, never the
// `encryptedFetch` helper from src/crypto-transport.ts. If you ever wire
// encryptedFetch from main.js you must FIRST extend this function to
// generate an ECDH key pair and send `clientPublicKey` so the server
// derives a shared key for the session — otherwise encryptedFetch will
// throw on any non-bootstrap path.
//
// /api/auth/session also REQUIRES the account to already exist — it no
// longer auto-upserts. Bootstrap flow: validate-token first (creates the
// account), then this function refreshes ECDH-less sessions on demand.
// email/phone/name on the body below are ignored server-side and only
// kept here as breadcrumbs for legacy callers.
let _desktopSessionToken = null;
let _desktopSessionExpiry = 0;
// Set when the server refuses this Mac a session until someone signs in here again:
// "device_removed" (the owner removed it in Account → Devices on another one) or
// "sign_in_required" (no device secret yet, e.g. signed in before secrets existed).
let _signInNeeded = null;

/** This device as the bot names it (src/session.ts getDeviceFingerprint): one Devices row per Mac. */
function deviceFingerprint() {
    const user = process.env.USER || process.env.USERNAME || "unknown";
    return `${process.platform}:${require("node:os").hostname()}:${user}`;
}

async function getDesktopSessionToken(overrideUserId, overrideInfo) {
    if (_desktopSessionToken && _desktopSessionExpiry > Date.now() + 3600000) {
        return _desktopSessionToken;
    }

    let userId = overrideUserId;

    // Until someone signs in here again the server will only refuse; asking anyway
    // just spends the sign-in rate limit.
    if (_signInNeeded) return null;
    const saved = loadAccountSession();
    if (!userId) {
        if (!saved || !saved.userId) return null;
        userId = saved.userId;
    }
    if (!saved?.deviceSecret) {
        _signInNeeded = "sign_in_required";
        return null;
    }

    const https = require("https");
    const bodyStr = JSON.stringify({
        otplessUserId: userId,
        deviceFingerprint: deviceFingerprint(),
        deviceSecret: saved.deviceSecret,
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
                        _signInNeeded = null;
                        _desktopSessionToken = data.token;
                        _desktopSessionExpiry = data.expiresAt || (Date.now() + 86400000);
                        resolve(data.token);
                    } else {
                        if (data.error === "device_removed" || data.error === "sign_in_required") _signInNeeded = data.error;
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

function convexPostNoAuth(urlPath, bodyObj) {
    return new Promise((resolve, reject) => {
        const https = require("https");
        const bodyStr = JSON.stringify(bodyObj || {});
        const url = new URL(`${CONVEX_SITE_URL}${urlPath}`);
        const req = https.request(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) },
            timeout: 20000,
        }, (res) => {
            let raw = "";
            res.on("data", c => raw += c);
            res.on("end", () => {
                try { resolve(JSON.parse(raw)); }
                catch { reject(new Error("Invalid JSON response")); }
            });
        });
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
        req.write(bodyStr);
        req.end();
    });
}

async function convexSiteRequest(method, urlPath, bodyObj) {
    const token = await getDesktopSessionToken();
    if (!token) throw new Error("No session token available");

    return new Promise((resolve, reject) => {
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
// and redirects asset downloads to public release URLs (Cloudflare R2).
//
// Channels: users on the "beta" channel get the BETA feed. Switch via
// store.set("updateChannel", "beta" | "stable" | "canary").
const UPDATE_FEED_BASE = `${CONVEX_SITE_URL}/api/updates`;

function getUpdateChannel() {
    const ch = (store.get("updateChannel") || "stable").toString().toLowerCase();
    return ch === "beta" || ch === "alpha" || ch === "canary" ? ch : "stable";
}

function configureAutoUpdater() {
    const channel = getUpdateChannel();
    // Feed URL is the directory; electron-updater appends latest-mac.yml /
    // latest.yml. Pass channel via query string — our Convex handler reads
    // it from `?channel=...`.
    const url = channel === "stable"
        ? UPDATE_FEED_BASE
        : `${UPDATE_FEED_BASE}?channel=${channel}`;
    autoUpdater.setFeedURL({ provider: "generic", url });
    autoUpdater.channel = channel;
    console.log(`[Updater] Configured | channel=${channel} | url=${url}`);
}


// ── Bot Log File System ─────────────────────
// Logs are saved to file with automatic rotation every 3 days

function getLogFilePath() {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    return path.join(LOGS_DIR, `atlas-${today}.log`);
}

// Buffered async log writer. Bot stdout fires this on every line (heartbeat,
// telemetry, tool calls — hundreds of lines during agent activity). Switching
// from appendFileSync to a 200ms-coalesced async append keeps the Electron
// main thread free for IPC and the UI. Buffered lines are flushed on
// before-quit so the user never loses log content on a clean exit.
let _logDirEnsured = false;
let _logBuffer = "";
let _logFlushTimer = null;
const _LOG_FLUSH_MS = 200;

function _flushLogBuffer() {
    if (!_logBuffer) return;
    const data = _logBuffer;
    _logBuffer = "";
    if (!_logDirEnsured) {
        try { fs.mkdirSync(LOGS_DIR, { recursive: true }); _logDirEnsured = true; }
        catch (err) { console.error("Failed to create log dir:", err.message); return; }
    }
    fs.appendFile(getLogFilePath(), data, (err) => {
        if (err) console.error("Failed to write log:", err.message);
    });
}

function writeToLogFile(message) {
    const timestamp = new Date().toISOString();
    _logBuffer += `[${timestamp}] ${message}\n`;
    if (_logFlushTimer) return;
    _logFlushTimer = setTimeout(() => { _logFlushTimer = null; _flushLogBuffer(); }, _LOG_FLUSH_MS);
}

// On clean shutdown, flush whatever is still buffered. Use sync append here
// because this is the single moment where blocking is acceptable — the app
// is exiting anyway.
app.on("before-quit", () => {
    if (_logFlushTimer) { clearTimeout(_logFlushTimer); _logFlushTimer = null; }
    if (_logBuffer) {
        try {
            fs.mkdirSync(LOGS_DIR, { recursive: true });
            fs.appendFileSync(getLogFilePath(), _logBuffer);
            _logBuffer = "";
        } catch (err) { console.error("Failed to flush log on exit:", err.message); }
    }
});

// ── OAuth callback page ────────────────────────
// Rendered by the ephemeral localhost:8844 server that catches Google's
// redirect after the user consents. They see this in their BROWSER, not in
// the Electron window — so it ships its own styles inline. Must match the
// warm Bhai aesthetic (coral/amber/cobalt orbs, Geist type, tinted
// shadows) since the previous version was a jarring dark-purple.
function renderOAuthCallbackPage({ kind, error } = {}) {
    const success = kind !== "error";
    const safeErr = (error || "").toString().replace(/[<>&"']/g, (c) => ({
        "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&#39;",
    }[c]));
    const heading = success ? "You're connected" : "Couldn't connect";
    const sub = success
        ? "Your Google account is now linked to Bhai. You can close this tab."
        : "We hit an issue during sign-in. Close this tab and try again from Bhai.";
    const errBlock = success
        ? ""
        : `<p class="err-detail">${safeErr}</p>`;
    const autoClose = success
        ? "<script>setTimeout(()=>window.close(),3000)</script>"
        : "";
    const iconSvg = success
        ? `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
              <circle cx="16" cy="16" r="15" class="icon-ring icon-ok"/>
              <path d="M10 16.5 L14.5 21 L22.5 12" class="icon-check icon-ok-stroke"/>
           </svg>`
        : `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
              <circle cx="16" cy="16" r="15" class="icon-ring icon-err"/>
              <path d="M11 11 L21 21 M21 11 L11 21" class="icon-check icon-err-stroke"/>
           </svg>`;
    const statusColor = success ? "#2fb06a" : "#c5392f";
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bhai — ${success ? "Connected" : "Sign-in error"}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap">
<style>
:root {
  --coral:#ff7a6b; --amber:#f9b34d; --peach:#ffa27a;
  --cobalt:#4d7bff; --mint:#39d9b6; --lavender:#b58cff;
  --accent:#e8533f; --accent-ring:rgba(232,83,63,.30);
  --text:#1d1a1a; --text-sub:#585253; --text-muted:#8c8689;
  --bg:#fdfbf7;
}
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%}
body{
  font-family:'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  background:var(--bg); color:var(--text); overflow:hidden;
  display:flex; align-items:center; justify-content:center; padding:24px;
  -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale;
}
/* Colorful orb backdrop — same palette as the rest of Bhai. */
.bg{position:fixed; inset:0; z-index:-1; overflow:hidden; background:var(--bg)}
.orb{position:absolute; border-radius:50%; filter:blur(70px); will-change:transform}
.o1{width:460px;height:460px;background:var(--coral);top:-140px;left:-140px;opacity:.62;animation:d1 9s ease-in-out infinite alternate}
.o2{width:380px;height:380px;background:var(--amber);bottom:-100px;right:-80px;opacity:.58;animation:d2 11s ease-in-out infinite alternate;animation-delay:-5s}
.o3{width:340px;height:340px;background:var(--cobalt);top:35%;right:18%;opacity:.48;animation:d3 10s ease-in-out infinite alternate;animation-delay:-8s}
.o4{width:320px;height:320px;background:var(--mint);top:-60px;right:22%;opacity:.50;animation:d4 12s ease-in-out infinite alternate;animation-delay:-3s}
.o5{width:300px;height:300px;background:var(--lavender);bottom:15%;left:28%;opacity:.46;animation:d5 13s ease-in-out infinite alternate;animation-delay:-10s}
.o6{width:260px;height:260px;background:var(--peach);top:12%;left:45%;opacity:.42;animation:d6 14s ease-in-out infinite alternate;animation-delay:-6s}
@keyframes d1{to{transform:translate(140px,-50px) scale(1.02)}}
@keyframes d2{to{transform:translate(-80px,100px) scale(1)}}
@keyframes d3{to{transform:translate(-80px,80px) scale(1.06)}}
@keyframes d4{to{transform:translate(100px,30px) scale(1)}}
@keyframes d5{to{transform:translate(120px,-50px) scale(1)}}
@keyframes d6{to{transform:translate(-50px,-90px) scale(1.04)}}
.bg::after{
  content:"";position:absolute;inset:0;pointer-events:none;opacity:.42;mix-blend-mode:soft-light;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%25' height='100%25' filter='url(%23n)' opacity='0.55'/></svg>");
}
.card{
  position:relative; z-index:1;
  width:100%; max-width:420px;
  background:rgba(255,253,249,.72);
  backdrop-filter:blur(40px) saturate(160%);
  -webkit-backdrop-filter:blur(40px) saturate(160%);
  border:1px solid rgba(255,255,255,.6);
  border-radius:24px;
  padding:44px 36px 32px;
  text-align:center;
  box-shadow:
    0 18px 48px rgba(75,45,90,.14),
    inset 0 0 0 1px rgba(255,255,255,.5);
  animation:card-in .4s cubic-bezier(.16,1,.3,1);
}
@keyframes card-in{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}

.icon-wrap{
  width:72px; height:72px; margin:0 auto 20px;
  display:flex; align-items:center; justify-content:center;
  border-radius:50%;
  background:radial-gradient(circle, ${success
    ? "rgba(47,176,106,.22) 0%, rgba(47,176,106,.08) 60%, rgba(47,176,106,0) 100%"
    : "rgba(197,57,47,.22) 0%, rgba(197,57,47,.08) 60%, rgba(197,57,47,0) 100%"});
  animation:pop .5s cubic-bezier(.34,1.56,.64,1);
}
@keyframes pop{0%{transform:scale(.3);opacity:0}60%{transform:scale(1.1);opacity:1}100%{transform:scale(1);opacity:1}}
.icon-wrap svg{width:44px;height:44px;overflow:visible}
.icon-ring{fill:none;stroke-width:2.5;stroke-dasharray:94;stroke-dashoffset:94;animation:draw .5s .05s cubic-bezier(.65,0,.35,1) forwards}
.icon-check{fill:none;stroke-width:2.8;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:30;stroke-dashoffset:30;animation:draw .38s .38s cubic-bezier(.65,0,.35,1) forwards}
.icon-ok{stroke:#2fb06a}.icon-ok-stroke{stroke:#2fb06a}
.icon-err{stroke:#c5392f}.icon-err-stroke{stroke:#c5392f}
@keyframes draw{to{stroke-dashoffset:0}}

h1{
  font-size:24px; font-weight:600; letter-spacing:-.02em;
  color:var(--text); text-wrap:balance;
  opacity:0; animation:fade-up .4s .45s cubic-bezier(.16,1,.3,1) forwards;
}
.sub{
  font-size:14px; color:var(--text-sub); margin-top:10px;
  max-width:34ch; margin-left:auto; margin-right:auto;
  text-wrap:pretty; line-height:1.55;
  opacity:0; animation:fade-up .4s .55s cubic-bezier(.16,1,.3,1) forwards;
}
.err-detail{
  margin-top:14px; font-size:12px; color:var(--text-muted);
  font-family:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  background:rgba(197,57,47,.08); border:1px solid rgba(197,57,47,.18);
  border-radius:10px; padding:10px 14px;
  max-width:340px; margin-left:auto; margin-right:auto;
  word-break:break-word;
  opacity:0; animation:fade-up .4s .65s cubic-bezier(.16,1,.3,1) forwards;
}
.hint{
  font-size:12px; color:var(--text-muted); margin-top:22px;
  letter-spacing:.005em;
  opacity:0; animation:fade-up .4s .75s cubic-bezier(.16,1,.3,1) forwards;
}
.hint .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:${statusColor};vertical-align:middle;margin-right:6px;box-shadow:0 0 0 4px ${success ? "rgba(47,176,106,.15)" : "rgba(197,57,47,.15)"}}
@keyframes fade-up{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}

/* Thin progress bar on success — matches the auth.html success state */
.prog{
  width:140px; height:3px; margin:22px auto 0;
  border-radius:2px; background:rgba(47,176,106,.12); overflow:hidden;
  opacity:0; animation:fade-up .4s .7s cubic-bezier(.16,1,.3,1) forwards;
}
.prog::after{
  content:""; display:block; height:100%; width:0;
  background:linear-gradient(90deg,#2fb06a,rgba(47,176,106,.5));
  animation:fill 2.8s .8s cubic-bezier(.45,.05,.55,.95) forwards;
}
@keyframes fill{to{width:100%}}
</style>
</head>
<body>
<div class="bg">
  <div class="orb o1"></div>
  <div class="orb o2"></div>
  <div class="orb o3"></div>
  <div class="orb o4"></div>
  <div class="orb o5"></div>
  <div class="orb o6"></div>
</div>
<main class="card" role="alert">
  <div class="icon-wrap" aria-hidden="true">${iconSvg}</div>
  <h1>${heading}</h1>
  <p class="sub">${sub}</p>
  ${errBlock}
  <p class="hint"><span class="dot"></span>${success ? "This tab will close automatically." : "You can close this tab."}</p>
  ${success ? `<div class="prog" aria-hidden="true"></div>` : ""}
</main>
${autoClose}
</body>
</html>`;
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
                        "Application files have been tampered with. Please reinstall Bhai.\n\n" + COPYRIGHT
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
    // One KEY=value line each: a newline in a value (or an odd key) would let a
    // settings write smuggle extra env vars (NODE_OPTIONS, CONVEX_URL) into the bot.
    for (const [k, v] of Object.entries(kvs)) {
        if (!/^[A-Z0-9_]+$/.test(k) || /[\r\n]/.test(String(v))) {
            throw new Error(`Invalid setting ${JSON.stringify(k)}`);
        }
    }
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
                personalize: (store.get("prefs") || {}).personalize || undefined,
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
        legalAcceptance: path.join(app.getPath("userData"), ".legal-acceptance.json"),
        envFile: path.join(app.getPath("userData"), ".env.enc"),
        googleTokens: path.join(app.getPath("userData"), "google-tokens"),
        botDir: path.join(process.resourcesPath || app.getAppPath(), "bot"),
        homeDir: app.getPath("home"),
        workspace: path.join(app.getPath("desktop"), "Bhai Files"),
        storedVersion: path.join(app.getPath("userData"), "version.json"),
        slackInstalls: path.join(app.getPath("userData"), "slack-installs"),
        whatsappOwners: path.join(app.getPath("userData"), "whatsapp-users", "owners.json"),
    };

    // Decrypt atlas-account.enc here so the detector can read the canonical
    // signin state. saveAccountSession writes to this file; prefs.account in
    // electron-store is never populated, so the detector previously always
    // claimed "not signed in" no matter how many times you signed in.
    const accountSessionFromFile = (() => {
        try { return loadAccountSession(); } catch { return null; }
    })();

    return {
        proc: process,
        fs,
        os: osmod,
        systemPreferences,
        accountSessionFromFile,
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
// Messages today: kept per calendar day on disk, so a restart doesn't zero it.
const MESSAGES_TODAY_FILE = path.join(DATA_DIR, "messages-today.json");
const localDay = () => new Date().toLocaleDateString("en-CA");
let messagesToday = { day: localDay(), count: 0 };
try { messagesToday = JSON.parse(fs.readFileSync(MESSAGES_TODAY_FILE, "utf-8")); } catch { /* first run */ }
function countMessagesToday() {
    if (messagesToday.day !== localDay()) messagesToday = { day: localDay(), count: 0 };
    return messagesToday.count;
}
function addMessageToday() {
    countMessagesToday();
    messagesToday.count++;
    try { fs.writeFileSync(MESSAGES_TODAY_FILE, JSON.stringify(messagesToday)); } catch { /* best effort */ }
}
let botToolCount = 0;
const channelStatuses = {};

// WhatsApp owner sign-up: the bot's own number (from its ##ATLAS_WA_SELF## line)
// lets the panel offer a wa.me link/QR with the code already typed in.
let waSelfNumber = "";
async function waOtpPayload(code) {
    const payload = { code, self: waSelfNumber };
    if (waSelfNumber) {
        payload.link = `https://wa.me/${waSelfNumber}?text=${code}`;
        try { payload.qr = await require("qrcode").toDataURL(payload.link, { width: 200, margin: 1 }); } catch { /* link still works */ }
    }
    return payload;
}

// Broadcast a theme change to every window that cares about it. The overlay
// is a separate BrowserWindow from the main one, so both need to be notified.
function broadcastThemeChange(theme) {
    applyNativeTheme(theme);
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("theme-changed", theme);
    }
    if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send("theme-changed", theme);
    }
}

// Native materials (the dashboard sidebar, the chat overlay's glass) follow the
// app's appearance, not the OS's, so they always match the chosen theme. This
// also drives prefers-color-scheme in every window.
function applyNativeTheme(theme) {
    nativeTheme.themeSource = theme === "light" || theme === "dark" ? theme : "system";
}

// ── User Preferences Store ───────────────────
const Store = require("electron-store");
const store = new Store({
    defaults: {
        launchAtLogin: false,
        theme: "system", // "light" | "dark" | "system"
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

// The overlay shortcut that is actually registered right now (may be a
// fallback when the preferred one is taken). Shown to the user in the UI.
let activeOverlayShortcut = null;
function getActiveOverlayShortcut() {
    return activeOverlayShortcut || getOverlayShortcut();
}
function shortcutLabel(accelerator) {
    if (process.platform !== "darwin") return accelerator.replace(/\+/g, " + ");
    const map = { Command: "\u2318", Cmd: "\u2318", CommandOrControl: "\u2318", Option: "\u2325", Alt: "\u2325", Shift: "\u21E7", Control: "\u2303", Ctrl: "\u2303", Space: "Space" };
    return accelerator.split("+").map((k) => map[k] || k).join("");
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
        const session = JSON.parse(json);
        if (session && isLegacyUserId(session.userId)) {
            console.log("[Auth] Purging legacy session:", session.userId);
            deleteAccountSession();
            return null;
        }
        return session;
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
        resetRetryBudget();
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
                    title: "Bhai Update Available",
                    // Windows silently drops notifications with an empty body
                    body: `Version ${info.version} is ready to download`,
                    icon: path.join(__dirname, process.platform === "win32" ? "logo.ico" : "logo.png"),
                }).show();
            }
        }
    });

    autoUpdater.on("update-not-available", (info) => {
        console.log("[Updater] No updates available");
        resetRetryBudget();
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

    require("electron").autoUpdater.on("before-quit-for-update", () => {
        isQuitting = true;
        if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
        if (buddyWindow && !buddyWindow.isDestroyed()) buddyWindow.destroy();
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
                    title: "Bhai Update Ready",
                    body: `Version ${info.version} is ready to install. Restart to update.`,
                    icon: path.join(__dirname, process.platform === "win32" ? "logo.ico" : "logo.png"),
                }).show();
            }
        }
    });

    autoUpdater.on("error", (err) => {
        const msg = err.message || "";
        // 404 is expected when the server hasn't published a release yet
        // (empty YAML with version 0.0.0). Don't spam retries for those.
        const isMissing =
            msg.includes("404") ||
            msg.includes("Not Found") ||
            msg.includes("ERR_UPDATER_LATEST_VERSION_NOT_FOUND");
        if (msg.includes("401") || msg.includes("403") || isMissing) {
            console.error("[Updater] endpoint unavailable:", msg);
            return; // nothing published / feed off — not worth a toast
        }
        console.error("[Updater] Error:", msg);
        scheduleRetry();
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("update-error", msg);
        }
    });
}

// ── Retry with exponential backoff ───────────────
// Transient network failures (DNS, TLS handshake, temporary 5xx) should
// not wait the full 4h interval. Retry up to 3 times with backoff, then
// give up until the next scheduled check.
let _retryAttempt = 0;
let _retryTimer = null;
const RETRY_SCHEDULE_MS = [30_000, 120_000, 600_000]; // 30s, 2m, 10m

function scheduleRetry() {
    if (_retryTimer) return; // already queued
    if (_retryAttempt >= RETRY_SCHEDULE_MS.length) {
        console.log("[Updater] Retry budget exhausted; waiting for next scheduled check");
        return;
    }
    const delay = RETRY_SCHEDULE_MS[_retryAttempt++];
    console.log(`[Updater] Retry #${_retryAttempt} in ${Math.round(delay / 1000)}s`);
    _retryTimer = setTimeout(() => {
        _retryTimer = null;
        autoUpdater.checkForUpdates().catch(err => {
            console.warn("[Updater] Retry check failed:", err.message);
        });
    }, delay);
}

function resetRetryBudget() {
    _retryAttempt = 0;
    if (_retryTimer) {
        clearTimeout(_retryTimer);
        _retryTimer = null;
    }
}

async function checkForUpdates() {
    if (IS_DEV) return;
    configureAutoUpdater();
    resetRetryBudget(); // fresh budget for each scheduled check
    try {
        await autoUpdater.checkForUpdates();
    } catch (err) {
        console.warn("[Updater] Check failed:", err.message);
        // error listener already called scheduleRetry — nothing more here
    }
}

// `killed` turns true as soon as a signal is SENT, while the bot spends seconds
// shutting down — so liveness comes from the exit fields instead.
const isAlive = (c) => !!c && c.exitCode === null && c.signalCode === null;

// ── Vault (vault-store.js) ──
// The decrypted vault exists only here and in the bot, which gets it over its
// stdin pipe (##BHAI_VAULT##, the reverse of the ##BHAI_BUDDY## stdout markers):
// at spawn and on every edit. It never touches disk unencrypted.
const VAULT_PATH = path.join(app.getPath("userData"), "vault.enc");
const pendingCvv = new Set(); // CVV prompts the bot asked for, by id
function writeToBot(line) {
    if (!isAlive(botProcess) || !botProcess.stdin || !botProcess.stdin.writable) return false;
    botProcess.stdin.write(`${line}\n`);
    return true;
}
function sendVaultToBot(entries) {
    try {
        const list = entries || (fs.existsSync(VAULT_PATH) ? readVault(VAULT_PATH, safeStorage).entries : []);
        writeToBot(`##BHAI_VAULT##${JSON.stringify(list)}`);
    } catch (e) {
        console.warn("[vault] not sent to the bot:", e.message);
    }
}
// The bot is about to pay with a saved card: ask the owner for the CVV in the
// panel. It goes straight back to the bot, used once, never stored.
function askCvv(req) {
    const id = Number(req && req.id);
    if (!mainWindow || mainWindow.isDestroyed()) return writeToBot(`##BHAI_VAULT_CVV##${JSON.stringify({ id, cvv: null })}`);
    pendingCvv.add(id);
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("vault:cvv-request", {
        id,
        label: String(req.label || "").slice(0, 80),
        item: String(req.item || "").slice(0, 120),
        amount: Number(req.amount) || 0,
        site: String(req.site || "").slice(0, 120), // the merchant host the card will be used on
    });
}
let stopPromise = null; // resolves when the bot being stopped has really exited
let botCrashTimes = []; // recent crash times, for restart backoff
let installInFlight = null; // the running setup install, shared by every caller
let overlayLoadFailed = false; // the overlay tried to load before the bot was listening
// Set when the bot won't start again on its own (exit 78, or it gave up after crashing):
// the overlay shows this instead of retrying the splash forever.
let botDownMessage = null;
const SIGN_IN_AGAIN_MSG = "Bhai couldn't start. Open Bhai to sign in again or check your credits.";

function getBotStatus() {
    return isAlive(botProcess) ? "running" : "stopped";
}

// The bot's boot probe found Accessibility or Screen Recording not working (a stale
// grant macOS still reports as granted, or a revoked one): say so once per app run.
// Not during setup (the permission tiles ask there) and not for one the user skipped.
let permsNotice = null; // kept referenced so its click handler survives GC
function notifyBrokenPermission(p) {
    const skipped = store.get("skippedPermissions") || {};
    const name = ["accessibility", "screen"].find((k) => p[k] === false && !skipped[k]);
    const { Notification } = require("electron");
    if (!name || permsNotice || !fs.existsSync(SETUP_FLAG) || !Notification.isSupported()) return;
    const { prefPaneUrlFor } = require("./components/permissions-grid");
    permsNotice = new Notification({
        title: "Bhai",
        body: `${name === "accessibility" ? "Accessibility" : "Screen Recording"} looks off. Click to fix.`,
    });
    permsNotice.on("click", () => shell.openExternal(prefPaneUrlFor(name)).catch(() => {}));
    permsNotice.show();
}

// Bot → "##BHAI_NOTIFY##{kind,title,body}" (src/desktop-notify.ts): a finished long
// task, a proactive message, Bhai stuck or needing a tap. A click opens the chat the
// owner last used, where the reply is.
const shouldNotify = require("./notify-gate").createNotifyGate((k) => store.get(k));
let lastChatSurface = "overlay"; // "panel" once the owner chats in the app window
function showBotNotification(note) {
    const { Notification, BrowserWindow } = require("electron");
    if (!Notification.isSupported() || !shouldNotify(note, !!BrowserWindow.getFocusedWindow())) return;
    const n = new Notification({
        title: String(note.title || "Bhai").slice(0, 80),
        body: String(note.body).slice(0, 240),
        icon: path.join(__dirname, process.platform === "win32" ? "logo.ico" : "logo.png"),
    });
    n.on("click", () => {
        if (lastChatSurface === "panel" && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.focus();
        } else showOverlay();
    });
    n.show();
}

// Bhai's face on the owner's Telegram bot: set once per bot, and only while it has
// no photo, so a picture the owner chose is never replaced.
async function ensureTelegramAvatar(token) {
    if (!/^\d+:[\w-]{30,}$/.test(token || "")) return;
    const botId = token.split(":")[0]; // a bot token starts with the bot's user id
    const doneFile = path.join(DATA_DIR, "telegram-avatar.json");
    try { if (JSON.parse(fs.readFileSync(doneFile, "utf8")).botId === botId) return; } catch { /* not yet */ }
    const api = (method) => `https://api.telegram.org/bot${token}/${method}`;
    try {
        const photos = await (await fetch(`${api("getUserProfilePhotos")}?user_id=${botId}&limit=1`)).json();
        if (!photos.ok) return;
        if (photos.result.total_count === 0) {
            const form = new FormData();
            form.append("photo", JSON.stringify({ type: "static", photo: "attach://avatar" }));
            const jpg = fs.readFileSync(path.join(__dirname, "assets", "mascot", "telegram-avatar.jpg"));
            form.append("avatar", new Blob([jpg], { type: "image/jpeg" }), "avatar.jpg");
            const r = await (await fetch(api("setMyProfilePhoto"), { method: "POST", body: form })).json();
            if (!r.ok) { console.warn("[Telegram] Couldn't set the bot's photo:", r.description); return; }
        }
        fs.writeFileSync(doneFile, JSON.stringify({ botId }));
    } catch (err) {
        console.warn("[Telegram] Bot photo check failed:", err.message);
    }
}

async function startBot() {
    if (stopPromise) await stopPromise; // never run two bots at once
    if (isAlive(botProcess)) return { status: "already_running" };

    // ── Account gate: signed out, or a device without its sign-in secret, only gets refused ──
    const session = loadAccountSession();
    if (!session?.userId) {
        console.log("[BOT] Not starting: signed out (Account → Sign in)");
        return { status: "signed_out" };
    }
    if (session?.userId && !session.deviceSecret) {
        _signInNeeded = "sign_in_required";
        botDownMessage = SIGN_IN_AGAIN_MSG;
        console.log("[BOT] Not starting: sign in again (Account) — this device has no sign-in secret yet");
        return { status: "sign_in_required" };
    }

    // Ensure data dir exists
    fs.mkdirSync(DATA_DIR, { recursive: true });

    // Write decrypted .env to temp location for bot to read
    const envContent = loadEnvDecrypted();
    const tempEnvPath = path.join(DATA_DIR, ".env.runtime");
    if (envContent) {
        fs.writeFileSync(tempEnvPath, envContent, { mode: 0o600 });
    }

    // Use the single bundled file if available (production build).
    // Falls back to the compiled dist/index.js for dev mode.
    const bundlePath = path.join(BOT_DIR, "bot-bundle.mjs");
    const entryPoint = fs.existsSync(bundlePath)
        ? bundlePath
        : path.join(BOT_DIR, "dist", "index.js");

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

    // Only an empty/unreadable settings file is worth a warning; no Telegram
    // token is normal (other channels, or just the overlay).
    if (!envContent) {
        sendLog("⚠️ Warning: settings are empty or couldn't be decrypted.");
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
        // Where Settings writes .user-personality.json (personality-sync.ts).
        ATLAS_USER_DATA_DIR: app.getPath("userData"),
        // The bot sends native notifications through us (showBotNotification).
        ATLAS_DESKTOP_NOTIFY: "1",
        NODE_ENV: "production",
        // V8 code cache for the 23MB bundle: a warm start skips re-compiling it.
        NODE_COMPILE_CACHE: path.join(app.getPath("userData"), "v8-cache"),
        // The app draws Bhai's ghost cursor (agent-cursor.js); off with ATLAS_NO_AGENT_CURSOR=true.
        // Not on Linux: setOpacity/content protection do nothing there, so Bhai's
        // own screenshots would see the overlay (and it can render opaque without
        // a compositor).
        ...(CURSOR_SUPPORTED ? { ATLAS_AGENT_CURSOR_IPC: "1" } : {}),
    };

    // Pass Convex URL + OTPless identity to bot process for credit enforcement
    spawnEnv.CONVEX_URL = CONVEX_API_URL;
    if (session && session.userId) {
        spawnEnv.ATLAS_OTPLESS_USER_ID = session.userId;
        spawnEnv.ATLAS_ACCOUNT_EMAIL = session.email || "";
        if (session.deviceSecret) spawnEnv.ATLAS_DEVICE_SECRET = session.deviceSecret;
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

    let child = null;
    botDownMessage = null;
    try {
        child = botProcess = spawn(executable, args, {
            cwd: BOT_DIR,
            env: spawnEnv,
            stdio: ["pipe", "pipe", "pipe"],
            shell: false, // Critical: shell:true on Windows might invoke cmd.exe instead of Electron
        });
    } catch (spawnErr) {
        sendLog(`❌ Failed to spawn process: ${spawnErr.message}`);
        return { status: "error", error: spawnErr.message };
    }
    child.stdin.on("error", () => { /* bot gone: cursor acks are best-effort; exit handler deals with EPIPE */ });
    sendVaultToBot();

    let stdoutTail = "";
    botProcess.stdout.on("data", (data) => {
        // Line-buffer so a companion marker split across chunks isn't lost, and
        // keep the markers out of the user's log.
        const lines = (stdoutTail + data.toString()).split("\n");
        stdoutTail = lines.pop();
        const rest = [];
        for (const line of lines) {
            const cursorEvt = parseCursorLine(line);
            if (cursorEvt) {
                try { agentCursor?.handle(cursorEvt, (id) => ackCursor(child, id)); } catch { /* cosmetic */ }
                continue;
            }
            const cvv = line.match(/^##BHAI_VAULT_CVV##(\{.*\})\s*$/);
            if (cvv) { try { askCvv(JSON.parse(cvv[1])); } catch { /* malformed line */ } continue; }
            const note = line.match(/^##BHAI_NOTIFY##(\{.*\})\s*$/);
            if (note) { try { showBotNotification(JSON.parse(note[1])); } catch { /* malformed line */ } continue; }
            const perms = line.match(/^##ATLAS_PERMS##(\{.*\})\s*$/);
            if (perms) { try { notifyBrokenPermission(JSON.parse(perms[1])); } catch { /* malformed line */ } continue; }
            const m = line.match(/^##BHAI_BUDDY##(\{.*\})\s*$/);
            if (!m) { rest.push(line); continue; }
            try { handleBuddyStatus(JSON.parse(m[1])); } catch { /* malformed line */ }
        }
        const msg = rest.join("\n").trim();
        if (msg) {
            sendLog(msg);
            // Track stats from log output
            if (msg.includes("User:")) addMessageToday();
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

            // Overlay server is listening: load the overlay now (it failed while the bot booted).
            if (msg.includes("##ATLAS_READY##")) {
                sendLog(`Bot ready in ${msg.split("##ATLAS_READY##")[1]?.trim() || "?"}ms`);
                if (overlayLoadFailed && overlayWindow && !overlayWindow.isDestroyed()) {
                    overlayLoadFailed = false;
                    overlayWindow.loadURL(OVERLAY_URL);
                }
            }

            // WhatsApp OTP forwarding
            const selfMatch = msg.match(/##ATLAS_WA_SELF##(\d+)##END_SELF##/);
            if (selfMatch) {
                waSelfNumber = selfMatch[1];
                if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("whatsapp-otp", { self: waSelfNumber });
            }
            const otpMatch = msg.match(/##ATLAS_WA_OTP##(.+)##END_OTP##/);
            if (otpMatch) {
                waOtpPayload(otpMatch[1]).then(p => {
                    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("whatsapp-otp", p);
                });
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
            if (msg.includes("Email connected") || msg.includes("IMAP connected") || msg.includes("Bhai's email:")) channelStatuses.email = "connected";
            if (msg.includes("\u2705 Bot online: @")) channelStatuses.telegram = "connected";
            if (msg.includes("Bhai online (Telegram disabled)")) channelStatuses.telegram = "not_configured";

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
            // stderr carries console.warn/info too, not just errors. Tag the log
            // line by the bot's own severity marker so benign warnings (channel
            // not configured, GPS→IP fallback) don't masquerade as [ERROR].
            const isError = /\[ERROR\]|❌|Error:|Uncaught|Unhandled/.test(msg);
            console.error("[BOT ERR]", msg);
            writeToLogFile(`${isError ? "[ERROR]" : "[WARN]"} ${msg}`);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send("bot-log", `${isError ? "❌" : "⚠"} ${msg}`);
            }
        }
    });

    // A stale child (an earlier bot finishing its shutdown) must not touch the
    // state of the one that replaced it.
    child.on("error", (err) => {
        if (botProcess !== child) return;
        sendLog(`❌ Process error: ${err.message}`);
        botProcess = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("bot-status", "stopped");
        }
        updateTrayMenu();
    });

    child.on("exit", (code, signal) => {
        if (botProcess !== child) return;
        agentCursor?.reset();
        sendLog(`Process exited with code ${code}`);
        botProcess = null;
        // "crashed" (restarting) / "failed" (gave up) let the panel show it.
        let exitStatus = "stopped";
        // A crash (not a Stop or app quit) restarts the bot with backoff:
        // 1, 2, 4, 8, 16s, at most 5 restarts in 10 minutes.
        // Exit 78 means "not allowed to run" (signed out / no credits): retrying won't help.
        if (!stopPromise && !isQuitting && code !== 78 && (code !== 0 || signal)) {
            const now = Date.now();
            botCrashTimes = botCrashTimes.filter((t) => now - t < 10 * 60_000);
            botCrashTimes.push(now);
            if (botCrashTimes.length <= 5) {
                const delay = 1000 * 2 ** (botCrashTimes.length - 1);
                sendLog(`Bot crashed; restarting in ${delay / 1000}s`);
                exitStatus = "crashed";
                setTimeout(() => {
                    if (!isAlive(botProcess) && !isQuitting) startBot().catch(() => {});
                }, delay);
            } else {
                sendLog("Bot crashed 5 times in 10 minutes; not restarting. Use Start to try again.");
                exitStatus = "failed";
                botDownMessage = "Bhai stopped after crashing several times. Open Bhai and press Start to try again.";
            }
        }
        if (code === 78) botDownMessage = SIGN_IN_AGAIN_MSG;
        hideBuddy();
        for (const k of Object.keys(channelStatuses)) delete channelStatuses[k];
        // Clean up temp env
        try { fs.unlinkSync(tempEnvPath); } catch { /* */ }
        // Notify renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("bot-status", exitStatus);
        }
        updateTrayMenu();
    });

    // Notify renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("bot-status", "running");
    }
    updateTrayMenu();
    botStartTime = Date.now();
    ensureTelegramAvatar(loadEnvKey("TELEGRAM_BOT_TOKEN")); // an existing bot without a photo gets Bhai's

    return { status: "started" };
}

function stopBot() {
    const child = botProcess;
    if (!isAlive(child)) return { status: "already_stopped" };
    if (!stopPromise) {
        stopPromise = new Promise((resolve) => {
            child.once("exit", resolve);
            child.kill("SIGTERM");
            setTimeout(() => {
                if (isAlive(child)) child.kill("SIGKILL");
            }, 5000);
        }).finally(() => {
            stopPromise = null;
        });
    }
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
        const desktopDirResolved = path.resolve(desktopDir);
        const server = http.createServer((req, res) => {
            // A rebound website (its name pointed at 127.0.0.1) would read the app's files here.
            if (!isLoopbackHost(req.headers.host, server.address()?.port)) {
                res.writeHead(421);
                res.end("Misdirected");
                return;
            }
            let filePath = path.join(desktopDir, req.url === "/" ? "/panel.html" : req.url);
            // Strip query strings
            filePath = filePath.split("?")[0];
            // F1: path-traversal containment. Resolve to absolute path and
            // assert the result is inside desktopDir. Without this, a request
            // like `GET /../../etc/passwd` would let any local process or
            // origin reachable via http://127.0.0.1:7421 read arbitrary files.
            const resolved = path.resolve(filePath);
            if (!resolved.startsWith(desktopDirResolved + path.sep) && resolved !== desktopDirResolved) {
                res.writeHead(403);
                res.end("Forbidden");
                return;
            }
            const ext = path.extname(resolved).toLowerCase();
            fs.readFile(resolved, (err, data) => {
                if (err) {
                    res.writeHead(404);
                    res.end("Not found"); // never echo req.url: it would reflect into this origin
                    return;
                }
                // F1: ACAO:* removed. Same-origin loads from the BrowserWindow
                // (which is on the same 127.0.0.1:port) need no CORS header.
                // The wildcard previously let any webpage in any user browser
                // tab fetch from here cross-origin.
                res.writeHead(200, {
                    "Content-Type": mime[ext] || "application/octet-stream",
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

// F4: applied to every BrowserWindow we create. Denies window.open(), blocks
// arbitrary navigations, and pins webPreferences to the safe defaults that
// shouldn't be opt-in. Pass `allowedNavigateOrigins` to permit specific
// remote loads (e.g. the OTPless-hosted auth page on tryatlasagi.com).
const TRUSTED_LOCAL_ORIGINS = new Set([new URL(OVERLAY_URL).origin]);

// target=_blank links in the panel/wizard: allowed sites open in the default browser.
function openPanelLink(url) {
    const target = require("./panel-links").panelLinkTarget(url);
    if (target) shell.openExternal(target).catch(() => {});
    else console.warn(`[Window] Blocked link to ${url}`);
}

function hardenBrowserWindow(win, opts = {}) {
    const allowed = Array.isArray(opts.allowedNavigateOrigins) ? opts.allowedNavigateOrigins : [];
    const allowLocal = opts.allowLocal !== false; // file:// + http://127.0.0.1 by default
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (opts.externalLinks) openPanelLink(url);
        return { action: "deny" };
    });
    // Local means our own files and our own servers (the bot's page, the panel's server),
    // not any service on a localhost port: a window keeps its preload wherever it navigates.
    const guard = (e, url) => {
        try {
            const u = new URL(url);
            if (allowLocal && (u.protocol === "file:" || TRUSTED_LOCAL_ORIGINS.has(u.origin))) return;
            if (allowed.includes(u.host)) return;
            e.preventDefault();
            console.warn(`[Window] Blocked navigation to ${url}`);
        } catch {
            e.preventDefault();
        }
    };
    win.webContents.on("will-navigate", guard);
    win.webContents.on("will-redirect", guard);
}

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
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            devTools: IS_DEV,
        },
        title: "Bhai Setup — © XAGI Labs",
    });

    hardenBrowserWindow(mainWindow, { externalLinks: true });
    mainWindow.loadFile(path.join(__dirname, "wizard.html"));
    if (IS_DEV) mainWindow.webContents.openDevTools({ mode: "detach" });
}

// macOS: native window chrome per Apple's HIG — standard traffic lights inset
// into a hidden title bar. The page paints the whole window (living colour
// orbs under liquid-glass panels), so the window is opaque; the background
// colour matches the theme so there's no flash before the page paints.
function macPanelChrome() {
    if (process.platform !== "darwin") return {};
    return {
        frame: true,
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 18, y: 18 },
        transparent: false,
        backgroundColor: nativeTheme.shouldUseDarkColors ? "#14100E" : "#F7F1EC",
    };
}

async function createPanelWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 640,
        minWidth: 760,
        minHeight: 540,
        frame: false,
        transparent: true,
        resizable: true,
        ...macPanelChrome(),
        icon: path.join(__dirname, "logo.ico"),
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            devTools: IS_DEV,
        },
        title: "Bhai — © XAGI Labs",
    });

    hardenBrowserWindow(mainWindow, { externalLinks: true });
    // The native close button hides to the menu bar, like the app's own close
    // control; Quit (⌘Q / tray) still quits.
    mainWindow.on("close", (e) => {
        if (!isQuitting) {
            e.preventDefault();
            mainWindow.hide();
        }
    });
    // Load from local HTTP server so OTPless SDK origin check passes
    const port = await startLocalServer();
    if (port) {
        TRUSTED_LOCAL_ORIGINS.add(`http://127.0.0.1:${port}`);
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
    // Centred command-bar placement (Spotlight-style) on the display the
    // cursor is on, a fifth of the way down, clear of menu bars and toolbars.
    return {
        x: Math.round(wa.x + (wa.width - OVERLAY_WIDTH) / 2),
        y: Math.round(wa.y + wa.height * 0.2),
    };
}

// ── On-screen companion ──────────────────────────
// The plush Bhai that pops up in the corner while it works for you (when the
// chat window isn't showing). Click-through, never takes focus, and excluded
// from screen capture so Bhai's own screenshots never see it.
const BUDDY_W = 300;
const BUDDY_H = 150;
let buddyWindow = null;
let buddyReady = false;
let buddyState = null;
let buddyHideTimer = null;
let buddyWatchdog = null;

function ensureBuddyWindow() {
    if (buddyWindow && !buddyWindow.isDestroyed()) return buddyWindow;
    buddyReady = false;
    buddyWindow = new BrowserWindow({
        width: BUDDY_W,
        height: BUDDY_H,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        // NOT closable:false — a window that refuses to close cancels app.quit()
        // and quitAndInstall. It's click-through and focus-less anyway.
        focusable: false,
        skipTaskbar: true,
        hasShadow: false,
        show: false,
        backgroundColor: "#00000000",
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: IS_DEV },
    });
    hardenBrowserWindow(buddyWindow);
    buddyWindow.setIgnoreMouseEvents(true);
    buddyWindow.setContentProtection(true);
    buddyWindow.setAlwaysOnTop(true, "floating");
    if (process.platform === "darwin") buddyWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    buddyWindow.webContents.on("did-finish-load", () => {
        buddyReady = true;
        if (buddyState) renderBuddy();
    });
    buddyWindow.on("closed", () => { buddyWindow = null; buddyReady = false; });
    buddyWindow.loadFile(path.join(__dirname, "buddy.html"));
    return buddyWindow;
}

function renderBuddy() {
    if (!buddyWindow || buddyWindow.isDestroyed() || !buddyReady || !buddyState) return;
    buddyWindow.webContents.executeJavaScript(`window.setBuddy(${JSON.stringify(buddyState)})`).catch(() => {});
}

function hideBuddy() {
    clearTimeout(buddyHideTimer);
    clearTimeout(buddyWatchdog);
    if (!buddyWindow || buddyWindow.isDestroyed()) return;
    buddyState = { ...(buddyState || {}), visible: false };
    renderBuddy();
    buddyHideTimer = setTimeout(() => {
        if (buddyWindow && !buddyWindow.isDestroyed()) buddyWindow.hide();
    }, 450);
}

function overlayShowing() {
    return !!(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible());
}

// `force`: Bhai is acting on the screen and has made the overlay invisible, so
// the companion stands in for it even while the overlay is open.
function showBuddy(mood, text, hideAfterMs, force = false) {
    // While the chat window is open the mascot already lives there.
    if (overlayShowing() && !force) {
        if (buddyState?.visible) hideBuddy();
        return;
    }
    const win = ensureBuddyWindow();
    clearTimeout(buddyHideTimer);
    clearTimeout(buddyWatchdog);
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    win.setPosition(Math.round(wa.x + wa.width - BUDDY_W - 12), Math.round(wa.y + wa.height - BUDDY_H - 8));
    buddyState = { mood, text, visible: true };
    if (!win.isVisible()) win.showInactive();
    renderBuddy();
    // Done/oops pop away on their own; anything else hides if Bhai goes quiet.
    if (hideAfterMs) buddyHideTimer = setTimeout(hideBuddy, hideAfterMs);
    else buddyWatchdog = setTimeout(hideBuddy, 90_000);
}

// ── Bhai's ghost cursor ──────────────────────────
// Bot → "##BHAI_CURSOR##{json}" lines from the computer-use tools; acks go back
// on its stdin. The (hidden) windows are made once at app ready and follow
// display changes, so nothing is created in the middle of a click.
const CURSOR_SUPPORTED = process.platform !== "linux";
let agentCursor = null;
function initAgentCursor() {
    if (!CURSOR_SUPPORTED || agentCursor) return;
    try {
        agentCursor = createAgentCursor({
            BrowserWindow,
            screen,
            harden: hardenBrowserWindow,
            htmlPath: path.join(__dirname, "agent-cursor.html"),
        });
        agentCursor.init();
    } catch (err) {
        console.error("[AgentCursor] init failed:", err.message);
        agentCursor = null;
    }
}
function ackCursor(child, id) {
    try { child.stdin.write(`##BHAI_CURSOR_ACK##${id}\n`); } catch { /* bot gone */ }
}

// Bot → "##BHAI_BUDDY##{type,text}" lines (see src/overlay/overlay-chat.ts).
// What the corner companion says, in Bhai's voice — varied so it doesn't repeat itself.
const BUDDY_LINES = {
    "thinking": [
        "Hmm, let me see…",
        "Thinking it through…",
        "Connecting the dots…",
        "Hmm, one sec…"
    ],
    "looking": [
        "Checking your screen…",
        "Taking a look…",
        "Eyes on it 👀",
        "Peeking over the shades 😎"
    ],
    "working": [
        "Sorting it out…",
        "On it…",
        "Finding a way…",
        "No hands, still on it…",
        "Chalo, on it…"
    ],
    "done": [
        "Sorted!",
        "Done ✅",
        "Ho gaya ✅",
        "All set 😎",
        "That's handled."
    ],
    "error": [
        "Arre, hit a snag.",
        "Hmm, that didn't land.",
        "That one fought back 😅",
        "Bump in the road."
    ]
};
let lastBuddyLine = "";
function buddyLine(kind) {
    const pool = BUDDY_LINES[kind].filter((l) => l !== lastBuddyLine);
    lastBuddyLine = pool[Math.floor(Math.random() * pool.length)];
    return lastBuddyLine;
}

function handleBuddyStatus({ type, text }) {
    const clean = (text || "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
    switch (type) {
        case "thinking": return showBuddy("thinking", buddyLine("thinking"));
        case "screen":
            // Out of the way for the agent's screenshots and clicks: the native
            // glass can't be hidden from CSS, and the window would block clicks.
            if (overlayShowing()) { overlayWindow.setOpacity(0); overlayWindow.setIgnoreMouseEvents(true); }
            return showBuddy("looking", buddyLine("looking"), 0, true);
        case "screen_done":
            if (overlayWindow && !overlayWindow.isDestroyed()) { overlayWindow.setOpacity(1); overlayWindow.setIgnoreMouseEvents(false); }
            return overlayShowing() ? hideBuddy() : showBuddy("working", buddyLine("working"));
        case "progress": {
            const looking = /screen|look|see|brows|search|web|page|read/i.test(clean);
            return showBuddy(looking ? "looking" : "working", clean || "Working on it…");
        }
        case "response": return buddyState?.visible ? showBuddy("happy", buddyLine("done"), 2400) : undefined;
        case "error": return showBuddy("oops", buddyLine("error"), 4000);
        case "silent": return hideBuddy();
    }
}

// Apple's real Liquid Glass (NSGlassEffectView, macOS 26+) behind the overlay's
// web contents, via the bot's native module (native/ in dev, Resources/bot/native
// when packaged). Returns false — logged once — so the caller falls back to vibrancy.
let overlayGlassNative; // undefined = not loaded yet, null = unavailable
function attachOverlayGlass(win) {
    try {
        if (overlayGlassNative === undefined) {
            overlayGlassNative = require(path.join(BOT_DIR, "native", `atlas-native.darwin-${process.arch}.node`));
        }
        const [w, h] = win.getContentSize();
        // Dark glass gets a smoky tint so white text stays readable over busy or
        // bright windows. Light mode gets a white veil in overlay.html instead
        // (a white tint renders the glass grey).
        const tint = nativeTheme.shouldUseDarkColors ? OVERLAY_DARK_TINT : null;
        if (overlayGlassNative?.attachGlassEffect?.(win.getNativeWindowHandle(), w, h, OVERLAY_CORNER_RADIUS, tint)) return true;
        throw new Error("NSGlassEffectView unavailable (needs macOS 26+)");
    } catch (err) {
        if (overlayGlassNative !== null) console.warn("[OVERLAY] Liquid Glass off, using vibrancy:", err.message);
        overlayGlassNative = null;
        return false;
    }
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
        // macOS: the glass (Liquid Glass, or vibrancy before macOS 26) is
        // attached right after creation by attachOverlayGlass(); CSS
        // backdrop-filter can't see other apps. visualEffectState applies to
        // the vibrancy fallback.
        hasShadow: true,
        visualEffectState: "active",
        roundedCorners: true,
        show: false,
        backgroundColor: "#00000000",
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            devTools: IS_DEV,
            preload: path.join(__dirname, "overlay-preload.js"),
        },
    });

    if (process.platform === "darwin") {
        if (!attachOverlayGlass(overlayWindow)) overlayWindow.setVibrancy("popover");
    } else {
        // No native glass here: give the clear page the theme's opaque panel fill.
        overlayWindow.webContents.on("did-finish-load", () => {
            overlayWindow.webContents.insertCSS("body, body.theme-light { background: var(--bg-panel); }").catch(() => {});
        });
    }

    // The native glass can't be faded from CSS, so keep the overlay out of
    // screen captures (Bhai's own screenshots must see what's underneath).
    overlayWindow.setContentProtection(true);

    // F4: deny window.open() and constrain navigation. Overlay loads from
    // 127.0.0.1 (the bot's overlay server), so allowLocal=true is sufficient.
    hardenBrowserWindow(overlayWindow);

    // macOS: show on all Spaces and in fullscreen
    if (process.platform === "darwin") {
        overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }

    hookOverlayToken(overlayWindow.webContents.session);
    overlayWindow.loadURL(OVERLAY_URL);

    // Retry loading if the bot server isn't ready yet (race condition on first show)
    overlayWindow.webContents.on("did-fail-load", (_e, errCode, errDesc, url) => {
        if (errCode === -102 || errCode === -6 || errDesc === "ERR_CONNECTION_REFUSED") {
            // Bot server not up yet: the bot's ##ATLAS_READY## line reloads it the
            // moment it listens; this slower retry is only a fallback.
            // Not coming up at all: say why instead of retrying forever. Still
            // flagged failed so a later start's ##ATLAS_READY## loads the overlay.
            if (botDownMessage && !isAlive(botProcess)) {
                overlayLoadFailed = true;
                overlayWindow.loadURL(overlaySplash(botDownMessage));
                return;
            }
            overlayLoadFailed = true;
            overlayWindow.loadURL(overlaySplash());
            setTimeout(() => {
                if (overlayLoadFailed && overlayWindow && !overlayWindow.isDestroyed()) {
                    overlayLoadFailed = false;
                    overlayWindow.loadURL(OVERLAY_URL);
                }
            }, 5000);
        } else {
            console.error(`[OVERLAY] Failed to load: ${errDesc} (${errCode}) — ${url}`);
        }
    });

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
    // The chat UI is served by the bot. If it isn't running, start it (when
    // signed in) and show the overlay's splash until it listens.
    if (!botProcess) {
        const signedIn = !!(loadAccountSession() || {}).userId;
        if (!signedIn) {
            const { Notification } = require("electron");
            if (Notification.isSupported()) {
                new Notification({ title: "Bhai", body: "Open Bhai and sign in to start chatting." }).show();
            }
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
            return;
        }
        startBot().catch((err) => console.error("[OVERLAY] Auto-start failed:", err.message));
    }

    hideBuddy(); // the overlay has its own mascot
    lastChatSurface = "overlay";

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
                if (inp) { inp.value = ''; inp.disabled = false; inp.dispatchEvent(new Event('input')); }
            }
            if (nb) { nb.classList.remove('visible'); nb.innerHTML = ''; }
            return busy;
        })();
    `).then((hasContent) => {
        if (!overlayWindow || overlayWindow.isDestroyed()) return;
        if (hasContent) {
            // Active content — resize window to fit now
            overlayWindow.webContents.executeJavaScript(
                OVERLAY_CONTENT_HEIGHT_JS
            ).then((sh) => {
                if (!overlayWindow || overlayWindow.isDestroyed()) return;
                const h = Math.min(Math.max(sh, OVERLAY_MIN_HEIGHT), OVERLAY_MAX_HEIGHT);
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
            if (window.noteHide) window.noteHide();
        })();
    `).catch(() => {});

    // Wait for animation, then hide
    setTimeout(() => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.hide();
            // Reset animations so springIn replays on next show, and start a
            // fresh chat if Bhai is idle (it keeps the context; the dashboard's
            // Chats page keeps the transcript).
            overlayWindow.webContents.executeJavaScript(`
                (function() {
                    var ib = document.getElementById('input-box');
                    var rb = document.getElementById('reply-box');
                    if (ib) ib.style.animation = '';
                    if (rb) rb.style.animation = '';
                    if (window.resetChatIfIdle) window.resetChatIfIdle();
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

// Height of the overlay's visible content: the bottom edge of the last shown
// section. (The container's scrollHeight can't be used — hidden absolutely
// positioned popovers inflate it to the window's own height, so the window
// could grow but never shrink back.)
const OVERLAY_CONTENT_HEIGHT_JS = `(() => {
    const c = document.getElementById('container');
    if (!c) return 0;
    let bottom = 0;
    for (const k of c.children) {
        if (getComputedStyle(k).display === 'none') continue;
        bottom = Math.max(bottom, k.getBoundingClientRect().bottom);
    }
    return Math.ceil(bottom);
})()`;

function startHeightPolling() {
    stopHeightPolling();
    overlayResizeTimer = setInterval(() => {
        if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) {
            stopHeightPolling();
            return;
        }
        overlayWindow.webContents.executeJavaScript(
            OVERLAY_CONTENT_HEIGHT_JS
        ).then((scrollHeight) => {
            if (!overlayWindow || overlayWindow.isDestroyed()) return;
            const newH = Math.min(Math.max(scrollHeight, OVERLAY_MIN_HEIGHT), OVERLAY_MAX_HEIGHT);
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

    function finalizeAuth({ session, userId, email, phone, name, deviceSecret }) {
        saveAccountSession({
            userId,
            token: session.token,
            email: email || null,
            phone: phone || null,
            name: name || null,
            deviceSecret: deviceSecret || null,
            created_at: new Date().toISOString(),
        });
        _desktopSessionToken = session.token;
        _desktopSessionExpiry = session.expiresAt || (Date.now() + 86400000);
        _signInNeeded = null;
        // The bot needs the new identity and device secret: restart a running one, and
        // start one that stopped for want of a sign-in (once setup is done).
        if (isAlive(botProcess) || fs.existsSync(SETUP_FLAG)) {
            stopBot();
            startBot().catch((err) => console.error("[AUTH] Bot start failed:", err.message));
        }
        // Seed the profile name from sign-in (the Profile screen is gone): the bot
        // writes it into the identity memory on boot (src/setup/wizard-seed.ts).
        if (name) {
            try {
                const profilePath = path.join(app.getPath("userData"), ".user-profile.json");
                const seeded = path.join(app.getPath("userData"), ".user-profile.seeded.json");
                if (!fs.existsSync(profilePath) && !fs.existsSync(seeded)) fs.writeFileSync(profilePath, JSON.stringify({ name }, null, 2));
            } catch { /* best-effort */ }
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("account-status-change", { signedIn: true });
            mainWindow.focus();
        }
        if (authWindow && !authWindow.isDestroyed()) {
            authWindow.close();
            authWindow = null;
        }
    }

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
            title: "Bhai — Sign In",
            alwaysOnTop: true,
            webPreferences: {
                // Non-persistent partition: each sign-in starts clean, so the
                // OTPless widget can't silently resume an old, expired attempt.
                partition: `auth-${Date.now()}`,
                preload: path.join(__dirname, "auth-preload.js"),
                nodeIntegration: false,
                contextIsolation: true,
                // F3: sandbox=true puts the renderer in OS-level sandbox.
                // webSecurity=true (default, but explicit) keeps SOP enforced.
                // allowRunningInsecureContent=false rejects mixed content on
                // the HTTPS auth page.
                sandbox: true,
                webSecurity: true,
                allowRunningInsecureContent: false,
                devTools: IS_DEV,
            },
        });
        // F3: lock down the auth window — it's the only window we load remote
        // content into. setWindowOpenHandler denies window.open() from the
        // page; will-navigate confines the renderer to the auth page's host.
        const authUrl = process.env.ATLAS_AUTH_URL || `${CONVEX_SITE_URL}/auth-login`;
        const authHost = (() => { try { return new URL(authUrl).host; } catch { return "tryatlasagi.com"; } })();
        hardenBrowserWindow(authWindow, { allowedNavigateOrigins: [authHost], allowLocal: false });
        // OTPless SDK requires a real HTTPS origin; auth-login/ hosts the
        // headless SDK page and hands the token back via the preload bridge.
        authWindow.loadURL(authUrl);
        authWindow.on("closed", () => { authWindow = null; });
        if (IS_DEV) authWindow.webContents.openDevTools({ mode: "detach" });
    }

    // Overlay IPC — auto-show overlay from preload (e.g. research completion)
    // In-app chat: the panel talks to Bhai over the chat bar's socket, held here so
    // the owner token never reaches the page. One socket; each send names its chat.
    let appChatWs = null;
    let appChatId = null;
    const appChatSocket = () => new Promise((resolve, reject) => {
        if (appChatWs && appChatWs.readyState === 1) return resolve(appChatWs);
        let tok = "";
        try { tok = fs.readFileSync(OVERLAY_TOKEN_FILE, "utf8").trim(); } catch { /* bot not up yet */ }
        if (!tok) return reject(new Error("Bhai isn't running"));
        const ws = new WebSocket(`ws://127.0.0.1:18792/?localToken=${encodeURIComponent(tok)}`);
        ws.onopen = () => { appChatWs = ws; resolve(ws); };
        ws.onerror = () => reject(new Error("Couldn't reach Bhai"));
        ws.onclose = () => { if (appChatWs === ws) appChatWs = null; };
        ws.onmessage = (e) => {
            let msg;
            try { msg = JSON.parse(e.data); } catch { return; }
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("chat:event", { chat: appChatId, msg });
        };
    });
    ipcMain.handle("chat:send", async (_, { chat, text, file } = {}) => {
        lastChatSurface = "panel";
        const t = String(text || "").trim().slice(0, 8000);
        const hasFile = file && typeof file.name === "string" && typeof file.base64 === "string" && file.base64.length < 28_000_000;
        if ((!t && !hasFile) || typeof chat !== "string") return { ok: false, error: "Nothing to send" };
        try {
            const ws = await appChatSocket();
            appChatId = chat.slice(0, 64);
            // One file or image per message, the way the chat bar sends a dropped file.
            ws.send(JSON.stringify(hasFile
                ? { type: "file_attach", chat: appChatId, name: file.name.slice(0, 200), base64: file.base64, mimeType: String(file.mimeType || "application/octet-stream"), text: t }
                : { type: "chat", chat: appChatId, text: t }));
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });
    ipcMain.on("chat:stop", () => {
        if (appChatWs && appChatWs.readyState === 1) appChatWs.send(JSON.stringify({ type: "stop" }));
    });
    ipcMain.handle("dash:activity", () => require("./activity").doneToday(path.join(DATA_DIR, "audit.jsonl")));
    ipcMain.on("overlay:show", () => {
        showOverlay();
    });
    // Lets the overlay sync its theme on load with the user's stored choice.
    ipcMain.handle("overlay:getTheme", () => store.get("theme") || "system");
    // Ready Hub "Talk" button — trigger live voice session from renderer.
    // Mirrors what the global live-voice hotkey does when pressed.
    ipcMain.handle("live-voice:trigger", () => {
        if (typeof toggleLiveVoice === "function") {
            try { toggleLiveVoice(); return { ok: true }; }
            catch (err) { return { ok: false, error: err.message || String(err) }; }
        }
        return { ok: false, error: "live-voice not available" };
    });
    // Open auth window from renderer. Short-circuits if a valid session already exists.
    ipcMain.handle("window:openAuth", () => {
        const existing = loadAccountSession();
        // Signed in before device secrets (or told to sign in again): open sign-in.
        if (existing && existing.userId && !isLegacyUserId(existing.userId) && existing.deviceSecret && !_signInNeeded) {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
            return { success: true, alreadySignedIn: true };
        }
        openAuthWindow();
        return { success: true };
    });

    ipcMain.handle("otpless:submit-token", async (_, { token }) => {
        if (!token || typeof token !== "string") {
            return { success: false, error: "Missing token" };
        }
        try {
            // The fingerprint lets a verified sign-in bring back a Mac removed in Account → Devices.
            const raw = await convexPostNoAuth("/api/otpless/validate-token", { token, deviceFingerprint: deviceFingerprint() });
            const parsed = parseOtplessVerifyResponse(raw);
            if (!parsed.ok) return { success: false, error: parsed.error };
            finalizeAuth(parsed);
            return { success: true, userId: parsed.userId };
        } catch (err) {
            return { success: false, error: err.message || "Network error" };
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
    const SECRET_SETTING = /TOKEN|SECRET|PASSWORD|PASSWD|PASS$|_KEY$|^KEY_|API_KEY|CREDENTIAL|COOKIE|SESSION|PRIVATE/i;
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
                // Tokens, passwords and keys stay in main: the panel only needs to know they're set.
                settings[key] = SECRET_SETTING.test(key) && value ? "••••••••" : value;
            }
            return { success: true, settings };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // ── Settings: Save credentials ──
    // Use saveEnvKVs (merge strategy) so saving from Settings does NOT
    // wipe channel credentials that channels:save-config wrote (Email,
    // Discord, Slack, WhatsApp, Matrix, etc.) or other env keys like
    // CONVEX_URL / ATLAS_ENV. Only the keys explicitly present in the
    // payload are touched; everything else in .env is preserved.
    ipcMain.handle("settings:save", (_, settings) => {
        try {
            const kvs = {};
            for (const key of ["TELEGRAM_BOT_TOKEN", "ALLOWED_USER_IDS", "GITHUB_TOKEN", "ATLAS_WORKSPACE"]) {
                if (Object.prototype.hasOwnProperty.call(settings, key)) {
                    kvs[key] = settings[key] ?? "";
                }
            }
            if (Object.prototype.hasOwnProperty.call(settings, "PRIMARY_CHANNEL")) {
                const ch = String(settings.PRIMARY_CHANNEL || "").toLowerCase();
                if (!["telegram", "whatsapp", "discord", "slack", "overlay", "email", "matrix"].includes(ch)) {
                    return { success: false, error: "Unknown channel" };
                }
                kvs.PRIMARY_CHANNEL = ch;
            }
            saveEnvKVs(kvs);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // ── Settings: Open data directory ──
    ipcMain.handle("settings:open-data-dir", () => {
        shell.openPath(DATA_DIR);
    });

    // ── Chats: the chat bar's saved transcript (written by src/overlay/chat-log.ts) ──
    const CHAT_LOG = path.join(DATA_DIR, "chat-history.jsonl");
    function readChatLog() {
        let raw = "";
        try { raw = fs.readFileSync(CHAT_LOG, "utf8"); } catch { return []; }
        const out = [];
        for (const line of raw.split("\n")) {
            if (!line) continue;
            try {
                const e = JSON.parse(line);
                if (e && e.chat && typeof e.text === "string") out.push(e);
            } catch { /* skip a torn line */ }
        }
        return out;
    }
    // Reminders and scheduled tasks the bot saved (src/tools/scheduled.ts).
    ipcMain.handle("schedule:upcoming", () => {
        try {
            const saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "scheduled-tasks.json"), "utf-8"));
            return Array.isArray(saved) ? saved.map(({ id, expression, description, fireAt }) => ({ id, expression, description, fireAt })) : [];
        } catch { return []; }
    });
    ipcMain.handle("chats:list", () => {
        const chats = new Map();
        for (const e of readChatLog()) {
            let c = chats.get(e.chat);
            if (!c) chats.set(e.chat, (c = { id: e.chat, start: e.ts, end: e.ts, title: "", count: 0 }));
            c.end = e.ts;
            c.count++;
            if (!c.title && e.role === "user") c.title = e.text.replace(/\s+/g, " ").slice(0, 90);
        }
        return [...chats.values()].sort((a, b) => b.end - a.end);
    });
    ipcMain.handle("chats:get", (_, id) =>
        readChatLog().filter((e) => e.chat === id).map(({ role, text, ts }) => ({ role, text, ts })));
    ipcMain.handle("chats:clear", () => {
        fs.rmSync(CHAT_LOG, { force: true });
        return true;
    });

    // ── Settings: Open logs directory ──
    ipcMain.handle("settings:open-logs-dir", () => {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
        shell.openPath(LOGS_DIR);
    });

    // ── Settings: Choose workspace folder ──
    ipcMain.handle("settings:choose-workspace", async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: "Choose Bhai Workspace Folder",
            properties: ["openDirectory", "createDirectory"],
        });
        if (result.canceled) return { canceled: true };
        return { path: result.filePaths[0] };
    });

    // ── Settings: Vault ──
    registerVaultIpc({
        ipcMain,
        safeStorage,
        file: VAULT_PATH,
        trusted: (evt) => !!mainWindow && !mainWindow.isDestroyed() && evt.sender === mainWindow.webContents,
        canTouchId: () => process.platform === "darwin" && systemPreferences.canPromptTouchID(),
        promptTouchId: (why) => systemPreferences.promptTouchID(why),
        onChange: (entries) => sendVaultToBot(entries),
    });
    ipcMain.handle("vault:cvv-submit", (evt, id, cvv) => {
        if (!mainWindow || evt.sender !== mainWindow.webContents || !pendingCvv.delete(Number(id))) return false;
        const ok = typeof cvv === "string" && /^\d{3,4}$/.test(cvv);
        return writeToBot(`##BHAI_VAULT_CVV##${JSON.stringify({ id: Number(id), cvv: ok ? cvv : null })}`);
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
                    // Same count the Memory page shows.
                    const row = db.prepare("SELECT COUNT(*) AS cnt FROM memories WHERE consolidated_into IS NULL").get();
                    if (row) memCount = String(row.cnt);
                } finally {
                    db.close();
                }
            }
        } catch { /* DB may be locked or table may not exist */ }
        return {
            uptimeMs: Date.now() - botStartTime,
            messagesHandled: countMessagesToday(),
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

    // ── Memory Studio ────────────────────────────────────────────────
    // Read-only snapshot APIs for the desktop Memory Studio. Each opens a
    // fresh better-sqlite3 read-only handle on memory.db and closes it after
    // the query — short-lived handles are fine for the panel UI cadence and
    // SQLite WAL mode keeps reads safe alongside the running bot.

    function _studioOpenDb() {
        const dbPath = path.join(DATA_DIR, "memory.db");
        if (!fs.existsSync(dbPath)) return null;
        const Database = require("better-sqlite3");
        return new Database(dbPath, { readonly: true, fileMustExist: true });
    }

    const STUDIO_COLOR = {
        you: "var(--accent-primary)",
        memory: "var(--orb-cobalt)",
        entity: "var(--orb-mint)",
        trait: "var(--orb-amber)",
        episode: "var(--orb-lavender)",
        emotion: "var(--orb-peach)",
        goal: "var(--text-muted)",
        task_learning: "var(--text-muted)",
        world_model: "var(--text-muted)",
        self_state: "var(--text-muted)",
    };

    function _clamp01(n) {
        if (!Number.isFinite(n)) return 0;
        if (n < 0) return 0;
        if (n > 1) return 1;
        return n;
    }
    function _recencyScore(ts) {
        if (!ts) return 0;
        const t = new Date(ts).getTime();
        if (!Number.isFinite(t)) return 0;
        const days = (Date.now() - t) / 86_400_000;
        if (days <= 1) return 1;
        if (days >= 90) return 0;
        return _clamp01(1 - days / 90);
    }
    function _isActive(recency) {
        return recency >= 0.92;
    }
    function _nodeSize(importance, recency) {
        return 6 + _clamp01(importance) * 22 + _clamp01(recency) * 10;
    }
    function _truncate(text, max = 60) {
        if (!text) return "";
        if (text.length <= max) return text;
        return text.slice(0, max - 1) + "…";
    }
    function _parseTags(raw) {
        if (!raw || typeof raw !== "string") return [];
        return raw.split(",").map((t) => t.trim()).filter(Boolean);
    }
    function _safeJsonArray(raw) {
        try {
            const v = JSON.parse(raw);
            return Array.isArray(v) ? v.map(String) : [];
        } catch { return []; }
    }
    function _safeAll(db, sql, params = []) {
        try { return db.prepare(sql).all(...params); }
        catch { return []; }
    }
    function _safeGet(db, sql, params = []) {
        try { return db.prepare(sql).get(...params); }
        catch { return null; }
    }

    function _buildStudioGraph(db, opts) {
        const o = opts || {};
        const centerOnUser = o.centerOnUser !== false;
        const includeAdvanced = !!o.includeAdvanced;
        const windowDays = typeof o.windowDays === "number" ? o.windowDays : 90;
        const maxNodes = Math.min(Math.max(20, o.maxNodes || 400), 1000);
        const searchQuery = (o.searchQuery || "").trim();

        const nodes = [];
        const edges = [];
        const memIds = new Set();
        const entIds = new Set();

        if (centerOnUser) {
            nodes.push({
                id: "you", kind: "you", label: "You", fullText: "You",
                importance: 1, recency: 1, size: 30, color: STUDIO_COLOR.you,
                pinned: true, tags: [], createdAt: new Date().toISOString(),
            });
        }

        const windowClause = windowDays ? `AND created_at > datetime('now','-${windowDays} days')` : "";

        // Memories
        const memBudget = Math.max(40, Math.floor(maxNodes * 0.3));
        const memRows = searchQuery
            ? _safeAll(db,
                `SELECT id, content, category, tags, importance, created_at, accessed_at, access_count, decay_score, COALESCE(pinned, 0) AS pinned
                 FROM memories WHERE consolidated_into IS NULL AND (content LIKE ? OR tags LIKE ?)
                 ORDER BY (importance * 0.6 + decay_score * 0.4) DESC LIMIT ?`,
                [`%${searchQuery}%`, `%${searchQuery}%`, memBudget])
            : _safeAll(db,
                `SELECT id, content, category, tags, importance, created_at, accessed_at, access_count, decay_score, COALESCE(pinned, 0) AS pinned
                 FROM memories WHERE consolidated_into IS NULL ${windowClause}
                 ORDER BY (importance * 0.6 + decay_score * 0.4) DESC LIMIT ?`,
                [memBudget]);
        // Group memories by category so each category gets its own synthetic
        // anchor node — memories of the same category cluster together
        // visually, and each cluster connects to "you" via the anchor.
        const categoryBuckets = new Map(); // category → [memRow]
        for (const r of memRows) {
            const cat = (r.category || "general").trim() || "general";
            if (!categoryBuckets.has(cat)) categoryBuckets.set(cat, []);
            categoryBuckets.get(cat).push(r);
        }

        // Add category anchors only when the bucket has ≥2 memories.
        const categoryAnchors = new Set();
        for (const [cat, rows] of categoryBuckets.entries()) {
            if (rows.length < 2) continue;
            const anchorId = `cat:${cat}`;
            categoryAnchors.add(cat);
            const recencyMax = rows.reduce((m, r) => Math.max(m, _recencyScore(r.accessed_at || r.created_at)), 0);
            nodes.push({
                id: anchorId, kind: "memory",
                label: cat.replace(/_/g, " "),
                fullText: `${rows.length} memories tagged "${cat}"`,
                importance: 0.7, recency: recencyMax,
                size: _nodeSize(0.55, recencyMax) + 4,
                color: STUDIO_COLOR.memory, pinned: false,
                tags: [cat], category: cat,
                createdAt: rows[0].created_at,
                meta: { active: _isActive(recencyMax), isCategoryAnchor: true, count: rows.length },
            });
            if (centerOnUser) {
                edges.push({
                    source: "you", target: anchorId,
                    kind: "kg", label: "remembers",
                    strength: 0.4 + recencyMax * 0.3, weight: rows.length,
                });
            }
        }

        for (const r of memRows) {
            const importance = _clamp01((r.importance ?? 5) / 10);
            const recency = _recencyScore(r.accessed_at || r.created_at);
            memIds.add(r.id);
            const score = importance * 0.6 + (r.decay_score ?? 1) * 0.4;
            const cat = (r.category || "general").trim() || "general";
            nodes.push({
                id: `mem:${r.id}`, kind: "memory",
                label: _truncate(r.content), fullText: r.content,
                importance, recency, size: _nodeSize(importance, recency),
                color: STUDIO_COLOR.memory, pinned: !!r.pinned,
                tags: _parseTags(r.tags), category: r.category || undefined,
                createdAt: r.created_at, accessCount: r.access_count ?? 0,
                meta: { decayScore: r.decay_score ?? 1, active: _isActive(recency), pinned: !!r.pinned },
            });
            // Anchor every memory: if its category has its own anchor, edge
            // there (clusters by category). Otherwise edge directly to "you"
            // so no memory is ever an orphan.
            if (categoryAnchors.has(cat)) {
                edges.push({
                    source: `cat:${cat}`, target: `mem:${r.id}`,
                    kind: "mention", label: cat,
                    strength: 0.4 + score * 0.3, weight: score,
                });
            } else if (centerOnUser) {
                edges.push({
                    source: "you", target: `mem:${r.id}`,
                    kind: "kg", label: "remembers",
                    strength: 0.18 + score * 0.25, weight: score,
                });
            }
        }

        // Entities
        const entBudget = Math.max(20, Math.floor(maxNodes * 0.2));
        const entRows = searchQuery
            ? _safeAll(db,
                `SELECT id, name, type, properties, last_accessed_at, created_at
                 FROM entities WHERE name LIKE ?
                 ORDER BY COALESCE(last_accessed_at, created_at) DESC LIMIT ?`,
                [`%${searchQuery}%`, entBudget])
            : _safeAll(db,
                `SELECT id, name, type, properties, last_accessed_at, created_at
                 FROM entities ORDER BY COALESCE(last_accessed_at, created_at) DESC LIMIT ?`,
                [entBudget]);
        for (const r of entRows) {
            entIds.add(r.id);
            const recency = _recencyScore(r.last_accessed_at || r.created_at);
            nodes.push({
                id: `ent:${r.id}`, kind: "entity",
                label: _truncate(r.name, 40), fullText: r.name,
                importance: 0.6, recency, size: _nodeSize(0.6, recency),
                color: STUDIO_COLOR.entity, pinned: false, tags: [],
                createdAt: r.created_at,
                meta: { entityType: r.type, active: _isActive(recency) },
            });
            if (centerOnUser) {
                edges.push({
                    source: "you", target: `ent:${r.id}`,
                    kind: "kg", label: "knows",
                    strength: 0.3 + recency * 0.3, weight: 1,
                });
            }
        }

        // Traits
        const traitRows = searchQuery
            ? _safeAll(db,
                `SELECT trait_key, value, confidence, topics, reinforcement_count, last_seen_ts, created_at
                 FROM behavioral_traits WHERE confidence > 0.3 AND (trait_key LIKE ? OR value LIKE ?)
                 ORDER BY confidence DESC LIMIT 40`,
                [`%${searchQuery}%`, `%${searchQuery}%`])
            : _safeAll(db,
                `SELECT trait_key, value, confidence, topics, reinforcement_count, last_seen_ts, created_at
                 FROM behavioral_traits WHERE confidence > 0.3
                 ORDER BY confidence DESC LIMIT 40`);
        for (const r of traitRows) {
            const recency = _recencyScore(r.last_seen_ts || r.created_at);
            const importance = _clamp01(r.confidence);
            nodes.push({
                id: `trait:${r.trait_key}`, kind: "trait",
                label: r.trait_key.replace(/_/g, " "), fullText: r.value,
                importance, recency, size: _nodeSize(importance, recency),
                color: STUDIO_COLOR.trait, pinned: false,
                tags: r.topics ? _safeJsonArray(r.topics) : [],
                createdAt: r.created_at,
                meta: {
                    confidence: r.confidence,
                    reinforcements: r.reinforcement_count ?? 0,
                    active: _isActive(recency),
                },
            });
            if (centerOnUser) {
                edges.push({
                    source: "you", target: `trait:${r.trait_key}`,
                    kind: "kg", label: "trait",
                    strength: 0.05 + _clamp01(r.confidence) * 0.05,
                    weight: r.confidence,
                });
            }
        }

        // Episodes
        const epiRows = searchQuery
            ? _safeAll(db,
                `SELECT id, type, description, importance_score, timestamp
                 FROM episodic_memory WHERE description LIKE ?
                 ORDER BY timestamp DESC LIMIT 30`,
                [`%${searchQuery}%`])
            : _safeAll(db,
                `SELECT id, type, description, importance_score, timestamp
                 FROM episodic_memory ORDER BY timestamp DESC LIMIT 30`);
        for (const r of epiRows) {
            const importance = _clamp01(r.importance_score ?? 0.5);
            const recency = _recencyScore(r.timestamp);
            nodes.push({
                id: `epi:${r.id}`, kind: "episode",
                label: _truncate(r.description, 50), fullText: r.description,
                importance, recency, size: _nodeSize(importance, recency),
                color: STUDIO_COLOR.episode, pinned: false,
                tags: [r.type], createdAt: r.timestamp,
                meta: { episodeType: r.type, active: _isActive(recency) },
            });
            if (centerOnUser) {
                edges.push({
                    source: "you", target: `epi:${r.id}`,
                    kind: "kg", label: "lived",
                    strength: 0.2 + importance * 0.3, weight: importance,
                });
            }
        }

        // Emotions
        const emoRows = _safeAll(db,
            `SELECT id, emotion, context, intensity, timestamp
             FROM emotional_memory WHERE timestamp > datetime('now','-30 days')
             ORDER BY intensity DESC LIMIT 30`);
        for (const r of emoRows) {
            const importance = _clamp01(r.intensity ?? 0.5);
            const recency = _recencyScore(r.timestamp);
            nodes.push({
                id: `emo:${r.id}`, kind: "emotion",
                label: r.emotion, fullText: `${r.emotion} — ${r.context}`,
                importance, recency, size: _nodeSize(importance, recency),
                color: STUDIO_COLOR.emotion, pinned: false, tags: [],
                createdAt: r.timestamp,
                meta: { intensity: r.intensity, active: _isActive(recency) },
            });
            if (centerOnUser && (importance > 0.6 || _isActive(recency))) {
                edges.push({
                    source: "you", target: `emo:${r.id}`,
                    kind: "kg", label: "felt",
                    strength: 0.15 + importance * 0.2, weight: importance,
                });
            }
        }

        // Advanced kinds
        if (includeAdvanced) {
            const goalRows = _safeAll(db,
                `SELECT id, description, deadline, progress, status, created_at
                 FROM goals WHERE status != 'archived'
                 ORDER BY created_at DESC LIMIT 20`);
            for (const r of goalRows) {
                const recency = _recencyScore(r.created_at);
                nodes.push({
                    id: `goal:${r.id}`, kind: "goal",
                    label: _truncate(r.description, 50), fullText: r.description,
                    importance: 0.5, recency, size: _nodeSize(0.5, recency),
                    color: STUDIO_COLOR.goal, pinned: false,
                    tags: [r.status], createdAt: r.created_at,
                    meta: { progress: r.progress, deadline: r.deadline, status: r.status },
                });
                if (centerOnUser) {
                    edges.push({
                        source: "you", target: `goal:${r.id}`,
                        kind: "kg", label: "pursues",
                        strength: 0.3, weight: 1,
                    });
                }
            }

            // World model entities (apps/APIs/sites the agent has touched).
            const worldRows = _safeAll(db,
                `SELECT name, type, last_used_at, success_rate, total_uses
                 FROM world_entities ORDER BY total_uses DESC LIMIT 15`);
            for (const r of worldRows) {
                const recency = _recencyScore(r.last_used_at);
                const importance = _clamp01((r.success_rate ?? 0.5) * 0.6 + Math.min((r.total_uses || 0) / 50, 1) * 0.4);
                nodes.push({
                    id: `world:${r.name}`, kind: "world_model",
                    label: _truncate(r.name, 30), fullText: `${r.name} (${r.type})`,
                    importance, recency, size: _nodeSize(importance, recency),
                    color: STUDIO_COLOR.world_model, pinned: false,
                    tags: [r.type], createdAt: r.last_used_at || new Date().toISOString(),
                    meta: { worldType: r.type, successRate: r.success_rate, totalUses: r.total_uses },
                });
                if (centerOnUser) {
                    edges.push({
                        source: "you", target: `world:${r.name}`,
                        kind: "mention", strength: 0.18 + recency * 0.12, weight: 1,
                    });
                }
            }

            // Self-state — single row representing Bhai's internal posture.
            const ss = _safeGet(db,
                `SELECT user_id, energy_level, engagement_mode, confidence_in_user_model, relationship_depth, recent_emotional_tone, updated_at
                 FROM self_state LIMIT 1`);
            if (ss) {
                const recency = _recencyScore(ss.updated_at);
                const energy = _clamp01(ss.energy_level ?? 0.5);
                const summary = `Mode: ${ss.engagement_mode || "—"} · Energy ${Math.round(energy * 100)}% · Tone ${ss.recent_emotional_tone || "—"}`;
                nodes.push({
                    id: `self:state`, kind: "self_state",
                    label: "Self-state", fullText: summary,
                    importance: 0.6, recency, size: _nodeSize(0.6, recency),
                    color: STUDIO_COLOR.self_state, pinned: false,
                    tags: [ss.engagement_mode || "self-state"],
                    createdAt: ss.updated_at || new Date().toISOString(),
                    meta: {
                        energyLevel: energy,
                        engagementMode: ss.engagement_mode,
                        confidence: ss.confidence_in_user_model,
                        relationshipDepth: ss.relationship_depth,
                        recentTone: ss.recent_emotional_tone,
                    },
                });
                if (centerOnUser) {
                    edges.push({
                        source: "you", target: "self:state",
                        kind: "kg", label: "self",
                        strength: 0.25, weight: 1,
                    });
                }
            }
        }

        // KG edges (entity-entity)
        if (entIds.size > 0) {
            const idList = Array.from(entIds);
            const placeholders = idList.map(() => "?").join(",");
            const relRows = _safeAll(db,
                `SELECT from_id, to_id, type, COALESCE(strength, 1.0) AS strength
                 FROM relationships WHERE invalid_at IS NULL
                   AND from_id IN (${placeholders}) AND to_id IN (${placeholders})`,
                [...idList, ...idList]);
            for (const r of relRows) {
                edges.push({
                    source: `ent:${r.from_id}`, target: `ent:${r.to_id}`,
                    kind: "kg", label: r.type,
                    strength: _clamp01((r.strength ?? 1) / 2),
                    weight: r.strength ?? 1,
                });
            }
        }

        // Mention edges (memory→entity via tags)
        if (memIds.size > 0 && entIds.size > 0) {
            const entIdList = Array.from(entIds);
            const memIdList = Array.from(memIds);
            const entRows2 = _safeAll(db,
                `SELECT id, name FROM entities WHERE id IN (${entIdList.map(() => "?").join(",")})`,
                entIdList);
            const memTags = _safeAll(db,
                `SELECT id, tags FROM memories WHERE id IN (${memIdList.map(() => "?").join(",")}) AND tags IS NOT NULL AND tags != ''`,
                memIdList);
            for (const m of memTags) {
                const tagList = _parseTags(m.tags).map((t) => t.toLowerCase());
                if (!tagList.length) continue;
                for (const e of entRows2) {
                    if (tagList.includes(e.name.toLowerCase())) {
                        edges.push({
                            source: `mem:${m.id}`, target: `ent:${e.id}`,
                            kind: "mention", strength: 0.3, weight: 1,
                        });
                    }
                }
            }
        }

        // ── Neural mesh layer ─────────────────────────────────────────
        // Lateral peer-to-peer mesh so the canvas reads as an interconnected
        // network without becoming a wall of strings. Pairing scores: same
        // kind + shared category + shared tag overlap.
        const meshTargetsByNode = 4;
        const tagsOf = (n) => {
            const set = new Set();
            for (const t of (n.tags || [])) set.add(String(t).toLowerCase());
            if (n.category) set.add(String(n.category).toLowerCase());
            if (n.meta && n.meta.entityType) set.add(String(n.meta.entityType).toLowerCase());
            if (n.meta && n.meta.episodeType) set.add(String(n.meta.episodeType).toLowerCase());
            return set;
        };
        const peerableKinds = new Set(["memory", "entity", "episode", "trait", "emotion"]);
        const peerable = nodes.filter((n) => peerableKinds.has(n.kind) && !(n.meta && n.meta.isCategoryAnchor));
        const peerTagSets = new Map();
        for (const n of peerable) peerTagSets.set(n.id, tagsOf(n));

        const meshEdgeKey = new Set();
        for (const e of edges) {
            const src = typeof e.source === "object" ? e.source.id : e.source;
            const tgt = typeof e.target === "object" ? e.target.id : e.target;
            meshEdgeKey.add(src < tgt ? `${src}|${tgt}` : `${tgt}|${src}`);
        }

        for (const a of peerable) {
            const aTags = peerTagSets.get(a.id);
            const candidates = [];
            for (const b of peerable) {
                if (b.id === a.id) continue;
                const bTags = peerTagSets.get(b.id);
                let overlap = 0;
                if (a.kind === b.kind) overlap += 1;
                if (a.category && b.category && a.category === b.category) overlap += 2;
                if (aTags && bTags) {
                    for (const t of aTags) if (bTags.has(t)) overlap += 2;
                }
                if (overlap > 0) candidates.push({ b, overlap });
            }
            candidates.sort((x, y) => y.overlap - x.overlap);
            const picks = candidates.slice(0, meshTargetsByNode);
            for (const { b, overlap } of picks) {
                const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
                if (meshEdgeKey.has(key)) continue;
                meshEdgeKey.add(key);
                const strength = Math.min(0.45, 0.18 + overlap * 0.06);
                edges.push({
                    source: a.id, target: b.id,
                    kind: "similarity",
                    strength, weight: overlap,
                });
            }
        }

        // Full intra-category mesh for tiny clusters (≤4 members). Keeps
        // small categories visually cohesive without exploding edge counts
        // for big buckets.
        for (const [cat, rows] of categoryBuckets.entries()) {
            if (rows.length < 2 || rows.length > 4) continue;
            for (let i = 0; i < rows.length; i++) {
                for (let j = i + 1; j < rows.length; j++) {
                    const a = `mem:${rows[i].id}`;
                    const b = `mem:${rows[j].id}`;
                    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
                    if (meshEdgeKey.has(key)) continue;
                    meshEdgeKey.add(key);
                    edges.push({
                        source: a, target: b,
                        kind: "similarity",
                        strength: 0.32, weight: 4,
                    });
                }
            }
        }

        // Cross-cluster bridges: each entity reaches to ~2 other entities so
        // clusters are stitched rather than islands.
        const entIdList2 = Array.from(entIds);
        if (entIdList2.length > 1) {
            const entRows3 = _safeAll(db,
                `SELECT id, name FROM entities WHERE id IN (${entIdList2.map(() => "?").join(",")})`,
                entIdList2);
            for (let i = 0; i < entRows3.length; i++) {
                for (let j = i + 1; j < Math.min(entRows3.length, i + 3); j++) {
                    const a = `ent:${entRows3[i].id}`;
                    const b = `ent:${entRows3[j].id}`;
                    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
                    if (meshEdgeKey.has(key)) continue;
                    meshEdgeKey.add(key);
                    edges.push({
                        source: a, target: b,
                        kind: "similarity",
                        strength: 0.22, weight: 2,
                    });
                }
            }
        }

        // Edge cap (5× node count)
        const edgeCap = nodes.length * 5;
        if (edges.length > edgeCap) {
            // Keep KG edges (structure) preferentially; trim weakest similarity
            // edges first.
            const kgEdges = edges.filter((e) => e.kind !== "similarity");
            const simEdges = edges
                .filter((e) => e.kind === "similarity")
                .sort((a, b) => b.weight - a.weight);
            const simBudget = Math.max(0, edgeCap - kgEdges.length);
            edges.length = 0;
            edges.push(...kgEdges, ...simEdges.slice(0, simBudget));
        }

        const truncated = nodes.length > maxNodes;
        if (truncated) nodes.length = maxNodes;

        return {
            nodes, edges,
            meta: {
                centerId: "you",
                nodeCount: nodes.length,
                edgeCount: edges.length,
                truncated,
                generatedAt: new Date().toISOString(),
            },
        };
    }

    ipcMain.handle("memory:studio-graph", async (_, opts) => {
        try {
            const db = _studioOpenDb();
            if (!db) return { success: false, error: "No memory database found" };
            try {
                const graph = _buildStudioGraph(db, opts || {});
                return { success: true, graph };
            } finally { db.close(); }
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("memory:studio-search", async (_, query, opts) => {
        try {
            const db = _studioOpenDb();
            if (!db) return { success: false, error: "No memory database found" };
            try {
                const merged = Object.assign({}, opts || {}, { searchQuery: query });
                const graph = _buildStudioGraph(db, merged);
                return { success: true, graph };
            } finally { db.close(); }
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("memory:studio-get-node", async (_, kind, id) => {
        try {
            const db = _studioOpenDb();
            if (!db) return { success: false, error: "No memory database found" };
            try {
                let row = null;
                if (kind === "memory") {
                    row = _safeGet(db,
                        `SELECT id, content, category, tags, importance, created_at, accessed_at, access_count, decay_score, source, scope, COALESCE(pinned, 0) AS pinned
                         FROM memories WHERE id = ?`, [id]);
                    if (row) row.pinned = !!row.pinned;
                } else if (kind === "entity") {
                    row = _safeGet(db,
                        `SELECT id, name, type, properties, created_at, updated_at, last_accessed_at
                         FROM entities WHERE id = ?`, [id]);
                } else if (kind === "episode") {
                    row = _safeGet(db,
                        `SELECT id, user_id, type, description, importance_score, timestamp
                         FROM episodic_memory WHERE id = ?`, [id]);
                } else if (kind === "trait") {
                    row = _safeGet(db,
                        `SELECT trait_key, value, confidence, explicit, topics, reinforcement_count, last_seen_ts, created_at
                         FROM behavioral_traits WHERE trait_key = ?`, [id]);
                } else if (kind === "emotion") {
                    row = _safeGet(db,
                        `SELECT id, user_id, emotion, context, intensity, timestamp
                         FROM emotional_memory WHERE id = ?`, [id]);
                } else if (kind === "goal") {
                    row = _safeGet(db, `SELECT * FROM goals WHERE id = ?`, [id]);
                }
                return { success: true, node: row };
            } finally { db.close(); }
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("memory:studio-connections", async (_, kind, id) => {
        try {
            const db = _studioOpenDb();
            if (!db) return { success: false, error: "No memory database found" };
            try {
                const connections = [];
                if (kind === "entity") {
                    const rels = _safeAll(db,
                        `SELECT r.from_id, r.to_id, r.type, COALESCE(r.strength, 1.0) AS strength,
                                e1.name AS from_name, e2.name AS to_name
                         FROM relationships r
                         LEFT JOIN entities e1 ON r.from_id = e1.id
                         LEFT JOIN entities e2 ON r.to_id = e2.id
                         WHERE r.invalid_at IS NULL AND (r.from_id = ? OR r.to_id = ?)
                         LIMIT 50`, [id, id]);
                    for (const r of rels) {
                        const isOut = r.from_id === id;
                        connections.push({
                            kind: "entity",
                            id: isOut ? r.to_id : r.from_id,
                            name: isOut ? r.to_name : r.from_name,
                            relation: r.type,
                            direction: isOut ? "out" : "in",
                            strength: r.strength,
                        });
                    }
                } else if (kind === "memory") {
                    const m = _safeGet(db, `SELECT id, tags FROM memories WHERE id = ?`, [id]);
                    if (m && m.tags) {
                        const tagList = _parseTags(m.tags).map((t) => t.toLowerCase());
                        if (tagList.length) {
                            const placeholders = tagList.map(() => "LOWER(name) = ?").join(" OR ");
                            const ents = _safeAll(db,
                                `SELECT id, name, type FROM entities WHERE ${placeholders} LIMIT 25`,
                                tagList);
                            for (const e of ents) {
                                connections.push({
                                    kind: "entity", id: e.id, name: e.name,
                                    relation: "mentioned_in", direction: "in",
                                });
                            }
                        }
                    }
                }
                return { success: true, connections };
            } finally { db.close(); }
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("memory:studio-you", async () => {
        try {
            const db = _studioOpenDb();
            if (!db) return { success: false, error: "No memory database found" };
            try {
                let name = null;
                const profile = _safeGet(db, `SELECT data FROM user_profiles LIMIT 1`);
                if (profile && profile.data) {
                    try {
                        const parsed = JSON.parse(profile.data);
                        if (parsed && typeof parsed.name === "string") name = parsed.name;
                    } catch { /* corrupt profile JSON */ }
                }
                const rel = _safeGet(db,
                    `SELECT trust_score, depth_score, engagement_streak, last_interaction
                     FROM relationship_state LIMIT 1`);
                const topTraits = _safeAll(db,
                    `SELECT trait_key AS key, value, confidence
                     FROM behavioral_traits WHERE confidence > 0.5
                     ORDER BY confidence DESC LIMIT 8`);
                return {
                    success: true,
                    you: {
                        name,
                        relationship: rel ? {
                            trustScore: rel.trust_score,
                            depthScore: rel.depth_score,
                            engagementStreak: rel.engagement_streak,
                            lastInteraction: rel.last_interaction,
                        } : null,
                        topTraits,
                    },
                };
            } finally { db.close(); }
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("memory:studio-stats", async () => {
        try {
            const db = _studioOpenDb();
            if (!db) return { success: false, error: "No memory database found" };
            try {
                const cnt = (sql) => {
                    const r = _safeGet(db, sql);
                    return r && typeof r.c === "number" ? r.c : 0;
                };
                const stats = {
                    memories: cnt("SELECT COUNT(*) AS c FROM memories WHERE consolidated_into IS NULL"),
                    entities: cnt("SELECT COUNT(*) AS c FROM entities"),
                    episodes: cnt("SELECT COUNT(*) AS c FROM episodic_memory"),
                    traits: cnt("SELECT COUNT(*) AS c FROM behavioral_traits WHERE confidence > 0.3"),
                    emotions: cnt("SELECT COUNT(*) AS c FROM emotional_memory WHERE timestamp > datetime('now','-30 days')"),
                    categories: {},
                };
                const cats = _safeAll(db,
                    `SELECT category, COUNT(*) AS c FROM memories WHERE consolidated_into IS NULL GROUP BY category`);
                for (const r of cats) {
                    stats.categories[r.category || "general"] = r.c;
                }
                return { success: true, stats };
            } finally { db.close(); }
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // ── Memory Studio: write paths ──────────────────────────────────
    // Open a R/W handle, run the change in a transaction, retry on
    // SQLITE_BUSY (the bot child process holds its own write handle and
    // WAL mode lets us coexist).

    function _studioOpenWriteDb() {
        const dbPath = path.join(DATA_DIR, "memory.db");
        if (!fs.existsSync(dbPath)) return null;
        const Database = require("better-sqlite3");
        const handle = new Database(dbPath, { fileMustExist: true });
        // Make sure the schema additions exist on this handle too — the bot
        // process runs the migrations when it boots, but the desktop main
        // process also opens the DB before the bot has started. Best-effort
        // self-heal so writes don't fail on a cold cache.
        try { handle.prepare("ALTER TABLE memories ADD COLUMN pinned INTEGER DEFAULT 0").run(); } catch { /* exists */ }
        try { handle.prepare("CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned) WHERE pinned = 1").run(); } catch { /* */ }
        try {
            handle.prepare(`CREATE TABLE IF NOT EXISTS memory_forget_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL,
                original_id TEXT NOT NULL,
                content_snapshot TEXT,
                reason TEXT NOT NULL,
                source TEXT DEFAULT 'user',
                forgotten_at TEXT DEFAULT (datetime('now'))
            )`).run();
        } catch { /* */ }
        try { handle.prepare("CREATE INDEX IF NOT EXISTS idx_forget_log_kind ON memory_forget_log(kind, forgotten_at)").run(); } catch { /* */ }
        // Forgotten means gone: older rows kept the content.
        try { handle.prepare("UPDATE memory_forget_log SET content_snapshot = NULL WHERE content_snapshot IS NOT NULL").run(); } catch { /* */ }
        try {
            handle.prepare(`CREATE TABLE IF NOT EXISTS memory_insights (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL,
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                evidence_ids TEXT NOT NULL DEFAULT '[]',
                metric_value REAL,
                metric_unit TEXT,
                computed_at TEXT DEFAULT (datetime('now')),
                window_days INTEGER DEFAULT 7
            )`).run();
        } catch { /* */ }
        try { handle.prepare("CREATE INDEX IF NOT EXISTS idx_insights_computed ON memory_insights(computed_at DESC)").run(); } catch { /* */ }
        try { handle.prepare("CREATE INDEX IF NOT EXISTS idx_insights_kind ON memory_insights(kind, computed_at DESC)").run(); } catch { /* */ }
        return handle;
    }

    function _studioRunWithRetry(fn) {
        const MAX_ATTEMPTS = 3;
        let lastErr = null;
        for (let i = 0; i < MAX_ATTEMPTS; i++) {
            try {
                return fn();
            } catch (e) {
                lastErr = e;
                if (e && (e.code === "SQLITE_BUSY" || e.code === "SQLITE_LOCKED")) {
                    const until = Date.now() + 50;
                    while (Date.now() < until) { /* tight wait — short */ }
                    continue;
                }
                throw e;
            }
        }
        throw lastErr || new Error("studio write failed");
    }

    ipcMain.handle("memory:studio-update-memory", async (_, id, fields) => {
        try {
            const db = _studioOpenWriteDb();
            if (!db) return { success: false, error: "No memory database found" };
            try {
                const sets = [];
                const params = [];
                if (typeof fields?.content === "string") { sets.push("content = ?"); params.push(fields.content); }
                if (typeof fields?.category === "string") { sets.push("category = ?"); params.push(fields.category); }
                if (typeof fields?.tags === "string") { sets.push("tags = ?"); params.push(fields.tags); }
                if (typeof fields?.importance === "number") {
                    sets.push("importance = ?");
                    params.push(Math.max(1, Math.min(10, Math.round(fields.importance))));
                }
                if (sets.length === 0) return { success: false, error: "no fields to update" };

                _studioRunWithRetry(() => {
                    const tx = db.transaction(() => {
                        db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
                        if (typeof fields?.content === "string") {
                            db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(id);
                        }
                    });
                    tx();
                });
                return { success: true };
            } finally { db.close(); }
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("memory:studio-set-importance", async (_, id, value) => {
        try {
            const db = _studioOpenWriteDb();
            if (!db) return { success: false, error: "No memory database found" };
            try {
                const v = Math.max(1, Math.min(10, Math.round(value)));
                _studioRunWithRetry(() => {
                    db.prepare("UPDATE memories SET importance = ? WHERE id = ?").run(v, id);
                });
                return { success: true, importance: v };
            } finally { db.close(); }
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("memory:studio-pin-memory", async (_, id, pinned) => {
        try {
            const db = _studioOpenWriteDb();
            if (!db) return { success: false, error: "No memory database found" };
            try {
                _studioRunWithRetry(() => {
                    db.prepare("UPDATE memories SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
                });
                return { success: true, pinned: !!pinned };
            } finally { db.close(); }
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("memory:studio-forget-memory", async (_, id, reason) => {
        try {
            const db = _studioOpenWriteDb();
            if (!db) return { success: false, error: "No memory database found" };
            try {
                _studioRunWithRetry(() => {
                    const tx = db.transaction(() => {
                        db.prepare(
                            "INSERT INTO memory_forget_log (kind, original_id, reason, source) VALUES (?, ?, ?, 'user')"
                        ).run("memory", String(id), reason || "unspecified");
                        db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(id);
                        db.prepare("DELETE FROM memories WHERE id = ?").run(id);
                    });
                    tx();
                });
                return { success: true };
            } finally { db.close(); }
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("memory:studio-bulk-forget", async (_, ids, reason) => {
        try {
            const db = _studioOpenWriteDb();
            if (!db) return { success: false, error: "No memory database found" };
            if (!Array.isArray(ids) || ids.length === 0) return { success: true, forgotten: 0 };
            try {
                let forgotten = 0;
                _studioRunWithRetry(() => {
                    const tx = db.transaction(() => {
                        for (const id of ids) {
                            db.prepare(
                                "INSERT INTO memory_forget_log (kind, original_id, reason, source) VALUES (?, ?, ?, 'user')"
                            ).run("memory", String(id), reason || "unspecified");
                            db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(id);
                            db.prepare("DELETE FROM memories WHERE id = ?").run(id);
                            forgotten++;
                        }
                    });
                    tx();
                });
                return { success: true, forgotten };
            } finally { db.close(); }
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("memory:studio-forget-trait", async (_, traitKey, reason) => {
        try {
            const db = _studioOpenWriteDb();
            if (!db) return { success: false, error: "No memory database found" };
            try {
                _studioRunWithRetry(() => {
                    const tx = db.transaction(() => {
                        db.prepare(
                            "INSERT INTO memory_forget_log (kind, original_id, reason, source) VALUES (?, ?, ?, 'user')"
                        ).run("trait", String(traitKey), reason || "unspecified");
                        db.prepare("DELETE FROM behavioral_traits WHERE trait_key = ?").run(traitKey);
                    });
                    tx();
                });
                return { success: true };
            } finally { db.close(); }
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("memory:studio-forget-entity", async (_, id, reason, cascade) => {
        try {
            const db = _studioOpenWriteDb();
            if (!db) return { success: false, error: "No memory database found" };
            try {
                let relCount = 0;
                _studioRunWithRetry(() => {
                    const tx = db.transaction(() => {
                        if (cascade !== false) {
                            const r = db.prepare("SELECT COUNT(*) AS c FROM relationships WHERE from_id = ? OR to_id = ?").get(id, id);
                            relCount = r ? r.c ?? 0 : 0;
                        }
                        db.prepare(
                            "INSERT INTO memory_forget_log (kind, original_id, reason, source) VALUES (?, ?, ?, 'user')"
                        ).run("entity", String(id), reason || "unspecified");
                        db.prepare("DELETE FROM entities WHERE id = ?").run(id);
                    });
                    tx();
                });
                return { success: true, forgotten: 1, relationshipsRemoved: relCount };
            } finally { db.close(); }
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // ── Insights ────────────────────────────────────────────────────
    ipcMain.handle("memory:studio-insights", async () => {
        try {
            const db = _studioOpenDb();
            if (!db) return { success: false, error: "No memory database found" };
            try {
                const cards = _safeAll(db,
                    `SELECT id, kind, title, body, evidence_ids, metric_value, metric_unit, computed_at, window_days
                     FROM memory_insights
                     WHERE id IN (SELECT MAX(id) FROM memory_insights GROUP BY kind)
                     ORDER BY CASE kind
                         WHEN 'mood' THEN 1
                         WHEN 'recurring_theme' THEN 2
                         WHEN 'avoidance' THEN 3
                         WHEN 'most_discussed' THEN 4
                         ELSE 5 END`);
                const parsed = cards.map((r) => {
                    let evidence = [];
                    try {
                        const v = JSON.parse(r.evidence_ids || "[]");
                        if (Array.isArray(v)) evidence = v.filter(
                            (e) => e && typeof e === "object" && typeof e.kind === "string" && typeof e.id === "string"
                        );
                    } catch { /* corrupt JSON */ }
                    return {
                        id: r.id,
                        kind: r.kind,
                        title: r.title,
                        body: r.body,
                        evidenceIds: evidence,
                        metricValue: r.metric_value,
                        metricUnit: r.metric_unit,
                        computedAt: r.computed_at,
                        windowDays: r.window_days,
                    };
                });
                return { success: true, insights: parsed };
            } finally { db.close(); }
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // SQL-only insight recompute. Mirrors the templated branches of
    // src/memory/studio-insights.ts but skips the optional LLM theme polish
    // (the bot's nightly job runs the full version).
    ipcMain.handle("memory:studio-recompute-insights", async () => {
        try {
            const db = _studioOpenWriteDb();
            if (!db) return { success: false, error: "No memory database found" };
            try {
                const windowDays = 7;
                const POSITIVE = new Set(["happy", "joy", "calm", "excited", "proud", "grateful", "content", "hopeful", "amused"]);
                const NEGATIVE = new Set(["sad", "angry", "frustrated", "anxious", "tired", "stressed", "scared", "lonely", "disappointed", "overwhelmed"]);

                let generated = 0;
                _studioRunWithRetry(() => {
                    const tx = db.transaction(() => {
                        // Mood
                        try {
                            const rows = db.prepare(
                                `SELECT id, emotion, COALESCE(intensity, 0.5) AS intensity
                                 FROM emotional_memory
                                 WHERE timestamp > datetime('now', ?)`,
                            ).all(`-${windowDays} days`);
                            if (rows.length >= 2) {
                                let sum = 0;
                                const evidence = [];
                                for (const r of rows) {
                                    const e = (r.emotion || "").toLowerCase();
                                    const polarity = POSITIVE.has(e) ? 1 : NEGATIVE.has(e) ? -1 : 0;
                                    sum += polarity * (r.intensity ?? 0.5);
                                    if (evidence.length < 6) evidence.push({ kind: "emotion", id: r.id });
                                }
                                const valence = sum / rows.length;
                                let title, body;
                                if (valence > 0.4) { title = "A bright stretch"; body = `Your week leaned warm — positive notes outnumbered the rough ones across ${rows.length} moments.`; }
                                else if (valence > 0.1) { title = "Mostly steady"; body = `Tone was even-keeled this week with a slight lift. ${rows.length} emotional notes recorded.`; }
                                else if (valence > -0.1) { title = "Mixed but balanced"; body = `${rows.length} emotional notes this week — a roughly even split between bright and heavy moments.`; }
                                else if (valence > -0.4) { title = "Heavier than usual"; body = `The tone tipped toward strain this week across ${rows.length} emotional notes.`; }
                                else { title = "A hard week"; body = `Most of the week's emotional notes leaned negative (${rows.length} recorded). Worth a check-in.`; }
                                db.prepare(
                                    `INSERT INTO memory_insights (kind, title, body, evidence_ids, metric_value, metric_unit, window_days) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                                ).run("mood", title, body, JSON.stringify(evidence), valence, "valence", windowDays);
                                generated++;
                            }
                        } catch { /* mood failed — skip */ }

                        // Recurring theme
                        try {
                            const top = db.prepare(
                                `SELECT category AS token, COUNT(*) AS cnt FROM memories
                                 WHERE consolidated_into IS NULL AND created_at > datetime('now', ?)
                                   AND category IS NOT NULL AND category != ''
                                 GROUP BY category ORDER BY cnt DESC LIMIT 1`,
                            ).get(`-${windowDays} days`);
                            if (top) {
                                const evidence = db.prepare(
                                    `SELECT id FROM memories
                                     WHERE consolidated_into IS NULL AND category = ?
                                       AND created_at > datetime('now', ?)
                                     ORDER BY (importance * 0.6 + decay_score * 0.4) DESC LIMIT 5`,
                                ).all(top.token, `-${windowDays} days`).map((r) => ({ kind: "memory", id: String(r.id) }));
                                db.prepare(
                                    `INSERT INTO memory_insights (kind, title, body, evidence_ids, metric_value, metric_unit, window_days) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                                ).run(
                                    "recurring_theme",
                                    top.token.replace(/_/g, " "),
                                    `${top.cnt} memories landed under "${top.token}" in the last ${windowDays} days — your most-touched theme.`,
                                    JSON.stringify(evidence), top.cnt, "count", windowDays,
                                );
                                generated++;
                            }
                        } catch { /* */ }

                        // Avoidance
                        try {
                            const before = db.prepare(
                                `SELECT category AS token, COUNT(*) AS cnt FROM memories
                                 WHERE consolidated_into IS NULL
                                   AND created_at < datetime('now', ?) AND created_at > datetime('now', ?)
                                   AND category IS NOT NULL AND category != ''
                                 GROUP BY category HAVING cnt >= 3`,
                            ).all(`-${windowDays} days`, `-${windowDays * 5} days`);
                            if (before.length > 0) {
                                const recent = db.prepare(
                                    `SELECT category AS token FROM memories
                                     WHERE consolidated_into IS NULL AND created_at > datetime('now', ?)
                                       AND category IS NOT NULL`,
                                ).all(`-${windowDays} days`);
                                const recentSet = new Set(recent.map((r) => r.token));
                                const dropped = before.filter((b) => !recentSet.has(b.token)).sort((a, b) => b.cnt - a.cnt);
                                if (dropped.length > 0) {
                                    const top = dropped[0];
                                    db.prepare(
                                        `INSERT INTO memory_insights (kind, title, body, evidence_ids, metric_value, metric_unit, window_days) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                                    ).run(
                                        "avoidance",
                                        top.token.replace(/_/g, " "),
                                        `You used to log "${top.token}" memories often (${top.cnt} in the prior month) but haven't this week.`,
                                        "[]", top.cnt, "count", windowDays,
                                    );
                                    generated++;
                                }
                            }
                        } catch { /* */ }

                        // Most-discussed
                        try {
                            const top = db.prepare(
                                `SELECT id, name FROM entities
                                 WHERE last_accessed_at > datetime('now', ?)
                                 ORDER BY last_accessed_at DESC LIMIT 1`,
                            ).get(`-${windowDays} days`);
                            if (top) {
                                const sample = db.prepare(
                                    `SELECT id FROM memories
                                     WHERE (',' || lower(tags) || ',') LIKE ('%,' || lower(?) || ',%')
                                       AND consolidated_into IS NULL
                                     ORDER BY accessed_at DESC LIMIT 5`,
                                ).all(top.name);
                                const evidence = [
                                    { kind: "entity", id: String(top.id) },
                                    ...sample.slice(0, 3).map((s) => ({ kind: "memory", id: String(s.id) })),
                                ];
                                db.prepare(
                                    `INSERT INTO memory_insights (kind, title, body, evidence_ids, metric_value, metric_unit, window_days) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                                ).run(
                                    "most_discussed",
                                    top.name,
                                    sample.length > 0
                                        ? `${top.name} keeps coming up — surfaced in ${sample.length} recent memories.`
                                        : `${top.name} was the most-touched person/thing this week.`,
                                    JSON.stringify(evidence), sample.length, "frequency", windowDays,
                                );
                                generated++;
                            }
                        } catch { /* */ }
                    });
                    tx();
                });
                return { success: true, generated };
            } finally { db.close(); }
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("memory:studio-forget-log", async (_, limit) => {
        try {
            const db = _studioOpenDb();
            if (!db) return { success: false, error: "No memory database found" };
            try {
                const cap = Math.max(1, Math.min(200, limit || 50));
                const rows = _safeAll(db,
                    `SELECT id, kind, original_id, content_snapshot, reason, source, forgotten_at
                     FROM memory_forget_log ORDER BY forgotten_at DESC LIMIT ?`,
                    [cap]);
                return { success: true, entries: rows };
            } finally { db.close(); }
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // Setup: save credentials
    ipcMain.handle("setup:save-credentials", async (_, creds) => {
        try {
            const envLines = [
                "# Bhai — Environment Variables",
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

    // W3: Magic Moment rich detection. Returns running-app snapshot.
    // Called once per Ready Hub mount. Best-effort: empty array on
    // failure or when ATLAS_NO_MAGIC_MOMENT_RICH=true.
    ipcMain.handle("setup:detect-magic-moment", async () => {
        if (process.env.ATLAS_NO_MAGIC_MOMENT_RICH === "true") {
            return { names: [], platform: process.platform, disabled: true };
        }
        try {
            const { getRunningApps } = require(path.join(__dirname, "detection", "running-apps.js"));
            return await getRunningApps(process.platform);
        } catch (err) {
            return { names: [], platform: process.platform, error: err.message };
        }
    });

    // Setup: persist legal acceptance (clickwrap evidence record).
    // Trust nothing from the renderer for the evidentiary record:
    //   - acceptedAt is set in main (un-spoofable)
    //   - version is the constant from router.js (renderer can't downgrade)
    //   - documents URLs and consents flags are whitelist-picked by key,
    //     not forwarded as raw objects (blocks prototype pollution and
    //     unexpected keys ending up in the audit log)
    ipcMain.handle("setup:save-legal", async (_, payload) => {
        try {
            if (!payload || payload.accepted !== true) {
                return { success: false, error: "Acceptance flag missing" };
            }
            const { CURRENT_ACCEPTANCE_VERSION } = require(path.join(__dirname, "wizard", "router.js"));
            const expectedDocIds = ["terms", "privacy", "acceptableUse", "disclaimer", "refund"];
            const documents = {};
            const rawDocs = payload.documents;
            if (rawDocs && typeof rawDocs === "object") {
                for (const id of expectedDocIds) {
                    const url = Object.prototype.hasOwnProperty.call(rawDocs, id) ? rawDocs[id] : null;
                    if (typeof url === "string" && /^https:\/\/(www\.)?tryatlasagi\.com\//.test(url)) {
                        documents[id] = url;
                    }
                }
            }
            const rawConsents = payload.consents && typeof payload.consents === "object" ? payload.consents : {};
            const consents = {
                documents: rawConsents.documents === true,
                ageOrAuthority: rawConsents.ageOrAuthority === true,
            };
            const record = {
                accepted: true,
                acceptedAt: new Date().toISOString(),
                version: CURRENT_ACCEPTANCE_VERSION,
                appVersion: app.getVersion(),
                platform: process.platform,
                documents,
                consents,
            };
            const targetPath = path.join(app.getPath("userData"), ".legal-acceptance.json");
            fs.writeFileSync(targetPath, JSON.stringify(record, null, 2));
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // Util: open an external URL via the OS browser. Whitelisted to first-party
    // legal/marketing pages so a compromised renderer can't pivot to phishing URLs.
    ipcMain.handle("util:open-external", async (_, url) => {
        try {
            if (typeof url !== "string") return { success: false, error: "Invalid URL" };
            const parsed = new URL(url);
            if (parsed.protocol !== "https:") return { success: false, error: "Only https URLs allowed" };
            // Reject URLs carrying user-info (https://attacker.com@trusted.com/) — these
            // pass a hostname check but some OS handlers route to the userinfo host.
            if (parsed.username || parsed.password) return { success: false, error: "URL must not contain credentials" };
            const host = parsed.hostname.toLowerCase();
            const allowed = host === "tryatlasagi.com" || host === "www.tryatlasagi.com" || host === "xagilab.com" || host === "www.xagilab.com";
            if (!allowed) return { success: false, error: "Host not in allowlist" };
            // Rebuild from canonical components so any retained userinfo / fragment quirks are dropped.
            const safeUrl = `${parsed.protocol}//${host}${parsed.pathname}${parsed.search}${parsed.hash}`;
            await shell.openExternal(safeUrl);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // Setup: choose workspace folder
    ipcMain.handle("setup:choose-workspace", async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: "Choose Bhai Workspace Folder",
            defaultPath: path.join(app.getPath("desktop"), "Bhai Files"),
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
                    "📁 Bhai Workspace",
                    "═══════════════════════════════════════",
                    COPYRIGHT,
                    "",
                    "This folder is managed by Bhai AI.",
                    "Files created by Bhai (screenshots, downloads,",
                    "research, exports) are saved here.",
                    "",
                    "Feel free to organize or move files —",
                    "Bhai will always save new files to this folder.",
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
    // Resolve options.workspace from the persisted .env.enc so retry/resume
    // paths preserve the workspace path the wizard captured on the first install.
    // Without this, ctx.options.workspace is undefined and the workspace phase
    // silently skips with "No workspace requested".
    function resolveWorkspaceOptions() {
        try {
            const env = loadEnvDecrypted() || "";
            const wsLine = env.split("\n").find((l) => l.startsWith("ATLAS_WORKSPACE="));
            if (wsLine) return { workspace: wsLine.slice("ATLAS_WORKSPACE=".length).trim() };
        } catch { /* ignore */ }
        return {};
    }

    ipcMain.handle("setup:install", (_, options) => {
        // Single flight: the Connect screen starts it in the background and a
        // second call (or Launch) joins the same run instead of racing it.
        installInFlight ??= runInstall(options).finally(() => {
            installInFlight = null;
        });
        return installInFlight;
    });

    async function runInstall(options) {
        const ctx = buildInstallCtx(mainWindow, options);
        try {
            const { runDetection, buildPhaseList, runPhases } = requireInstaller();
            const state = await runDetection(buildDetectionDeps());
            // The packaged app runs the bot on its own Node: never download a
            // system Node (its installer asks for an admin password).
            if (app.isPackaged) state.installed = { ...(state.installed || {}), node: true };
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
    }

    // Is the bot up, and is the Chrome extension connected to it? (Connect screen)
    ipcMain.handle("extension:status", async () => {
        try {
            const r = await fetch("http://127.0.0.1:18800/health", { signal: AbortSignal.timeout(1500) });
            const j = await r.json();
            return { running: true, connected: j && j.connected === true };
        } catch {
            return { running: false, connected: false };
        }
    });

    // Help the user add the extension: Chrome's extensions page, or the folder to "Load unpacked".
    ipcMain.handle("extension:open", async (_, what) => {
        const dir = app.isPackaged ? path.join(process.resourcesPath, "chrome-extension") : path.join(__dirname, "..", "chrome-extension");
        // Chrome's "Load unpacked" picker can't browse into Bhai.app: hand over the
        // path so the user can paste it (⌘⇧G) instead.
        if (what === "copy-path") {
            require("electron").clipboard.writeText(dir);
            return { success: true, path: dir };
        }
        if (what === "folder") {
            shell.showItemInFolder(path.join(dir, "manifest.json"));
            return { success: true };
        }
        const { spawn } = require("child_process");
        if (process.platform === "darwin") spawn("open", ["-a", "Google Chrome", "chrome://extensions"], { detached: true, stdio: "ignore" }).unref();
        else if (process.platform === "win32") spawn("cmd", ["/c", "start", "chrome", "chrome://extensions"], { detached: true, stdio: "ignore" }).unref();
        else spawn("google-chrome", ["chrome://extensions"], { detached: true, stdio: "ignore" }).unref();
        return { success: true };
    });

    // Setup: retry a single install phase by id. Used by install-log's Retry button
    // (see desktop/components/install-log.js).
    ipcMain.handle("setup:retry-install-phase", async (_, phaseId) => {
        try {
            const { runDetection, buildPhaseList, runPhases, getResumeList, readSetupState } = requireInstaller();
            const state = await runDetection(buildDetectionDeps());
            const full = buildPhaseList(state);
            const idx = full.findIndex((p) => p.id === phaseId);
            if (idx < 0) return { success: false, error: "Unknown phase: " + phaseId };
            // Run the failed phase AND every subsequent phase that isn't already
            // done. Without this, retry-success leaves the install stuck — phases
            // after the failed one never auto-run, the user thinks "Retry" =
            // "complete the install" and walks away with a half-installed app.
            const tail = full.slice(idx);
            const remaining = getResumeList(tail, readSetupState(DATA_DIR));
            // Carry forward the workspace path that the wizard captured earlier.
            // Without this, the workspace phase silently skips ("No workspace
            // requested — skipping") because ctx.options.workspace is undefined.
            const res = await runPhases(remaining, buildInstallCtx(mainWindow, resolveWorkspaceOptions()));
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

    // Setup: resume install — runs only phases that don't yet have a done-marker
    // in data/setup-state.json. Used when the user relaunches the app mid-install.
    ipcMain.handle("setup:resume-install", async () => {
        try {
            const { runDetection, buildPhaseList, runPhases, getResumeList, readSetupState } = requireInstaller();
            const state = await runDetection(buildDetectionDeps());
            const full = buildPhaseList(state);
            const remaining = getResumeList(full, readSetupState(DATA_DIR));
            const res = await runPhases(remaining, buildInstallCtx(mainWindow, resolveWorkspaceOptions()));
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

    // Setup: the ordered phase IDs for the user's chosen vision tier — the single
    // source of truth the install screen uses to render exactly the rows that
    // belong to the tier (lite=7, standard=8, full=10), instead of a hardcoded
    // 10-row list that mislabels lite installs.
    //
    // We deliberately clear `installed`/`visionDeps` before building so we get the
    // FULL tier sequence, not the install-time REMAINDER. buildPhaseList drops
    // already-installed phases (for the actual run), but the install SCREEN must
    // still show every tier phase so completed ones render with green checks and
    // the Resume/done-count logic (install.js) lines up against real markers. The
    // actual run is re-filtered identically by setup:install, so this only affects
    // what rows are displayed.
    ipcMain.handle("setup:get-phase-ids", async () => {
        try {
            const { runDetection, buildPhaseList } = requireInstaller();
            const state = await runDetection(buildDetectionDeps());
            state.installed = {};
            const ids = buildPhaseList(state).map((p) => p.id);
            return { success: true, ids: ids };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // Setup: finish and launch dashboard
    ipcMain.handle("setup:finish", async () => {
        // A background install may still be running (Connect was skipped): its
        // first-install data step must finish before the bot starts.
        if (installInFlight) await installInFlight.catch(() => {});
        if (process.platform === "darwin" && mainWindow && !mainWindow.isDestroyed()) {
            // The wizard window is frameless; the dashboard gets native chrome.
            const wizard = mainWindow;
            await createPanelWindow();
            wizard.destroy();
        } else if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setMinimumSize(780, 560);
            mainWindow.setSize(840, 620);
            mainWindow.setResizable(true);
            mainWindow.center();
            mainWindow.loadFile(path.join(__dirname, "panel.html"));
        }
        if (!botProcess) startBot().catch((err) => console.error("[SETUP] Auto-start failed:", err.message));
        return { success: true };
    });

    // Shared helper — finds google-credentials.json across all possible locations.
    // F7: the installer no longer bundles google-credentials.json. Operators
    // must drop their own credentials at ~/Downloads/google-credentials.json
    // (or DATA_DIR), and the wizard's Google setup step documents this.
    // TODO(F7): replace this entirely with per-installation OAuth obtained
    // via Convex on first run — eliminates the need for the user to handle
    // any client_secret at all.
    // Checks the writable userData dir first (survives reinstalls), then the
    // (legacy) bundled-resources path for backward compat with older installs,
    // then the user's Downloads folder as the documented operator drop-zone.
    function findGoogleCredentials() {
        const candidates = [
            path.join(DATA_DIR, "google-credentials.json"),           // writable userData
            path.join(BOT_DIR, "data", "google-credentials.json"),    // legacy bundled (no longer shipped)
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

    // Settings → Integrations: what's connected, for the cards' status lines.
    const googleTokensDir = path.join(DATA_DIR, "google-tokens");
    function connectedGoogleAccounts() {
        const out = [];
        let files = [];
        try { files = fs.readdirSync(googleTokensDir).filter(f => f.endsWith(".json")); } catch { return out; }
        for (const file of files) {
            let email = "";
            try {
                const tokens = JSON.parse(fs.readFileSync(path.join(googleTokensDir, file), "utf-8"));
                if (tokens.id_token) email = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64").toString("utf-8")).email || "";
            } catch { /* unreadable token file */ }
            out.push({ file, email: email || file.replace(/\.json$/, "") });
        }
        return out;
    }

    ipcMain.handle("settings:integrations", () => {
        const custom = loadEnvKey("ATLAS_WORKSPACE") || "";
        return {
            workspace: custom || path.join(app.getPath("desktop"), "Bhai Files"),
            workspaceIsDefault: !custom,
            googleAvailable: !!findGoogleCredentials(),
            googleAccounts: connectedGoogleAccounts().map(a => a.email),
            githubSaved: !!loadEnvKey("GITHUB_TOKEN"),
        };
    });

    // Checks a GitHub token (or the saved one) and says whose it is.
    ipcMain.handle("settings:test-github", async (_, token) => {
        token = token || loadEnvKey("GITHUB_TOKEN") || "";
        if (!token) return { success: false, message: "No token" };
        try {
            const res = await fetch("https://api.github.com/user", {
                headers: { Authorization: `Bearer ${token}`, "User-Agent": "Bhai", Accept: "application/vnd.github+json" },
                signal: AbortSignal.timeout(15000),
            });
            if (res.status === 401) return { success: false, message: "GitHub didn't accept this token. It may be mistyped, expired or revoked." };
            if (!res.ok) return { success: false, message: `GitHub error (${res.status})` };
            const user = await res.json();
            return { success: true, login: user.login, name: user.name || "", scopes: res.headers.get("x-oauth-scopes") || "" };
        } catch (err) { return { success: false, message: err.message }; }
    });

    ipcMain.handle("settings:google-disconnect", (_, email) => {
        const hit = connectedGoogleAccounts().find(a => a.email === email);
        if (hit) fs.rmSync(path.join(googleTokensDir, hit.file), { force: true });
        return { success: !!hit };
    });

    ipcMain.handle("settings:open-workspace", () => {
        const dir = loadEnvKey("ATLAS_WORKSPACE") || path.join(app.getPath("desktop"), "Bhai Files");
        fs.mkdirSync(dir, { recursive: true });
        return shell.openPath(dir);
    });

    // Setup: Google OAuth
    ipcMain.handle("setup:google-oauth", async () => {
        try {
            const clientCreds = findGoogleCredentials();
            if (!clientCreds) {
                return { success: false, error: "Google credentials file not found." };
            }

            // F2: random state — 32 bytes hex. Stored in closure (main process
            // memory) and validated on the callback. Without this, a malicious
            // local page could navigate the user to the OAuth flow with its
            // own code= param and bind a foreign Google account.
            const { generateOAuthState, safeStringEqual } = require(path.join(__dirname, "auth-helpers.js"));
            const expectedState = generateOAuthState();
            let codeConsumed = false;

            const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
                `client_id=${clientCreds.client_id}` +
                `&redirect_uri=${encodeURIComponent("http://127.0.0.1:8844")}` +
                `&response_type=code` +
                `&state=${encodeURIComponent(expectedState)}` +
                `&scope=${encodeURIComponent("openid email profile https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify")}` +
                `&access_type=offline&prompt=consent`;

            const http = require("http");
            const https = require("https");

            return new Promise((resolve) => {
                const server = http.createServer((req, res) => {
                    const url = new URL(req.url || "/", "http://127.0.0.1:8844");
                    const code = url.searchParams.get("code");
                    const error = url.searchParams.get("error");
                    const stateParam = url.searchParams.get("state") || "";

                    if (error) {
                        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                        res.end(renderOAuthCallbackPage({ kind: "error", error }));
                        server.close();
                        resolve({ success: false, error });
                        return;
                    }

                    if (code) {
                        // F2: per-flow single-use code. Reject any second
                        // callback after a code has already been consumed.
                        if (codeConsumed) {
                            res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
                            res.end("Code already consumed");
                            return;
                        }
                        // F2: validate state with constant-time compare.
                        if (!safeStringEqual(stateParam, expectedState)) {
                            res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
                            res.end("Invalid OAuth state");
                            server.close();
                            resolve({ success: false, error: "Invalid OAuth state" });
                            return;
                        }
                        codeConsumed = true;
                        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                        res.end(renderOAuthCallbackPage({ kind: "success" }));
                        server.close();

                        // Exchange token
                        const data = new URLSearchParams({
                            client_id: clientCreds.client_id,
                            client_secret: clientCreds.client_secret,
                            code: code,
                            grant_type: "authorization_code",
                            redirect_uri: "http://127.0.0.1:8844"
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

                // F2: bind explicitly to 127.0.0.1 so the callback server
                // is not reachable from other hosts on the LAN. Without
                // this, http.createServer().listen(port) binds to 0.0.0.0
                // on Linux/Windows and accepts callbacks from any peer
                // that can reach this machine.
                server.listen(8844, "127.0.0.1", () => {
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

    // Setup: check if setup is complete
    ipcMain.handle("setup:is-complete", () => fs.existsSync(SETUP_FLAG));

    // Setup: adaptive detection for the redesigned wizard (Bhai wizard v2).
    // Runs all Phase A signal probes in parallel with per-signal timeouts.
    // Fail-safe: errors and timeouts never abort detection — every probe has a fallback.
    ipcMain.handle("setup:detect", async () => {
        const { runDetection } = requireInstaller();
        const state = await runDetection(buildDetectionDeps());
        state.overlayShortcut = getActiveOverlayShortcut();
        state.overlayShortcutLabel = shortcutLabel(state.overlayShortcut);
        return state;
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
    // macOS lists the app under Microphone/Accessibility only once it has asked,
    // so ask first: the prompt comes from the tile the user just clicked.
    // Non-darwin is a no-op returning {ok:true, skipped:true}.
    ipcMain.handle("setup:request-permission", async (_evt, name) => {
        if (process.platform !== "darwin") return { ok: true, skipped: true };
        const { prefPaneUrlFor } = require("./components/permissions-grid");
        const url = prefPaneUrlFor(name);
        if (!url) return { ok: false, error: "unknown permission: " + String(name) };
        if (name === "microphone" && systemPreferences.getMediaAccessStatus("microphone") === "not-determined") {
            return { ok: await systemPreferences.askForMediaAccess("microphone") };
        }
        if (name === "accessibility") systemPreferences.isTrustedAccessibilityClient(true);
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
            activeOverlayShortcut = combo;
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
    // macOS, e.g. "/Applications/Bhai.app/...") are correctly URL-encoded.
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
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
                webSecurity: true,
                allowRunningInsecureContent: false,
            },
        });
        // F4: confine the Slack OAuth popup to slack.com.
        hardenBrowserWindow(popup, { allowedNavigateOrigins: ["slack.com"], allowLocal: false });
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
            // The app reads its appearance from the top-level "theme" key.
            if (update && update.theme) {
                store.set("theme", update.theme);
                broadcastThemeChange(update.theme);
            }
            try { saveEnvKVs(envKVsFromPersonalize(next.personalize)); }
            catch (e) { console.warn("[setup:save-personalize] env mirror failed:", e.message); }
            // Mirror personality choice into a separate file that the bot's
            // boot sequence picks up and pushes to /api/user/addendum/upsert.
            // Idempotent: bot renames to .user-personality.synced.json after
            // successful upload.
            try {
                if (next.personalize && next.personalize.personality) {
                    const personalityPath = path.join(app.getPath("userData"), ".user-personality.json");
                    // mode 0o600: owner-only read/write. File contains the user's
                    // free-text personality notes, which can include personal
                    // context the user wouldn't want readable by other local
                    // accounts on shared macOS/Linux systems.
                    fs.writeFileSync(personalityPath, JSON.stringify({
                        preset: next.personalize.personality.preset,
                        notes: next.personalize.personality.notes || "",
                        updatedAt: Date.now(),
                    }, null, 2), { mode: 0o600 });
                }
            } catch (e) {
                console.warn("[setup:save-personalize] personality file write failed:", e.message);
            }
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
        defaultWorkspace: path.join(app.getPath("desktop"), "Bhai Files"),
        platform: process.platform,
        // The shortcut actually registered: a fallback when the preferred one was taken.
        overlayShortcut: getActiveOverlayShortcut(),
    }));

    // ── Auto-Updater IPC ─────────────────────────
    ipcMain.handle("update:check", async () => {
        if (IS_DEV) return { available: false, isDev: true };
        try {
            // Guarantee the feed URL is set before electron-updater fetches.
            // Without this, a fresh install with no app-update.yml falls back
            // to the default GitHub provider and 404s on a stale repo.
            configureAutoUpdater();
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
        channel: getUpdateChannel(),
    }));

    ipcMain.handle("update:setChannel", async (_, channel) => {
        const allowed = ["stable", "beta", "alpha", "canary"];
        const next = String(channel || "stable").toLowerCase();
        if (!allowed.includes(next)) {
            return { success: false, error: "Invalid channel" };
        }
        store.set("updateChannel", next);
        // Re-check immediately on the new channel so the user gets feedback.
        if (!IS_DEV) {
            configureAutoUpdater();
            resetRetryBudget();
            autoUpdater.checkForUpdates().catch(err => {
                console.warn("[Updater] Channel-switch check failed:", err.message);
            });
        }
        return { success: true, channel: next };
    });

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

        if (key === "theme") broadcastThemeChange(value);

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
            activeOverlayShortcut = accelerator;
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
            if (globalShortcut.register(defaultShortcut, () => {
                toggleOverlay();
            })) activeOverlayShortcut = defaultShortcut;

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

    ipcMain.handle("hotkey:get-overlay", () => {
        const shortcut = getActiveOverlayShortcut();
        return { shortcut, label: shortcutLabel(shortcut) };
    });

    ipcMain.handle("hotkey:get-live-voice", () => {
        return { shortcut: getLiveVoiceShortcut() };
    });

    // ── Connection Status IPC ────────────────────
    ipcMain.handle("status:connections", () => {
        // Derived from what the bot actually logged — never assume a channel is up.
        const running = isAlive(botProcess);
        return {
            telegram: running && channelStatuses.telegram === "connected",
            telegramConfigured: channelStatuses.telegram !== "not_configured",
            email: running && channelStatuses.email === "connected",
            overlay: running,
        };
    });

    // ── Account Handlers ─────────────────────────
    // otplessData = { userId, token, email, phone, name }

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
            if (_signInNeeded) return { signedIn: false, deviceRemoved: _signInNeeded === "device_removed", signInAgain: true };

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

    // Account → Devices
    ipcMain.handle("account:devices", async () => {
        try {
            const data = await convexSiteRequest("GET", "/api/account/devices");
            return { success: true, devices: Array.isArray(data?.devices) ? data.devices : [] };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });
    ipcMain.handle("account:remove-device", async (_, deviceId) => {
        if (typeof deviceId !== "string" || !deviceId) return { success: false, error: "No device" };
        try {
            const r = await convexSiteRequest("POST", "/api/account/devices/remove", { deviceId });
            return r?.ok ? { success: true } : { success: false, error: r?.error || "Couldn't remove it" };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle("account:userId", async () => {
        const session = loadAccountSession();
        return session?.userId || null;
    });

    // ── Store IPC ───────────────────────────────────────────────
    const STORE_DIR = path.join(app.getPath("home"), ".atlas", "store");

    // Fetch store items via the session-authenticated proxy. Store Convex
    // functions are internalQuery-only (security audit fb99bbf) and are not
    // reachable on the public /api/query endpoint — they must go through
    // /api/store/query, which validates the session token and runs the
    // internal function via ctx.runQuery.
    ipcMain.handle("store:list", async () => {
        console.log("[Store] store:list IPC handler called");
        try {
            const data = await convexSiteRequest("POST", "/api/store/query", {
                functionPath: "store/items:list",
                args: {},
            });
            if (!data || data.status !== "success") {
                throw new Error(data?.error || "Store query failed");
            }
            const items = data.value || [];
            console.log("[Store] Success! Items:", items.length);
            return { success: true, items };
        } catch (err) {
            console.error("[Store] Failed to fetch store items:", err.message);
            return { success: false, error: err.message, items: [] };
        }
    });

    // Start an install via the authenticated proxy. startInstall validates
    // the item is active, that the user hasn't already installed it, and
    // returns the content download URL. userId is injected server-side from
    // the session (USER_BOUND_PATHS), so it must not be passed here.
    // store:install downloads and runs code: only a URL this process got from the store's own
    // startInstall (not whatever the renderer passes) may be installed.
    const issuedStoreUrls = new Set();
    ipcMain.handle("store:start-install", async (_, { itemId, version }) => {
        try {
            const data = await convexSiteRequest("POST", "/api/store/mutation", {
                functionPath: "store/installs:startInstall",
                args: { itemId, version },
            });
            if (!data || data.status !== "success") {
                throw new Error(data?.error || "Failed to start install");
            }
            if (typeof data.value?.contentUrl === "string") issuedStoreUrls.add(data.value.contentUrl);
            return { success: true, ...data.value };
        } catch (err) {
            console.error("[Store] start-install failed:", err.message);
            return { success: false, error: err.message };
        }
    });

    // Confirm an install via the authenticated proxy. confirmInstall records
    // the install row and atomically increments installCount/weeklyInstalls,
    // replacing the old direct incrementInstallCount call.
    ipcMain.handle("store:confirm-install", async (_, { itemId }) => {
        try {
            const data = await convexSiteRequest("POST", "/api/store/mutation", {
                functionPath: "store/installs:confirmInstall",
                args: { itemId },
            });
            if (!data || data.status !== "success") {
                throw new Error(data?.error || "Failed to confirm install");
            }
            return { success: true };
        } catch (err) {
            console.error("[Store] confirm-install failed:", err.message);
            return { success: false, error: err.message };
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

    // slug/type come from the renderer: never put them in a path unchecked
    // (slug "../../.." made uninstall rm -rf the home directory).
    function storeItemDir(type, slug) {
        if (!["skill", "mcp", "tool"].includes(type)) throw new Error("Invalid store item type");
        if (typeof slug !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(slug)) {
            throw new Error("Invalid store item slug");
        }
        const base = path.resolve(STORE_DIR, type + "s");
        const dir = path.resolve(base, slug);
        if (!dir.startsWith(base + path.sep)) throw new Error("Invalid store item path");
        return dir;
    }
    const STORE_MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

    ipcMain.handle("store:install", async (_, item) => {
        try {
            const { slug, type, name, version, downloadUrl, permissions } = item;

            const typeDir = storeItemDir(type, slug);
            if (typeof downloadUrl !== "string" || !/^https:\/\//i.test(downloadUrl)) {
                throw new Error("Store downloads must use https");
            }
            if (!issuedStoreUrls.delete(downloadUrl)) throw new Error("Start the install from the Store first");
            fs.mkdirSync(typeDir, { recursive: true });

            // Download content
            console.log(`[Store] Downloading ${name}...`);
            const https = require("https");

            await new Promise((resolve, reject) => {
                const request = https.get(downloadUrl, (response) => {
                    if (response.statusCode === 302 || response.statusCode === 301) {
                        // Follow one redirect, still https only.
                        const location = new URL(response.headers.location || "", downloadUrl).toString();
                        if (!location.startsWith("https://"))
                            return reject(new Error("Store downloads must use https"));
                        https
                            .get(location, (res) => {
                                handleDownload(res, resolve, reject);
                            })
                            .on("error", reject);
                    } else {
                        handleDownload(response, resolve, reject);
                    }
                });
                request.on("error", reject);

                function handleDownload(response, resolve, reject) {
                    const chunks = [];
                    let size = 0;
                    response.on("data", (chunk) => {
                        size += chunk.length;
                        if (size > STORE_MAX_DOWNLOAD_BYTES) {
                            response.destroy();
                            reject(new Error("Store download too large"));
                            return;
                        }
                        chunks.push(chunk);
                    });
                    response.on("end", async () => {
                        try {
                            const buffer = Buffer.concat(chunks);

                            // Extract zip — same entry checks as sideload (no
                            // traversal, absolute paths or symlinks).
                            const AdmZip = require("adm-zip");
                            const zip = new AdmZip(buffer);
                            const check = validateZipEntries(zip.getEntries());
                            if (!check.ok) throw new Error(check.error);
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
            const typeDir = storeItemDir(type, slug);
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

    // F8: trusted Ed25519 publisher public keys, hex-encoded. Start with
    // Bhai's own key; add more as ecosystem partners are vetted. Stored as
    // an env-overridable allowlist so we don't ship a hardcoded list that's
    // tedious to rotate.
    const TRUSTED_PUBLISHER_KEYS = (process.env.ATLAS_TRUSTED_PUBLISHER_KEYS || "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

    // F8: pre-validate every ZIP entry. AdmZip exposes attributes (`attr`)
    // and we additionally check the entryName looks sane. Used to reject
    // path traversal, absolute paths, and symlink entries before extraction.
    function validateZipEntries(entries) {
        const safePattern = /^[A-Za-z0-9_./-]+$/;
        for (const e of entries) {
            const name = e.entryName || "";
            if (!safePattern.test(name)) {
                return { ok: false, error: `Invalid ZIP entry name: ${name}` };
            }
            if (name.startsWith("/") || name.startsWith("..") || name.includes("/../")) {
                return { ok: false, error: `Unsafe ZIP entry path: ${name}` };
            }
            // adm-zip surfaces UNIX file mode in `attr` (upper 16 bits).
            // Symlinks have mode bits 0xA000. Reject any entry that looks
            // like one — they let a malicious zip plant files outside the
            // extraction dir after extraction.
            const mode = (e.attr >>> 16) & 0o170000;
            if (mode === 0o120000) {
                return { ok: false, error: `Symlink entries not allowed: ${name}` };
            }
        }
        return { ok: true };
    }

    // F8: verify Ed25519 signature against a canonical hash of all files.
    // The signature.json schema:
    //   { algo: "ed25519", publisherKey: "<hex>", signature: "<hex>",
    //     files: [{ name: "...", sha256: "<hex>" }, ...] }
    // Canonical hash = SHA-256 of the JSON-serialized sorted file list.
    function verifySkillSignature(zip, entries) {
        const sigEntry = entries.find((e) => e.entryName === "signature.json");
        if (!sigEntry) {
            return { ok: false, reason: "no_signature" };
        }
        let sig;
        try {
            sig = JSON.parse(sigEntry.getData().toString("utf-8"));
        } catch {
            return { ok: false, reason: "malformed_signature" };
        }
        if (sig.algo !== "ed25519" || typeof sig.publisherKey !== "string" ||
            typeof sig.signature !== "string" || !Array.isArray(sig.files)) {
            return { ok: false, reason: "malformed_signature" };
        }
        if (!TRUSTED_PUBLISHER_KEYS.includes(sig.publisherKey)) {
            return { ok: false, reason: "untrusted_publisher" };
        }
        // Verify per-file hashes match the manifest.
        const cryptoMod = require("node:crypto");
        const filesSorted = [...sig.files].sort((a, b) => a.name.localeCompare(b.name));
        for (const file of filesSorted) {
            if (file.name === "signature.json") continue;
            const entry = entries.find((e) => e.entryName === file.name);
            if (!entry) return { ok: false, reason: `missing_file:${file.name}` };
            const actual = cryptoMod.createHash("sha256").update(entry.getData()).digest("hex");
            if (actual !== file.sha256) return { ok: false, reason: `hash_mismatch:${file.name}` };
        }
        // Verify the Ed25519 signature over the canonical file list.
        const canonical = JSON.stringify(filesSorted.filter((f) => f.name !== "signature.json"));
        const ok = cryptoMod.verify(
            null,
            Buffer.from(canonical, "utf-8"),
            { key: Buffer.from(sig.publisherKey, "hex"), format: "der", type: "spki" },
            Buffer.from(sig.signature, "hex"),
        );
        return ok ? { ok: true, publisherKey: sig.publisherKey } : { ok: false, reason: "bad_signature" };
    }

    ipcMain.handle("store:sideload-install", async (_, filePath, options) => {
        try {
            const ext = path.extname(filePath).toLowerCase();
            const AdmZip = require("adm-zip");
            const acceptUnsigned = Boolean(options && options.acceptUnsigned);

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
            let signatureStatus = { signed: false, publisherKey: null };

            if (ext === ".zip") {
                // Extract ZIP and look for SKILL.md or *.md with frontmatter
                const zip = new AdmZip(filePath);
                const entries = zip.getEntries();

                // F8: pre-validate entries BEFORE touching disk. Rejects
                // ../ traversal, absolute paths, symlinks, weird names.
                const validation = validateZipEntries(entries);
                if (!validation.ok) {
                    return { success: false, error: `Sideload rejected: ${validation.error}` };
                }

                // F8: signature check. Two outcomes:
                //   - signed + trusted key + hashes match  → install normally
                //   - missing/invalid signature            → require explicit
                //     opt-in via options.acceptUnsigned; mark install as
                //     "unsigned" so it never auto-runs without user click.
                const sigResult = verifySkillSignature(zip, entries);
                if (sigResult.ok) {
                    signatureStatus = { signed: true, publisherKey: sigResult.publisherKey };
                } else {
                    if (!acceptUnsigned) {
                        return {
                            success: false,
                            error: "Skill is unsigned or signature invalid. Re-call with options.acceptUnsigned=true after warning the user.",
                            requiresUnsignedConsent: true,
                            signatureReason: sigResult.reason,
                        };
                    }
                    console.warn(`[Sideload] Installing UNSIGNED skill (user accepted). Reason: ${sigResult.reason}`);
                }

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
                // Direct .md file — never signed, so it needs the same consent
                // as an unsigned zip.
                if (!acceptUnsigned) {
                    return {
                        success: false,
                        error: "Skill is unsigned. Re-call with options.acceptUnsigned=true after warning the user.",
                        requiresUnsignedConsent: true,
                    };
                }
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
                // F8: persist signature status so the agent's tool loader
                // can refuse to auto-run unsigned skills and require an
                // explicit user click each time.
                signed: signatureStatus.signed,
                publisherKey: signatureStatus.publisherKey,
                autoRunAllowed: signatureStatus.signed,
                installedAt: new Date().toISOString(),
            });
            fs.writeFileSync(installsPath, JSON.stringify(data, null, 2));

            console.log(`[Sideload] Installed ${name} (${slug}) → ${skillDir} (signed=${signatureStatus.signed})`);

            return {
                success: true,
                name,
                slug,
                type: itemType,
                version,
                categories,
                signed: signatureStatus.signed,
                publisherKey: signatureStatus.publisherKey,
                warnings: warnings.length > 0 ? warnings : undefined,
            };
        } catch (err) {
            console.error("[Sideload] Failed:", err.message);
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
                    selfNumber: waSelfNumber,
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
                    enabled: !!env.EMAIL_USER || !!env.BHAI_MAIL_ADDRESS,
                    bhaiAddress: env.BHAI_MAIL_ADDRESS || "",
                    bhaiOwner: env.BHAI_MAIL_OWNER || "",
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
                        "BHAI_MAIL_ADDRESS", "BHAI_MAIL_OWNER",
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
                // Bhai's own address (server-issued, see channel:bhai-mail-claim)
                if (/^[a-z0-9]+\.bhai@[a-z0-9.-]+$/.test(config.email.bhaiAddress || "") && config.email.bhaiOwner && !/[\s=]/.test(config.email.bhaiOwner)) {
                    envLines.push(`BHAI_MAIL_ADDRESS=${config.email.bhaiAddress}`);
                    envLines.push(`BHAI_MAIL_OWNER=${config.email.bhaiOwner}`);
                }
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

            const isBotRunning = isAlive(botProcess);
            return { success: true, botRunning: isBotRunning };
        } catch (err) {
            console.error("[Channels] save-config error:", err.message);
            return { success: false, error: err.message };
        }
    });

    // ── Channel Connection Tests ─────────────────
    // These work WITHOUT the bot running — just HTTP calls to verify credentials

    // Empty or masked ("***") field = use the token already saved.
    const savedOr = (v, key) => (v && v !== "***" ? v : loadEnvKey(key) || "");

    ipcMain.handle("channel:test-telegram", async (_, { token }) => {
        try {
            token = savedOr(token, "TELEGRAM_BOT_TOKEN");
            const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`);
            const data = await res.json();
            if (data.ok) return { success: true, username: data.result.username, message: `Connected as @${data.result.username} (${data.result.first_name})` };
            return { success: false, message: data.description || "Invalid token" };
        } catch (err) { return { success: false, message: err.message }; }
    });

    // Waits for the owner to message the new bot and returns their user id, so
    // nobody has to look it up. Only runs before the bot uses this token (the
    // bot's own polling would take the update instead). Single-flight per token.
    const __tgOwnerWaits = new Map();
    ipcMain.handle("channel:telegram-wait-owner", (_, { token }) => {
        token = savedOr(token, "TELEGRAM_BOT_TOKEN");
        if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) return { success: false, message: "Bad Telegram token" };
        if (token === loadEnvKey("TELEGRAM_BOT_TOKEN") && isAlive(botProcess)) return { success: false, message: "Bhai is already using this bot" };
        if (__tgOwnerWaits.has(token)) return __tgOwnerWaits.get(token);
        const p = (async () => {
            const deadline = Date.now() + 3 * 60 * 1000;
            while (Date.now() < deadline) {
                try {
                    const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/getUpdates?timeout=20&allowed_updates=["message"]`, { signal: AbortSignal.timeout(30000) });
                    const data = await res.json();
                    if (!data.ok) return { success: false, message: data.description || "Telegram refused getUpdates" };
                    // Updates are not acknowledged, so the bot still sees the hi after it starts.
                    const from = data.result.map(u => u.message && u.message.from).find(f => f && !f.is_bot);
                    if (from) return { success: true, userId: String(from.id), name: [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || "" };
                } catch { await new Promise(r => setTimeout(r, 2000)); }
            }
            return { success: false, message: "No message arrived in 3 minutes" };
        })().finally(() => __tgOwnerWaits.delete(token));
        __tgOwnerWaits.set(token, p);
        return p;
    });

    // Also returns the app owner's id (fills the allowlist) and whether the
    // Message Content intent is on (without it the bot reads empty messages).
    ipcMain.handle("channel:test-discord", async (_, { token }) => {
        try {
            token = savedOr(token, "DISCORD_BOT_TOKEN");
            const res = await fetch("https://discord.com/api/v10/applications/@me", { headers: { Authorization: `Bot ${token}` } });
            if (!res.ok) return { success: false, message: res.status === 401 ? "Discord rejected this token. Reset it in the Bot tab and paste the new one." : `Discord error (${res.status})` };
            const app = await res.json();
            const owner = app.team ? (app.team.members || []).find(m => m.user && m.user.id === app.team.owner_user_id)?.user : app.owner;
            const MESSAGE_CONTENT = (1 << 18) | (1 << 19);
            return {
                success: true,
                clientId: app.id,
                ownerId: owner ? owner.id : "",
                ownerName: owner ? (owner.global_name || owner.username) : "",
                intentOk: !!(app.flags & MESSAGE_CONTENT),
                message: `Connected as ${app.bot ? app.bot.username : app.name}`,
            };
        } catch (err) { return { success: false, message: err.message }; }
    });

    // Also suggests the workspace's primary owner for the allowlist (users:read
    // is in the manifest); the panel lets the user change it.
    ipcMain.handle("channel:test-slack", async (_, { botToken }) => {
        try {
            botToken = savedOr(botToken, "SLACK_BOT_TOKEN");
            const headers = { Authorization: `Bearer ${botToken}` };
            const data = await (await fetch("https://slack.com/api/auth.test", { headers })).json();
            if (!data.ok) return { success: false, message: data.error || "Invalid token" };
            let ownerId = "", ownerName = "";
            try {
                const ul = await (await fetch("https://slack.com/api/users.list?limit=200", { headers })).json();
                const humans = (ul.members || []).filter(u => !u.is_bot && !u.deleted && u.id !== "USLACKBOT");
                const owner = humans.find(u => u.is_primary_owner) || (humans.length === 1 ? humans[0] : null);
                if (owner) { ownerId = owner.id; ownerName = owner.real_name || owner.name; }
            } catch { /* optional */ }
            let appId = "";
            try {
                const bi = await (await fetch(`https://slack.com/api/bots.info?bot=${encodeURIComponent(data.bot_id || "")}`, { headers })).json();
                appId = (bi.bot && bi.bot.app_id) || "";
            } catch { /* optional */ }
            return { success: true, ownerId, ownerName, appId, message: `Connected to ${data.team} as ${data.user}` };
        } catch (err) { return { success: false, message: err.message }; }
    });

    // Real IMAP login, not just a TLS reachability check: a wrong app password
    // should fail here, not silently after the restart.
    ipcMain.handle("channel:test-email", async (_, { user, password, imapHost, imapPort }) => {
        const { ImapFlow } = require("imapflow");
        const port = Number(imapPort) || 993;
        const client = new ImapFlow({ host: imapHost, port, secure: port === 993, auth: { user, pass: savedOr(password, "EMAIL_PASSWORD") }, logger: false });
        try {
            await client.connect();
            await client.logout();
            return { success: true, message: `Signed in to ${user}` };
        } catch (err) {
            const auth = err.authenticationFailed || /auth|credential|password/i.test(String(err.responseText || err.message));
            return { success: false, message: auth ? "Sign-in failed. Use an app password, not your normal password." : `Cannot reach ${imapHost}:${port}: ${err.message}` };
        }
    });

    ipcMain.handle("channel:test-matrix", async (_, { homeserver, username, password }) => {
        try {
            const base = (homeserver || "https://matrix.org").replace(/\/$/, "");
            const res = await fetch(`${base}/_matrix/client/v3/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: "m.login.password", identifier: { type: "m.id.user", user: username }, password: savedOr(password, "MATRIX_PASSWORD") })
            });
            const data = await res.json();
            if (data.access_token) return { success: true, userId: data.user_id, message: `Logged in as ${data.user_id}` };
            return { success: false, message: data.error || "Login failed" };
        } catch (err) { return { success: false, message: err.message }; }
    });

    // One-tap Telegram bot through Bhai's manager bot (convex/telegramManaged.ts):
    // claim a username, open Telegram's prefilled "create bot" screen, then
    // collect the token and the owner's id once the user taps Create.
    ipcMain.handle("channel:telegram-managed-start", async () => {
        const username = `bhai_${require("crypto").randomBytes(3).toString("hex")}_bot`;
        try {
            const r = await convexSiteRequest("POST", "/api/telegram/managed/claim", { username });
            if (!r || !r.link) return { success: false, notConfigured: !!r && r.error === "not_configured", message: (r && r.error) || "No reply" };
            await shell.openExternal(r.link);
            return { success: true, username };
        } catch (err) { return { success: false, message: err.message }; }
    });

    ipcMain.handle("channel:telegram-managed-wait", async (_, { username }) => {
        const deadline = Date.now() + 10 * 60 * 1000;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 3000));
            let r;
            try { r = await convexSiteRequest("POST", "/api/telegram/managed/collect", { username }); } catch { continue; }
            if (r && r.status === "ready") {
                ensureTelegramAvatar(r.token);
                return { success: true, username, token: r.token, userId: r.ownerId, name: r.ownerName || "" };
            }
            if (r && r.status === "expired") return { success: false, message: "That request expired" };
            if (r && r.error && !/rate limit/i.test(r.error)) return { success: false, message: r.error };
        }
        return { success: false, message: "Telegram didn't confirm in 10 minutes" };
    });

    // Bhai's own email: the server hands out <name>.bhai@xagilab.com for this
    // account; it only takes mail from ownerEmail and only writes to it.
    ipcMain.handle("channel:bhai-mail-claim", async (_, { ownerEmail }) => {
        try {
            const r = await convexSiteRequest("POST", "/api/mail/claim", { ownerEmail });
            if (r && r.address) return { success: true, address: r.address };
            return { success: false, notConfigured: !!r && r.error === "not_configured", message: (r && r.error) || "No reply" };
        } catch (err) { return { success: false, message: err.message }; }
    });

    // Coming back from BotFather / the Discord or Slack portal with a token
    // copied fills it in. Only a value shaped like the asked-for token leaves
    // main; the rest of the clipboard never reaches the page.
    const TOKEN_SHAPES = {
        telegram: /^\d{6,}:[A-Za-z0-9_-]{30,}$/,
        discord: /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{25,}$/,
        slackBot: /^xoxb-[A-Za-z0-9-]{20,}$/,
        slackApp: /^xapp-[A-Za-z0-9-]{20,}$/,
        github: /^(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})$/,
    };
    ipcMain.handle("channel:clipboard-token", (_, kind) => {
        const text = require("electron").clipboard.readText().trim();
        return TOKEN_SHAPES[kind] && TOKEN_SHAPES[kind].test(text) ? text : "";
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
        // The bot reads this file the next time a message arrives (getActiveOTP).
        const code = String(require("crypto").randomInt(100000, 1000000));
        const otpPath = path.join(DATA_DIR, "whatsapp-otp-signal.json");
        fs.writeFileSync(otpPath, JSON.stringify({ code, expiresAt: Date.now() + 5 * 60 * 1000 }), { mode: 0o600 });
        return waOtpPayload(code);
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
        return { name: "Bhai", systemPrompt: "", allowedToolNames: [], autoAllow: false };
    });

    ipcMain.handle("wa:save-persona", (_, persona) => {
        try {
            const { mergeWaPersona } = require("./wa-persona-merge");
            const personaPath = path.join(DATA_DIR, "whatsapp-persona.json");
            fs.mkdirSync(path.dirname(personaPath), { recursive: true });
            // Merge onto the persisted persona so fields the Settings form
            // doesn't send (notably allowedToolNames, set via WhatsApp commands)
            // survive the save instead of being wiped.
            let existing = {};
            try { if (fs.existsSync(personaPath)) existing = JSON.parse(fs.readFileSync(personaPath, "utf-8")); } catch {}
            fs.writeFileSync(personaPath, JSON.stringify(mergeWaPersona(existing, persona), null, 2));
            return { success: true };
        } catch (err) { return { success: false, error: err.message }; }
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

// Augment PATH with common binary locations missing from Electron's stripped
// dock-launch PATH. brew (Apple Silicon at /opt/homebrew/bin), ollama, python3,
// and ATLAS-managed tools all live in non-default locations.
function buildAugmentedPath() {
    if (process.platform === "win32") return process.env.PATH || "";
    const extras = [
        path.join(require("os").homedir(), ".atlas", "bin"),
        "/opt/homebrew/bin",       // Homebrew (Apple Silicon)
        "/usr/local/bin",          // Homebrew (Intel) / general
        "/opt/homebrew/sbin",
        "/usr/local/sbin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ];
    const current = (process.env.PATH || "").split(path.delimiter);
    return [...new Set([...extras, ...current])].join(path.delimiter);
}

// Quote a single arg for spawn(..., { shell: true }) on Windows. Node does NOT
// quote the args array under shell:true — it joins them with spaces and hands the
// raw string to `cmd.exe /c`, so any arg with whitespace or cmd metacharacters
// (`"`, `;`, `(`, `)`, `,`, `&`, `|`, `<`, `>`, `^`, `%`) gets re-tokenized. That
// shreds Python `-c` scripts and breaks paths like `C:\Users\John Doe\...`. Simple
// args pass through unchanged so existing single-token calls keep working.
function winQuoteArg(s) {
    const str = String(s);
    if (str.length && !/[\s"();,&|<>^%]/.test(str)) return str;
    // Escape backslashes that precede a quote (Windows arg-parsing rule), then the
    // quotes themselves, then wrap. `%` can't be safely escaped for cmd.exe, but
    // our args never contain it; the test above only quotes — it doesn't strip.
    const escaped = str.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
    return '"' + escaped + '"';
}

function runCommand(cmd, args, cwd, onOutput) {
    return new Promise((resolve, reject) => {
        let executable = cmd;
        // Augment PATH so spawn(shell:false) on POSIX can find brew, ollama,
        // python3 etc. Without this, the macOS dock-launched Electron has only
        // /usr/bin:/bin in its inherited PATH and every Homebrew binary errors
        // with ENOENT.
        let spawnEnv = {
            ...process.env,
            NODE_ENV: "production",
            PATH: buildAugmentedPath(),
        };
        // shell: false everywhere except Windows. On POSIX we resolve via PATH
        // without a shell wrapper — safer (no risk that a future caller's
        // interpolated arg gets re-parsed by /bin/sh). Windows still needs
        // shell:true so spawn can find .cmd/.bat shims (winget, choco) via
        // PATHEXT resolution.
        let shell = process.platform === "win32";

        if (cmd === "node" && !IS_DEV) {
            executable = process.execPath;
            spawnEnv.ELECTRON_RUN_AS_NODE = "1";
            shell = false; // Disable shell so parameters are passed correctly, and executable path handles spaces properly
        }

        // Under shell:true (Windows), spawn won't quote args — cmd.exe would
        // re-tokenize anything with spaces/metacharacters. Quote each arg (and the
        // executable if it contains a space) ourselves. shell:false passes args
        // literally and must NOT be quoted.
        const spawnExecutable = shell && /\s/.test(executable) ? winQuoteArg(executable) : executable;
        const spawnArgs = shell ? args.map(winQuoteArg) : args;
        const proc = spawn(spawnExecutable, spawnArgs, {
            cwd,
            shell,
            env: spawnEnv,
        });

        let output = "";
        // Forward BOTH stdout and stderr to onOutput. Tools like `ollama pull`
        // write their progress bar to stderr (typical for download progress so
        // pipes-to-other-tools stay clean). If we only forward stdout, the
        // install log shows nothing for the entire 15-minute pull.
        // Split on \r AND \n because progress bars rewrite the same line.
        const forwardChunk = (data) => {
            const s = data.toString();
            output += s;
            if (!onOutput) return;
            // Each \r-separated segment is a re-render of the same line.
            // Emit each non-empty segment so the latest progress reaches the UI.
            const parts = s.split(/[\r\n]+/);
            for (const p of parts) {
                const trimmed = p.trim();
                if (trimmed) onOutput(trimmed);
            }
        };
        proc.stdout?.on("data", forwardChunk);
        proc.stderr?.on("data", forwardChunk);

        proc.on("exit", (code) => {
            if (code === 0) resolve(output);
            else reject(new Error(`Command '${cmd} ${args.join(" ")}' failed (code ${code}): ${output.substring(0, 200)}`));
        });

        proc.on("error", reject);

        // Per-command timeout. The vision-model pull legitimately takes 15-25
        // minutes on slow connections; 10 minutes was too tight. 45 minutes
        // is enough for a 5 GB pull at ~2 MB/s.
        setTimeout(() => {
            proc.kill();
            reject(new Error(`Command '${cmd}' timed out after 45 minutes`));
        }, 45 * 60 * 1000);
    });
}

// ── System Tray ───────────────────────────────

function createTray() {
    // Windows requires .ico for tray icons; macOS/Linux use PNG
    const iconFile = process.platform === "win32" ? "logo.ico" : "logo.png";
    const iconPath = path.join(__dirname, iconFile);
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip("Bhai — Personal AI Agent");

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
            label: "Start Bhai",
            click: () => { startBot(); updateTrayMenu(); },
            enabled: !running,
        },
        {
            label: "Stop Bhai",
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
                        const workspace = store.get("workspace") || path.join(app.getPath("desktop"), "Bhai Files");
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
                                broadcastThemeChange("light");
                            },
                        },
                        {
                            label: "Dark",
                            type: "radio",
                            checked: store.get("theme") === "dark",
                            click: () => {
                                store.set("theme", "dark");
                                broadcastThemeChange("dark");
                            },
                        },
                        {
                            label: "System",
                            type: "radio",
                            checked: store.get("theme") === "system",
                            click: () => {
                                store.set("theme", "system");
                                broadcastThemeChange("system");
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
            label: "Start Bhai",
            click: () => { startBot(); updateTrayMenu(); },
            enabled: !running,
        },
        {
            label: "Stop Bhai",
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
                        const workspace = store.get("workspace") || path.join(app.getPath("desktop"), "Bhai Files");
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
                                broadcastThemeChange("light");
                            },
                        },
                        {
                            label: "Dark",
                            type: "radio",
                            checked: store.get("theme") === "dark",
                            click: () => {
                                store.set("theme", "dark");
                                broadcastThemeChange("dark");
                            },
                        },
                        {
                            label: "System",
                            type: "radio",
                            checked: store.get("theme") === "system",
                            click: () => {
                                store.set("theme", "system");
                                broadcastThemeChange("system");
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
    let tooltip = running ? "Bhai — Online" : "Bhai — Offline";
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
    // Setup used to save its theme where nothing read it, leaving the old
    // "light" default in charge even on a dark Mac. Adopt that choice once.
    const setupTheme = store.get("prefs")?.personalize?.theme;
    if (setupTheme && !store.get("themeFromSetup")) {
        store.set("theme", setupTheme);
        store.set("themeFromSetup", true);
    }
    applyNativeTheme(store.get("theme"));
    // Re-tint the overlay's glass when the appearance flips (theme or macOS).
    nativeTheme.on("updated", () => {
        if (overlayGlassNative && overlayWindow && !overlayWindow.isDestroyed()) attachOverlayGlass(overlayWindow);
    });
    // Run v1 → v2 migration before anything reads SETUP_FLAG or prefs.json.
    await runV2Migration();
    // Ghost-cursor windows exist (hidden) before any bot can drive the screen.
    initAgentCursor();

    // Configure the auto-updater feed URL once at startup. Some launch paths
    // (native menu shortcuts, scheduled checks) call autoUpdater directly
    // without going through our wrappers; without setFeedURL the library
    // falls back to its default GitHub provider, which 404s. Fail-open if
    // configuration throws — the IPC wrappers also call this defensively.
    try { if (!IS_DEV) configureAutoUpdater(); } catch (err) {
        console.error("[Updater] Initial configure failed:", err.message);
    }

    // Windows: set AppUserModelID for Action Center notification grouping
    if (process.platform === "win32") {
        app.setAppUserModelId("com.xagilabs.bhai");
        console.log("[INIT] Windows AppUserModelID set: com.xagilabs.bhai");

        // F5: permission handler with per-origin confirmation gate.
        // Auto-granting microphone/camera/geolocation to any webContents
        // meant a malicious remote page (loaded into a stray window) could
        // silently turn on the user's mic. Now: localhost/file is trusted,
        // any other origin must be confirmed via dialog and the choice is
        // remembered in electron-store.
        const { session } = require("electron");
        const PERMITTED_TYPES = new Set([
            "microphone", "camera", "geolocation", "notifications", "media",
        ]);
        session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
            if (!PERMITTED_TYPES.has(permission)) {
                return callback(false);
            }
            let originHost = "";
            try {
                const u = new URL(webContents.getURL());
                originHost = u.hostname;
                if (u.protocol === "file:" || u.hostname === "127.0.0.1" || u.hostname === "localhost") {
                    console.log(`[PERMISSIONS] ${permission} granted to trusted local origin (${u.hostname || "file"})`);
                    return callback(true);
                }
            } catch {
                return callback(false);
            }
            const grants = store.get("permissionGrants") || {};
            const key = `${originHost}::${permission}`;
            if (grants[key] === "allow") return callback(true);
            if (grants[key] === "deny") return callback(false);
            // Prompt the owner. dialog.showMessageBox is sync from a handler
            // perspective — use the non-promise form to keep this callback fast.
            const { dialog } = require("electron");
            dialog.showMessageBox({
                type: "question",
                buttons: ["Deny", "Allow once", "Always allow"],
                defaultId: 0,
                cancelId: 0,
                title: "Bhai — Permission Request",
                message: `Grant ${permission} access to ${originHost}?`,
                detail: "Only allow if you trust this site. Bhai will remember your choice for 'Always allow'.",
            }).then(({ response }) => {
                if (response === 2) {
                    grants[key] = "allow";
                    store.set("permissionGrants", grants);
                    callback(true);
                } else if (response === 1) {
                    callback(true);
                } else {
                    callback(false);
                }
            }).catch(() => callback(false));
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

    // Clean old log files on startup (keeps only last 3 days)
    cleanOldLogs();

    // Check accessibility permission on macOS (required for global shortcuts).
    // Log only: the prompt comes from the wizard / Ready Hub permission tiles.
    if (process.platform === "darwin") {
        const trusted = systemPreferences.isTrustedAccessibilityClient(false);
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
        activeOverlayShortcut = overlayShortcut;
        console.log(`[SHORTCUT] Overlay shortcut registered: ${overlayShortcut}`);
    } else {
        console.warn(`[SHORTCUT] ⚠️ Could not register overlay shortcut: ${overlayShortcut} — trying fallback...`);
        // Try fallback shortcuts
        const fallbacks = process.platform === "darwin"
            ? ["Command+Shift+J", "Command+Option+J", "Command+\\"]
            : ["Alt+J", "Ctrl+Shift+J", "Ctrl+\\"];
        for (const fb of fallbacks) {
            if (globalShortcut.register(fb, () => toggleOverlay())) {
                activeOverlayShortcut = fb;
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
        // Auto-start bot (no fixed delay: it was a second added to every launch)
        startBot().catch((err) => console.error("[BOT] Auto-start failed:", err.message));
        updateTrayMenu();

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
