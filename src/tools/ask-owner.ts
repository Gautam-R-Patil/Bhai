// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Ask-Owner relay tool ──────────────────────────────────────────────────────
// Allows a contact-facing agent to escalate questions to the owner when it
// cannot answer them directly (tool failure, personal preference needed, etc.).
//
// Which contact a run serves travels with that run (AsyncLocalStorage): contact messages
// from separate WhatsApp events run concurrently, and a module-level "current contact"
// let one contact's ask_owner be filed (and the owner's answer sent) under another's.

import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "../config/paths.js";
import type { ToolDefinition } from "./get-current-time.js";

export interface PendingOwnerQuery {
    id: string;
    contactJid: string;
    contactName: string;
    question: string;
    askedAt: number;
    ownerJid: string;
}

// ── State ─────────────────────────────────────

// On disk too: a question the owner hasn't answered yet must survive an app restart,
// or their answer finds nothing to go to.
const QUERIES_FILE = () => path.join(getDataDir(), "whatsapp-owner-questions.json");
let pendingQueries: PendingOwnerQuery[] | null = null;

function queries(): PendingOwnerQuery[] {
    if (!pendingQueries) {
        try {
            const saved = JSON.parse(fs.readFileSync(QUERIES_FILE(), "utf-8"));
            pendingQueries = Array.isArray(saved) ? saved : [];
        } catch {
            pendingQueries = [];
        }
    }
    return pendingQueries;
}

function saveQueries(): void {
    try {
        fs.mkdirSync(getDataDir(), { recursive: true });
        fs.writeFileSync(QUERIES_FILE(), JSON.stringify(queries(), null, 2), "utf-8");
    } catch (err) {
        console.warn("[ask-owner] Could not save pending questions:", (err as Error).message);
    }
}

type Sender = (jid: string, text: string) => Promise<void>;
let _sender: Sender | null = null;

// Set once at startup from whatsapp.ts
export function registerOwnerRelaySender(fn: Sender): void {
    _sender = fn;
}

type RelayContact = { contactJid: string; contactName: string; ownerJid: string };
const relayContact = new AsyncLocalStorage<RelayContact>();

/** Run `fn` (a contact's agent turn) with ask_owner knowing which contact it serves. */
export function withRelayContact<T>(ctx: RelayContact, fn: () => Promise<T>): Promise<T> {
    return relayContact.run(ctx, fn);
}

/** True inside a contact's agent turn (never the owner's). */
export function inContactRun(): boolean {
    return relayContact.getStore() !== undefined;
}

// ── Query management ─────────────────────────

export function getPendingQueriesForOwner(ownerJid: string): PendingOwnerQuery[] {
    return queries().filter((q) => q.ownerJid === ownerJid);
}

export function resolveQuery(id: string): PendingOwnerQuery | undefined {
    const idx = queries().findIndex((q) => q.id === id);
    if (idx === -1) return undefined;
    const [query] = queries().splice(idx, 1);
    saveQueries();
    return query;
}

export function resolveLatestQueryForOwner(ownerJid: string): PendingOwnerQuery | undefined {
    const ownerQueries = getPendingQueriesForOwner(ownerJid);
    if (ownerQueries.length === 0) return undefined;
    const latest = ownerQueries[ownerQueries.length - 1];
    return resolveQuery(latest.id);
}

export function resolveQueryByContactName(ownerJid: string, nameHint: string): PendingOwnerQuery | undefined {
    const lowerHint = nameHint.toLowerCase();
    const ownerQueries = getPendingQueriesForOwner(ownerJid);
    const match = ownerQueries.find((q) => q.contactName.toLowerCase().includes(lowerHint));
    if (!match) return undefined;
    return resolveQuery(match.id);
}

// ── Tool definition ──────────────────────────

export const askOwnerTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "ask_owner",
            description:
                "Relay a question to the owner when you cannot answer it yourself. Use when: " +
                "(1) a tool fails and you need the owner's input to answer the contact, " +
                "(2) you need to know the owner's personal availability/preferences, " +
                "(3) the contact's question requires the owner's direct confirmation. " +
                "The owner will be notified on WhatsApp. You MUST also provide a polite holding reply to send to the contact immediately.",
            parameters: {
                type: "object",
                properties: {
                    question: {
                        type: "string",
                        description:
                            "The question to relay to the owner, written as if you are asking the owner on the contact's behalf.",
                    },
                    contact_reply: {
                        type: "string",
                        description:
                            "What to tell the contact right now while waiting for the owner's reply. Should be friendly and set expectations (e.g. 'Let me check with him and get back to you!').",
                    },
                },
                required: ["question", "contact_reply"],
            },
        },
    },

    async handler(input) {
        const question = (input.question as string)?.trim();
        const contactReply =
            (input.contact_reply as string)?.trim() || "Let me check with him and get back to you shortly!";

        if (!question) return JSON.stringify({ error: "question is required" });

        const ctx = relayContact.getStore() ?? null;
        if (!ctx || !_sender) {
            return JSON.stringify({ error: "Relay not available in this context." });
        }

        const id = `relay_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        queries().push({
            id,
            contactJid: ctx.contactJid,
            contactName: ctx.contactName,
            question,
            askedAt: Date.now(),
            ownerJid: ctx.ownerJid,
        });
        saveQueries();

        // Build owner notification
        const ownerPending = getPendingQueriesForOwner(ctx.ownerJid);
        let ownerMsg = `❓ *${ctx.contactName}* wants to know:\n"${question}"`;
        if (ownerPending.length > 1) {
            ownerMsg +=
                `\n\n_${ownerPending.length} questions pending:_\n` +
                ownerPending.map((q, i) => `${i + 1}. [${q.contactName}] "${q.question}"`).join("\n");
            ownerMsg += `\n\nReply:\n• \`reply to <name>: <answer>\` — answer a specific contact\n• \`reply <answer>\` — answer the latest (${ctx.contactName})`;
        } else {
            ownerMsg += `\n\nReply with \`reply <answer>\` to respond to them.`;
        }

        try {
            await _sender(ctx.ownerJid, ownerMsg);
        } catch {
            // Non-fatal — query is still queued
        }

        return JSON.stringify({ success: true, contact_reply: contactReply });
    },
};
