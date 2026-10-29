// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Idempotent sends: a retry (error recovery, a sub-agent re-run, a model loop)
// must never deliver the same message to the same person twice. executeTool
// claims a send's key before running it and keeps it only if the send worked.
// One ledger is shared by every turn, so a concurrent or follow-up turn can't
// repeat a send either. An autonomous run (a cron job) gets its own
// (withSendLedger): its retries are caught, but the next tick of a job texting
// every 5 minutes is an intentional repeat, not a duplicate.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";

type Result = Record<string, unknown>;
/** Tools that deliver something to someone, with the fields naming who and what. */
const SENDS: Record<string, { to: string[]; content: string[]; actions?: string[]; sent?: (r: Result) => boolean }> = {
    whatsapp_send: { to: ["to"], content: ["message", "file_path"] },
    whatsapp_sticker: { to: ["to"], content: ["image_path"] },
    email_send: { to: ["to", "cc", "bcc"], content: ["subject", "body"] },
    gmail: { to: ["account", "to", "message_id"], content: ["subject", "body"], actions: ["send", "reply"] },
    messages_tool: { to: ["to"], content: ["text"], actions: ["send"] },
    send_message_on_channel: { to: ["channel"], content: ["message", "file_path"] },
    social_post: {
        to: ["platform", "brand_id", "subreddit"],
        content: ["content_type", "caption", "media_path", "hashtags", "scheduled_at"],
    },
    cold_outreach: {
        to: ["channel", "brand_id", "target_description"],
        content: ["message_template"],
        // runOutreachCampaign reports failure (no credentials, no leads) and the
        // LinkedIn "pick an approach" question as a status, not an error.
        sent: (r) => r.status === "sent" && Number(r.sentCount) > 0,
    },
};
// Not here: send_file / send_screenshot deliver only to the owner's own chat.
export const SEND_TOOLS = Object.keys(SENDS);

export const RESEND_PARAM = {
    type: "boolean",
    description:
        "Only when the user explicitly asks to send the same thing again. Without it, an identical send to the same recipient within 10 minutes is refused as a duplicate.",
};

const WINDOW_MS = 10 * 60_000;
const MAX_ENTRIES = 500;
// at: when the send started. done: it went out (false while in flight, outcome unknown).
type Ledger = Map<string, { at: number; to: string; done: boolean }>;
const runLedger = new AsyncLocalStorage<Ledger>();
const shared: Ledger = new Map();
const currentLedger = (): Ledger => runLedger.getStore() ?? shared;

/** Run an autonomous agent run (a cron job) with its own send ledger. */
export function withSendLedger<T>(fn: () => T): T {
    return runLedger.run(new Map(), fn);
}

const text = (v: unknown): string =>
    Array.isArray(v) ? v.map(text).join(",") : v == null ? "" : String(v).toLowerCase().replace(/\s+/g, " ").trim();
// "+91 98765-43210" and "+919876543210", "a@x.com, b@x.com" and "b@x.com,a@x.com" are the same
// recipient. Separators are dropped only from phone numbers: john-doe@ and johndoe@ are two people.
const recipient = (v: unknown): string =>
    text(v)
        .split(/[,;]/)
        .map((s) => s.trim())
        .map((s) => (/^[+\d\s()-]+$/.test(s) ? s.replace(/[\s()-]/g, "") : s))
        .filter(Boolean)
        .sort()
        .join(",");

const FILE_FIELDS = new Set(["file_path", "image_path", "media_path"]);
/** A file by its bytes, not its path: a file rewritten at the same path is a new send. */
const fileFingerprint = (v: unknown): string => {
    if (Array.isArray(v)) return v.map(fileFingerprint).join(",");
    const p = String(v ?? "").trim();
    if (!p) return "";
    const abs = p.replace(/^~(?=\/|$)/, homedir());
    // ponytail: reads the whole file to hash it; stream it if multi-GB sends ever show up.
    try {
        return createHash("sha256").update(readFileSync(abs)).digest("hex");
    } catch {
        try {
            const st = statSync(abs);
            return `${text(p)}|${st.mtimeMs}|${st.size}`;
        } catch {
            return text(p);
        }
    }
};

export interface SendClaim {
    key: string;
    to: string;
    sent?: (r: Result) => boolean;
}

/** The send this call would make (who + a hash of what), or null when it isn't one. */
export function sendClaim(name: string, args: Record<string, unknown>): SendClaim | null {
    const spec = SENDS[name];
    if (!spec || (spec.actions && !spec.actions.includes(String(args.action ?? "")))) return null;
    const parts = spec.content.map((f) => (FILE_FIELDS.has(f) ? fileFingerprint(args[f]) : text(args[f])));
    const content = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
    return {
        key: `${name}|${String(args.action ?? "")}|${spec.to.map((f) => recipient(args[f])).join("|")}|${content}`,
        to:
            spec.to
                .map((f) => String(args[f] ?? "").trim())
                .filter(Boolean)
                .join(", ") || "the current chat",
        sent: spec.sent,
    };
}

/** The refusal (JSON) when this exact send went out, or is in flight, within the window and `resend` isn't set. */
export function duplicateSend(claim: SendClaim, resend: boolean, now = Date.now()): string | null {
    const prior = currentLedger().get(claim.key);
    if (resend || !prior || now - prior.at > WINDOW_MS) return null;
    const secs = Math.round((now - prior.at) / 1000);
    // A send still in flight (say, past executeTool's timeout) may yet fail: never claim it went out.
    return JSON.stringify({
        success: false,
        duplicate: true,
        error: prior.done
            ? `Already sent this exact message to ${prior.to} ${secs}s ago — not sending it twice.`
            : `This exact message to ${prior.to} is still being sent (started ${secs}s ago) — not sending it twice. Check whether it arrived before telling the user it was sent.`,
        next_step: "If the user explicitly asked to send it again, call again with resend: true.",
    });
}

/**
 * Record the send as it starts (so a parallel twin is refused too) and drop the record
 * if it fails: an error result or a throw. Settles on the handler itself, not on the
 * timeout race: a send still running after a timeout may yet go out.
 */
export function holdSend(claim: SendClaim, sending: Promise<string>, now = Date.now()): void {
    const ledger = currentLedger();
    for (const [k, e] of ledger) if (now - e.at > WINDOW_MS) ledger.delete(k);
    ledger.delete(claim.key);
    const entry = { at: now, to: claim.to, done: false };
    ledger.set(claim.key, entry);
    // ponytail: oldest-first eviction at 500 entries; 10 min of sends never gets near it.
    if (ledger.size > MAX_ENTRIES) ledger.delete(ledger.keys().next().value as string);
    // Only this send's own entry: a resend may have replaced it meanwhile.
    const release = () => ledger.get(claim.key) === entry && ledger.delete(claim.key);
    sending.then((r) => {
        try {
            const p = JSON.parse(r);
            const failed = p?.error || p?.success === false || p?.status === "error";
            if (failed || (p && claim.sent && !claim.sent(p))) return release();
        } catch {
            /* plain text: it went out */
        }
        entry.done = true;
    }, release);
}

/** Test hook. */
export function _resetSendLedger(): void {
    shared.clear();
}
