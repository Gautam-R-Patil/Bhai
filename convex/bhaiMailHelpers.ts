// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Pure helpers for Bhai's own email (bhaiMail.ts, bhaiMailNode.ts). No Convex
// functions here, so both runtimes can import it.

export const DAY_MS = 24 * 60 * 60 * 1000;
// Bhai can email anyone, so the company domain is protected by caps instead.
export const SEND_RECIPIENTS_PER_DAY = 100;
export const MAX_RECIPIENTS_PER_EMAIL = 10;
// Mail from people other than the owner each costs an agent run.
export const OTHERS_INBOUND_PER_DAY = 200;
export const MAX_TEXT = 20_000;

export function mailDomain(): string {
    return (process.env.BHAI_MAIL_DOMAIN || "xagilab.com").toLowerCase();
}

export function isEmail(s: unknown): s is string {
    return typeof s === "string" && s.length <= 254 && /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i.test(s);
}

// "Dheeraj.S+x@gmail.com" → "dheerajs"
export function handleFromEmail(email: string): string {
    const local = email
        .split("@")[0]
        .split("+")[0]
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
    return (local || "me").slice(0, 20);
}

export function bhaiAddress(handle: string, n: number, domain: string): string {
    return `${handle}${n > 1 ? n : ""}.bhai@${domain}`;
}

// The .bhai suffix keeps users off real staff mailboxes on the same domain.
export function pickBhaiRecipient(addresses: string[], domain: string): string | null {
    const re = new RegExp(`^[a-z0-9]+\\.bhai@${domain.replace(/\./g, "\\.")}$`);
    for (const a of addresses) {
        const addr = a.trim().toLowerCase();
        if (re.test(addr)) return addr;
    }
    return null;
}

// Keep what the owner wrote, not the thread quoted under it.
export function stripQuoted(text: string): string {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const out: string[] = [];
    for (const line of lines) {
        if (/^On .{4,200}wrote:\s*$/.test(line.trim()) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())) break;
        if (line.startsWith(">")) continue;
        out.push(line);
    }
    return out.join("\n").trim().slice(0, MAX_TEXT);
}

// "a@x.com, B <b@y.com>" → ["a@x.com", "b@y.com"]; null if any part isn't an address.
export function parseRecipients(list: unknown): string[] | null {
    if (typeof list !== "string" || !list.trim()) return [];
    const out: string[] = [];
    for (const part of list.split(",")) {
        const m = /<([^>]+)>/.exec(part);
        const addr = (m ? m[1] : part).trim().toLowerCase();
        if (!isEmail(addr)) return null;
        if (!out.includes(addr)) out.push(addr);
    }
    return out;
}

// Newsletters, auto-replies, bounces and no-reply senders: Bhai never answers
// these (no mail loops, no replies to robots). headers are lower-cased names.
export function isAutomatedMail(from: string, headers: Record<string, string>): boolean {
    const auto = (headers["auto-submitted"] || "").toLowerCase();
    if (auto && auto !== "no") return true;
    if (/^(bulk|junk|list|auto_reply)$/i.test((headers.precedence || "").trim())) return true;
    if (headers["list-unsubscribe"] || headers["list-id"] || headers["x-autoreply"] || headers["x-autorespond"])
        return true;
    return /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?|notifications?)[@+.-]/i.test(from);
}

// Raw header block → { lower-case name: value } (folded lines joined).
export function parseHeaderBlock(raw: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of raw.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    return out;
}
