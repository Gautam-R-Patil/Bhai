// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import express from "express";
import type { ToolDefinition } from "./get-current-time.js";

// ── Types ─────────────────────────────────────

interface WebhookEndpoint {
    id: string;
    path: string;
    description: string;
    created_at: string;
}

// ── State ─────────────────────────────────────

const endpoints = new Map<string, WebhookEndpoint>();
let server: ReturnType<typeof express.application.listen> | null = null;
let webhookCounter = 0;
let onWebhook: ((endpointId: string, payload: unknown) => Promise<void>) | null = null;

// ── Initialize ────────────────────────────────

export function initWebhookServer(port = 18790): void {
    const app = express();
    app.use(express.json());

    // Dynamic webhook handler
    app.all("/webhook/:id", async (req, res) => {
        const endpoint = endpoints.get(req.params.id);
        if (!endpoint) {
            res.status(404).json({ error: "Webhook not found" });
            return;
        }

        const payload = {
            method: req.method,
            headers: req.headers,
            body: req.body,
            query: req.query,
            timestamp: new Date().toISOString(),
        };

        console.log(`🔔 Webhook received: ${endpoint.path} (${endpoint.description})`);

        if (onWebhook) {
            await onWebhook(endpoint.id, payload);
        }

        res.json({ success: true, received: true });
    });

    // Health check
    app.get("/health", (_req, res) => res.json({ status: "ok", endpoints: endpoints.size }));

    // Listen on localhost only
    server = app.listen(port, "127.0.0.1", () => {
        console.log(`🔔 Webhook server listening on http://127.0.0.1:${port}`);
    }) as unknown as ReturnType<typeof express.application.listen>;
}

export function setWebhookHandler(handler: (endpointId: string, payload: unknown) => Promise<void>): void {
    onWebhook = handler;
}

// ── Register Webhook Tool ─────────────────────

export const registerWebhook: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "register_webhook",
            description: "Register a new webhook endpoint. Returns the URL to receive webhooks.",
            parameters: {
                type: "object",
                properties: {
                    description: { type: "string", description: "What this webhook is for" },
                },
                required: ["description"],
            },
        },
    },
    async handler(input) {
        const id = `wh_${++webhookCounter}`;
        const endpoint: WebhookEndpoint = {
            id,
            path: `/webhook/${id}`,
            description: input.description as string,
            created_at: new Date().toISOString(),
        };
        endpoints.set(id, endpoint);

        return JSON.stringify({
            success: true,
            id,
            url: `http://127.0.0.1:18790/webhook/${id}`,
            description: endpoint.description,
        });
    },
};

// ── List Webhooks Tool ────────────────────────

export const listWebhooks: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "list_webhooks",
            description: "List all registered webhook endpoints.",
            parameters: { type: "object", properties: {}, required: [] },
        },
    },
    async handler() {
        const list = Array.from(endpoints.values());
        return JSON.stringify({ webhooks: list, count: list.length });
    },
};

// ── Cleanup ───────────────────────────────────

export function stopWebhookServer(): void {
    if (server) {
        (server as unknown as { close: () => void }).close();
        server = null;
    }
}
