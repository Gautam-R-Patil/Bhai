// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
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
// "not": "not sure", "not yet", "ok not now" are not a yes.
const NEGATIVE = /\b(no|not|nope|don'?t|do not|stop|cancel|wait|hold on|later|nahi|mat)\b/i;
// An ask is answerable for 10 minutes: an "ok thanks" hours later about something else must
// not grant a call that was refused back then.
const ASK_TTL_MS = 10 * 60_000;

let ownerTurn = 0;
let lastOwnerMessage = "";
const ownerMessages: Array<{ at: number; text: string }> = []; // recent, newest last
const pending = new Map<string, { turn: number; at: number }>(); // action key → when it was asked

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
    // Whole words only: "ok" must not match inside "looks".
    return ownerMessages.some((m) => m.at >= since && ` ${norm(m.text)} `.includes(` ${q} `));
}

/**
 * Approval gate: `quote` is a whole-word excerpt of the owner's LATEST message,
 * sent at/after `since`, and that whole message reads as a yes (not a no).
 */
export function ownerApproved(quote: string, since: number): boolean {
    const last = ownerMessages.at(-1);
    if (!last || last.at < since) return false;
    const q = norm(quote);
    return (
        q.length >= 2 &&
        ` ${norm(last.text)} `.includes(` ${q} `) &&
        AFFIRMATIVE.test(last.text) &&
        !NEGATIVE.test(last.text)
    );
}

export type ConsentResult = "granted" | "needs_consent";

/**
 * `key` identifies the exact action (tool + arguments). Returns "granted" only
 * for a confirmed repeat of an action the owner was asked about and said yes to.
 */
export function checkConsent(key: string, confirmed: boolean, opts: { nextTurnOnly?: boolean } = {}): ConsentResult {
    const asked = pending.get(key);
    const askedAt = asked && Date.now() - asked.at < ASK_TTL_MS ? asked.turn : undefined;
    // nextTurnOnly: the yes must be the owner's very next message after the ask,
    // not a later "ok" that answered something else.
    const ownerSpokeSince =
        askedAt !== undefined && (opts.nextTurnOnly ? ownerTurn === askedAt + 1 : ownerTurn > askedAt);
    const saidYes = AFFIRMATIVE.test(lastOwnerMessage) && !NEGATIVE.test(lastOwnerMessage);
    if (confirmed && ownerSpokeSince && saidYes) {
        pending.delete(key);
        return "granted";
    }
    pending.set(key, { turn: ownerTurn, at: Date.now() });
    return "needs_consent";
}

/** True when an action was refused for consent at or after `since` (ms): the turn ended asking for a yes. */
export function consentAskedSince(since: number): boolean {
    return [...pending.values()].some((p) => p.at >= since);
}

/** @internal — tests only. */
export function _resetConsent(): void {
    ownerTurn = 0;
    lastOwnerMessage = "";
    pending.clear();
    ownerMessages.length = 0;
}
