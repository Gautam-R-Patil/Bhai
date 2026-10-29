// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Pure helpers for Bhai's own email (bhaiMail.ts, bhaiMailNode.ts). No Convex
// functions here, so both runtimes can import it.

export const SEND_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
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
