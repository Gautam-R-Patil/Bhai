// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Ask-Owner relay tool ──────────────────────────────────────────────────────
// Allows a contact-facing agent to escalate questions to the owner when it
// cannot answer them directly (tool failure, personal preference needed, etc.).
//
// Architecture note: JS is single-threaded and contact messages process
// sequentially (handleIncomingMessage uses `await` in a for-loop), so the
// module-level _currentContact is safe — it is always set/cleared atomically
// around a single runAgent call.

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

const pendingQueries: PendingOwnerQuery[] = [];

type Sender = (jid: string, text: string) => Promise<void>;
let _sender: Sender | null = null;

// Set once at startup from whatsapp.ts
export function registerOwnerRelaySender(fn: Sender): void {
    _sender = fn;
}

// Set/cleared around each handleContactMessage → runAgent call
let _currentContact: { contactJid: string; contactName: string; ownerJid: string } | null = null;

export function setRelayContactContext(
    ctx: { contactJid: string; contactName: string; ownerJid: string } | null,
): void {
    _currentContact = ctx;
}

// ── Query management ─────────────────────────

export function getPendingQueriesForOwner(ownerJid: string): PendingOwnerQuery[] {
    return pendingQueries.filter((q) => q.ownerJid === ownerJid);
}

export function resolveQuery(id: string): PendingOwnerQuery | undefined {
    const idx = pendingQueries.findIndex((q) => q.id === id);
    if (idx === -1) return undefined;
    return pendingQueries.splice(idx, 1)[0];
}

export function resolveLatestQueryForOwner(ownerJid: string): PendingOwnerQuery | undefined {
    const ownerQueries = pendingQueries.filter((q) => q.ownerJid === ownerJid);
    if (ownerQueries.length === 0) return undefined;
    const latest = ownerQueries[ownerQueries.length - 1];
    return resolveQuery(latest.id);
}

export function resolveQueryByContactName(ownerJid: string, nameHint: string): PendingOwnerQuery | undefined {
    const lowerHint = nameHint.toLowerCase();
    const ownerQueries = pendingQueries.filter((q) => q.ownerJid === ownerJid);
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

        const ctx = _currentContact;
        if (!ctx || !_sender) {
            return JSON.stringify({ error: "Relay not available in this context." });
        }

        const id = `relay_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        pendingQueries.push({
            id,
            contactJid: ctx.contactJid,
            contactName: ctx.contactName,
            question,
            askedAt: Date.now(),
            ownerJid: ctx.ownerJid,
        });

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
