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
    /** What Bhai does, as the owner, if the owner says yes ("order Kunal an Amul Lassi on Zepto"). */
    action?: string;
    /** The notice reached the owner. */
    delivered?: boolean;
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

/** Resolves false when the notice couldn't be sent (not connected, rate limited). */
type Sender = (jid: string, text: string) => Promise<boolean | void>;
let _sender: Sender | null = null;

// Set once at startup from whatsapp.ts
export function registerOwnerRelaySender(fn: Sender): void {
    _sender = fn;
}

type RelayContact = {
    contactJid: string;
    contactName: string;
    ownerJid: string;
    ownerName?: string;
    relation?: string;
};
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

/**
 * One plain line that WhatsApp shows exactly as written: Bhai's sending rewrites markdown (bullets,
 * bold, links) and drops "snake_case: value" lines, and a swipe-reply quotes what was shown, so
 * the notice's request must survive that unchanged to be found again.
 */
export function plainLine(raw: string, max = 300): string {
    return raw
        .replace(/^\s*([-*•]|\d+\.)\s+/gm, "")
        .replace(/[*~`#]/g, "")
        .replace(/[_[\]<>]/g, " ")
        .replace(/\s*\n+\s*/g, "; ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max);
}

/**
 * The action as the owner will see it and Bhai will run it: one plain line. Anything the
 * notice's sending would change or hide (markup, brackets, tool-like "x: y" lines) means it
 * isn't run as written, so the request goes to the owner without an action to approve.
 */
export function safeAction(raw: unknown): string | undefined {
    if (typeof raw !== "string") return undefined;
    const one = raw.replace(/\s+/g, " ").trim().slice(0, 300);
    if (!one || /[[\]{}<>=`]|\b[a-z]+_[a-z_]+\s*:/.test(one)) return undefined;
    return one;
}

// ── Tool definition ──────────────────────────

export const askOwnerTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "ask_owner",
            description:
                "Reach the owner (the person you work for) from this chat: pass on a message, ask them something, " +
                "or ask their OK for something you'd do for this person. Use it whenever the person wants something " +
                "that is the owner's to decide or do (plans, favours, orders, money, anything on the owner's behalf, " +
                "using the owner's computer or accounts), when they leave a message for the owner, or when you can't " +
                "answer without the owner. Never say you passed something on without calling this. The owner answers " +
                "on WhatsApp and you pass the answer back; if `action` is set and the owner says yes, it gets done for real.\n",
            parameters: {
                type: "object",
                properties: {
                    question: {
                        type: "string",
                        description:
                            "What the owner sees, in plain words, as you'd tell them: the message, the question, or the request (who wants what, and any details given).",
                    },
                    contact_reply: {
                        type: "string",
                        description:
                            'What to tell this person right now, warmly, e.g. "Let me check with him, I\'ll get back to you!"',
                    },
                    action: {
                        type: "string",
                        description:
                            'Only for a request the owner can approve: exactly what to do if they say yes (e.g. "Order one Amul Lassi on Zepto for Kunal"). Leave out for messages and questions.',
                    },
                },
                required: ["question", "contact_reply"],
            },
        },
    },

    async handler(input) {
        const question = typeof input.question === "string" ? plainLine(input.question) : "";
        const contactReply =
            (input.contact_reply as string)?.trim() || "Let me check with him and get back to you shortly!";

        if (!question) return JSON.stringify({ error: "question is required" });

        const ctx = relayContact.getStore() ?? null;
        if (!ctx || !_sender) {
            return JSON.stringify({ error: "Relay not available in this context." });
        }
        const contactName = plainLine(ctx.contactName, 60) || "Someone";

        const action = safeAction(input.action);
        // Asked again (the same thing, same person) and the owner has it: no second notice.
        // If the first notice never went out, this one replaces it.
        const same = queries().find((q) => q.contactJid === ctx.contactJid && q.question === question);
        if (same?.delivered) return JSON.stringify({ success: true, already_asked: true, contact_reply: contactReply });
        if (same) resolveQuery(same.id);
        const id = `relay_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        queries().push({
            id,
            contactJid: ctx.contactJid,
            contactName: contactName,
            question,
            askedAt: Date.now(),
            ownerJid: ctx.ownerJid,
            ...(action ? { action } : {}),
        });
        saveQueries();

        // Build owner notification: who (and who they are to the owner), then what they want.
        const ownerPending = getPendingQueriesForOwner(ctx.ownerJid);
        const who =
            ctx.relation && ctx.relation.length <= 40
                ? `*${contactName}* (${plainLine(ctx.relation, 40)})`
                : `*${contactName}*`;
        let ownerMsg = action
            ? `🙋 ${who} asks:\n"${question}"\n\nIf you say yes, I'll: ${action}\nSwipe-reply *yes* or *no* (or anything you want me to tell them).`
            : `💬 ${who}:\n"${question}"\n\nSwipe-reply to answer them.`;
        if (ownerPending.length > 1) {
            ownerMsg +=
                `\n\n_${ownerPending.length} questions pending:_\n` +
                ownerPending.map((q, i) => `${i + 1}. [${q.contactName}] "${q.question}"`).join("\n");
            ownerMsg += `\n\nSwipe-reply on a question to answer it (or send \`reply to <name>: <answer>\`).`;
        }

        let delivered = false;
        try {
            delivered = (await _sender(ctx.ownerJid, ownerMsg)) !== false;
        } catch {
            delivered = false;
        }
        const filed = queries().find((q) => q.id === id);
        if (filed && delivered) {
            filed.delivered = true;
            saveQueries();
        }
        if (!delivered) {
            // Kept for later, but never claim it reached them.
            return JSON.stringify({
                success: false,
                queued: true,
                error: "Couldn't reach the owner right now. Tell the person plainly you couldn't pass it on yet; don't say you did.",
            });
        }

        return JSON.stringify({ success: true, contact_reply: contactReply });
    },
};
