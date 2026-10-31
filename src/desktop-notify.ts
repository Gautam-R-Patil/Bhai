// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
//
// Native notifications through the desktop app: the bot writes one
// "##BHAI_NOTIFY##{kind,title,body,tag?,actions?}" stdout line and the app shows
// it (desktop/notify-gate.js decides whether, by kind, Settings and focus).
// A notification with a tag replaces the app's earlier one with that tag;
// {close: tag} takes it away.

export type NotifyKind = "done" | "proactive" | "reminder" | "inbox" | "stuck" | "waiting" | "handoff";

/** A button: says `message` in chat as the owner, or sends `ws` (an inbox decision) on the chat socket. */
export type NotifyAction = {
    label: string;
    message?: string;
    ws?: { type: "inbox:approve" | "inbox:reject"; id: string };
};

/** A turn shorter than this needs no "done" notification: the owner is still looking. */
export const LONG_TURN_MS = 15_000;

/** A notification shows two or three lines of plain text: no markdown, links as their words. */
export function plainNotifyText(md: string, max = 200): string {
    const text = md
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/^\s*(#{1,6}|[-*+]|\d+\.|>)\s+/gm, "")
        .replace(/[*_`~]+/g, "")
        .replace(/\s+/g, " ")
        .trim();
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const desktopListening = (): boolean => process.env.BHAI_DESKTOP_NOTIFY === "1";

/** False when no desktop app is listening (standalone bot), so the caller can fall back. */
export function notifyDesktop(
    kind: NotifyKind,
    title: string,
    body: string,
    opts: { tag?: string; actions?: NotifyAction[] } = {},
): boolean {
    if (!desktopListening()) return false;
    const text = plainNotifyText(body);
    if (!text) return false;
    process.stdout.write(
        `##BHAI_NOTIFY##${JSON.stringify({ kind, title: title.slice(0, 80), body: text, ...opts })}\n`,
    );
    return true;
}

/** Takes away the app's notification with this tag (what it was about is settled). */
export function closeDesktopNotification(tag: string): void {
    if (desktopListening()) process.stdout.write(`##BHAI_NOTIFY##${JSON.stringify({ close: tag })}\n`);
}

const YES_NO: NotifyAction[] = [
    { label: "Yes, go ahead", message: "Yes, go ahead." },
    { label: "No", message: "No, don't do that." },
];

export interface TurnEnd {
    chat?: string;
    stuck?: boolean;
    failed?: boolean;
    /** The turn ended asking the owner for a yes (consent, design docs, a new tool). */
    waiting?: boolean;
    /** The owner sent this turn from a notification's reply box: answer the same way. */
    fromNotification?: boolean;
    /** The stuck report's buttons ("I'll take over", "Retry", "Skip"). */
    stuckActions?: NotifyAction[];
}

/** The end of an owner's turn: "done" only when it ran long; stuck and waiting whenever Bhai needs the owner. */
export function notifyTurnEnd(text: string, startedAt: number, end: TurnEnd = {}): boolean {
    const tag = end.chat ? `turn:${end.chat}` : undefined;
    if (end.stuck) return notifyDesktop("stuck", "Bhai needs you", text, { tag, actions: end.stuckActions });
    if (end.waiting) return notifyDesktop("waiting", "Bhai is waiting for your yes", text, { tag, actions: YES_NO });
    if (!end.fromNotification && Date.now() - startedAt < LONG_TURN_MS) return false;
    const title = end.failed ? "Bhai hit a snag" : /\?\s*$/.test(text) ? "Bhai has a question" : "Bhai finished";
    return notifyDesktop("done", title, text, { tag });
}
