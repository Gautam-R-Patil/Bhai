// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Live Canvas ───────────────────────────────
// WebSocket server pushing interactive widgets to connected clients

import { WebSocketServer, type WebSocket } from "ws";
import { timingSafeEqual } from "node:crypto";
import { getOverlayLocalToken } from "../overlay/overlay-chat.js";

// ── Types ─────────────────────────────────────

interface CanvasWidget {
    id: string;
    type: "html" | "chart" | "table" | "form" | "markdown";
    content: string;
    created_at: string;
}

// ── State ─────────────────────────────────────

const MAX_WIDGETS = 100;
const AUTH_TIMEOUT_MS = 5000;

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();
const widgets: CanvasWidget[] = [];
let widgetCounter = 0;

function safeEqualStr(a: string, b: string): boolean {
    if (typeof a !== "string" || typeof b !== "string") return false;
    if (a.length !== b.length) return false;
    try {
        const ba = Buffer.from(a, "utf-8");
        const bb = Buffer.from(b, "utf-8");
        if (ba.length !== bb.length) return false;
        return timingSafeEqual(ba, bb);
    } catch { return false; }
}

function tokenMatchesAny(t: string): boolean {
    if (!t) return false;
    if (safeEqualStr(t, getOverlayLocalToken())) return true;
    const w = process.env.WIDGET_TOKEN;
    if (w && w.length >= 32 && safeEqualStr(t, w)) return true;
    return false;
}

// ── Initialize ────────────────────────────────

export function initCanvas(port = 18791): void {
    const server = new WebSocketServer({ port, host: "127.0.0.1" });

    server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
            console.warn(`🎨 Canvas port ${port} already in use — another Bhai instance is running. Skipping canvas server.`);
        } else {
            console.warn(`🎨 Canvas server error:`, err.message);
        }
        try { server.close(); } catch { /* nothing to close */ }
        if (wss === server) wss = null;
    });

    wss = server;

    server.on("connection", (ws) => {
        // Unauthenticated until the client sends {type:"auth", token:"..."}.
        // Holds connection in a pre-auth state with a short timeout; existing
        // widgets are NOT sent until auth succeeds.
        let authed = false;
        const authTimer: NodeJS.Timeout = setTimeout(() => {
            if (!authed) {
                try { ws.close(4001, "auth timeout"); } catch { /* */ }
            }
        }, AUTH_TIMEOUT_MS);
        // Don't keep the event loop alive on this timer.
        (authTimer as unknown as { unref?: () => void }).unref?.();

        ws.on("close", () => {
            clearTimeout(authTimer);
            clients.delete(ws);
            if (authed) console.log(`🎨 Canvas client disconnected (${clients.size} total)`);
        });

        ws.on("error", (err) => {
            clearTimeout(authTimer);
            console.warn(`🎨 Canvas client error:`, (err as Error).message);
            clients.delete(ws);
            try { ws.terminate(); } catch { /* already dead */ }
        });

        ws.on("message", (data) => {
            let msg: Record<string, unknown>;
            try { msg = JSON.parse(data.toString()); } catch { return; }
            if (!authed) {
                if (msg.type === "auth" && typeof msg.token === "string" && tokenMatchesAny(msg.token)) {
                    authed = true;
                    clearTimeout(authTimer);
                    clients.add(ws);
                    console.log(`🎨 Canvas client connected (${clients.size} total)`);
                    try { ws.send(JSON.stringify({ type: "init", widgets })); } catch { /* */ }
                } else {
                    try { ws.close(4001, "unauthorized"); } catch { /* */ }
                }
                return;
            }
            handleClientMessage(msg);
        });
    });

    console.log(`🎨 Live Canvas server on ws://127.0.0.1:${port}`);
}

// ── Push Widget ───────────────────────────────

export function pushWidget(
    type: CanvasWidget["type"],
    content: string
): string {
    const id = `widget_${++widgetCounter}`;
    const widget: CanvasWidget = {
        id,
        type,
        content,
        created_at: new Date().toISOString(),
    };

    widgets.push(widget);
    // FIFO-cap the buffer so a long-lived server doesn't grow unbounded.
    while (widgets.length > MAX_WIDGETS) {
        const dropped = widgets.shift();
        if (dropped) broadcast({ type: "remove", id: dropped.id });
    }
    broadcast({ type: "widget", widget });
    return id;
}

// ── Update Widget ─────────────────────────────

export function updateWidget(id: string, content: string): boolean {
    const widget = widgets.find((w) => w.id === id);
    if (!widget) return false;

    widget.content = content;
    broadcast({ type: "update", widget });
    return true;
}

// ── Remove Widget ─────────────────────────────

export function removeWidget(id: string): boolean {
    const index = widgets.findIndex((w) => w.id === id);
    if (index === -1) return false;

    widgets.splice(index, 1);
    broadcast({ type: "remove", id });
    return true;
}

// ── Broadcast ─────────────────────────────────

function broadcast(data: unknown): void {
    const msg = JSON.stringify(data);
    for (const client of clients) {
        if (client.readyState === 1) {
            try {
                client.send(msg);
            } catch {
                clients.delete(client);
                try { client.terminate(); } catch { /* already dead */ }
            }
        }
    }
}

// ── Client Message Handler ────────────────────

function handleClientMessage(msg: Record<string, unknown>): void {
    if (msg.type === "form_submit") {
        console.log("🎨 Form submission:", msg.data);
        // Can be routed to the agent
    }
}

// ── Cleanup ───────────────────────────────────

export function closeCanvas(): void {
    if (wss) {
        wss.close();
        wss = null;
        clients.clear();
        console.log("🎨 Canvas server closed");
    }
}

// ── Get Connected Count ───────────────────────

export function getCanvasClientCount(): number {
    return clients.size;
}
