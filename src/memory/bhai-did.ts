// © 2024-2026 TRUSCOR Private Limited. All rights reserved.

// ── What Bhai did for the owner ───────────────────────────────────
// One low-importance 'bhai_did' memory per owner turn whose real-world action went
// through (a send, a file to the owner, a calendar event), so "same as the 12 Oct
// one?" has an answer. Only names, subjects, titles and file names are kept, and
// only when playbooks' looksSensitive passes them: never message bodies, contacts
// or secrets.

import { basename, extname } from "node:path";
import { looksSensitive } from "./playbooks.js";

const safe = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const t = v.replace(/\s+/g, " ").trim();
    return t && t.length <= 60 && !t.includes("{{") && !looksSensitive(t) ? t : undefined;
};

/** "~/Desktop/Q3-deck.pdf" → `the file "Q3 deck"`: separators read as spaces, so "Q3-deck" isn't taken for a password. */
const fileLabel = (p: unknown, fallback: string): string => {
    if (typeof p !== "string" || !p.trim()) return fallback;
    const name = safe(basename(p.trim(), extname(p.trim())).replace(/[-_.]+/g, " "));
    return name ? `the file "${name}"` : fallback;
};

/** Who it went to: a plain name, or a name from the owner's message that the address holds (riya@… → Riya). */
const recipient = (to: unknown, ownerMessage: string): string => {
    const addr = String(to ?? "").toLowerCase();
    const name =
        safe(to) ??
        (addr ? ownerMessage.match(/\p{Lu}\p{L}{2,}/gu)?.find((n) => addr.includes(n.toLowerCase())) : undefined);
    return name ? ` to ${name}` : "";
};

/** One line for a tool call that worked, or undefined when it isn't an action worth keeping. */
export function didLine(fnName: string, args: Record<string, unknown>, ownerMessage: string): string | undefined {
    const action = String(args.action ?? "");
    const to = recipient(args.to, ownerMessage);
    switch (fnName) {
        case "whatsapp_send":
            return `sent ${fileLabel(args.file_path, "a message")}${to} via WhatsApp`;
        case "whatsapp_sticker":
            return `sent a sticker${to} via WhatsApp`;
        case "messages_tool":
            return action === "send" ? `sent a message${to} via Messages` : undefined;
        case "email_send":
        case "gmail": {
            if (fnName === "gmail" && action !== "send" && action !== "reply") return undefined;
            const subject = safe(args.subject);
            return `sent ${action === "reply" ? "a reply" : "an email"}${subject ? ` "${subject}"` : ""}${to} via ${fnName === "gmail" ? "Gmail" : "email"}`;
        }
        case "send_message_on_channel":
            return `sent the owner ${fileLabel(args.file_path, "a message")} on ${safe(args.channel) ?? "another channel"}`;
        case "send_file":
            return `sent the owner ${fileLabel(args.file_path, "a file")}`;
        case "social_post":
            return `posted ${safe(args.content_type) ?? "a post"} on ${safe(args.platform) ?? "social media"}`;
        case "cold_outreach":
            return `ran cold outreach on ${safe(args.channel) ?? "a channel"}`;
        case "calendar_tool":
        case "google_calendar": {
            if (action !== "create") return undefined;
            const title = safe(args.title);
            const when = /^\d{4}-\d\d-\d\d(?:[ T]\d\d:\d\d)?/
                .exec(String(args.start_time ?? ""))?.[0]
                .replace("T", " ");
            return `added ${title ? `"${title}"` : "an event"} to the owner's calendar${when ? ` for ${when}` : ""}`;
        }
        default:
            return undefined;
    }
}

export interface DidTurn {
    isOwner: boolean;
    autonomous: boolean;
    stuck: boolean;
    /** Touched the vault or had a screenshot withheld (verify gate's secretSeen). */
    secret: boolean;
    /** The turn's last screen action failed (verify gate's lastMutatorFailed). */
    failed: boolean;
}

/** The turn's dated 'bhai_did' memory, or null: nothing went out, or the turn isn't the owner's own, clean one. */
export function bhaiDidMemory(lines: string[], turn: DidTurn, now = new Date()): string | null {
    if (!turn.isOwner || turn.autonomous || turn.stuck || turn.secret || turn.failed) return null;
    const uniq = [...new Set(lines)];
    if (uniq.length === 0) return null;
    const day = now.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    const more = uniq.length > 3 ? ` (+${uniq.length - 3} more)` : "";
    return `On ${day} Bhai ${uniq.slice(0, 3).join("; ")}${more}`;
}
