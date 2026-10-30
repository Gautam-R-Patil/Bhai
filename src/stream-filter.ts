// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * Streaming safety filters: answer and note text streams to chat surfaces as the model
 * writes it, and nothing the final reply hides may ever show on the way.
 *
 * How: keep the raw text so far, find the earliest point where a tag or marker is still
 * undecided (a possible opener, or a block whose terminator hasn't arrived), and run the
 * SAME whole-text cleanups the final reply gets over everything before it. Only what
 * extends what was already sent goes out; nothing is ever taken back. Handles ([OTP_1])
 * stay handles: only the final `response` reveals them.
 */

import { dropStuckMarker } from "./channel-text.js";
import { MEMORY_CONTEXT_CLOSE, MEMORY_CONTEXT_OPEN, sanitizeContextEchoes } from "./context-scrubber.js";
import { protect } from "./security/pii-vault.js";
import { sanitizeSecrets } from "./security/secrets-sanitizer.js";

/** sanitizeAgentResponse's strip, untrimmed: agent.ts trims the final reply; a stream can't. */
export function stripInternalTags(text: string): string {
    return text
        .replace(/<system_log>[\s\S]*?<\/system_log>/g, "")
        .replace(/<tool_log[\s\S]*?<\/tool_log>/g, "")
        .replace(/\[Tool Result [^\]]+\]:[\s\S]*?(?=\n\n|\n[A-Z]|$)/g, "")
        .replace(/\[NO_REPLY\]/gi, "")
        .replace(/\[no_reply\]/gi, "")
        .replace(/\[SOURCE:.*?\]/gs, "");
}

/** Overlay markers off the overlay. Only those: other HTML comments can be real content (code, "A --> B"). */
export function stripOverlayMarkers(text: string): string {
    return text.replace(/<!--\s*(?:QUICK_ACTIONS|WIDGET|\/?COLLAPSE)\b[\s\S]*?-->/g, "");
}

/** The final reply's cleanups (llm.ts echo scrub, finalReplyText, takeStuckMarker, overlay marker lift), stream-safe. */
function clean(raw: string, overlay: boolean): string {
    let t = stripInternalTags(sanitizeContextEchoes(raw));
    if (!overlay) t = stripOverlayMarkers(t);
    t = dropStuckMarker(t)
        // The overlay lifts these into buttons/widgets (overlay-chat.ts parseInteractiveElements).
        .replace(/<!--\s*(?:WIDGET|QUICK_ACTIONS)\b[\s\S]*?-->/g, "")
        // Stricter than the final reply: an unterminated block never shows. Only reachable at flush,
        // since a block whose end hasn't arrived is held.
        .replace(
            /<system_log>[\s\S]*$|<tool_log[\s\S]*$|\[SOURCE:[\s\S]*$|\[Tool Result [^\]]*$|<!--\s*(?:WIDGET|QUICK_ACTIONS)\b[\s\S]*$/,
            "",
        );
    if (!overlay) t = t.replace(/<!--\s*\/?COLLAPSE\b[\s\S]*$/, "");
    return t.trimStart();
}

const HOLD = -1;
const NONE = -2;
const WRAP = "*_`";
const TAG_BLOCKS: [string, string][] = [
    ["<system_log>", "</system_log>"],
    ["<tool_log", "</tool_log>"],
    [MEMORY_CONTEXT_OPEN, MEMORY_CONTEXT_CLOSE],
];
const COMMENT_MARKERS = ["QUICK_ACTIONS", "WIDGET", "COLLAPSE", "/COLLAPSE"];
const STUCK_FULL = /\[\[[ \t]*stuck[ \t]*\]\]/iy;
const STUCK_PARTIAL = /\[(?:\[[ \t]*(?:s(?:t(?:u(?:c(?:k[ \t]*\]?)?)?)?)?)?)?$/iy;

/** `s` is a proper prefix of `full`: more input could still complete it. */
function isPrefix(s: string, full: string, ci = false): boolean {
    if (s.length >= full.length) return false;
    return ci ? full.toLowerCase().startsWith(s.toLowerCase()) : full.startsWith(s);
}

/** Where a `[Tool Result …]:` body ends (the regex's `(?=\n\n|\n[A-Z]|$)`), or HOLD while it can't be known. */
function toolResultEnd(raw: string, from: number): number {
    for (let p = raw.indexOf("\n", from); p >= 0; p = raw.indexOf("\n", p + 1)) {
        const n = raw[p + 1];
        if (n === "\n" || (n >= "A" && n <= "Z")) return p;
    }
    return HOLD;
}

/** Only whitespace between `i` and the start of its line (the `^\s*` of the system-note rule). */
function atLineStart(raw: string, i: number): boolean {
    let j = i - 1;
    while (j >= 0 && raw[j] !== "\n" && /\s/.test(raw[j])) j--;
    return j < 0 || raw[j] === "\n";
}

/**
 * What starts at `i`: HOLD (could still be a hidden construct), the end index of a decided
 * hidden construct (skip it), or NONE (ordinary text).
 */
function constructAt(raw: string, i: number, overlay: boolean): number {
    const c = raw[i];
    const s = raw.slice(i, i + 20);
    if (c === "<") {
        for (const [open, close] of TAG_BLOCKS) {
            if (isPrefix(s, open)) return HOLD;
            if (s.startsWith(open)) {
                const j = raw.indexOf(close, i + open.length);
                return j < 0 ? HOLD : j + close.length;
            }
        }
        if (isPrefix(s, "<!--")) return HOLD;
        if (!s.startsWith("<!--")) return NONE;
        let k = i + 4;
        while (k < raw.length && /\s/.test(raw[k])) k++;
        if (k === raw.length) return HOLD;
        const rest = raw.slice(k, k + 14);
        for (const kw of COMMENT_MARKERS) {
            if (isPrefix(rest, kw)) return HOLD;
            if (!rest.startsWith(kw)) continue;
            const after = k + kw.length;
            if (after === raw.length) return HOLD; // the regexes need \b after the keyword
            if (/\w/.test(raw[after])) continue;
            // Overlay keeps COLLAPSE sections (its renderer folds them): hold one until it closes
            // rather than flash raw markup, but still filter what's inside.
            if (overlay && kw === "COLLAPSE") return raw.includes("<!--/COLLAPSE-->", after) ? NONE : HOLD;
            if (overlay && kw === "/COLLAPSE") return NONE;
            const j = raw.indexOf("-->", after);
            return j < 0 ? HOLD : j + 3;
        }
        return NONE;
    }
    if (c === "[") {
        if (isPrefix(s, "[no_reply]", true)) return HOLD;
        if (s.slice(0, 10).toLowerCase() === "[no_reply]") return i + 10;
        if (isPrefix(s, "[SOURCE:")) return HOLD;
        if (s.startsWith("[SOURCE:")) {
            const j = raw.indexOf("]", i + 8);
            return j < 0 ? HOLD : j + 1;
        }
        if (isPrefix(s, "[Tool Result ")) return HOLD;
        if (s.startsWith("[Tool Result ")) {
            const j = raw.indexOf("]", i + 13);
            if (j < 0) return HOLD;
            if (j === i + 13) return NONE; // needs at least one char of name
            if (j + 1 === raw.length) return HOLD;
            return raw[j + 1] === ":" ? toolResultEnd(raw, j + 2) : NONE;
        }
    }
    if (c === "S" && atLineStart(raw, i)) {
        // A line starting "System note:" may be the recalled-memory note: held to its end.
        if (isPrefix(s, "System note:")) return HOLD;
        if (s.startsWith("System note:")) return raw.includes("\n", i) ? NONE : HOLD;
        return NONE;
    }
    // [[STUCK]], optionally wrapped in the same 1-2 of * _ ` on both sides (channel-text.ts STUCK_MARKER).
    let w = 0;
    while (w < 3 && i + w < raw.length && WRAP.includes(raw[i + w])) w++;
    if (w > 2 || (w === 0 && c !== "[")) return NONE;
    const at = i + w;
    if (at === raw.length) return HOLD;
    STUCK_FULL.lastIndex = at;
    if (STUCK_FULL.test(raw)) {
        const after = STUCK_FULL.lastIndex;
        const wrap = raw.slice(i, at);
        const tail = raw.slice(after, after + w);
        if (tail === wrap) return after + w;
        return tail.length < w && wrap.startsWith(tail) ? HOLD : NONE;
    }
    STUCK_PARTIAL.lastIndex = at;
    return STUCK_PARTIAL.test(raw) ? HOLD : NONE;
}

const MAY_START = new Set(["<", "[", "S", ...WRAP]);

/**
 * Filters a streamed answer. `push` returns what may be shown now; `flush` the rest at the end.
 * Prose goes out at once; a possible marker start is held until decided (a few chars), a
 * recognised block until its end arrives.
 */
export class AnswerStreamFilter {
    private readonly overlay: boolean;
    private raw = "";
    private sent = "";
    private scanFrom = 0;
    private lastCut = 0;
    private stalled = false;

    constructor(opts: { channel: string }) {
        this.overlay = opts.channel === "overlay";
    }

    push(delta: string): string {
        if (!delta) return "";
        this.raw += delta;
        let cut = this.holdPoint();
        // A trailing whitespace run with a newline can still be eaten by a line-start rule
        // (stuck line, system-note line): hold it until the next visible char.
        let j = cut;
        while (j > 0 && /\s/.test(this.raw[j - 1])) j--;
        if (this.raw.slice(j, cut).includes("\n")) cut = j;
        return this.emit(cut);
    }

    flush(): string {
        return this.emit(this.raw.length, true);
    }

    /** Earliest index from which the text is undecided. Positions before it never change verdict. */
    private holdPoint(): number {
        let i = this.scanFrom;
        while (i < this.raw.length) {
            const v = MAY_START.has(this.raw[i]) ? constructAt(this.raw, i, this.overlay) : NONE;
            if (v === HOLD) break;
            i = v === NONE ? i + 1 : v;
        }
        this.scanFrom = i;
        return i;
    }

    private emit(cut: number, force = false): string {
        if (this.stalled || (cut === this.lastCut && !force)) return "";
        this.lastCut = cut;
        // ponytail: re-cleans the whole prefix each push (O(n²) over a reply); fine at chat sizes.
        const out = clean(this.raw.slice(0, cut), this.overlay);
        // A cleanup that rewrote already-sent text (only pathological overlaps): stop streaming
        // rather than guess; the final response replaces the streamed text anyway.
        if (!out.startsWith(this.sent)) {
            this.stalled = true;
            return "";
        }
        const delta = out.slice(this.sent.length);
        this.sent = out;
        return delta;
    }
}

function maskLines(text: string): string {
    return text
        .split("\n")
        .map((line) => (line ? sanitizeSecrets(protect(line, { credentials: true })).sanitized : line))
        .join("\n");
}

/**
 * Filters streamed thinking/narration: the answer rules, then credential masking and the
 * secrets sanitizer per line (code tools' raw output can reach the model unmasked).
 * Line-buffered: only complete lines go out; the last partial line on flush.
 */
export class NoteStreamFilter {
    private readonly answer = new AnswerStreamFilter({ channel: "note" });
    private line = "";

    push(delta: string): string {
        this.line += this.answer.push(delta);
        const end = this.line.lastIndexOf("\n");
        if (end < 0) return "";
        const done = this.line.slice(0, end + 1);
        this.line = this.line.slice(end + 1);
        return maskLines(done);
    }

    flush(): string {
        const rest = this.line + this.answer.flush();
        this.line = "";
        return maskLines(rest);
    }
}
