// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// ESM-safe require via createRequire — `require` is not defined in compiled ESM output
// (only available in tsx dev mode). Found via DEEP R3 review.
const _esmRequire = createRequire(import.meta.url);

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

export async function dumpAccessibilityTree(opts: AxDumpOptions = {}): Promise<AxDump> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const start = Date.now();
    try {
        if (process.platform === "darwin") return appendMeta(await dumpMacOS(opts, timeoutMs), "swift", start);
        if (process.platform === "win32") return appendMeta(await dumpWindows(opts, timeoutMs), "powershell", start);
        if (process.platform === "linux") return appendMeta(await dumpLinux(opts, timeoutMs), "pyatspi", start);
    } catch (err) {
        return failureResult(start, "unavailable", (err as Error).message);
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

function projectRoot(): string {
    return join(__dirname, "..", "..");
}

async function dumpMacOS(opts: AxDumpOptions, timeoutMs: number): Promise<AxDump> {
    const root = projectRoot();
    const bin = join(root, "scripts", "dump_ax_bin");
    const script = join(root, "scripts", "dump_ax.swift");
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
    const script = join(projectRoot(), "scripts", "dump_uia.ps1");
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script];
    if (opts.pid && opts.pid > 0) args.push("-Pid", String(opts.pid));
    if (opts.depth) args.push("-MaxDepth", String(opts.depth));
    if (opts.bboxOnly) args.push("-BboxOnly");
    const { stdout } = await execFileAsync("powershell", args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    return parseDump(stdout);
}

async function dumpLinux(opts: AxDumpOptions, timeoutMs: number): Promise<AxDump> {
    const script = join(projectRoot(), "scripts", "dump_atspi.py");
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

function flattenInteractiveJs(dump: AxDump): AxFlatElement[] {
    const out: AxFlatElement[] = [];
    let id = 1;
    function walk(node: AxNode, path: number[], depth: number) {
        if (depth > MAX_WALK_DEPTH) return;
        if (isInteractiveRole(node.role) && node.w > 0 && node.h > 0) {
            const label = (node.label || "").trim();
            const value = (node.value || "").trim();
            if (label || value) {
                out.push({
                    id: id++,
                    role: node.role || "",
                    label,
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
export function findElementByLabel(elements: AxFlatElement[], query: string, minScore = 0.5): AxFlatElement | null {
    if (!query) return null;
    const q = query.toLowerCase().trim();
    let best: { el: AxFlatElement; score: number } | null = null;
    for (const el of elements) {
        // Score against label AND value separately; take the higher.
        const label = (el.label || "").toLowerCase();
        const value = (el.value || "").toLowerCase();
        if (!label && !value) continue;
        const score = Math.max(scoreText(q, label), scoreText(q, value));
        if (!best || score > best.score) best = { el, score };
    }
    if (!best || best.score < minScore) return null;
    return best.el;
}

function scoreText(q: string, hay: string): number {
    if (!hay) return 0;
    if (hay === q) return 1.0;
    if (hay.includes(q) || q.includes(hay)) return 0.85;
    // Char-overlap similarity for very loose matches.
    const intersect = [...new Set(q)].filter((c) => hay.includes(c)).length;
    return (intersect / Math.max(q.length, 1)) * 0.5;
}
