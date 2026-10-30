// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Native notifications through the desktop app: the bot writes one
// "##BHAI_NOTIFY##{kind,title,body}" stdout line and the app shows it
// (desktop/notify-gate.js decides whether, by kind, Settings and focus).

export type NotifyKind = "done" | "proactive" | "stuck" | "handoff";

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

/** False when no desktop app is listening (standalone bot), so the caller can fall back. */
export function notifyDesktop(kind: NotifyKind, title: string, body: string): boolean {
    if (process.env.ATLAS_DESKTOP_NOTIFY !== "1") return false;
    const text = plainNotifyText(body);
    if (!text) return false;
    process.stdout.write(`##BHAI_NOTIFY##${JSON.stringify({ kind, title: title.slice(0, 80), body: text })}\n`);
    return true;
}

/** The end of an owner's turn: "done" only when it ran long, "stuck" whenever Bhai needs the owner. */
export function notifyTurnEnd(text: string, startedAt: number, stuck = false): void {
    if (stuck) notifyDesktop("stuck", "Bhai needs you", text);
    else if (Date.now() - startedAt >= LONG_TURN_MS) notifyDesktop("done", "Bhai finished", text);
}
