// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Consent for irreversible actions (deleting files, emptying Trash, dangerous
// shell commands, and later checkout in site skills).
//
// The first attempt is refused and recorded as a pending request; the agent
// tells the owner what it wants to do. The action is allowed only when the
// same call comes back with `confirmed: true` AFTER the owner has sent a new
// message that reads as a yes. A flag the model sets on its own — say because a
// web page told it to — is never enough, and autonomous runs (scheduled tasks,
// research follow-ups) never count as the owner speaking.

const AFFIRMATIVE =
    /\b(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|confirm(?:ed)?|proceed|approved?|haan?|haanji|kar do|karo)\b/i;
const NEGATIVE = /\b(no|nope|don'?t|do not|stop|cancel|wait|hold on|nahi|mat)\b/i;

let ownerTurn = 0;
let lastOwnerMessage = "";
const ownerMessages: Array<{ at: number; text: string }> = []; // recent, newest last
const pending = new Map<string, number>(); // action key → owner turn when it was asked

/** Call once per message the owner actually sent (not for autonomous runs). */
export function noteOwnerMessage(text: string): void {
    ownerTurn++;
    lastOwnerMessage = text;
    ownerMessages.push({ at: Date.now(), text });
    if (ownerMessages.length > 50) ownerMessages.shift();
}

const norm = (t: string) =>
    t
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();

/**
 * True when `quote` appears in a message the owner actually sent at or after
 * `since` (ms). Approval gates use it so the model can't approve its own work
 * with a quote it wrote, or with the owner's original request.
 */
export function ownerSaid(quote: string, since: number): boolean {
    const q = norm(quote);
    if (q.length < 2) return false;
    return ownerMessages.some((m) => m.at >= since && norm(m.text).includes(q));
}

export type ConsentResult = "granted" | "needs_consent";

/**
 * `key` identifies the exact action (tool + arguments). Returns "granted" only
 * for a confirmed repeat of an action the owner was asked about and said yes to.
 */
export function checkConsent(key: string, confirmed: boolean): ConsentResult {
    const askedAt = pending.get(key);
    const ownerSpokeSince = askedAt !== undefined && ownerTurn > askedAt;
    const saidYes = AFFIRMATIVE.test(lastOwnerMessage) && !NEGATIVE.test(lastOwnerMessage);
    if (confirmed && ownerSpokeSince && saidYes) {
        pending.delete(key);
        return "granted";
    }
    pending.set(key, ownerTurn);
    return "needs_consent";
}

/** @internal — tests only. */
export function _resetConsent(): void {
    ownerTurn = 0;
    lastOwnerMessage = "";
    pending.clear();
    ownerMessages.length = 0;
}
