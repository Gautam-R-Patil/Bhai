// Copyright (c) 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Matrix/Element Bot Channel ──────────────────────────────
// Lightweight Matrix bot using the CS API directly via fetch.
// No matrix-bot-sdk dependency — just REST calls.
// Supports text messages only (no E2E encryption, no media).

import { withStuckReplyLine } from "./channel-text.js";
import type { LLMClient } from "./llm.js";
import { runAgent, type MediaAttachment, type ChannelContext } from "./agent.js";
import { smartChunkMessage } from "./alive-ux.js";

// ── Constants ────────────────────────────────────

const MATRIX_MSG_LIMIT = 40_000; // Matrix has a generous message limit
const SYNC_TIMEOUT_MS = 30_000;  // Long-poll timeout for /sync
const RETRY_DELAY_MS = 5_000;    // Delay before retrying after an error

// ── State ────────────────────────────────────────

let accessToken: string | null = null;
let homeserverUrl: string | null = null;
let botUserId: string | null = null;
let allowedRooms: Set<string> | null = null;
let syncToken: string | null = null;
let running = false;
let llmClient: LLMClient | null = null;

// Track processed events to avoid duplicates
const processedEvents = new Set<string>();
const MAX_PROCESSED_EVENTS = 5000;

// Track active rooms to avoid duplicate processing
const activeRooms = new Set<string>();

// Transaction counter for message sending
let txnCounter = 0;

// F3: OWNER_MATRIX_IDS strict subset of allowed senders.
function parseMatrixOwners(): Set<string> {
    const raw = process.env.OWNER_MATRIX_IDS;
    if (!raw) return new Set();
    return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
}

export function isPlatformOwner(channel: "matrix", userId: string): boolean {
    if (channel !== "matrix") return false;
    return parseMatrixOwners().has(userId);
}

// F7: per-sender inbound rate limit.
const MATRIX_RATE_WINDOW_MS = 60_000;
const MATRIX_RATE_MAX = 20;
const matrixRateBuckets = new Map<string, number[]>();
function matrixRateLimitAllow(sender: string): boolean {
    const now = Date.now();
    const arr = matrixRateBuckets.get(sender) || [];
    const fresh = arr.filter(ts => now - ts < MATRIX_RATE_WINDOW_MS);
    if (fresh.length >= MATRIX_RATE_MAX) {
        matrixRateBuckets.set(sender, fresh);
        return false;
    }
    fresh.push(now);
    matrixRateBuckets.set(sender, fresh);
    return true;
}

// ── Strip internal debug blocks before sending ──

function sanitizeReply(text: string): string {
    return text
        .replace(/<system_log>[\s\S]*?<\/system_log>/g, "")
        .replace(/<tool_log[\s\S]*?<\/tool_log>/g, "")
        .replace(/\[Tool Result [^\]]+\]:[\s\S]*?(?=\n\n|\n[A-Z]|$)/g, "")
        .replace(/\[SYSTEM NOTE:[^\]]*\]/g, "")
        .trim();
}

// ── Matrix CS API Helpers ────────────────────────

async function matrixFetch(
    endpoint: string,
    options: RequestInit = {},
): Promise<unknown> {
    const url = `${homeserverUrl}${endpoint}`;
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(options.headers as Record<string, string> || {}),
    };

    const response = await fetch(url, {
        ...options,
        headers,
        signal: options.signal ?? AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Matrix API ${response.status}: ${body.substring(0, 200)}`);
    }

    return response.json();
}

// ── Login ────────────────────────────────────────

async function login(userId: string, password: string): Promise<void> {
    const result = await matrixFetch("/_matrix/client/v3/login", {
        method: "POST",
        body: JSON.stringify({
            type: "m.login.password",
            identifier: {
                type: "m.id.user",
                user: userId,
            },
            password,
            initial_device_display_name: "Bhai Bot",
        }),
    }) as { access_token: string; user_id: string; device_id: string };

    accessToken = result.access_token;
    botUserId = result.user_id;
    console.log(`[MATRIX] Logged in as ${botUserId} (device: ${result.device_id})`);
}

// ── Send Message ─────────────────────────────────

async function sendMessage(roomId: string, text: string): Promise<void> {
    const txnId = `atlas_${Date.now()}_${++txnCounter}`;

    // Convert basic markdown to Matrix HTML (org.matrix.custom.html)
    const htmlBody = markdownToMatrixHtml(text);

    await matrixFetch(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
        {
            method: "PUT",
            body: JSON.stringify({
                msgtype: "m.text",
                body: text,
                format: "org.matrix.custom.html",
                formatted_body: htmlBody,
            }),
        },
    );
}

async function sendReply(roomId: string, text: string): Promise<void> {
    const chunks = smartChunkMessage(text, MATRIX_MSG_LIMIT);
    for (const chunk of chunks) {
        const clean = sanitizeReply(chunk);
        if (clean.length === 0) continue;
        await sendMessage(roomId, clean);
    }
}

// ── Set Typing Indicator ─────────────────────────

async function setTyping(roomId: string, typing: boolean): Promise<void> {
    if (!botUserId) return;
    try {
        await matrixFetch(
            `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(botUserId)}`,
            {
                method: "PUT",
                body: JSON.stringify({
                    typing,
                    timeout: typing ? 30_000 : undefined,
                }),
            },
        );
    } catch { /* typing indicator is non-critical */ }
}

// ── Markdown to Matrix HTML ──────────────────────

function markdownToMatrixHtml(text: string): string {
    let html = text;

    // Escape HTML special chars first
    html = html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    // Code blocks
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, "<pre><code>$2</code></pre>");

    // Inline code
    html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");

    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

    // Italic
    html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    // Line breaks
    html = html.replace(/\n/g, "<br/>");

    return html;
}

// ── Handle Incoming Message ──────────────────────

async function handleMessage(roomId: string, sender: string, body: string): Promise<void> {
    if (!llmClient) return;

    // Skip messages from the bot itself
    if (sender === botUserId) return;

    // Skip if room not allowlisted. Fail-CLOSED — without an explicit
    // MATRIX_ALLOWED_ROOMS env, no room is processed. The invite-acceptance
    // path was already hardened; a bot that was joined to a room before
    // the rollout (or via an admin server-join that bypasses invites) must
    // also be ignored here, otherwise any sender gets `isOwner: true`.
    if (!allowedRooms || allowedRooms.size === 0 || !allowedRooms.has(roomId)) {
        console.log(`[MATRIX] Ignoring message from non-allowlisted room ${roomId} (set MATRIX_ALLOWED_ROOMS to enable).`);
        return;
    }

    // F7: per-sender rate limit
    if (!matrixRateLimitAllow(sender)) {
        console.log(`[MATRIX] Rate limit hit for ${sender} — dropping`);
        return;
    }

    // Skip if already processing a message in this room
    if (activeRooms.has(roomId)) {
        console.log(`[MATRIX] Already processing a message in ${roomId}, queuing...`);
        return;
    }

    console.log(`\n[MATRIX] Message from ${sender} in ${roomId}: ${body.substring(0, 120)}`);

    activeRooms.add(roomId);
    try {
        await setTyping(roomId, true);

        const senderIsOwner = isPlatformOwner("matrix", sender);
        const result = await runAgent(llmClient, body, async (progress) => {
            // Send progress updates as typing indicators
            await setTyping(roomId, true);
        }, undefined, undefined, undefined, undefined, undefined, { channel: "matrix", userId: sender, userName: undefined, isOwner: senderIsOwner });

        await setTyping(roomId, false);

        if (result.text) {
            await sendReply(roomId, withStuckReplyLine(result, senderIsOwner));
        }

        console.log(`[MATRIX] Response sent (${result.text.length} chars, ${result.toolCalls} tool calls)`);
    } catch (err) {
        console.error(`[MATRIX] Error handling message:`, (err as Error).message);
        await setTyping(roomId, false);
        try {
            await sendMessage(roomId, "Sorry, I encountered an error processing your message. Please try again.");
        } catch { /* send error non-fatal */ }
    } finally {
        activeRooms.delete(roomId);
    }
}

// ── Sync Loop ────────────────────────────────────

async function syncLoop(): Promise<void> {
    while (running) {
        try {
            const params = new URLSearchParams({
                timeout: String(SYNC_TIMEOUT_MS),
                ...(syncToken ? { since: syncToken } : {}),
                // On first sync, filter to not get all history
                ...(!syncToken ? { filter: JSON.stringify({
                    room: {
                        timeline: { limit: 1 }, // Only latest message on first sync
                    },
                }) } : {}),
            });

            const result = await matrixFetch(
                `/_matrix/client/v3/sync?${params.toString()}`,
                { signal: AbortSignal.timeout(SYNC_TIMEOUT_MS + 10_000) },
            ) as {
                next_batch: string;
                rooms?: {
                    join?: Record<string, {
                        timeline?: {
                            events?: Array<{
                                event_id: string;
                                type: string;
                                sender: string;
                                content: {
                                    msgtype?: string;
                                    body?: string;
                                };
                                origin_server_ts: number;
                            }>;
                        };
                    }>;
                    invite?: Record<string, unknown>;
                };
            };

            const prevToken = syncToken;
            syncToken = result.next_batch;

            // Skip processing on the initial sync (just get the token)
            if (!prevToken) {
                console.log(`[MATRIX] Initial sync complete, listening for messages...`);
                continue;
            }

            // Process room events
            const joinedRooms = result.rooms?.join;
            if (!joinedRooms) continue;

            for (const [roomId, roomData] of Object.entries(joinedRooms)) {
                const events = roomData.timeline?.events || [];
                for (const event of events) {
                    // Skip already-processed events
                    if (processedEvents.has(event.event_id)) continue;

                    // Track event
                    processedEvents.add(event.event_id);
                    if (processedEvents.size > MAX_PROCESSED_EVENTS) {
                        // Trim oldest events (convert to array, remove first 1000)
                        const arr = [...processedEvents];
                        for (let i = 0; i < 1000; i++) processedEvents.delete(arr[i]);
                    }

                    // Only process text messages
                    if (event.type !== "m.room.message") continue;
                    if (event.content.msgtype !== "m.text") continue;
                    if (!event.content.body) continue;

                    // Skip messages from the bot
                    if (event.sender === botUserId) continue;

                    // Skip old messages (older than 60 seconds)
                    const age = Date.now() - event.origin_server_ts;
                    if (age > 60_000) continue;

                    // Handle the message (async, don't block the sync loop)
                    handleMessage(roomId, event.sender, event.content.body).catch(err =>
                        console.error(`[MATRIX] Message handler error:`, (err as Error).message)
                    );
                }
            }

            // Accept room invites — but ONLY for rooms explicitly allowlisted
            // via MATRIX_ALLOWED_ROOMS. Auto-joining any inviter's room let
            // attackers drop the bot into their own room and start running
            // the agent against arbitrary input.
            const invitedRooms = result.rooms?.invite;
            if (invitedRooms) {
                for (const roomId of Object.keys(invitedRooms)) {
                    if (!allowedRooms || allowedRooms.size === 0 || !allowedRooms.has(roomId)) {
                        console.log(`[MATRIX] Ignoring invite to non-allowlisted room ${roomId} (set MATRIX_ALLOWED_ROOMS to enable).`);
                        continue;
                    }
                    try {
                        await matrixFetch(
                            `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
                            { method: "POST", body: "{}" },
                        );
                        console.log(`[MATRIX] Auto-joined room ${roomId}`);
                    } catch (err) {
                        console.warn(`[MATRIX] Failed to join room ${roomId}:`, (err as Error).message);
                    }
                }
            }
        } catch (err) {
            if (!running) break;
            console.warn(`[MATRIX] Sync error (retrying in ${RETRY_DELAY_MS / 1000}s):`, (err as Error).message);
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }
    }
}

// ── Public API ───────────────────────────────────

/**
 * Initialize the Matrix bot channel.
 * Requires MATRIX_HOMESERVER, MATRIX_USER_ID, and MATRIX_PASSWORD env vars.
 * Optional: MATRIX_ALLOWED_ROOMS (comma-separated room IDs).
 */
export async function initMatrix(llm: LLMClient): Promise<void> {
    const server = process.env.MATRIX_HOMESERVER;
    const userId = process.env.MATRIX_USER_ID;
    const password = process.env.MATRIX_PASSWORD;

    if (!server || !userId || !password) {
        console.warn("[MATRIX] Missing MATRIX_HOMESERVER, MATRIX_USER_ID, or MATRIX_PASSWORD -- Matrix disabled");
        return;
    }

    // Normalize homeserver URL (remove trailing slash)
    homeserverUrl = server.replace(/\/$/, "");
    llmClient = llm;

    // Parse allowed rooms (optional)
    const roomsEnv = process.env.MATRIX_ALLOWED_ROOMS;
    if (roomsEnv) {
        allowedRooms = new Set(roomsEnv.split(",").map(r => r.trim()).filter(Boolean));
        console.log(`[MATRIX] Allowed rooms: ${allowedRooms.size}`);
    }

    try {
        await login(userId, password);
        running = true;

        // Start sync loop in background (non-blocking)
        syncLoop().catch(err => {
            console.error("[MATRIX] Sync loop crashed:", (err as Error).message);
            running = false;
        });

        console.log(`[MATRIX] Bot started, listening for messages...`);
    } catch (err) {
        console.error("[MATRIX] Login failed:", (err as Error).message);
    }
}

/**
 * Send a proactive message to all allowed rooms.
 * Used by heartbeat, notifications, and research completion.
 */
export async function sendMatrixProactiveMessage(message: string): Promise<void> {
    if (!accessToken || !homeserverUrl || !running) return;

    // If no allowed rooms configured, skip
    if (!allowedRooms || allowedRooms.size === 0) return;

    for (const roomId of allowedRooms) {
        try {
            await sendReply(roomId, message);
        } catch (err) {
            console.warn(`[MATRIX] Failed to send proactive message to ${roomId}:`, (err as Error).message);
        }
    }
}

/**
 * Gracefully close the Matrix bot.
 */
export function getMatrixStatus(): string {
    if (!accessToken) return "disabled";
    return running ? "connected" : "disconnected";
}

export function closeMatrix(): void {
    running = false;
    accessToken = null;
    console.log("[MATRIX] Bot stopped");
}
