// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Google API Integration (Multi-Account) ────
// OAuth2 authentication + Google Calendar + Gmail
// Supports multiple Google accounts simultaneously.

import { execFile } from "node:child_process";
import { existsSync, promises as fs, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { OAuth2Client } from "google-auth-library";
import type { calendar_v3 } from "googleapis";
import { getDataDir } from "../config/paths.js";
import { getTimezone } from "../location/index.js";
import { newOAuthState, oauthStateMatches } from "../security/oauth-state.js";
import type { ToolDefinition } from "./get-current-time.js";

const execFileAsync = promisify(execFile);

// googleapis costs ~0.6-1s to import; load it on the first Google call, not at boot.
let googleMod: typeof import("googleapis").google | undefined;
async function loadGoogle(): Promise<typeof import("googleapis").google> {
    googleMod ??= (await import("googleapis")).google;
    return googleMod;
}

// ═══════════════════════════════════════════════
// OAuth2 Account Manager
// ═══════════════════════════════════════════════

const BASE_DATA_DIR = process.env.ATLAS_DATA_DIR || join(process.cwd(), "data");
const DATA_DIR = join(BASE_DATA_DIR, "google-tokens");
const CREDENTIALS_PATH = join(BASE_DATA_DIR, "google-credentials.json");
const OAUTH_CALLBACK_PORT = 8844;
const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}`;
const SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/tasks",
];

interface GoogleAccount {
    email: string;
    tokenPath: string;
    client: OAuth2Client;
}

const accounts = new Map<string, GoogleAccount>();

function ensureDataDir(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadCredentials(): { client_id: string; client_secret: string; redirect_uris: string[] } | null {
    // Try writable data dir, bundled app dir, then user's Downloads
    const paths = [
        CREDENTIALS_PATH,
        // Fallback: bundled credentials in app resources (read-only but valid for reading)
        join(getDataDir(), "google-credentials.json"),
        // Windows uses USERPROFILE instead of HOME
        join(
            process.env.HOME || process.env.USERPROFILE || "",
            "Downloads",
            "client_secret_1066050169128-uuqbnjq9v4n0pfc0q8ienabmoj3cnbhb.apps.googleusercontent.com.json",
        ),
        join(process.env.HOME || process.env.USERPROFILE || "", "Downloads", "google-credentials.json"),
    ];

    for (const p of paths) {
        if (existsSync(p)) {
            try {
                const raw = JSON.parse(readFileSync(p, "utf-8"));
                const creds = raw.installed || raw.web;
                if (creds) {
                    // Copy to data dir for future use
                    if (p !== CREDENTIALS_PATH) {
                        ensureDataDir();
                        writeFileSync(CREDENTIALS_PATH, JSON.stringify(raw, null, 2));
                    }
                    return creds;
                }
            } catch {
                /* invalid file */
            }
        }
    }
    return null;
}

function createOAuth2Client(): OAuth2Client | null {
    const creds = loadCredentials();
    if (!creds) return null;
    // Always use our callback server port for seamless OAuth
    const client = new OAuth2Client(creds.client_id, creds.client_secret, OAUTH_REDIRECT_URI);

    // Auto-refresh tokens and persist to disk
    client.on("tokens", (tokens) => {
        // When a refresh happens, merge new tokens with existing and save
        const existing = client.credentials;
        const merged = { ...existing, ...tokens };
        client.setCredentials(merged);
        // Persist — find the matching account and save
        for (const [, acc] of accounts) {
            if (acc.client === client) {
                try {
                    writeFileSync(acc.tokenPath, JSON.stringify(merged, null, 2));
                } catch {
                    /* */
                }
                break;
            }
        }
    });

    return client;
}

/**
 * Load all previously authenticated accounts from disk.
 */

/**
 * One header value: a line break in to/subject (model-written, or quoted from a page or
 * an email) started a new header — "x\r\nBcc: someone@else" added a recipient nobody saw.
 * Non-ASCII text (a Hindi subject) is RFC 2047-encoded so it arrives readable.
 */
export function header(value: string, encode = false): string {
    const v = String(value ?? "").replace(/[\r\n]+/g, " ").trim();
    return encode && /[^\x20-\x7e]/.test(v) ? `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=` : v;
}
export function loadSavedAccounts(): void {
    ensureDataDir();
    try {
        const files = readdirSync(DATA_DIR);
        for (const file of files) {
            if (!file.endsWith(".json") || file === "google-credentials.json") continue;
            try {
                const tokenPath = join(DATA_DIR, file);
                const tokens = JSON.parse(readFileSync(tokenPath, "utf-8"));
                const email = file.replace(".json", "").replace(/_/g, ".");
                const client = createOAuth2Client();
                if (!client) continue;
                client.setCredentials(tokens);
                accounts.set(email, { email, tokenPath, client });
                console.log(`📧 Google account loaded: ${email}`);
            } catch {
                /* skip invalid token files */
            }
        }
    } catch {
        /* no saved accounts */
    }
}

/**
 * Get all connected account emails.
 */
export function getConnectedAccounts(): string[] {
    return Array.from(accounts.keys());
}

// ═══════════════════════════════════════════════
// OAuth Callback Server
// ═══════════════════════════════════════════════

let activeCallbackServer: Server | null = null;

/**
 * Start a temporary local HTTP server to capture the OAuth callback automatically.
 * Returns a promise that resolves with the auth result.
 */
const escapeHtml = (s: string) =>
    s.replace(
        /[&<>"']/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
    );

/**
 * Catches Google's redirect on 127.0.0.1 only. A request without this flow's
 * `state` (another site, a LAN host) is ignored, not taken as the answer:
 * otherwise anyone could abort the sign-in or slip in their own account's code.
 */
function startOAuthCallbackServer(
    expectedState: string,
): Promise<{ success: boolean; email?: string; error?: string }> {
    // Kill any existing server
    if (activeCallbackServer) {
        try {
            activeCallbackServer.close();
        } catch {
            /* */
        }
        activeCallbackServer = null;
    }

    return new Promise((resolve) => {
        const timeout = setTimeout(
            () => {
                cleanup();
                resolve({ success: false, error: "OAuth timed out after 5 minutes." });
            },
            5 * 60 * 1000,
        );

        const cleanup = () => {
            clearTimeout(timeout);
            if (activeCallbackServer) {
                activeCallbackServer.close();
                activeCallbackServer = null;
            }
        };

        const successHTML = (email: string) => `
            <html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0">
            <div style="text-align:center">
                <h1 style="font-size:3em;margin-bottom:0.2em">✅</h1>
                <h2>Account Connected!</h2>
                <p style="font-size:1.2em;opacity:0.9">${escapeHtml(email)}</p>
                <p style="opacity:0.5;margin-top:2em">You can close this tab now.</p>
                <script>setTimeout(()=>window.close(),3000)</script>
            </div></body></html>`;

        const errorHTML = (msg: string) => `
            <html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0">
            <div style="text-align:center">
                <h1 style="font-size:3em;margin-bottom:0.2em">❌</h1>
                <h2>Connection Failed</h2>
                <p style="opacity:0.8">${escapeHtml(msg)}</p>
                <p style="opacity:0.5;margin-top:2em">You can close this tab.</p>
            </div></body></html>`;

        const server = createServer(async (req, res) => {
            const url = new URL(req.url || "/", `http://localhost:${OAUTH_CALLBACK_PORT}`);
            const code = url.searchParams.get("code");
            const error = url.searchParams.get("error");

            if ((code || error) && !oauthStateMatches(url.searchParams.get("state"), expectedState)) {
                res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
                res.end("This sign-in link doesn't match the one Bhai started.");
                return;
            }

            if (error) {
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end(errorHTML(error));
                cleanup();
                resolve({ success: false, error: `Google OAuth denied: ${error}` });
                return;
            }

            if (!code) {
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end(
                    `<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0"><div style="text-align:center"><h2>⏳ Waiting for authorization...</h2></div></body></html>`,
                );
                return;
            }

            // Got the code! Exchange it for tokens
            try {
                const result = await completeGoogleAuth(code);
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                if (result.success) {
                    res.end(successHTML(result.email || "Unknown"));
                } else {
                    res.end(errorHTML(result.error || "Unknown error"));
                }
                cleanup();
                resolve(result);
            } catch (err) {
                res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
                res.end(errorHTML((err as Error).message));
                cleanup();
                resolve({ success: false, error: (err as Error).message });
            }
        });

        server.listen(OAUTH_CALLBACK_PORT, "127.0.0.1", () => {
            console.log(`🔐 OAuth callback server listening on port ${OAUTH_CALLBACK_PORT}`);
        });

        server.on("error", (err) => {
            console.error(`🔐 OAuth callback server error:`, err.message);
            cleanup();
            resolve({ success: false, error: `Failed to start OAuth callback server: ${err.message}` });
        });

        activeCallbackServer = server;
    });
}

// ═══════════════════════════════════════════════
// Tool: Google Account Manager
// ═══════════════════════════════════════════════

export const googleAccounts: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "google_accounts",
            description:
                "Manage connected Google accounts. Add new accounts via OAuth, list connected accounts, or remove an account.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["add", "complete", "list", "remove"],
                        description:
                            "Action: 'add' = start OAuth flow, 'complete' = finish OAuth with auth code, 'list' = show accounts, 'remove' = disconnect account",
                    },
                    email: {
                        type: "string",
                        description: "Email of account to remove (for 'remove' action)",
                    },
                    code: {
                        type: "string",
                        description: "Authorization code from Google OAuth redirect (for 'complete' action)",
                    },
                },
                required: ["action"],
            },
        },
    },

    async handler(input) {
        const action = input.action as string;

        try {
            if (action === "list") {
                const emails = getConnectedAccounts();
                return JSON.stringify({
                    success: true,
                    count: emails.length,
                    accounts: emails,
                    note:
                        emails.length === 0
                            ? "No Google accounts connected. Use action='add' to connect one."
                            : undefined,
                });
            }

            if (action === "add") {
                const client = createOAuth2Client();
                if (!client) {
                    return JSON.stringify({
                        error: "Google OAuth credentials not found. Place client_secret JSON file in data/google-credentials.json",
                    });
                }

                const state = newOAuthState();
                const authUrl = client.generateAuthUrl({
                    access_type: "offline",
                    scope: SCOPES,
                    prompt: "consent",
                    state,
                });

                // Start callback server to auto-capture the code
                const authPromise = startOAuthCallbackServer(state);

                // Open browser for auth
                await execFileAsync("open", [authUrl], { timeout: 5000 }).catch(() => {});

                // Wait for the callback (up to 5 min)
                const result = await authPromise;

                if (result.success) {
                    return JSON.stringify({
                        success: true,
                        action: "account_connected",
                        email: result.email,
                        message: `✅ Google account ${result.email} connected successfully! You can now use Google Calendar and Gmail.`,
                    });
                }

                return JSON.stringify({
                    success: false,
                    action: "auth_failed",
                    error: result.error,
                    fallback: "If the automatic flow didn't work, use action='complete' with the code from the URL.",
                });
            }

            if (action === "remove") {
                const email = input.email as string;
                if (!email) return JSON.stringify({ error: "Provide 'email' of account to remove." });
                const account = accounts.get(email);
                if (!account) return JSON.stringify({ error: `Account not found: ${email}` });

                // Delete token file and remove from map
                await fs.unlink(account.tokenPath).catch(() => {});
                accounts.delete(email);
                return JSON.stringify({ success: true, removed: email });
            }

            if (action === "complete") {
                const code = input.code as string;
                if (!code) return JSON.stringify({ error: "Provide the 'code' from the Google OAuth redirect URL." });

                const result = await completeGoogleAuth(code);
                if (result.success) {
                    return JSON.stringify({
                        success: true,
                        email: result.email,
                        message: `✅ Google account ${result.email} connected successfully! You can now use google_calendar and gmail tools with this account.`,
                    });
                }
                return JSON.stringify({ error: result.error || "Failed to complete OAuth" });
            }

            return JSON.stringify({ error: `Unknown action: ${action}` });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

/**
 * Complete OAuth flow with authorization code.
 */
export async function completeGoogleAuth(code: string): Promise<{ success: boolean; email?: string; error?: string }> {
    try {
        const client = createOAuth2Client();
        if (!client) return { success: false, error: "No OAuth credentials" };

        console.log("🔐 Exchanging authorization code for tokens...");
        const { tokens } = await client.getToken(code);

        if (!tokens || !tokens.access_token) {
            console.error("🔐 Token exchange returned no access_token:", JSON.stringify(tokens));
            return { success: false, error: "Token exchange failed — no access token received" };
        }

        client.setCredentials(tokens);
        console.log("🔐 Tokens received successfully (access_token present)");

        // Try to get email from id_token JWT (no API call needed)
        let email = "unknown";
        if (tokens.id_token) {
            try {
                const payload = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64").toString("utf-8"));
                if (payload.email) email = payload.email;
                console.log(`🔐 Email from id_token: ${email}`);
            } catch {
                /* failed to decode JWT */
            }
        }

        // Fall back to userinfo API if id_token didn't have email
        if (email === "unknown") {
            try {
                const oauth2 = (await loadGoogle()).oauth2({ version: "v2", auth: client });
                const userInfo = await oauth2.userinfo.get();
                email = userInfo.data.email || "unknown";
                console.log(`🔐 Email from userinfo API: ${email}`);
            } catch (err) {
                console.warn(`🔐 userinfo API failed (non-critical): ${(err as Error).message}`);
            }
        }

        // Save token
        ensureDataDir();
        const tokenPath = join(DATA_DIR, `${email.replace(/\./g, "_")}.json`);
        writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));

        accounts.set(email, { email, tokenPath, client });
        console.log(`📧 Google account connected: ${email}`);

        return { success: true, email };
    } catch (err) {
        console.error(`🔐 completeGoogleAuth error:`, (err as Error).message);
        return { success: false, error: (err as Error).message };
    }
}

// ═══════════════════════════════════════════════
// Tool: Google Calendar
// ═══════════════════════════════════════════════

export const googleCalendarTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "google_calendar",
            description:
                "Interact with Google Calendar. List events, create events, check availability. Supports multiple accounts.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["today", "list", "create", "upcoming"],
                        description:
                            "Action: 'today' = today's events, 'list' = events for specific date (requires date param), 'create' = new event, 'upcoming' = next 5 events. Note: use 'list' not 'list_events'.",
                    },
                    account: {
                        type: "string",
                        description: "Gmail address to use. If omitted, checks ALL connected accounts.",
                    },
                    date: {
                        type: "string",
                        description: "Date in YYYY-MM-DD format (for 'list' action)",
                    },
                    title: { type: "string", description: "Event title (for 'create')" },
                    start_time: { type: "string", description: "Start time ISO format (for 'create')" },
                    end_time: { type: "string", description: "End time ISO format (for 'create')" },
                    description: { type: "string", description: "Event description (for 'create')" },
                    location: { type: "string", description: "Event location (for 'create')" },
                },
                required: ["action"],
            },
        },
    },

    async handler(input) {
        const action = input.action as string;
        const targetAccount = input.account as string | undefined;

        try {
            // For read actions, query all accounts or specific one
            const accountsToQuery = targetAccount
                ? ([accounts.get(targetAccount)].filter(Boolean) as GoogleAccount[])
                : Array.from(accounts.values());

            if (accountsToQuery.length === 0) {
                return JSON.stringify({
                    error: "No Google accounts connected. Use google_accounts action='add' first.",
                });
            }

            // Accept common LLM hallucinations as aliases
            const normalizedAction =
                action === "list_events"
                    ? "list"
                    : action === "get_events"
                      ? "list"
                      : action === "check"
                        ? "today"
                        : action;

            if (normalizedAction === "today" || normalizedAction === "list" || normalizedAction === "upcoming") {
                const action = normalizedAction; // shadow for rest of block
                let timeMin: string;
                let timeMax: string;

                if (action === "upcoming") {
                    timeMin = new Date().toISOString();
                    timeMax = new Date(Date.now() + 7 * 86400000).toISOString();
                } else {
                    const dateStr =
                        action === "today"
                            ? new Date().toLocaleDateString("en-CA", { timeZone: getTimezone() })
                            : (input.date as string) ||
                              new Date().toLocaleDateString("en-CA", { timeZone: getTimezone() });
                    const dayStart = new Date(`${dateStr}T00:00:00+05:30`);
                    const dayEnd = new Date(`${dateStr}T23:59:59+05:30`);
                    timeMin = dayStart.toISOString();
                    timeMax = dayEnd.toISOString();
                }

                const allEvents: Array<{
                    account: string;
                    title: string;
                    start: string;
                    end: string;
                    location: string;
                    description: string;
                }> = [];

                for (const acc of accountsToQuery) {
                    try {
                        const calendar = (await loadGoogle()).calendar({ version: "v3", auth: acc.client });
                        const res = await calendar.events.list({
                            calendarId: "primary",
                            timeMin,
                            timeMax,
                            maxResults: action === "upcoming" ? 5 : 50,
                            singleEvents: true,
                            orderBy: "startTime",
                        });

                        for (const ev of res.data.items || []) {
                            allEvents.push({
                                account: acc.email,
                                title: ev.summary || "(untitled)",
                                start: ev.start?.dateTime || ev.start?.date || "",
                                end: ev.end?.dateTime || ev.end?.date || "",
                                location: ev.location || "",
                                description: (ev.description || "").substring(0, 100),
                            });
                        }
                    } catch (err) {
                        allEvents.push({
                            account: acc.email,
                            title: `[Error: ${(err as Error).message}]`,
                            start: "",
                            end: "",
                            location: "",
                            description: "",
                        });
                    }
                }

                // Sort by start time
                allEvents.sort((a, b) => a.start.localeCompare(b.start));

                return JSON.stringify({
                    success: true,
                    action,
                    count: allEvents.length,
                    events: allEvents,
                });
            }

            if (action === "create") {
                const title = input.title as string;
                if (!title) return JSON.stringify({ error: "Provide 'title' for the event." });

                // Use specific account or first for creation
                const acc = targetAccount ? accounts.get(targetAccount) : accounts.values().next().value;
                if (!acc) return JSON.stringify({ error: "No account available for creating events." });

                const calendar = (await loadGoogle()).calendar({ version: "v3", auth: acc.client });

                const startTime = input.start_time as string;
                const endTime = input.end_time as string;
                if (!startTime) return JSON.stringify({ error: "Provide 'start_time' in ISO format." });

                const event: calendar_v3.Schema$Event = {
                    summary: title,
                    description: (input.description as string) || undefined,
                    location: (input.location as string) || undefined,
                    start: { dateTime: startTime, timeZone: getTimezone() },
                    end: {
                        dateTime: endTime || new Date(new Date(startTime).getTime() + 3600000).toISOString(),
                        timeZone: getTimezone(),
                    },
                };

                const created = await calendar.events.insert({
                    calendarId: "primary",
                    requestBody: event,
                });

                return JSON.stringify({
                    success: true,
                    action: "create",
                    account: acc.email,
                    event: {
                        id: created.data.id,
                        title: created.data.summary,
                        start: created.data.start?.dateTime,
                        end: created.data.end?.dateTime,
                        link: created.data.htmlLink,
                    },
                });
            }

            return JSON.stringify({ error: `Unknown action: ${action}` });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

export async function listCalendarEventsRaw(params: { timeMin: string; timeMax: string; maxResults?: number }): Promise<
    Array<{
        id: string;
        summary: string;
        start: { dateTime?: string; date?: string };
        end: { dateTime?: string; date?: string };
        location?: string;
        attendees?: Array<{ email?: string }>;
    }>
> {
    const accountsToQuery = Array.from(accounts.values());
    const allEvents: any[] = [];
    for (const acc of accountsToQuery) {
        try {
            const calendar = (await loadGoogle()).calendar({ version: "v3", auth: acc.client });
            const res = await calendar.events.list({
                calendarId: "primary",
                timeMin: params.timeMin,
                timeMax: params.timeMax,
                maxResults: params.maxResults ?? 25,
                singleEvents: true,
                orderBy: "startTime",
            });
            for (const ev of res.data.items ?? []) {
                allEvents.push({
                    id: ev.id ?? "",
                    summary: ev.summary ?? "(untitled)",
                    start: ev.start ?? {},
                    end: ev.end ?? {},
                    location: ev.location ?? undefined,
                    attendees: ev.attendees ?? undefined,
                });
            }
        } catch {
            // One account's failure doesn't block others.
        }
    }
    return allEvents;
}

// ═══════════════════════════════════════════════
// Tool: Gmail
// ═══════════════════════════════════════════════

export const gmailTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "gmail",
            description:
                "Interact with Gmail. List unread emails, read specific emails, search, send, and reply. Supports multiple accounts.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["unread", "read", "search", "send", "reply"],
                        description:
                            "Action: 'unread' = list unread, 'read' = read specific email, 'search' = search emails, 'send' = compose and send, 'reply' = reply to email",
                    },
                    account: {
                        type: "string",
                        description: "Gmail address to use. If omitted for read actions, checks ALL accounts.",
                    },
                    message_id: { type: "string", description: "Message ID (for 'read' and 'reply')" },
                    query: { type: "string", description: "Search query (for 'search')" },
                    to: { type: "string", description: "Recipient email (for 'send')" },
                    subject: { type: "string", description: "Email subject (for 'send')" },
                    body: { type: "string", description: "Email body text (for 'send' and 'reply')" },
                    max_results: { type: "number", description: "Max results to return (default 10)" },
                },
                required: ["action"],
            },
        },
    },

    async handler(input) {
        const action = input.action as string;
        const targetAccount = input.account as string | undefined;
        const maxResults = (input.max_results as number) || 10;

        try {
            const accountsToQuery = targetAccount
                ? ([accounts.get(targetAccount)].filter(Boolean) as GoogleAccount[])
                : Array.from(accounts.values());

            if (accountsToQuery.length === 0) {
                return JSON.stringify({
                    error: "No Google accounts connected. Use google_accounts action='add' first.",
                });
            }

            if (action === "unread") {
                const allMessages: Array<{
                    account: string;
                    id: string;
                    subject: string;
                    from: string;
                    date: string;
                    snippet: string;
                }> = [];

                for (const acc of accountsToQuery) {
                    try {
                        const gmail = (await loadGoogle()).gmail({ version: "v1", auth: acc.client });
                        const res = await gmail.users.messages.list({
                            userId: "me",
                            q: "is:unread",
                            maxResults,
                        });

                        for (const msg of res.data.messages || []) {
                            const detail = await gmail.users.messages.get({
                                userId: "me",
                                id: msg.id!,
                                format: "metadata",
                                metadataHeaders: ["Subject", "From", "Date"],
                            });

                            const headers = detail.data.payload?.headers || [];
                            allMessages.push({
                                account: acc.email,
                                id: msg.id!,
                                subject: headers.find((h) => h.name === "Subject")?.value || "(no subject)",
                                from: headers.find((h) => h.name === "From")?.value || "",
                                date: headers.find((h) => h.name === "Date")?.value || "",
                                snippet: detail.data.snippet || "",
                            });
                        }
                    } catch (err) {
                        allMessages.push({
                            account: acc.email,
                            id: "error",
                            subject: `[Error: ${(err as Error).message}]`,
                            from: "",
                            date: "",
                            snippet: "",
                        });
                    }
                }

                return JSON.stringify({
                    success: true,
                    action: "unread",
                    count: allMessages.length,
                    messages: allMessages,
                });
            }

            if (action === "read") {
                const messageId = input.message_id as string;
                if (!messageId) return JSON.stringify({ error: "Provide 'message_id'." });

                // Try each account to find the message
                for (const acc of accountsToQuery) {
                    try {
                        const gmail = (await loadGoogle()).gmail({ version: "v1", auth: acc.client });
                        const detail = await gmail.users.messages.get({
                            userId: "me",
                            id: messageId,
                            format: "full",
                        });

                        const headers = detail.data.payload?.headers || [];
                        let body = "";

                        // Extract body text
                        const payload = detail.data.payload;
                        if (payload?.body?.data) {
                            body = Buffer.from(payload.body.data, "base64").toString("utf-8");
                        } else if (payload?.parts) {
                            const textPart = payload.parts.find((p) => p.mimeType === "text/plain");
                            if (textPart?.body?.data) {
                                body = Buffer.from(textPart.body.data, "base64").toString("utf-8");
                            }
                        }

                        return JSON.stringify({
                            success: true,
                            action: "read",
                            account: acc.email,
                            subject: headers.find((h) => h.name === "Subject")?.value || "",
                            from: headers.find((h) => h.name === "From")?.value || "",
                            to: headers.find((h) => h.name === "To")?.value || "",
                            date: headers.find((h) => h.name === "Date")?.value || "",
                            body: body.substring(0, 3000), // Truncate for context window
                            labels: detail.data.labelIds,
                        });
                    } catch {
                        /* not found in this account */
                    }
                }

                return JSON.stringify({ error: `Message ${messageId} not found in any connected account.` });
            }

            if (action === "search") {
                const query = input.query as string;
                if (!query) return JSON.stringify({ error: "Provide 'query' for search." });

                const allResults: Array<{
                    account: string;
                    id: string;
                    subject: string;
                    from: string;
                    date: string;
                    snippet: string;
                }> = [];

                for (const acc of accountsToQuery) {
                    try {
                        const gmail = (await loadGoogle()).gmail({ version: "v1", auth: acc.client });
                        const res = await gmail.users.messages.list({
                            userId: "me",
                            q: query,
                            maxResults: Math.min(maxResults, 20),
                        });

                        for (const msg of res.data.messages?.slice(0, 5) || []) {
                            const detail = await gmail.users.messages.get({
                                userId: "me",
                                id: msg.id!,
                                format: "metadata",
                                metadataHeaders: ["Subject", "From", "Date"],
                            });

                            const headers = detail.data.payload?.headers || [];
                            allResults.push({
                                account: acc.email,
                                id: msg.id!,
                                subject: headers.find((h) => h.name === "Subject")?.value || "(no subject)",
                                from: headers.find((h) => h.name === "From")?.value || "",
                                date: headers.find((h) => h.name === "Date")?.value || "",
                                snippet: detail.data.snippet || "",
                            });
                        }
                    } catch (err) {
                        allResults.push({
                            account: acc.email,
                            id: "error",
                            subject: `[Error: ${(err as Error).message}]`,
                            from: "",
                            date: "",
                            snippet: "",
                        });
                    }
                }

                return JSON.stringify({
                    success: true,
                    action: "search",
                    query,
                    count: allResults.length,
                    results: allResults,
                });
            }

            if (action === "send") {
                const to = input.to as string;
                const subject = input.subject as string;
                const body = input.body as string;
                if (!to || !subject || !body) {
                    return JSON.stringify({ error: "Provide 'to', 'subject', and 'body'." });
                }

                const acc = targetAccount ? accounts.get(targetAccount) : accounts.values().next().value;
                if (!acc) return JSON.stringify({ error: "No account available for sending." });

                const gmail = (await loadGoogle()).gmail({ version: "v1", auth: acc.client });
                const raw = Buffer.from(
                    [
                        `From: ${acc.email}`,
                        `To: ${header(to)}`,
                        `Subject: ${header(subject, true)}`,
                        `Content-Type: text/plain; charset=utf-8`,
                        "",
                        body,
                    ].join("\r\n"),
                ).toString("base64url");

                await gmail.users.messages.send({
                    userId: "me",
                    requestBody: { raw },
                });

                return JSON.stringify({ success: true, action: "send", from: acc.email, to, subject });
            }

            if (action === "reply") {
                const messageId = input.message_id as string;
                const body = input.body as string;
                if (!messageId || !body) return JSON.stringify({ error: "Provide 'message_id' and 'body'." });

                // Find the account that has this message
                for (const acc of accountsToQuery) {
                    try {
                        const gmail = (await loadGoogle()).gmail({ version: "v1", auth: acc.client });
                        const original = await gmail.users.messages.get({
                            userId: "me",
                            id: messageId,
                            format: "metadata",
                            metadataHeaders: ["Subject", "From", "Message-ID"],
                        });

                        const headers = original.data.payload?.headers || [];
                        const from = headers.find((h) => h.name === "From")?.value || "";
                        const subject = headers.find((h) => h.name === "Subject")?.value || "";
                        const replyTo = from;
                        const reSubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
                        const msgIdHeader = headers.find((h) => h.name === "Message-ID")?.value || "";

                        const raw = Buffer.from(
                            [
                                `From: ${acc.email}`,
                                `To: ${header(replyTo)}`,
                                `Subject: ${header(reSubject, true)}`,
                                `In-Reply-To: ${header(msgIdHeader)}`,
                                `References: ${header(msgIdHeader)}`,
                                `Content-Type: text/plain; charset=utf-8`,
                                "",
                                body,
                            ].join("\r\n"),
                        ).toString("base64url");

                        await gmail.users.messages.send({
                            userId: "me",
                            requestBody: {
                                raw,
                                threadId: original.data.threadId || undefined,
                            },
                        });

                        return JSON.stringify({
                            success: true,
                            action: "reply",
                            account: acc.email,
                            to: replyTo,
                            subject: reSubject,
                        });
                    } catch {
                        /* not found in this account */
                    }
                }

                return JSON.stringify({ error: `Message ${messageId} not found in any connected account.` });
            }

            return JSON.stringify({ error: `Unknown action: ${action}` });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ═══════════════════════════════════════════════
// Raw export: Google Tasks
// ═══════════════════════════════════════════════

export async function listGoogleTasksRaw(params: { showCompleted?: boolean; dueMax?: string }): Promise<
    Array<{
        id: string;
        title: string;
        due?: string;
        status: "needsAction" | "completed";
    }>
> {
    const accountsToQuery = Array.from(accounts.values());
    const allTasks: any[] = [];
    for (const acc of accountsToQuery) {
        try {
            const tasks = (await loadGoogle()).tasks({ version: "v1", auth: acc.client });
            const res = await tasks.tasks.list({
                tasklist: "@default",
                showCompleted: params.showCompleted ?? false,
                dueMax: params.dueMax,
                maxResults: 100,
            });
            for (const t of res.data.items ?? []) {
                allTasks.push({
                    id: t.id ?? "",
                    title: t.title ?? "(untitled)",
                    due: t.due ?? undefined,
                    status: (t.status as "needsAction" | "completed") ?? "needsAction",
                });
            }
        } catch {
            // Graceful degradation: scope missing or API down → empty result for this account.
        }
    }
    return allTasks;
}

// ═══════════════════════════════════════════════
// Raw export: Gmail stale emails + engaged senders
// ═══════════════════════════════════════════════

export async function listStaleEmailsRaw(): Promise<
    Array<{
        id: string;
        from: string;
        subject: string;
        received_ms: number;
        is_important: boolean;
        thread_msg_count: number;
    }>
> {
    const accountsToQuery = Array.from(accounts.values());
    const all: any[] = [];
    for (const acc of accountsToQuery) {
        try {
            const gmail = (await loadGoogle()).gmail({ version: "v1", auth: acc.client });
            const listRes = await gmail.users.messages.list({
                userId: "me",
                q: "(is:unread OR is:important) older_than:3d -from:me",
                maxResults: 20,
            });
            const messages = listRes.data.messages ?? [];
            for (const m of messages) {
                if (!m.id) continue;
                const meta = await gmail.users.messages.get({
                    userId: "me",
                    id: m.id,
                    format: "metadata",
                    metadataHeaders: ["From", "Subject", "Date"],
                });
                const headers = meta.data.payload?.headers ?? [];
                const fromHdr = headers.find((h) => h.name?.toLowerCase() === "from")?.value ?? "";
                const subjHdr = headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "";
                const dateHdr = headers.find((h) => h.name?.toLowerCase() === "date")?.value ?? "";
                const labels = meta.data.labelIds ?? [];
                all.push({
                    id: m.id,
                    from: fromHdr,
                    subject: subjHdr,
                    received_ms: dateHdr ? Date.parse(dateHdr) : 0,
                    is_important: labels.includes("IMPORTANT"),
                    thread_msg_count: 1,
                });
            }
        } catch {
            // Graceful degradation
        }
    }
    return all;
}

export async function getEngagedSenders(): Promise<string[]> {
    const accountsToQuery = Array.from(accounts.values());
    const senders = new Set<string>();
    for (const acc of accountsToQuery) {
        try {
            const gmail = (await loadGoogle()).gmail({ version: "v1", auth: acc.client });
            const listRes = await gmail.users.messages.list({
                userId: "me",
                q: "from:me newer_than:30d",
                maxResults: 100,
            });
            const messages = listRes.data.messages ?? [];
            for (const m of messages.slice(0, 50)) {
                if (!m.id) continue;
                try {
                    const meta = await gmail.users.messages.get({
                        userId: "me",
                        id: m.id,
                        format: "metadata",
                        metadataHeaders: ["To"],
                    });
                    const to = meta.data.payload?.headers?.find((h) => h.name?.toLowerCase() === "to")?.value ?? "";
                    const emails = to.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [];
                    for (const e of emails) senders.add(e.toLowerCase());
                } catch {
                    // skip this message
                }
            }
        } catch {
            // skip this account
        }
    }
    return Array.from(senders);
}

// ═══════════════════════════════════════════════
// Initialize on boot
// ═══════════════════════════════════════════════

export function initGoogleAPI(): void {
    loadSavedAccounts();
    const count = accounts.size;
    if (count > 0) {
        console.log(`📧 Google: ${count} account(s) ready`);
    } else {
        console.log(`📧 Google: No accounts connected (use google_accounts tool to add)`);
    }
}
