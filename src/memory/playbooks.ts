// © 2024-2026 XAGI Labs Private Limited. All rights reserved.

// ── Playbooks from verified wins ──────────────────────────────────
// A turn that changed the screen, checked the result after its last action and
// left no error behind is a recipe worth keeping. A screenshot alone counts only
// when the reply doesn't ask or admit anything (the model may have seen a blocker). These pure helpers turn its
// tool calls into a compact step list for task-learnings. Only tool names and
// short targets (labels, hosts, app names) are kept: never typed text, scripts
// or message bodies.

import { drivesScreen, isMutator, isVerifier } from "../agents/verify-before-done.js";
import { isStuckReplyPhrase, STUCK_REPLY_LINE, stuckCallbackMessage } from "../channel-text.js";
import { maskCredentials } from "../security/credential-mask.js";
import { findPii } from "../security/pii-redactor.js";
import { sanitizeSecrets } from "../security/secrets-sanitizer.js";
import type { LearningCategory } from "./task-learnings.js";

export interface PlaybookCall {
    fnName: string;
    fnArgs: Record<string, unknown>;
    failed: boolean;
}

export interface Playbook {
    category: LearningCategory;
    taskPattern: string;
    context: string;
    steps: string[];
}

const MAX_STEPS = 12;
const MAX_TARGET = 40;

const hostOf = (url: unknown): string | undefined => {
    try {
        return new URL(String(url)).hostname.replace(/^www\./, "") || undefined;
    } catch {
        return undefined;
    }
};

/** A short, single-line, non-secret value, or undefined. */
const shortTarget = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const t = v.replace(/\s+/g, " ").trim();
    if (!t || t.length > MAX_TARGET || t.includes("{{")) return undefined;
    // A label can be a contact ("priya@x.com", "+91 98200 12345"): same check as the task text.
    return looksSensitive(t) ? undefined : t;
};

/**
 * "tool(key arg)": the host for a URL, else a label / instruction / app name.
 * `text` is the click target only on click tools; elsewhere it's what was typed.
 */
export function describeStep(fnName: string, fnArgs: Record<string, unknown> = {}): string {
    const target =
        hostOf(fnArgs.url) ??
        shortTarget(fnArgs.label) ??
        shortTarget(fnArgs.instruction) ??
        shortTarget(fnArgs.app_name) ??
        shortTarget(fnArgs.app) ??
        (fnName.includes("click") ? shortTarget(fnArgs.text) : undefined);
    return target ? `${fnName}(${target})` : fnName;
}

const isStepTool = (c: PlaybookCall) => c.fnName.startsWith("browser_") || drivesScreen(c.fnName, c.fnArgs);

/** The ordered screen/browser steps that worked, repeats collapsed, at most 12. */
export function extractSteps(calls: PlaybookCall[]): string[] {
    const steps: string[] = [];
    for (const c of calls) {
        if (c.failed || !isStepTool(c)) continue;
        const step = describeStep(c.fnName, c.fnArgs);
        if (steps[steps.length - 1] !== step) steps.push(step);
    }
    return steps.slice(0, MAX_STEPS);
}

/** Some tool failed and the same tool never succeeded after it. */
export function hasUnresolvedError(calls: PlaybookCall[]): boolean {
    const open = new Set<string>();
    for (const c of calls) {
        if (c.failed) open.add(c.fnName);
        else open.delete(c.fnName);
    }
    return open.size > 0;
}

/**
 * A batch in the order its calls can be trusted to have finished: other tools, then the in-order
 * screen lane, then the browser lane (it runs alongside the screen lane, so a screen check in the
 * same batch may have run before a browser action). Same order as verify-before-done's recordBatch.
 */
export function inLaneOrder<T extends { fnName: string; fnArgs?: Record<string, unknown>; isBrowser: boolean }>(
    batch: T[],
): T[] {
    const lane = (r: T) => (r.isBrowser ? 2 : drivesScreen(r.fnName, r.fnArgs) ? 1 : 0);
    return [...batch].sort((a, b) => lane(a) - lane(b));
}

export type LastCheck = "no_action" | "none" | "failed" | "screenshot" | "checked";

const isScreenshot = (c: PlaybookCall) => /^(win_)?os_screenshot$/.test(c.fnName) || c.fnName === "os_computer_action";

/**
 * How the turn's last action was checked, in call order: not at all, by a check
 * that failed (or the action itself failed), only by a screenshot, or by a real
 * check (expected text, page text, now playing).
 */
export function lastCheck(calls: PlaybookCall[]): LastCheck {
    let check: LastCheck = "no_action";
    for (const c of calls) {
        if (isMutator(c.fnName, c.fnArgs)) check = c.failed ? "failed" : "none";
        else if (check === "no_action" || !isVerifier(c.fnName, c.fnArgs)) continue;
        else if (c.failed) check = "failed";
        else if (!isScreenshot(c)) check = "checked";
        else if (check !== "checked") check = "screenshot";
    }
    return check;
}

/** The turn acted on the screen and its check after the last action failed or never ran. */
export function verificationFailed(calls: PlaybookCall[]): boolean {
    const check = lastCheck(calls);
    return check === "none" || check === "failed";
}

/** A reply that admits a blocker: a passing tool check can still have read an error on the page. */
const BLOCKER_RE = /\b(couldn'?t|can'?t|cannot|unable|failed|didn'?t|not sure|blocked)\b/i;

/** A verified win: something acted, a check passed after the last action, nothing left broken. */
export function isVerifiedWin(calls: PlaybookCall[], reply: string, stuck: boolean): boolean {
    if (stuck || hasUnresolvedError(calls) || BLOCKER_RE.test(reply)) return false;
    // Only a programmatic check (expected text, gone, now playing) teaches a playbook. A screenshot
    // alone leaves the verdict to the reply's wording, which can't be read reliably in every language.
    return lastCheck(calls) === "checked";
}

/** Card numbers, IDs, keys, "password …"/"secret …" or a password-like word: never kept in memory. */
const PASSWORDISH_RE = /\b(pass(word|code|phrase)?|pwd|pw|pin|otp|cvv|cvc|secret)\b|(?=\S*[A-Za-z])(?=\S*\d)\S{8,}/i;
/** A one-time code: "enter the code 482913", "4829 is the verification code". */
const ONE_TIME_CODE_RE = /\bcode\b\D{0,20}\b\d{4,8}\b|\b\d{4,8}\b\D{0,30}\bcode\b/i;
/** Contacts: findPii covers cards and IDs, not email addresses or phone numbers. */
const CONTACT_RE = /[^\s@]+@[^\s@]+\.[a-z]{2,}|\+?\d[\d\s().-]{6,}\d/i;
export function looksSensitive(text: string): boolean {
    return (
        PASSWORDISH_RE.test(text) ||
        ONE_TIME_CODE_RE.test(text) ||
        CONTACT_RE.test(text) ||
        findPii(text).length > 0 ||
        sanitizeSecrets(text).totalRedactions > 0 ||
        maskCredentials(text) !== text
    );
}

const HANDOFF_MESSAGES = new Set(["takeover", "retry", "skip"].map((a) => stuckCallbackMessage(`stuck:${a}`)));
/** The quoted message telegram.ts / whatsapp.ts put in front of a reply. */
const REPLY_QUOTE_RE = /^\[Replying to [^\n]*?message: "([\s\S]*?)"\]\n\n/;
/** `text` without the message it replies to: the sender's own words. */
export const ownWords = (text: string) => text.replace(REPLY_QUOTE_RE, "");

/** A stuck-report handoff: a Retry / Skip / take-over button's text, or the typed "retry it" etc. */
export function isStuckHandoff(text: string): boolean {
    return HANDOFF_MESSAGES.has(text.trim()) || isStuckReplyPhrase(text);
}

/** How agent.ts stuckNote() opens its templated report. */
export const STUCK_NOTE_OPENER = "I got stuck and stopped:";
const STUCK_NOTE_CONTRACT_RE = /\(done = ([\s\S]+)\)\. I can retry/;

/**
 * The task a turn's playbook is keyed by: the owner's own words, or for a handoff turn the
 * report it replies to (the button text would match every later retry). A templated stuckNote
 * is all boilerplate (it would match every other stuck report), so only its "done = …"
 * contract counts. Undefined: learn nothing.
 */
export function playbookTaskText(rawUserMessage: string, userIntentText: string): string | undefined {
    if (!isStuckHandoff(userIntentText)) return userIntentText;
    // Drop the channel's own handoff line ("Reply: retry it · …" / "@mention me with: …"): it's boilerplate, not the task.
    let quoted = REPLY_QUOTE_RE.exec(rawUserMessage)?.[1]
        ?.split("\n")
        .filter((line) => !line.includes(STUCK_REPLY_LINE.slice("Reply: ".length)))
        .join("\n")
        .trim();
    if (quoted?.startsWith(STUCK_NOTE_OPENER)) quoted = STUCK_NOTE_CONTRACT_RE.exec(quoted)?.[1]?.trim();
    return quoted && !looksSensitive(quoted) ? quoted : undefined;
}

/** The playbook a verified win teaches, or null when the turn wasn't one. */
export function buildPlaybook(
    userMessage: string,
    calls: PlaybookCall[],
    reply: string,
    stuck: boolean,
): Playbook | null {
    if (!isVerifiedWin(calls, reply, stuck)) return null;
    const message = userMessage.replace(/\s+/g, " ").trim();
    if (!message || looksSensitive(message)) return null;
    const steps = extractSteps(calls);
    const taskPattern = message.slice(0, 120).trim();
    if (steps.length === 0) return null;

    const ok = calls.filter((c) => !c.failed);
    const lastOf = (pick: (c: PlaybookCall) => string | undefined) =>
        ok
            .map(pick)
            .filter((v): v is string => !!v)
            .pop();
    if (ok.some((c) => c.fnName.startsWith("browser_"))) {
        const site = lastOf((c) => (c.fnName.startsWith("browser_") ? hostOf(c.fnArgs.url) : undefined));
        return { category: "browser", taskPattern, steps, context: site ?? "web" };
    }
    const desktop = (c: PlaybookCall) => /^(win_)?os_/.test(c.fnName) || c.fnName === "app_manager";
    const app = lastOf((c) => (desktop(c) ? (shortTarget(c.fnArgs.app_name) ?? shortTarget(c.fnArgs.app)) : undefined));
    const os = ok.some(desktop);
    return { category: os ? "os" : "app", taskPattern, steps, context: app ?? "desktop" };
}
