// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Live Canvas ───────────────────────────────
// WebSocket server pushing interactive widgets to connected clients

import { WebSocketServer, type WebSocket } from "ws";

// ── Types ─────────────────────────────────────

interface CanvasWidget {
    id: string;
    type: "html" | "chart" | "table" | "form" | "markdown";
    content: string;
    created_at: string;
}

// ── State ─────────────────────────────────────

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();
const widgets: CanvasWidget[] = [];
let widgetCounter = 0;

// ── Initialize ────────────────────────────────

export function initCanvas(port = 18791): void {
    const server = new WebSocketServer({ port, host: "127.0.0.1" });

    server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
            console.warn(`🎨 Canvas port ${port} already in use — another ATLAS instance is running. Skipping canvas server.`);
        } else {
            console.warn(`🎨 Canvas server error:`, err.message);
        }
        try { server.close(); } catch { /* nothing to close */ }
        if (wss === server) wss = null;
    });

    wss = server;

    server.on("connection", (ws) => {
        clients.add(ws);
        console.log(`🎨 Canvas client connected (${clients.size} total)`);

        // Send existing widgets
        ws.send(JSON.stringify({ type: "init", widgets }));

        ws.on("close", () => {
            clients.delete(ws);
            console.log(`🎨 Canvas client disconnected (${clients.size} total)`);
        });

        ws.on("error", (err) => {
            console.warn(`🎨 Canvas client error:`, (err as Error).message);
            clients.delete(ws);
            try { ws.terminate(); } catch { /* already dead */ }
        });

        ws.on("message", (data) => {
            try {
                const msg = JSON.parse(data.toString());
                handleClientMessage(msg);
            } catch { /* ignore invalid messages */ }
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
