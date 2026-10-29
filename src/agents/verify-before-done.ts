// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * Verify-before-done gate.
 *
 * The agent has a well-documented failure mode on OS-automation tasks: it fires
 * a state-mutating tool call ("press cmd+return to send the message"), the call
 * succeeds at the API level (the keystroke was emitted), and the LLM declares
 * the task done without ever checking that the keystroke actually had the
 * intended UI effect. The keystroke might have landed in the wrong window, on
 * the wrong contact, or with the wrong focus — and the user sees "✅ message
 * sent" while nothing was sent.
 *
 * This module owns two lists:
 *  - MUTATORS: tools that change visible UI state (click, type, drag, run an
 *    apple-script that contains keystroke/click/type, …).
 *  - VERIFIERS: tools that read state back AFTER mutation in a structured way.
 *    A bare screenshot is *not* enough — the LLM looking at a screenshot and
 *    confabulating "yes, sent" is exactly the failure mode we're fixing. The
 *    verifier must have a programmatic check (expect_text, expect_gone,
 *    now_playing → track_name match) so success isn't just LLM vibes.
 *
 * The runAgent loop tracks both flags per run and forces one extra iteration
 * with a system reminder if the LLM tries to exit with mutations but no verify.
 *
 * Kill-switch: ATLAS_NO_VERIFY_GATE=true disables the gate entirely.
 */

import { getActiveChannel } from "../tools/channel-send.js";
import { isPhotoFile } from "../tools/send-file.js";

const MUTATOR_TOOLS = new Set<string>([
    // Cross-OS smart click cascade
    "os_smart_click",
    "os_click_id",
    "os_click",
    "os_click_element",
    "os_ocr_click",
    "os_double_click",
    "os_right_click",
    "os_type",
    "os_drag",
    "os_multi_action",
    // Windows equivalents
    "win_os_click",
    "win_os_type",
    "win_os_ocr_click",
    // Hierarchical computer-use agent
    "computer_use",
    // Browser interaction — also a "did the action stick?" risk surface
    "browser_click_at",
    "browser_type",
    "browser_click",
    "browser_drag",
]);

const VERIFIER_TOOLS = new Set<string>([
    "os_visual_verify",
    "win_os_visual_verify",
    // Music verifier — orchestrator already enforces now_playing for songs;
    // listing here so a track-confirmation also counts as "verified".
    "spotify", // narrowed below by action='now_playing'
    "music_control", // narrowed below by action
    // Web-side: extracting text from the page IS a programmatic check.
    "browser_extract",
    "browser_get_text",
    "browser_wait_for_selector",
    "browser_extract_article",
    "browser_form_state", // reads the fields: checks what was typed (it was listed as an action)
]);

const ACTING_COMPUTER_ACTIONS = new Set([
    "click",
    "double_click",
    "triple_click",
    "right_click",
    "drag",
    "scroll",
    "type",
    "key",
    "hold_key",
]);

/** Apple-script / PowerShell strings that count as UI mutations. */
const KEYSTROKE_OR_CLICK_RE = /\b(keystroke|key\s+code|click\s+at|click\s+menu|click\s+button|key\s+down|tell\s+application\s+"[^"]+"\s+to\s+(activate|launch))/i;

/**
 * Decide whether a given tool call mutated UI state.
 *
 * For wrapper tools (apple_script, powershell_script) we sniff the script body
 * — the same wrapper is used for both "read the version of Safari" (no mutation,
 * shouldn't gate) and "press cmd+return in the focused field" (mutation, should
 * gate). Without sniffing we'd over-trigger on every script run.
 */
export function isMutator(fnName: string, fnArgs: Record<string, unknown>): boolean {
    if (MUTATOR_TOOLS.has(fnName)) return true;
    // os_computer_action also looks (screenshot/zoom) and waits; only these act.
    if (fnName === "os_computer_action") return ACTING_COMPUTER_ACTIONS.has(String(fnArgs?.action ?? ""));
    if (fnName === "apple_script" || fnName === "powershell_script") {
        const script = String(fnArgs?.script ?? fnArgs?.code ?? "");
        return KEYSTROKE_OR_CLICK_RE.test(script);
    }
    return false;
}

/** Non-os_* tools that also drive the screen (os_* / win_os_* are matched by prefix). */
const SCREEN_TOOLS = new Set(["app_manager", "apple_script", "window_manage", "run_shortcut", "computer_use"]);

/** Tools that hand the work to another agent, whose own calls this gate never sees. */
const DELEGATES = new Set(["swarm_task", "start_long_task", "resume_long_task"]);

/**
 * Runs in the batch's in-order screen lane: it shares focus, mouse and keyboard,
 * reads the screen (send_screenshot), or is something this gate tracks, so its
 * place in call order is the order it ran in.
 */
export function drivesScreen(fnName: string, fnArgs: Record<string, unknown> = {}): boolean {
    return (
        /^(win_)?os_/.test(fnName) ||
        SCREEN_TOOLS.has(fnName) ||
        fnName === "send_screenshot" ||
        isMutator(fnName, fnArgs) ||
        isVerifier(fnName, fnArgs)
    );
}

/**
 * Decide whether a given tool call counts as a programmatic verification.
 *
 * A screenshot counts too: the model receives it as an image (it used to get
 * only truncated base64 text, which is why screenshots were once excluded).
 */
export function isVerifier(fnName: string, fnArgs: Record<string, unknown>): boolean {
    if (fnName === "os_screenshot" || fnName === "win_os_screenshot") return true;
    if (fnName === "os_computer_action") return ["screenshot", "zoom"].includes(String(fnArgs?.action ?? ""));
    if (fnName === "spotify" || fnName === "music_control") {
        return String(fnArgs?.action ?? "") === "now_playing";
    }
    if (fnName === "os_visual_verify" || fnName === "win_os_visual_verify") {
        // Only a call with something the tool can check counts — not an
        // unparameterized LLM-vision opinion.
        return !!(fnArgs?.expect_text || fnArgs?.expect_gone || fnArgs?.expected_text);
    }
    return VERIFIER_TOOLS.has(fnName);
}

/** Per-run bookkeeping. Reset on each runAgent invocation. */
export interface VerifyGateState {
    osStateMutated: boolean;
    verifyCalled: boolean;
    lastMutator?: string;
    /** Set once we've nudged for this run, to prevent infinite re-prompt loops. */
    nudgedThisRun: boolean;
    /** The latest screenshot (data URL) taken after the last mutator: the turn's receipt. */
    receiptImage?: string;
    /** The turn's last mutator failed: a receipt would show a result the reply may not claim. */
    lastMutatorFailed?: boolean;
    /** This turn touched the vault or had a screenshot withheld: no receipt for it. */
    secretSeen?: boolean;
    /** The agent sent the owner the screen since the last mutator: no receipt until the next one. */
    screenSent?: boolean;
}

export function newVerifyGateState(): VerifyGateState {
    return { osStateMutated: false, verifyCalled: false, nudgedThisRun: false };
}

/**
 * Record one tool call's effect on gate state, in call order: a check only
 * covers the actions before it, so a later action needs a fresh one. A check
 * that failed to run doesn't count.
 */
export function recordToolCall(
    state: VerifyGateState,
    fnName: string,
    fnArgs: Record<string, unknown>,
    isError = false,
    // imageUrl: what the model saw; receiptUrl: the same screen for the owner (no coordinate grid), if one could be made.
    more: { imageUrl?: string; receiptUrl?: string; failed?: boolean; secret?: boolean } = {},
): void {
    const failed = more.failed ?? isError;
    if (more.secret) state.secretSeen = true;
    if (isMutator(fnName, fnArgs)) {
        state.osStateMutated = true;
        state.lastMutator = fnName;
        state.lastMutatorFailed = failed;
        state.verifyCalled = false;
        state.receiptImage = undefined; // a screenshot before this action no longer shows the result
        state.screenSent = false;
    } else if (!failed && sentTheScreen(fnName, fnArgs)) {
        state.receiptImage = undefined; // the owner already has the screen; don't send it twice
        state.screenSent = true; // nor a later look at the same screen
    } else if (more.imageUrl && state.osStateMutated && !state.screenSent) {
        state.receiptImage = more.receiptUrl;
    } else if (SCREEN_TOOLS.has(fnName) || DELEGATES.has(fnName)) {
        // Not an action this gate checks, but the screen may have moved on since that screenshot.
        state.receiptImage = undefined;
    }
    if (isVerifier(fnName, fnArgs) && !isError) {
        state.verifyCalled = true;
    }
}

/**
 * The agent already sent the owner an image of the screen in the chat this turn
 * runs in (a PDF or a song doesn't count). send_screenshot and send_file go to
 * the owner's Telegram chat; send_message_on_channel only counts on this turn's
 * own channel. whatsapp_send goes to a contact or group, never the owner's chat.
 */
const sentTheScreen = (fnName: string, fnArgs: Record<string, unknown>) => {
    // send_screenshot / send_file deliver to the owner's Telegram chat: that's this turn's chat only on Telegram.
    const onTelegram = (getActiveChannel() ?? "telegram") === "telegram";
    if (fnName === "send_screenshot") return onTelegram;
    const toOwnerChat =
        (fnName === "send_file" && onTelegram) ||
        // ponytail: the active channel is process-global, so a concurrent turn on another channel can blur this.
        (fnName === "send_message_on_channel" && String(fnArgs?.channel ?? "").toLowerCase() === getActiveChannel());
    return toOwnerChat && isPhotoFile(String(fnArgs?.file_path ?? ""));
};

/**
 * Record one tool batch in the order it may have run. The parallel lane (calls
 * that don't drive the screen) starts at once, so record it first: a file sent
 * there predates any screen action in the batch. The browser lane runs alongside
 * the in-order screen lane, so a browser call may predate a screen action:
 * record browser calls last (they still need their own check), and when a
 * screen action ran in the batch, a browser screenshot can't be its receipt.
 */
export function recordBatch(
    state: VerifyGateState,
    results: Array<{
        fnName: string;
        fnArgs?: Record<string, unknown>;
        isError: boolean;
        isBrowser: boolean;
        reportedFailure?: boolean;
        imageUrl?: string;
        receiptUrl?: string;
        secret?: boolean;
    }>,
): void {
    const lane = (r: (typeof results)[number]) => (r.isBrowser ? 2 : drivesScreen(r.fnName, r.fnArgs) ? 1 : 0);
    const screenActed = results.some((r) => !r.isBrowser && isMutator(r.fnName, r.fnArgs || {}));
    for (const r of [...results].sort((a, b) => lane(a) - lane(b))) {
        recordToolCall(state, r.fnName, r.fnArgs || {}, r.isError, {
            imageUrl: r.isBrowser && screenActed ? undefined : r.imageUrl,
            receiptUrl: r.isBrowser && screenActed ? undefined : r.receiptUrl,
            failed: r.isError || r.reportedFailure === true,
            secret: r.secret,
        });
    }
}

export interface Receipt {
    imageBase64: string;
    mimeType: string;
}

/**
 * Done comes with the receipt: the screenshot taken after the turn's last action.
 * Only for the owner in a private chat (a group or contact never sees the owner's
 * screen), never on a stuck turn or after a failed last action (the photo would
 * imply a success the reply doesn't claim), and never for a turn that touched the
 * vault or had a screenshot withheld (the capture could show a secret). That last
 * flag is per turn: the vault's own taint is global and a concurrent turn resets it.
 */
export function pickReceipt(
    state: VerifyGateState,
    turn: { stuck?: boolean; isOwner?: boolean; isPrivate?: boolean },
): Receipt | undefined {
    if (!state.receiptImage || state.lastMutatorFailed || state.secretSeen) return undefined;
    if (turn.stuck || !turn.isOwner || !turn.isPrivate) return undefined;
    const m = /^data:([^;,]+);base64,(.+)$/s.exec(state.receiptImage);
    return m ? { mimeType: m[1], imageBase64: m[2] } : undefined;
}

/**
 * Should the loop force one more iteration with a verify reminder?
 *
 * Fires only when:
 *  - mutation happened AND no verify, AND
 *  - we haven't already nudged this run (cap at one re-prompt — a stubborn LLM
 *    that refuses to verify after being told twice is not going to be saved by
 *    a third nudge, and burning credits in an infinite loop is the worse outcome).
 *  - the user hasn't disabled the gate.
 */
export function shouldForceVerify(state: VerifyGateState): boolean {
    if (process.env.ATLAS_NO_VERIFY_GATE === "true") return false;
    if (state.nudgedThisRun) return false;
    return state.osStateMutated && !state.verifyCalled;
}

/** The reminder text the loop appends as a user message to force one more iteration. */
export function buildVerifyReminder(state: VerifyGateState): string {
    const mutator = state.lastMutator || "an OS action";
    return (
        `STOP — you ran ${mutator} but never verified the result. Don't claim "done"/"sent"/"opened" on faith. ` +
        `Call os_visual_verify with a specific expect_text (or expect_gone) BEFORE giving your final answer. ` +
        `If you can't visually confirm the action succeeded, say so — don't confabulate success from a screenshot. ` +
        `(This gate fires once per run; if the verify legitimately can't be performed, explain why in your next message.)`
    );
}
