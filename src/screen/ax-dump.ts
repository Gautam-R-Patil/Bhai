// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { getScriptsDir } from "../config/paths.js";

// ESM-safe require via createRequire — `require` is not defined in compiled ESM output
// (only available in tsx dev mode). Found via DEEP R3 review.
const _esmRequire = createRequire(import.meta.url);

const execFileAsync = promisify(execFile);

export interface AxNode {
    role: string | null;
    subrole?: string | null;
    label?: string | null;
    value?: string | null;
    x: number;
    y: number;
    w: number;
    h: number;
    focusable: boolean;
    enabled: boolean;
    children: AxNode[];
}

export interface AxDump {
    app: string;
    pid: number;
    root: AxNode;
    trusted: boolean;
    depth: number;
    /** macOS helper: an AX read timed out (ATLAS_AX_MSG_TIMEOUT_MS), so elements are missing. */
    partial?: boolean;
    // Added by the wrapper, not present in raw helper output:
    elapsedMs: number;
    source: "swift" | "powershell" | "pyatspi" | "unavailable";
    error?: string;
}

export interface AxFlatElement {
    id: number;
    role: string;
    label: string;
    value: string;
    bbox: { x: number; y: number; w: number; h: number };
    center: { x: number; y: number };
    focusable: boolean;
    enabled: boolean;
    path: number[]; // breadcrumb of child indices from root
    depth: number;
}

export interface AxDumpOptions {
    pid?: number;
    depth?: number;
    bboxOnly?: boolean;
    timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Session-level negative cache. When the user has revoked AX permission, every
 * dumpAccessibilityTree call takes 200-500ms (osascript spin-up + Swift binary
 * launch) before failing. On a long-running agent that's a permanent tax on
 * every cascade call. Once we've seen a permission-shaped error, short-circuit
 * for `AX_NEGATIVE_CACHE_MS` and return the cached failure instantly.
 *
 * Cleared by `clearAxFailureCache()` or auto-expires after 5 minutes (gives the
 * user time to fix permission via System Preferences and try again).
 */
const AX_NEGATIVE_CACHE_MS = 5 * 60 * 1000;
let _axNegativeUntil = 0;
let _axNegativeReason = "";

function looksLikePermissionError(msg: string): boolean {
    const lower = msg.toLowerCase();
    return (
        lower.includes("not trusted") ||
        lower.includes("accessibility") ||
        lower.includes("permission") ||
        lower.includes("-25204") ||
        lower.includes("-1719") ||
        lower.includes("1002")
    );
}

export function clearAxFailureCache(): void {
    _axNegativeUntil = 0;
    _axNegativeReason = "";
}

export async function dumpAccessibilityTree(opts: AxDumpOptions = {}): Promise<AxDump> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const start = Date.now();
    if (_axNegativeUntil > Date.now()) {
        return failureResult(start, "unavailable", `ax_negative_cache:${_axNegativeReason}`);
    }
    try {
        if (process.platform === "darwin") return appendMeta(await dumpMacOS(opts, timeoutMs), "swift", start);
        if (process.platform === "win32") return appendMeta(await dumpWindows(opts, timeoutMs), "powershell", start);
        if (process.platform === "linux") return appendMeta(await dumpLinux(opts, timeoutMs), "pyatspi", start);
    } catch (err) {
        const msg = (err as Error).message;
        if (looksLikePermissionError(msg)) {
            _axNegativeUntil = Date.now() + AX_NEGATIVE_CACHE_MS;
            _axNegativeReason = msg.slice(0, 100);
        }
        return failureResult(start, "unavailable", msg);
    }
    return failureResult(start, "unavailable", `unsupported platform: ${process.platform}`);
}

function appendMeta(dump: AxDump, source: AxDump["source"], start: number): AxDump {
    return { ...dump, source, elapsedMs: Date.now() - start };
}

function failureResult(start: number, source: AxDump["source"], message: string): AxDump {
    return {
        app: "unavailable",
        pid: 0,
        root: {
            role: null,
            label: null,
            value: null,
            x: 0,
            y: 0,
            w: 0,
            h: 0,
            focusable: false,
            enabled: false,
            children: [],
        },
        trusted: false,
        depth: 0,
        elapsedMs: Date.now() - start,
        source,
        error: message,
    };
}

async function dumpMacOS(opts: AxDumpOptions, timeoutMs: number): Promise<AxDump> {
    const sdir = getScriptsDir();
    const bin = join(sdir, "dump_ax_bin");
    const script = join(sdir, "dump_ax.swift");
    let exec: string;
    let args: string[];
    if (existsSync(bin)) {
        exec = bin;
        args = [];
    } else {
        exec = "swift";
        args = [script];
    }
    if (opts.pid && opts.pid > 0) {
        args.push("--pid", String(opts.pid));
    } else {
        args.push("--frontmost");
    }
    if (opts.depth) args.push("--depth", String(opts.depth));
    if (opts.bboxOnly) args.push("--bbox-only");
    const { stdout } = await execFileAsync(exec, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    return parseDump(stdout);
}

async function dumpWindows(opts: AxDumpOptions, timeoutMs: number): Promise<AxDump> {
    const script = join(getScriptsDir(), "dump_uia.ps1");
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script];
    if (opts.pid && opts.pid > 0) args.push("-Pid", String(opts.pid));
    if (opts.depth) args.push("-MaxDepth", String(opts.depth));
    if (opts.bboxOnly) args.push("-BboxOnly");
    const { stdout } = await execFileAsync("powershell", args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    return parseDump(stdout);
}

async function dumpLinux(opts: AxDumpOptions, timeoutMs: number): Promise<AxDump> {
    const script = join(getScriptsDir(), "dump_atspi.py");
    const args = [script];
    if (opts.pid && opts.pid > 0) args.push("--pid", String(opts.pid));
    if (opts.depth) args.push("--depth", String(opts.depth));
    if (opts.bboxOnly) args.push("--bbox-only");
    const { stdout } = await execFileAsync("python3", args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    return parseDump(stdout);
}

function parseDump(stdout: string): AxDump {
    const trimmed = stdout.trim();
    if (trimmed.startsWith("error|")) {
        const reason = trimmed.slice("error|".length);
        throw new Error(reason);
    }
    const parsed = JSON.parse(trimmed) as AxDump;
    // The helper outputs already have these fields; default the rest at the wrapper level.
    return { ...parsed, elapsedMs: 0, source: "swift" };
}

// ── Flatten + filter helpers ──────────────────────

const INTERACTIVE_ROLES_MAC = new Set([
    "AXButton",
    "AXLink",
    "AXTextField",
    "AXTextArea",
    "AXCheckBox",
    "AXRadioButton",
    "AXPopUpButton",
    "AXMenuButton",
    "AXMenuItem",
    "AXMenuBarItem",
    "AXDisclosureTriangle",
    "AXSlider",
    "AXIncrementor",
    "AXComboBox",
    "AXTabGroup",
    "AXTab",
    "AXRow",
    "AXCell",
    "AXImage",
    "AXStaticText",
]);
const INTERACTIVE_ROLES_WIN = new Set([
    "Button",
    "Hyperlink",
    "Edit",
    "Document",
    "CheckBox",
    "RadioButton",
    "ComboBox",
    "MenuItem",
    "Slider",
    "Tab",
    "TabItem",
    "DataItem",
    "ListItem",
    "TreeItem",
    "Image",
    "Text",
]);
const INTERACTIVE_ROLES_LINUX = new Set([
    "push button",
    "link",
    "text",
    "entry",
    "check box",
    "radio button",
    "combo box",
    "menu item",
    "slider",
    "tab",
    "page tab",
    "table cell",
    "table row",
    "image",
    "label",
]);

function isInteractiveRole(role: string | null | undefined): boolean {
    if (!role) return false;
    return INTERACTIVE_ROLES_MAC.has(role) || INTERACTIVE_ROLES_WIN.has(role) || INTERACTIVE_ROLES_LINUX.has(role);
}

/**
 * Flatten the tree into a numbered list of interactive elements suitable for
 * "click element [N]" tool semantics. Drops invisible elements (w=h=0) and
 * elements with no label AND no value (they're impossible to disambiguate).
 *
 * Uses the native Rust `ax_flatten_interactive` when the addon is loaded
 * (5-15× faster for trees >100 nodes). Falls back to pure-TS implementation
 * if the native module isn't present (e.g. fresh checkout without `npm run build:native`).
 */
export function flattenInteractive(dump: AxDump): AxFlatElement[] {
    // Kill-switch per CLAUDE.md rollout pattern. JSON round-trip dominates for trees <200 nodes,
    // so TS is often faster. Default: TS (force opt-in to Rust via ATLAS_NATIVE_AX=true).
    // Once bench-native.ts shows a measured win across representative inputs, flip the default.
    if (process.env.ATLAS_NATIVE_AX === "true") {
        const native = loadNative();
        if (native?.axFlattenInteractive) {
            try {
                const dumpJson = JSON.stringify({
                    app: dump.app,
                    pid: dump.pid,
                    trusted: dump.trusted,
                    depth: dump.depth,
                    root: dump.root,
                });
                const resultJson = native.axFlattenInteractive(dumpJson);
                return JSON.parse(resultJson) as AxFlatElement[];
            } catch {
                /* fall through to pure-TS */
            }
        }
    }
    return flattenInteractiveJs(dump);
}

// Match the Rust walker's MAX_WALK_DEPTH=64 to prevent stack-overflow on adversarial JSON.
const MAX_WALK_DEPTH = 64;

// Roles whose VALUE/title is the human-readable text we want to inherit. Many
// container rows (AXRow/AXCell/AXGroup, Win ListItem/DataItem) carry no title of
// their own — the visible text lives in child static-text nodes. Without
// surfacing it, those rows flatten to empty and get dropped, so a literal label
// like "Downloads" in a Finder sidebar row (or a WhatsApp chat row) never
// matches and the click falls through to the slow vision path. macOS + Windows
// + Linux text roles.
const _TEXT_ROLES = new Set([
    "AXStaticText", "AXText", "AXTextField", "AXHeading",
    "Text", "Edit", "Document", "Hyperlink",
    "label", "text", "static", "heading", "push button",
]);

/**
 * Derive a label for an interactive node that has no title/value of its own by
 * collecting the text of its nearest static-text descendants. Bounded depth +
 * count so a big container (a whole table/window) doesn't slurp unrelated text.
 */
function deriveLabelFromDescendants(node: AxNode): string {
    const parts: string[] = [];
    const MAX_SUBDEPTH = 4;
    const MAX_PARTS = 4;
    function collect(n: AxNode, d: number) {
        if (d > MAX_SUBDEPTH || parts.length >= MAX_PARTS) return;
        if (_TEXT_ROLES.has(n.role || "")) {
            const t = (n.label || n.value || "").trim();
            if (t && t !== "[secure]") parts.push(t);
        }
        for (const c of n.children) {
            if (parts.length >= MAX_PARTS) break;
            collect(c, d + 1);
        }
    }
    for (const c of node.children) collect(c, 1);
    return parts.join(" ").trim().slice(0, 200);
}

function flattenInteractiveJs(dump: AxDump): AxFlatElement[] {
    const out: AxFlatElement[] = [];
    let id = 1;
    function walk(node: AxNode, path: number[], depth: number) {
        if (depth > MAX_WALK_DEPTH) return;
        if (isInteractiveRole(node.role) && node.w > 0 && node.h > 0) {
            const label = (node.label || "").trim();
            const value = (node.value || "").trim();
            // Fall back to descendant static-text when the node carries no text of
            // its own — recovers list/sidebar/chat rows that would otherwise drop.
            const derived = label || value ? "" : deriveLabelFromDescendants(node);
            const effLabel = label || derived;
            if (effLabel || value) {
                out.push({
                    id: id++,
                    role: node.role || "",
                    label: effLabel,
                    value,
                    bbox: { x: node.x, y: node.y, w: node.w, h: node.h },
                    center: { x: node.x + Math.floor(node.w / 2), y: node.y + Math.floor(node.h / 2) },
                    focusable: node.focusable,
                    enabled: node.enabled,
                    path: [...path],
                    depth,
                });
            }
        }
        for (let i = 0; i < node.children.length; i++) {
            walk(node.children[i], [...path, i], depth + 1);
        }
    }
    walk(dump.root, [], 0);
    return out;
}

let _native: {
    axFlattenInteractive?: (s: string) => string;
    axFindByLabel?: (s: string, q: string, m: number) => string;
} | null = null;
let _nativeLoaded = false;
function loadNative(): typeof _native {
    if (_nativeLoaded) return _native;
    _nativeLoaded = true;
    try {
        _native = _esmRequire(join(process.cwd(), "native", "index.js"));
        return _native;
    } catch {
        return null;
    }
}

/** Best-match by label or value substring. Returns null if no match meets the score floor. */
// Keys and symbols the agent writes vs the labels apps use (Calculator: "Multiply").
const _SYMBOL_ALIASES: Record<string, string> = {
    "×": "multiply",
    "*": "multiply",
    "÷": "divide",
    "/": "divide",
    "=": "equals",
    "+": "add",
    "−": "subtract",
    "-": "subtract",
    "%": "percent",
};

/**
 * Best element for a natural-language instruction ("the "1" button on the
 * Calculator keypad"). `appName`'s words are ignored: they described every
 * element in that app and dragged real hits below the threshold.
 */
export function findElementByLabel(
    elements: AxFlatElement[],
    query: string,
    minScore = 0.5,
    appName?: string,
): AxFlatElement | null {
    if (!query) return null;
    const raw = query.toLowerCase().trim();

    // A quoted target ("1", '×', “Save”) is what the agent means: try it exactly.
    const quoted = /["'“‘]([^"'”’]{1,40})["'”’]/.exec(query)?.[1]?.toLowerCase().trim();
    if (quoted) {
        const want = [quoted, _SYMBOL_ALIASES[quoted]].filter(Boolean);
        const exact = elements.find((el) => want.includes((el.label || "").toLowerCase().trim()));
        if (exact) return exact;
    }

    const appWords = new Set(_tokens((appName || "").toLowerCase()));
    let q = raw
        .split(/\s+/)
        .map((w) => _SYMBOL_ALIASES[w] ?? w)
        .filter((w) => !appWords.has(w.replace(/[^a-z0-9]/g, "")))
        .join(" ")
        .trim();
    if (!q) q = raw;

    let best: { el: AxFlatElement; score: number } | null = null;
    for (const el of elements) {
        const label = (el.label || "").toLowerCase();
        const value = (el.value || "").toLowerCase();
        if (!label && !value) continue;
        // Score the raw instruction too: stripping the app name can leave a
        // fragment ("All Mail" in Mail → "all") that only the full words pin down.
        let score = Math.max(scoreText(q, label), q === raw ? 0 : scoreText(raw, label));
        // Values are free text (a display showing "128 × 46", a document): an
        // exact match counts; a fuzzy one only for short label-less text (macOS
        // puts static text in the value), and never against the raw symbol.
        if (value) score = Math.max(score, value === q || value === raw ? 0.9 : !label && value.length <= 40 ? scoreText(q, value) : 0);
        if (!best || score > best.score) best = { el, score };
    }
    if (!best || best.score < minScore) return null;
    return best.el;
}

const _STOPWORDS = new Set([
    "the",
    "a",
    "an",
    "to",
    "in",
    "on",
    "of",
    "for",
    "at",
    "by",
    "click",
    "tap",
    "button",
    "icon",
    "menu",
    "item",
    "field",
    "the",
    "and",
    "or",
    "this",
    "that",
    "with",
    "into",
    "left",
    "right",
    "top",
    "bottom",
    "sidebar",
    "bar",
    "open",
    // Containers, not targets ("the 1 key on the keypad").
    "keypad",
    "keyboard",
    "key",
    "keys",
    "window",
    "app",
    "application",
    "panel",
    "toolbar",
    "screen",
]);

function _tokens(s: string): string[] {
    return s
        .split(/[^a-z0-9]+/i)
        .map((t) => t.toLowerCase())
        .filter((t) => t.length > 0);
}

function _wordIn(hay: string, q: string): boolean {
    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, "u").test(hay);
}

function scoreText(q: string, hay: string): number {
    if (!hay) return 0;
    if (hay === q) return 1.0;
    // Label CONTAINS the whole query → strong (the query is a specific substring
    // of a longer label, e.g. q="Downloads" hay="Downloads, 14 items").
    // On word boundaries: "all" is not in "Install".
    if (_wordIn(hay, q)) return 0.85;
    // Query CONTAINS the label as a substring — only strong when the label is a
    // SUBSTANTIAL fraction of the query. A short label buried in a long unrelated
    // instruction (q="the purple ... widget" ⊃ "Purple") must NOT score 0.85 here;
    // it falls through to the token logic which weighs query-side coverage.
    if (q.includes(hay) && hay.length >= Math.max(4, q.length * 0.5)) return 0.85;

    // Token-aware match: agents pass DESCRIPTIVE instructions ("the Downloads
    // folder in the Finder sidebar") while AX labels are short ("Downloads").
    // Pure substring/char-overlap missed these. Score by how much of the SHORTER
    // side's significant tokens are covered by the longer side. A label whose
    // every meaningful token appears in the query (e.g. "Downloads" ⊂ query)
    // scores high; this is what lets natural-language instructions hit AX.
    const qTok = _tokens(q).filter((t) => !_STOPWORDS.has(t));
    const hTok = _tokens(hay).filter((t) => !_STOPWORDS.has(t));
    if (qTok.length > 0 && hTok.length > 0) {
        const qSet = new Set(qTok);
        const hSet = new Set(hTok);
        const sharedH = hTok.filter((t) => qSet.has(t)).length;
        const sharedQ = qTok.filter((t) => hSet.has(t)).length;
        const hayCovered = sharedH / hTok.length; // label tokens found in query
        const qCovered = sharedQ / qTok.length; // query tokens found in label
        // A short label fully covered by a LONG query is weak evidence — the query
        // is "about" something else and just happens to contain the label word
        // (e.g. "the purple ... widget" hitting a tag labeled "Purple"). Require
        // BOTH meaningful label-coverage AND that the shared tokens aren't a tiny
        // fraction of the query. Score = harmonic-ish blend so one-sided coverage
        // can't alone reach the top. Genuine case (label = the query's head noun,
        // e.g. "Downloads" in "the Downloads folder in the sidebar") still wins
        // because qCovered there is high relative to the few content tokens.
        if (hayCovered >= 0.999 && qCovered >= 0.5) return 0.82; // label fully in query AND dominates it
        const blend = (2 * hayCovered * qCovered) / (hayCovered + qCovered || 1); // F1 of the two coverages
        if (blend > 0) return Math.min(0.79, 0.35 + blend * 0.45);
    }

    // Char-overlap similarity for very loose matches.
    const intersect = [...new Set(q)].filter((c) => hay.includes(c)).length;
    return (intersect / Math.max(q.length, 1)) * 0.5;
}
