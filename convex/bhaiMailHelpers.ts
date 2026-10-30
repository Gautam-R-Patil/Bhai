// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
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
    const re = new RegExp(`^[a-z0-9]+\\.bhai@${domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
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
/** The first (topmost) value of a header: the one our receiving server added. */
export function firstHeader(raw: string, name: string): string | null {
    const unfolded = raw.replace(/\r?\n[ \t]+/g, " ");
    const m = new RegExp(`^${name}:\\s*(.+)$`, "im").exec(unfolded);
    return m ? m[1].trim() : null;
}

const domainOf = (addr: string | undefined): string =>
    ((/@([a-z0-9.-]+)/i.exec(addr ?? "") ?? /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i.exec((addr ?? "").trim()))?.[1] ?? "")
        .toLowerCase()
        .replace(/\.$/, "");

/**
 * Did the receiving server verify that this mail really comes from `fromAddress`'s domain?
 * Fail-closed: no Authentication-Results, any fail/softfail, or a pass for another domain
 * (what a spoofer gets for free) is "no". Same rule as src/email.ts isEmailAuthenticated:
 * the From header alone is anyone's to write, and it decided who got owner Bhai.
 */
export function senderAuthenticated(authResults: string | null, fromAddress: string): boolean {
    if (!authResults) return false;
    const fromDomain = domainOf(fromAddress);
    if (!fromDomain) return false;
    const aligned = (d: string) => !!d && (d === fromDomain || fromDomain.endsWith(`.${d}`) || d.endsWith(`.${fromDomain}`));
    let pass = false;
    for (const seg of authResults.split(";")) {
        const m = /\b(spf|dkim|dmarc)\s*=\s*(\w+)/i.exec(seg);
        if (!m) continue;
        const method = m[1].toLowerCase();
        const result = m[2].toLowerCase();
        if (result === "fail" || result === "softfail") return false;
        const prop = (n: string) => new RegExp(`\\b${n.replace(".", "\\.")}\\s*=\\s*([^\\s;]+)`, "i").exec(seg)?.[1];
        const domain = domainOf(
            method === "dkim"
                ? prop("header.d") || prop("header.i")
                : method === "spf"
                  ? prop("smtp.mailfrom") || prop("smtp.helo")
                  : prop("header.from"),
        );
        if (result === "pass" && aligned(domain)) pass = true;
    }
    return pass;
}

export function parseHeaderBlock(raw: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of raw.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    return out;
}
