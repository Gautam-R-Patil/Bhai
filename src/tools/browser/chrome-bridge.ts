// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Chrome Bridge Server ─────────────────────
// WebSocket server that the Bhai Chrome Extension connects to.
// Enables the agent to see and interact with the user's real Chrome tabs
// instead of always opening a headless Playwright browser.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire as _bridgeCreateRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { type WebSocket, WebSocketServer } from "ws";
import { getBhaiHome, getDataDir, getScriptsDir } from "../../config/paths.js";
import { getOverlayLocalToken } from "../../overlay/overlay-chat.js";
import { bhaiExtensionIds, isForeignExtensionOrigin } from "../../security/extension-origin.js";
import { isBrowserPageLoad, isLoopbackHost, isWebOrigin } from "../../security/loopback.js";
import { resetBackend } from "./browser-backend.js";
import type { ChromeBridgeCommand, ChromeBridgeEvent, ChromeBridgeResponse, ChromeTabInfo } from "./types.js";

// ── Try native Rust module for token/encryption (fail-open to JS) ──

let native: {
    generateBridgeToken: () => string;
    validateBridgeToken: (token: string) => boolean;
    setBridgeToken: (token: string) => void;
    checkBridgeRateLimit: (commandType: string) => boolean;
    validateBridgeCommand: (json: string) => string;
    recordBridgeError: () => void;
    getBridgeStats: () => string;
    encryptBridgeMessage: (plaintext: string) => string;
    decryptBridgeMessage: (encrypted: string) => string;
} | null = null;

try {
    // Use createRequire (synchronous) so the bundle has no top-level await
    const _req = _bridgeCreateRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = _req(path.join(process.cwd(), "native", "index.js")) as any;
    if (mod.generateBridgeToken && mod.validateBridgeToken) {
        native = mod;
        console.log("  🦀 Chrome bridge: using native Rust security module");
    }
} catch {
    // Native module unavailable — use JS fallback
}

// ── State ────────────────────────────────────

const BRIDGE_PORT = 18800;
const TOKEN_FILE = path.join(getDataDir(), "chrome-bridge-token.txt");
const DISCOVERY_FILE = path.join(getBhaiHome(), "chrome-bridge.json");
// F10: local-only access token for CLI/native callers. Lives at 0o600 and
// is required to call /discover-local. The chrome-extension /discover path
// uses browser-set Origin instead (chrome-extension://...) which can't be
// forged from a non-browser context.
const LOCAL_TOKEN_FILE = path.join(getBhaiHome(), "data", "chrome-bridge-local-token");
const AUTH_TIMEOUT_MS = 5000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10000;
const OPERATION_TIMEOUTS: Record<string, number> = {
    click_at: 3000,
    type_text: 3000,
    keyboard: 2000,
    hover: 2000,
    scroll: 2000,
    screenshot: 5000,
    scan_elements: 10000,
    navigate: 30000,
    execute_js: 15000,
    wait_for: 15000,
    select_option: 3000,
    close_tab: 2000,
    switch_tab: 2000,
    get_tabs: 2000,
    get_cookies: 5000,
};
const HEARTBEAT_INTERVAL_MS = 15000;

let httpServer: http.Server | null = null;
let wss: WebSocketServer | null = null;
let extensionSocket: WebSocket | null = null;
let bridgeToken: string = "";
let authenticated = false;
let heartbeatTimer: NodeJS.Timeout | null = null;
let lastPong = 0;

// Pending requests waiting for extension responses.
// Bounded to protect against an extension that acks out of order, crashes
// mid-transaction, or silently drops responses — without a cap the map
// could grow unbounded with orphan entries until process memory was gone.
const MAX_PENDING_REQUESTS = 100;
const pendingRequests = new Map<
    string,
    {
        resolve: (data: unknown) => void;
        reject: (err: Error) => void;
        timeout: NodeJS.Timeout;
    }
>();

// Event handlers for unsolicited extension events
const eventHandlers: Array<(event: ChromeBridgeEvent) => void> = [];

// ── Token Management ─────────────────────────

function generateToken(): string {
    if (native) {
        return native.generateBridgeToken();
    }
    // JS fallback: 32 random bytes → hex
    return crypto.randomBytes(32).toString("hex");
}

function loadOrCreateToken(): string {
    try {
        // Ensure data/ directory exists
        const dataDir = path.dirname(TOKEN_FILE);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        if (fs.existsSync(TOKEN_FILE)) {
            const stored = fs.readFileSync(TOKEN_FILE, "utf-8").trim();
            if (stored.length >= 32) {
                // Sync the loaded token to the native Rust module so
                // validateBridgeToken() works correctly (prevents state divergence)
                if (native && native.setBridgeToken) {
                    native.setBridgeToken(stored);
                }
                return stored;
            }
        }
    } catch {
        /* generate new */
    }

    const token = generateToken();
    try {
        fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 }); // Owner-only permissions
    } catch (err) {
        console.warn("⚠️  Could not save bridge token to disk:", (err as Error).message);
    }
    return token;
}

function validateToken(token: string): boolean {
    if (native) {
        return native.validateBridgeToken(token);
    }
    // JS fallback: constant-time comparison
    if (token.length !== bridgeToken.length) return false;
    let diff = 0;
    for (let i = 0; i < token.length; i++) {
        diff |= token.charCodeAt(i) ^ bridgeToken.charCodeAt(i);
    }
    return diff === 0;
}

// F10: local-only token. Loaded (or created) at server boot. Lives outside
// the extension flow so we can keep the extension auth simple (browser-set
// Origin) without locking out local CLI tools that legitimately need to
// fetch the bridge token. Constant-time compare.
let localToken: string = "";

function loadOrCreateLocalToken(): string {
    try {
        const dir = path.dirname(LOCAL_TOKEN_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        if (fs.existsSync(LOCAL_TOKEN_FILE)) {
            const stored = fs.readFileSync(LOCAL_TOKEN_FILE, "utf-8").trim();
            if (stored.length >= 32) return stored;
        }
    } catch {
        /* generate new */
    }
    const tok = crypto.randomBytes(32).toString("hex");
    try {
        fs.writeFileSync(LOCAL_TOKEN_FILE, tok, { mode: 0o600 });
    } catch (err) {
        console.warn("⚠️  Could not save local bridge token:", (err as Error).message);
    }
    return tok;
}

function validateLocalToken(presented: string): boolean {
    if (typeof presented !== "string" || presented.length !== localToken.length) return false;
    let diff = 0;
    for (let i = 0; i < presented.length; i++) {
        diff |= presented.charCodeAt(i) ^ localToken.charCodeAt(i);
    }
    return diff === 0;
}

// ── Overlay channel info ─────────────────────
// The extension also drives the overlay chat socket (port 18792), which
// authenticates via ?localToken=. That token only ever reaches a client over
// loopback; surface it through the bridge's already-origin-gated /discover so
// the extension can open the overlay socket without being served overlay.html.
// Fail-open: if the overlay token can't be resolved, omit the field.
function getOverlayInfo(): { port: number; wsUrl: string; localToken: string } | undefined {
    try {
        const localToken = getOverlayLocalToken();
        if (!localToken) return undefined;
        return { port: 18792, wsUrl: "ws://127.0.0.1:18792", localToken };
    } catch {
        return undefined;
    }
}

// ── Discovery File ───────────────────────────

function writeDiscoveryFile(port: number): void {
    try {
        const dir = path.dirname(DISCOVERY_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const discovery = {
            port,
            token: bridgeToken,
            wsUrl: `ws://127.0.0.1:${port}`,
            httpUrl: `http://127.0.0.1:${port}`,
            pid: process.pid,
            startedAt: new Date().toISOString(),
            overlay: getOverlayInfo(),
        };
        fs.writeFileSync(DISCOVERY_FILE, JSON.stringify(discovery, null, 2), { mode: 0o600 });
    } catch (err) {
        console.warn("⚠️  Could not write discovery file:", (err as Error).message);
    }
    removeLegacyDiscoveryFile();
}

// The pre-rename ~/.atlas/chrome-bridge.json is stale once the bridge writes under ~/.bhai. Delete it
// only when it holds this bridge's token: the separate ATLAS app writes the same file.
// ponytail: drop one release after the rename.
export function removeLegacyDiscoveryFile(legacy = path.join(homedir(), ".atlas", "chrome-bridge.json")): void {
    if (path.resolve(legacy) === path.resolve(DISCOVERY_FILE)) return;
    try {
        if (bridgeToken && JSON.parse(fs.readFileSync(legacy, "utf-8")).token === bridgeToken) fs.unlinkSync(legacy);
    } catch {
        /* absent, unreadable or not ours: leave it */
    }
}

function removeDiscoveryFile(): void {
    try {
        if (fs.existsSync(DISCOVERY_FILE)) {
            fs.unlinkSync(DISCOVERY_FILE);
        }
    } catch {
        /* non-fatal */
    }
}

// ── Register Native Messaging Host ───────────

// Once Bhai's extension has fetched its token over native messaging (scoped to this OS user)
// and connected with it, /discover stops handing tokens to any local caller that asks.
// Delete this file to go back to HTTP discovery.
const NATIVE_OK_FILE = path.join(getBhaiHome(), "bridge-native-ok");
let nativeHostRegistered = false;
export const discoverServesTokens = (): boolean => !(nativeHostRegistered && fs.existsSync(NATIVE_OK_FILE));

/**
 * The /bin/sh launcher Chrome runs as the native host. Chrome can start it while Bhai is
 * being reinstalled: running the half-copied app then dies in dyld/Electron startup
 * ("Library missing"), leaving a crash report and a "Bhai quit unexpectedly" alert. So
 * it checks the runtime is all there first and otherwise exits quietly (the extension
 * retries discovery a few seconds later).
 */
export function nativeHostLauncher(execPath: string, hostScript: string): string {
    const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    const fw = execPath.includes(".app/Contents/MacOS/")
        ? path.join(path.dirname(path.dirname(execPath)), "Frameworks", "Electron Framework.framework")
        : null;
    const ready = [`[ -x ${q(execPath)} ]`, `[ -r ${q(hostScript)} ]`];
    if (fw)
        ready.push(
            `[ -e ${q(path.join(fw, "Electron Framework"))} ]`,
            `[ -e ${q(path.join(fw, "Resources", "icudtl.dat"))} ]`,
        );
    return `#!/bin/sh\n${ready.join(" && ")} || exit 1\nELECTRON_RUN_AS_NODE=1 exec ${q(execPath)} ${q(hostScript)}\n`;
}

const HOST_NAME = "com.bhai.bridge";
// Extensions from before the rename still ask for com.atlas.bridge: register it too, same host.
// ponytail: drop LEGACY_HOST_NAME one release after the rename.
const LEGACY_HOST_NAME = "com.atlas.bridge";

/**
 * Whether the old-name manifest at `file` may be (over)written: only when there is none or it
 * is Bhai's own (allows one of Bhai's extension IDs). The separate ATLAS app registers that name.
 */
export function mayWriteLegacyManifest(file: string, ids: Iterable<string>): boolean {
    try {
        const origins: unknown = JSON.parse(fs.readFileSync(file, "utf-8")).allowed_origins;
        return Array.isArray(origins) && [...ids].some((id) => origins.includes(`chrome-extension://${id}/`));
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "ENOENT";
    }
}

async function registerNativeMessagingHost(_port: number): Promise<void> {
    try {
        // Write the native host script next to the discovery file
        const hostScriptPath = path.join(getBhaiHome(), "bhai-bridge-host.js");
        const hostScript = `#!/usr/bin/env node
// Bhai Browser Bridge — Native Messaging Host
// Reads the discovery file and returns config to the Chrome extension.
const fs = require("fs");

function readMessage() {
    return new Promise((resolve) => {
        let data = Buffer.alloc(0);
        process.stdin.on("data", (chunk) => {
            data = Buffer.concat([data, chunk]);
            if (data.length >= 4) {
                const len = data.readUInt32LE(0);
                if (data.length >= 4 + len) {
                    resolve(JSON.parse(data.slice(4, 4 + len).toString()));
                }
            }
        });
    });
}

function sendMessage(msg) {
    const json = JSON.stringify(msg);
    const len = Buffer.byteLength(json);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(len, 0);
    process.stdout.write(header);
    process.stdout.write(json);
}

(async () => {
    await readMessage();
    try {
        const discoveryPath = ${JSON.stringify(DISCOVERY_FILE)};
        const config = JSON.parse(fs.readFileSync(discoveryPath, "utf-8"));
        sendMessage({ success: true, ...config });
    } catch (err) {
        sendMessage({ success: false, error: err.message });
    }
    process.exit(0);
})();
`;
        fs.writeFileSync(hostScriptPath, hostScript, { mode: 0o755 });

        // Chrome starts a native host with a minimal PATH (no node there, and a packaged
        // install may have none at all): a launcher runs the host with Bhai's own runtime.
        const ids = bhaiExtensionIds();
        if (!ids) return; // Chrome rejects wildcard origins, so without Bhai's ID there's nothing to register
        let hostPath = hostScriptPath;
        if (process.platform !== "win32") {
            hostPath = path.join(getBhaiHome(), "bhai-bridge-host");
            fs.writeFileSync(hostPath, nativeHostLauncher(process.execPath, hostScriptPath), { mode: 0o755 });
        }

        // Write the native messaging host manifest
        const manifest = {
            name: HOST_NAME,
            description: "Bhai Browser Bridge — auto-discovery for Chrome extension",
            path: hostPath,
            type: "stdio",
            allowed_origins: [...ids].map((id) => `chrome-extension://${id}/`),
        };

        // macOS: ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
        // Linux: ~/.config/google-chrome/NativeMessagingHosts/
        // Windows: HKCU registry keys for Chrome, Edge, and Chromium
        const platform = process.platform;

        if (platform === "win32") {
            // Windows: register via registry
            const bhaiDir = getBhaiHome();
            if (!fs.existsSync(bhaiDir)) fs.mkdirSync(bhaiDir, { recursive: true });

            try {
                // winreg2 is ESM with named exports — there is no default export
                // (the old `winreg` package had one). It also exposes Promise
                // methods without the `Async` suffix (create/set, not
                // createAsync/setAsync) and separate Hive/RegType enums rather
                // than statics on the class.
                const { Registry, Hive, RegType } = await import("winreg2");
                for (const name of [HOST_NAME, LEGACY_HOST_NAME]) {
                    const manifestPath = path.join(bhaiDir, `${name}.json`);
                    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, name }, null, 2));
                    for (const browser of ["Google\\Chrome", "Microsoft\\Edge", "Chromium"]) {
                        const key = new Registry({
                            hive: Hive.HKCU,
                            key: `\\SOFTWARE\\${browser}\\NativeMessagingHosts\\${name}`,
                        });
                        if (name === LEGACY_HOST_NAME) {
                            const cur = await key.get("").then(
                                (item) => item.value,
                                () => "",
                            );
                            if (cur && cur !== manifestPath && !mayWriteLegacyManifest(cur, ids)) continue;
                        }
                        await key.create();
                        await key.set("", RegType.REG_SZ, manifestPath);
                    }
                }
                console.log("✓ Chrome/Edge/Chromium native messaging host registered (Windows registry)");
            } catch (err) {
                console.warn("⚠️  Windows registry write failed (non-fatal):", (err as Error).message);
            }
            return;
        }

        let manifestDir: string;
        if (platform === "darwin") {
            manifestDir = path.join(
                homedir(),
                "Library",
                "Application Support",
                "Google",
                "Chrome",
                "NativeMessagingHosts",
            );
        } else if (platform === "linux") {
            manifestDir = path.join(homedir(), ".config", "google-chrome", "NativeMessagingHosts");
        } else {
            // Unsupported platform — skip
            return;
        }

        if (!fs.existsSync(manifestDir)) {
            fs.mkdirSync(manifestDir, { recursive: true });
        }

        for (const name of [HOST_NAME, LEGACY_HOST_NAME]) {
            const file = path.join(manifestDir, `${name}.json`);
            if (name === LEGACY_HOST_NAME && !mayWriteLegacyManifest(file, ids)) continue;
            fs.writeFileSync(file, JSON.stringify({ ...manifest, name }, null, 2));
        }
        nativeHostRegistered = true;
    } catch (err) {
        // Native messaging registration is non-fatal — HTTP discovery is the primary method
        console.warn("⚠️  Could not register native messaging host (non-fatal):", (err as Error).message);
    }
}

// ── Initialize ───────────────────────────────

export function initChromeBridge(port = BRIDGE_PORT): void {
    bridgeToken = loadOrCreateToken();
    // F10: load (or generate) the local-only auth token used by /discover-local.
    localToken = loadOrCreateLocalToken();

    // Create HTTP server that handles both discovery requests and WS upgrades.
    // This allows the extension to auto-discover the token via HTTP GET /discover
    // and then upgrade to WebSocket for ongoing communication.
    httpServer = http.createServer((req, res) => {
        // DNS-rebinding guard: /discover hands out the bridge AND overlay tokens.
        if (!isLoopbackHost(req.headers.host, port)) {
            res.writeHead(421, { "Content-Type": "text/plain" });
            res.end("Misdirected request");
            return;
        }
        // ── Discovery Endpoint ──
        // The extension fetches this on boot to get the token automatically.
        // CORS is intentionally NOT wildcarded — "localhost is safe" was wrong:
        // any webpage in the user's browser can fetch http://127.0.0.1:18800/discover
        // because CORS rules apply to JS not the OS, and ws:// connections are
        // not gated by CORS at all. To accept a request the caller must come
        // from a Chrome extension origin (`chrome-extension://...`) — which
        // is set by the browser, not by JS, and cannot be forged from a tab.
        if (req.method === "GET" && req.url === "/discover") {
            // Reject only requests that carry a WEB origin (http/https) — that's
            // the real threat: a malicious page in the user's browser fetching
            // the token. A chrome-extension:// origin is allowed. So is a request
            // with NO Origin header: when the extension SW fetches a URL that
            // exactly matches its host_permissions, Chrome treats it as a
            // privileged same-origin request and OMITS the Origin header — that
            // was the cause of the extension getting 403 here. (A local CLI can
            // also omit Origin, but it can already read ~/.bhai/chrome-bridge.json
            // directly as the same UID, so the gate never meaningfully stopped it;
            // the web-origin block is the protection that matters.)
            const origin = (req.headers.origin as string | undefined) || "";
            const isWebOrigin = origin.startsWith("http://") || origin.startsWith("https://");
            // ...and so does another extension: only Bhai's own may read the token. A browser
            // page load (top-level navigation sends no Origin) would show it as page text the
            // agent's own browser tools can read — e.g. a web page sending Bhai here.
            if (isWebOrigin || isForeignExtensionOrigin(origin) || isBrowserPageLoad(req.headers)) {
                res.writeHead(403, { "Content-Type": "application/json" });
                res.end(
                    JSON.stringify({
                        error: "Forbidden — web origins may not read the bridge token.",
                    }),
                );
                return;
            }
            // After the extension has connected over native messaging, tokens stay off HTTP:
            // a no-Origin GET can come from any local process, not only the extension.
            const discovery = discoverServesTokens()
                ? { port, token: bridgeToken, wsUrl: `ws://127.0.0.1:${port}`, pid: process.pid, overlay: getOverlayInfo() }
                : { port, wsUrl: `ws://127.0.0.1:${port}`, pid: process.pid, native: true };
            const discoverHeaders: Record<string, string> = {
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
                Vary: "Origin",
            };
            // Only emit CORS headers when an extension origin is present. A
            // privileged no-Origin fetch needs none (and ACAO must not be "").
            if (origin.startsWith("chrome-extension://")) {
                discoverHeaders["Access-Control-Allow-Origin"] = origin;
                discoverHeaders["Access-Control-Allow-Private-Network"] = "true";
            }
            res.writeHead(200, discoverHeaders);
            res.end(JSON.stringify(discovery));
            return;
        }

        // F10: local CLI / native auth path. Auth via file-backed Bearer
        // token at LOCAL_TOKEN_FILE (mode 0o600, generated at boot, only
        // readable by the OS user running Bhai). This replaces the
        // Sec-Fetch-Site=none escape hatch — only callers that can read
        // the file (i.e. the same UID) get a bridge token.
        if (req.method === "GET" && req.url === "/discover-local") {
            const authHeader = (req.headers.authorization as string | undefined) || "";
            const presented = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
            if (!presented || !validateLocalToken(presented)) {
                res.writeHead(401, { "Content-Type": "application/json" });
                res.end(
                    JSON.stringify({ error: "Unauthorized — provide local token in Authorization: Bearer header" }),
                );
                return;
            }
            res.writeHead(200, {
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
            });
            res.end(
                JSON.stringify({
                    port,
                    token: bridgeToken,
                    wsUrl: `ws://127.0.0.1:${port}`,
                    pid: process.pid,
                    overlay: getOverlayInfo(),
                }),
            );
            return;
        }

        // CORS preflight for /discover — only echo the requesting extension origin.
        if (req.method === "OPTIONS") {
            const origin = (req.headers.origin as string | undefined) || "";
            const isExtension = origin.startsWith("chrome-extension://") && !isForeignExtensionOrigin(origin);
            const allowOrigin = isExtension ? origin : "null";
            const headers: Record<string, string> = {
                "Access-Control-Allow-Origin": allowOrigin,
                "Access-Control-Allow-Methods": "GET",
                "Access-Control-Allow-Headers": "Content-Type,Authorization",
                Vary: "Origin",
            };
            // Private Network Access (Chrome 130+): a fetch from an extension to a
            // loopback address triggers a preflight carrying this request header.
            // The response MUST echo Access-Control-Allow-Private-Network or Chrome
            // silently blocks the request — which made /discover unreachable from
            // the extension service worker even though curl worked.
            if (isExtension && req.headers["access-control-request-private-network"] === "true") {
                headers["Access-Control-Allow-Private-Network"] = "true";
            }
            res.writeHead(204, headers);
            res.end();
            return;
        }

        // Health check
        if (req.method === "GET" && req.url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok", connected: isExtensionConnected() }));
            return;
        }

        // All other requests — 404
        res.writeHead(404);
        res.end("Not Found");
    });

    // Attach WS server to the HTTP server (share the same port)
    wss = new WebSocketServer({ noServer: true });

    httpServer.on("upgrade", (req, socket, head) => {
        // Only Bhai's extension (its chrome-extension:// origin) or a local CLI (no
        // Origin) may connect — never a web page or another extension.
        if (
            !isLoopbackHost(req.headers.host, port) ||
            isWebOrigin(req.headers.origin) ||
            isForeignExtensionOrigin(req.headers.origin)
        ) {
            socket.destroy();
            return;
        }
        wss!.handleUpgrade(req, socket, head, (ws) => {
            wss!.emit("connection", ws, req);
        });
    });

    wss.on("connection", (ws) => {
        // Only allow one extension connection at a time
        if (extensionSocket && extensionSocket.readyState === 1) {
            console.warn("🔌 Chrome bridge: rejecting second connection (only 1 extension allowed)");
            ws.close(4001, "Only one extension connection allowed");
            return;
        }

        console.log("🔌 Chrome extension connecting...");

        // Auth timeout — must authenticate within 5 seconds
        const authTimer = setTimeout(() => {
            if (!authenticated) {
                console.warn("🔌 Chrome bridge: auth timeout — disconnecting");
                ws.close(4002, "Authentication timeout");
            }
        }, AUTH_TIMEOUT_MS);

        ws.on("message", (data) => {
            try {
                const msg = JSON.parse(data.toString());
                handleExtensionMessage(ws, msg, authTimer);
            } catch (err) {
                console.warn("[Chrome Bridge] Failed to parse message:", (err as Error).message);
            }
        });

        ws.on("close", () => dropExtension(ws, "Extension disconnected"));

        ws.on("error", (err) => {
            console.warn("🔌 Chrome bridge error:", (err as Error).message);
            dropExtension(ws, "Extension connection error");
            try {
                ws.terminate();
            } catch {
                /* already dead */
            }
        });
    });

    wss.on("error", (err) => {
        console.error("🔌 Chrome bridge WS error:", (err as Error).message);
    });

    httpServer.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
            console.error(
                `🔌 [CHROME-BRIDGE] Port ${port} already in use — another Bhai instance is likely running. Chrome extension bridge disabled this run.`,
            );
        } else {
            console.error(`🔌 [CHROME-BRIDGE] HTTP server error: ${err.message}`);
        }
    });

    httpServer.listen(port, "127.0.0.1", () => {
        console.log(`🔌 Chrome Bridge server on http://127.0.0.1:${port} (WS + HTTP discovery)`);
        console.log(`   Extension auto-connects via GET /discover — no manual config needed`);
        // Write discovery file AFTER server is bound and listening (Windows safety)
        writeDiscoveryFile(port);
        // Register native messaging host (belt + suspenders for auto-discovery)
        registerNativeMessagingHost(port).catch((err) => {
            console.warn("⚠️  Native messaging host registration failed (non-fatal):", (err as Error).message);
        });
    });
}

// ── Extension updates ────────────────────────
// Chrome runs an unpacked extension from memory, so an update installed with Bhai
// (new files under a running Chrome) stays unused until it reloads. An extension
// older than the copy shipped beside Bhai is asked to reload itself, once per
// version per run (a copy that can't update, e.g. from the store, can't loop).

const reloadAsked = new Set<string>();

function shippedExtensionVersion(): string | null {
    const scripts = getScriptsDir(); // <repo>/scripts in dev, <Resources>/bot/scripts packaged
    for (const dir of [path.join(scripts, "..", "chrome-extension"), path.join(scripts, "..", "..", "chrome-extension")]) {
        try {
            const v = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).version;
            if (typeof v === "string") return v;
        } catch {
            /* not this one */
        }
    }
    return null;
}

/** True when dotted version `a` is newer than `b` ("1.0.10" > "1.0.9"). */
export function isNewerVersion(a: string, b: string): boolean {
    const x = a.split(".").map(Number);
    const y = b.split(".").map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] || 0) - (y[i] || 0);
        if (d) return d > 0;
    }
    return false;
}

function askOutdatedExtensionToReload(ws: WebSocket, running: unknown): void {
    const shipped = shippedExtensionVersion();
    if (!shipped) return;
    if (typeof running !== "string") {
        console.log(`🔌 Chrome extension is older than ${shipped}: reload it once in chrome://extensions to update it`);
        return;
    }
    if (!isNewerVersion(shipped, running) || reloadAsked.has(shipped)) return;
    reloadAsked.add(shipped);
    console.log(`🔌 Chrome extension ${running} → ${shipped}: asking it to reload`);
    ws.send(JSON.stringify({ type: "reload" }));
}

// ── Message Handler ──────────────────────────

function handleExtensionMessage(ws: WebSocket, msg: Record<string, unknown>, authTimer: NodeJS.Timeout): void {
    // Auth handshake — must be first message
    if (msg.type === "auth") {
        const token = msg.token as string;
        if (validateToken(token)) {
            authenticated = true;
            extensionSocket = ws;
            clearTimeout(authTimer);
            startHeartbeat(ws);
            ws.send(JSON.stringify({ type: "auth_ok" }));
            // Reset the browser backend so auto-mode picks up the extension
            resetBackend();
            notifyEvent({ type: "extension_connected", data: {} });
            console.log(`🔌 Chrome extension authenticated ✓${msg.native === true ? " (native messaging)" : ""}`);
            if (msg.native === true && !fs.existsSync(NATIVE_OK_FILE)) {
                try {
                    fs.writeFileSync(NATIVE_OK_FILE, new Date().toISOString(), { mode: 0o600 });
                    console.log("🔌 Bridge tokens now go out only over native messaging; /discover no longer serves them");
                } catch {
                    /* keep serving them */
                }
            }
            askOutdatedExtensionToReload(ws, msg.version);
        } else {
            ws.send(JSON.stringify({ type: "auth_failed", error: "Invalid token" }));
            ws.close(4003, "Invalid token");
        }
        return;
    }

    // All other messages require authentication
    if (!authenticated || ws !== extensionSocket) {
        ws.send(JSON.stringify({ type: "error", error: "Not authenticated" }));
        return;
    }

    // Heartbeat pong
    if (msg.type === "pong") {
        lastPong = Date.now();
        return;
    }

    // Response to a pending request
    if (msg.id && typeof msg.id === "string") {
        const pending = pendingRequests.get(msg.id);
        if (pending) {
            pendingRequests.delete(msg.id);
            clearTimeout(pending.timeout);

            if (msg.success === false) {
                if (native) native.recordBridgeError();
                pending.reject(new Error((msg.error as string) || "Extension command failed"));
            } else {
                pending.resolve(msg.data);
            }
            return;
        }
    }

    // Unsolicited event from extension
    if (msg.type === "event" && msg.event) {
        notifyEvent(msg.event as ChromeBridgeEvent);
    }
}

// ── Send Command to Extension ────────────────

// Commands the bridge itself failed (timed out, queue full, send failed), for
// diagnostics and the bridge loop test: callers often swallow these. Not counted:
// a page's own error (success:false) and a `tolerated` command (a page-ready
// probe, which expects to lose its document mid-navigation and tries again).
let failureCount = 0;
const recentFailures: { type: string; error: string }[] = [];
const bridgeFailed = (type: string, error: string, tolerated: boolean) => {
    if (tolerated) return;
    failureCount++;
    recentFailures.push({ type, error });
    if (recentFailures.length > 20) recentFailures.shift();
};
export const bridgeCommandFailures = () => ({ count: failureCount, recent: [...recentFailures] });

export async function sendBridgeCommand(
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs?: number,
    tolerated = false,
): Promise<unknown> {
    if (!extensionSocket || extensionSocket.readyState !== 1 || !authenticated) {
        throw new Error("Chrome extension not connected");
    }

    // Rate limit check (native or skip)
    // The rate limit (30/s per command type) is checked once, inside native.validateBridgeCommand
    // below; checking here too counted every command twice (an effective 15/s).

    const effectiveTimeout = timeoutMs || OPERATION_TIMEOUTS[type] || DEFAULT_COMMAND_TIMEOUT_MS;

    const id = crypto.randomUUID();
    const command: ChromeBridgeCommand = { id, type, payload };

    // Validate command via native module if available.
    if (native) {
        try {
            native.validateBridgeCommand(JSON.stringify(command));
        } catch (err) {
            throw new Error(`Invalid bridge command: ${(err as Error).message}`);
        }
    }

    return new Promise((resolve, reject) => {
        // Backpressure: if the extension has stalled and we have too many
        // orphan in-flight commands, refuse the new one rather than let
        // the map grow until process memory is exhausted. Include a
        // retry hint so callers don't tight-loop — the queue drains as
        // pending commands time out (see OPERATION_TIMEOUTS above;
        // most are 2-30 s).
        if (pendingRequests.size >= MAX_PENDING_REQUESTS) {
            if (native) native.recordBridgeError();
            bridgeFailed(type, "queue full", tolerated);
            reject(
                new Error(
                    `Chrome bridge pending-request queue full (${pendingRequests.size} / ${MAX_PENDING_REQUESTS}) — ` +
                        `extension is unresponsive or very busy. Retry after 5-10 seconds once pending commands ` +
                        `time out; if this persists, reconnect or restart the extension.`,
                ),
            );
            return;
        }

        const timeout = setTimeout(() => {
            pendingRequests.delete(id);
            if (native) native.recordBridgeError();
            bridgeFailed(type, `timed out after ${effectiveTimeout}ms`, tolerated);
            reject(new Error(`Chrome bridge command "${type}" timed out after ${effectiveTimeout}ms`));
        }, effectiveTimeout);

        pendingRequests.set(id, { resolve, reject, timeout });

        try {
            extensionSocket!.send(JSON.stringify(command));
        } catch (err) {
            pendingRequests.delete(id);
            clearTimeout(timeout);
            bridgeFailed(type, `send failed: ${(err as Error).message}`, tolerated);
            reject(new Error(`Failed to send command: ${(err as Error).message}`));
        }
    });
}

// ── Public API ───────────────────────────────

/**
 * Check if the Chrome extension is currently connected and authenticated.
 */
export function isExtensionConnected(): boolean {
    return authenticated && extensionSocket !== null && extensionSocket.readyState === 1;
}

/**
 * Wait up to `timeoutMs` for the Chrome extension to connect.
 * Returns true if connected within the timeout, false otherwise.
 */
export function waitForExtensionConnection(timeoutMs: number): Promise<boolean> {
    if (isExtensionConnected()) return Promise.resolve(true);
    return new Promise((resolve) => {
        const interval = 200;
        let elapsed = 0;
        const timer = setInterval(() => {
            elapsed += interval;
            if (isExtensionConnected()) {
                clearInterval(timer);
                resolve(true);
            } else if (elapsed >= timeoutMs) {
                clearInterval(timer);
                resolve(false);
            }
        }, interval);
    });
}

/**
 * Get a descriptive status string for the Chrome extension connection.
 * Useful for agent diagnostics when the extension isn't connected.
 */
export function getExtensionStatus(): string {
    if (isExtensionConnected()) return "connected";
    if (httpServer?.listening) return "waiting_for_extension";
    return "server_not_started";
}

/**
 * Get info about all tabs in the user's Chrome browser.
 */
export async function getExtensionTabs(): Promise<ChromeTabInfo[]> {
    const result = await sendBridgeCommand("get_all_tabs", {});
    return result as ChromeTabInfo[];
}

/**
 * Get the active tab info from the user's Chrome browser.
 */
export async function getActiveExtensionTab(): Promise<ChromeTabInfo | null> {
    const result = await sendBridgeCommand("get_active_tab", {});
    return result as ChromeTabInfo | null;
}

/**
 * The user's Chrome cookies that Chrome would send to this http(s) URL — one
 * site, scoped by Chrome's own public-suffix rules. Never the whole jar.
 */
export async function getExtensionCookies(url: string): Promise<unknown[]> {
    const result = await sendBridgeCommand("get_cookies", { url });
    return Array.isArray(result) ? result : [];
}

/**
 * Register a handler for unsolicited extension events.
 */
export function onExtensionEvent(handler: (event: ChromeBridgeEvent) => void): void {
    eventHandlers.push(handler);
}

/**
 * Get bridge statistics (uses native module if available).
 */
export function getBridgeStats(): Record<string, unknown> {
    if (native) {
        try {
            return JSON.parse(native.getBridgeStats());
        } catch {
            /* fallback below */
        }
    }
    return {
        authenticated,
        connected: isExtensionConnected(),
        pendingRequests: pendingRequests.size,
        hasToken: bridgeToken.length > 0,
    };
}

/**
 * Get the bridge token (for display to user).
 */
export function getBridgeToken(): string {
    return bridgeToken;
}

/**
 * Rotate the bridge token (forces extension to re-authenticate).
 */
export function rotateBridgeToken(): string {
    // Disconnect current extension
    const current = extensionSocket;
    if (current) {
        dropExtension(current, "Token rotated");
        current.close(4004, "Token rotated");
    }

    if (native) {
        bridgeToken = native.generateBridgeToken();
    } else {
        bridgeToken = crypto.randomBytes(32).toString("hex");
    }

    try {
        fs.writeFileSync(TOKEN_FILE, bridgeToken, { mode: 0o600 });
    } catch {
        /* non-fatal */
    }

    // Rewrite discovery file with new token
    writeDiscoveryFile(BRIDGE_PORT);

    console.log(`🔑 Bridge token rotated: ${bridgeToken.substring(0, 8)}...`);
    return bridgeToken;
}

/**
 * Close the Chrome bridge server.
 */
export function closeChromeBridge(): void {
    stopHeartbeat();
    clearPendingRequests("Bridge shutting down");

    if (extensionSocket) {
        try {
            extensionSocket.close(1000, "Server shutting down");
        } catch {
            /* */
        }
        extensionSocket = null;
    }

    if (wss) {
        wss.close();
        wss = null;
    }

    if (httpServer) {
        httpServer.close();
        httpServer = null;
    }

    // Remove discovery file so extension doesn't try to connect to a dead server
    removeDiscoveryFile();

    authenticated = false;
    console.log("🔌 Chrome bridge server closed");
}

// ── Internal Helpers ─────────────────────────

/**
 * The one teardown for the extension's socket (close, error, token rotation, silence):
 * pending calls fail now, the heartbeat stops, and the backend falls back to
 * Playwright. Error and rotation used to skip the last part, leaving calls on a dead
 * socket until their own timeouts.
 */
function dropExtension(ws: WebSocket, reason: string): void {
    if (ws !== extensionSocket) return;
    extensionSocket = null;
    authenticated = false;
    clearPendingRequests(reason);
    stopHeartbeat();
    resetBackend(); // auto mode falls back to Playwright
    notifyEvent({ type: "extension_disconnected", data: {} });
    console.log(`🔌 Chrome extension disconnected (${reason})`);
}

function startHeartbeat(ws: WebSocket): void {
    stopHeartbeat();
    lastPong = Date.now();
    heartbeatTimer = setInterval(() => {
        // A socket that stopped answering (laptop slept, extension worker killed) stays
        // "open" until the OS notices, minutes later: until then every call waits out its
        // timeout and the extension's reconnect is refused as a second connection.
        // No ping from here: the extension sends a pong every 20 s on its own (its MV3
        // keep-alive), and it still answers a ping if one comes.
        if (Date.now() - lastPong > HEARTBEAT_INTERVAL_MS * 2.5) {
            dropExtension(ws, "Extension stopped answering");
            ws.terminate();
        }
    }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

function clearPendingRequests(reason: string): void {
    for (const [id, pending] of pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(reason));
    }
    pendingRequests.clear();
}

function notifyEvent(event: ChromeBridgeEvent): void {
    for (const handler of eventHandlers) {
        try {
            handler(event);
        } catch {
            /* handler errors shouldn't crash the bridge */
        }
    }
}
