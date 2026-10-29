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
    "browser_form_state",
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
): void {
    if (isMutator(fnName, fnArgs)) {
        state.osStateMutated = true;
        state.lastMutator = fnName;
        state.verifyCalled = false;
    }
    if (isVerifier(fnName, fnArgs) && !isError) {
        state.verifyCalled = true;
    }
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
