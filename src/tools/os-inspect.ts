// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * os_inspect — fast cross-OS accessibility-tree dump. Returns a numbered list of
 * interactive elements (buttons, links, text fields, ...) for the focused app.
 *
 * 50-200ms typical, vs 1500-4000ms for a vision round-trip. Uses Rust-accelerated
 * walker (5-15× faster than pure-TS for >100-node trees).
 *
 * Combine with os_click_id to click an element by its returned label number.
 */

import {
    AX_PERMISSION_ERROR,
    type AxFlatElement,
    type AxNode,
    dumpAccessibilityTree,
    flattenInteractive,
    isAxPermissionError,
    matchElementByLabel,
} from "../screen/ax-dump.js";
import { getFrontmostApp, pidOfApp } from "../screen/frontmost.js";
import type { ToolDefinition } from "./get-current-time.js";

/** Ids older than this are re-resolved by label before clicking: the UI may have moved. */
const CLICK_ID_FRESH_MS = 3_000;
const DEFAULT_INSPECT_DEPTH = 20; // web content (links) sits ~17 levels deep

// In-process cache of the last flattened list for os_click_id lookup.
interface InspectCache {
    elements: AxFlatElement[];
    app: string;
    pid: number;
    /** The inspected app was frontmost (else an explicit pid: the Dock, a menu extra, a background window). */
    wasFront: boolean;
    depth: number;
    timestamp: number;
    /** The elements a query-filtered inspect listed (their ids are not 1..n). */
    shown?: AxFlatElement[];
}

/** Elements whose label (or a static text's value) shares words with the query, best first. */
export function matchElements<T extends { label?: string | null; value?: string | null; role: string }>(
    all: T[],
    query: string,
): T[] {
    const words = (t: string) => t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const want = [...new Set(words(query))].filter((w) => w.length > 1 || /\d/.test(w));
    if (!want.length) return [];
    return all
        .map((e) => {
            const have = new Set(words(`${e.label ?? ""} ${e.role === "AXStaticText" ? (e.value ?? "") : ""}`));
            return { e, hit: want.filter((w) => have.has(w)).length / want.length };
        })
        .filter((x) => x.hit > 0)
        .sort((a, b) => b.hit - a.hit)
        .map((x) => x.e);
}

// Roles whose AX value is their state (checked, slider position, typed text): it
// changes when the agent uses them, so it can't identify them on a re-check.
const STATE_VALUE_ROLES = new Set([
    "AXCheckBox",
    "AXRadioButton",
    "AXSlider",
    "AXTextField",
    "AXTextArea",
    "AXPopUpButton",
    "AXComboBox",
]);

let _lastInspect: InspectCache | null = null;
const INSPECT_CACHE_TTL_MS = 30_000;

export function getLastInspect(): InspectCache | null {
    if (!_lastInspect) return null;
    if (Date.now() - _lastInspect.timestamp > INSPECT_CACHE_TTL_MS) return null;
    return _lastInspect;
}

const WINDOW_ROLE = /^(AXWindow|Window|window|frame|dialog)$/;
/** Titles of the app's windows (top two levels of the tree), front first as AX lists them. */
export function windowTitles(root: AxNode | undefined): string[] {
    const out: string[] = [];
    for (const n of [root, ...(root?.children ?? [])])
        if (n && WINDOW_ROLE.test(n.role ?? "") && n.label) out.push(truncate(n.label, 80));
    return out.slice(0, 8);
}

export const osInspect: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_inspect",
            description:
                "FAST cross-OS accessibility tree dump. Returns a numbered list of interactive elements (buttons, links, text fields, etc.) for the focused app, or for `app` without bringing it forward (read a background window: Finder's sidebar, a dialog). ~100-300ms typical. After this, use os_click_id with the label number to click. PREFERRED over screenshot+grid and over AppleScript 'entire contents' for native apps — no vision call needed.",
            parameters: {
                type: "object",
                properties: {
                    app: {
                        type: "string",
                        description: "Name of a running app to inspect without switching to it (e.g. 'Finder'). macOS. Default: frontmost app.",
                    },
                    pid: {
                        type: "number",
                        description: "Optional process ID to inspect. Default: frontmost app.",
                    },
                    depth: {
                        type: "number",
                        description: "Max tree depth (default 20, max 30). Higher = more elements but slower.",
                    },
                    query: {
                        type: "string",
                        description:
                            "Only the elements matching these words (labels, and on-screen text), best first, e.g. 'save' or 'wi-fi toggle'. A much smaller result than the full list: use it when you know what you're looking for.",
                    },
                    max_elements: {
                        type: "number",
                        description:
                            'Cap the returned element list at this many (default 60). For an element past the list, click it with os_click_id text="..." (it searches every element).',
                    },
                },
                required: [],
            },
        },
    },

    async handler(input) {
        let pid = typeof input.pid === "number" ? input.pid : 0;
        // Asked to read Finder's sidebar in the background, the model had no pid and fell back to
        // AppleScript 'entire contents' (slow, came back empty). A name is what it has.
        const app = typeof input.app === "string" ? input.app.trim() : "";
        if (!pid && app && process.platform === "darwin") {
            pid = await pidOfApp(app);
            if (!pid) return JSON.stringify({ success: false, error: `${app} isn't running.`, hint: "Open it with app_manager first." });
        }
        const depth = typeof input.depth === "number" ? Math.max(1, Math.min(30, input.depth)) : DEFAULT_INSPECT_DEPTH;
        const maxElements =
            typeof input.max_elements === "number" ? Math.max(5, Math.min(500, input.max_elements)) : 60;

        try {
            const dump = await dumpAccessibilityTree({ pid: pid || undefined, depth });
            if (dump.error) {
                // Invalidate stale cache so subsequent os_click_id can't use post-revoke coords.
                _lastInspect = null;
                return JSON.stringify({
                    success: false,
                    error: isAxPermissionError(dump.error) ? AX_PERMISSION_ERROR : dump.error,
                    hint: isAxPermissionError(dump.error)
                        ? "Grant Bhai Accessibility permission in System Settings → Privacy & Security → Accessibility, then retry."
                        : dump.source === "pyatspi" && dump.error.includes("atspi_not_available")
                          ? "Install python3-pyatspi (apt install python3-pyatspi). Electron apps need --force-renderer-accessibility."
                          : dump.source === "powershell"
                            ? "Ensure UIAutomationClient assemblies are available (PowerShell 5+ on Win 10+)."
                            : "Inspection unavailable on this platform.",
                });
            }

            const all = flattenInteractive(dump);
            // A query returns only the matching elements (ids unchanged, so os_click_id works):
            // a few hundred characters instead of the whole window.
            const query = typeof input.query === "string" ? input.query.trim() : "";
            const elements = query
                ? matchElements(all, query).slice(0, Math.min(maxElements, 15))
                : all.slice(0, maxElements);

            _lastInspect = {
                elements: all, // os_click_id text= can match past the listed cap
                app: dump.app,
                pid: dump.pid,
                wasFront: !pid || (await getFrontmostApp())?.pid === dump.pid,
                depth,
                timestamp: Date.now(),
                ...(query ? { shown: elements } : {}),
            };

            // SECURITY: summary uses `label`, and `value` only for read-only static text (a
            // calculator display, a status line: what a screenshot shows anyway). Text-field
            // contents (which include passwords, account numbers, etc. if a parent app's AX
            // implementation is imperfect) stay in the in-process cache for os_click_id
            // disambiguation but never reach the LLM's prompt context.
            // Also capped by bytes: past ~8KB the agent swaps the whole result for a
            // 2KB preview (non-Latin labels hit that well before 60 elements).
            const lines: string[] = [];
            let bytes = 0;
            for (const e of elements) {
                const display = e.label ? truncate(e.label, 60) : `<${e.role.toLowerCase()}>`;
                const shown =
                    e.role === "AXStaticText" && e.value && e.value !== e.label ? ` = "${truncate(e.value, 80)}"` : "";
                const line = `[${e.id}] (${e.role}) "${display}"${shown} at (${e.center.x},${e.center.y})${e.enabled ? "" : " [disabled]"}${e.offscreen ? " [offscreen]" : ""}`;
                bytes += Buffer.byteLength(line) + 1;
                if (bytes > 6000) break;
                lines.push(line);
            }
            const summary = lines.join("\n");

            // Phase 2 finding: empty AT-SPI tree on Linux often means Electron/Chromium without
            // --force-renderer-accessibility. Surface this as a hint.
            let hint: string | undefined =
                query && !elements.length
                    ? `Nothing matches "${query}" (a query matches element labels, not areas like "sidebar" or "toolbar"). Call os_inspect without query for the full list.`
                    : undefined;
            if (dump.source === "pyatspi" && all.length === 0) {
                hint =
                    "Empty tree — if targeting an Electron/Chromium app (VS Code, Slack, browsers), relaunch with --force-renderer-accessibility for AT-SPI to populate.";
            }
            if (dump.partial) {
                // The walk stops at a 3 s budget (dump_ax.swift). Ran to it: a big window (Finder
                // on Downloads, ~3000 elements), not a hung app; what's listed is accurate. Said
                // as "the app stopped answering", the model called even the sidebar it read unverified.
                const why =
                    dump.elapsedMs >= 2500
                        ? `Big window: the read stopped after ${all.length} elements, so ones further down the tree are missing. Everything listed (and the window titles) is accurate. To find one element, call os_inspect with query="its words".`
                        : "Incomplete list: the app stopped answering mid-read, so some elements are missing. Retry os_inspect, or take a screenshot instead.";
                // A query that matched nothing keeps its own advice first: "sidebar" labels no element,
                // and with only the big-window note the model gave up instead of listing everything.
                hint = hint ? `${hint} ${why}` : why;
            }

            return JSON.stringify({
                success: true,
                app: dump.app,
                pid: dump.pid,
                // The elements are buttons and rows; "what's this window called?" needs the titles.
                windows: windowTitles(dump.root),
                elapsed_ms: dump.elapsedMs,
                source: dump.source,
                element_count: lines.length,
                total_count: all.length,
                truncated: all.length > lines.length,
                elements: summary,
                hint,
                tip: `${query && elements.length ? `To click "${truncate(elements[0].label || elements[0].role, 40)}": os_click_id id=${elements[0].id} (the number in brackets, not its place in this list). ` : ""}Use os_click_id with id=<number> to click an element. Or query by text: os_click_id with text="<query>". Cache TTL: ${Math.round(INSPECT_CACHE_TTL_MS / 1000)}s.`,
            });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

export const osClickId: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_click_id",
            description:
                "Click an element by its label number (from os_inspect) OR by text search. PREFERRED click method for native apps after os_inspect — pixel-perfect, no vision needed.",
            parameters: {
                type: "object",
                properties: {
                    id: {
                        type: "number",
                        description: "Element label number from os_inspect.",
                    },
                    text: {
                        type: "string",
                        description:
                            "Alternative to id: best-match by label/value substring against the last os_inspect result.",
                    },
                    action: {
                        type: "string",
                        enum: ["click", "double_click", "right_click"],
                        description: "Click action (default: click).",
                    },
                },
                required: [],
            },
        },
    },

    async handler(input) {
        const cache = getLastInspect();
        if (!cache) {
            return JSON.stringify({
                success: false,
                error: "No recent os_inspect result. Call os_inspect first.",
            });
        }
        const id = typeof input.id === "number" ? input.id : null;
        const text = typeof input.text === "string" ? input.text : null;
        const action = (input.action as string) || "click";

        let el: AxFlatElement | null = null;
        if (id !== null) {
            // os_inspect query="BhaiEval" listed [195] "BhaiEval"; gpt-4.1-nano clicked id=1
            // (the first in the list), which was "Recents".
            const shown = cache.shown;
            if (shown?.length && id <= shown.length && !shown.some((e) => e.id === id)) {
                return JSON.stringify({
                    success: false,
                    error: `Not clicked: id=${id} wasn't in your last os_inspect list. Ids are the numbers in brackets: ${shown
                        .slice(0, 5)
                        .map((e) => `[${e.id}] "${truncate(e.label || e.role, 40)}"`)
                        .join(", ")}.`,
                });
            }
            el = cache.elements.find((e) => e.id === id) || null;
            if (!el)
                return JSON.stringify({
                    success: false,
                    error: `No element with id=${id} in last inspect (${cache.elements.length} total).`,
                });
        } else if (text) {
            const m = matchElementByLabel(cache.elements, text, 0.5);
            if (m.ambiguous) {
                return JSON.stringify({
                    success: false,
                    error: `"${text}" matches ${m.ambiguous.length} elements equally; click one by id.`,
                    ambiguous: m.ambiguous.map((e) => ({ id: e.id, role: e.role, label: e.label, at: e.center })),
                });
            }
            if (m.disabled) return JSON.stringify({ success: false, error: `"${m.disabled.label}" is disabled.` });
            el = m.el;
            if (!el) return JSON.stringify({ success: false, error: `No element matching "${text}" in last inspect.` });
        } else {
            return JSON.stringify({ success: false, error: "Provide either id (number) or text (string)." });
        }

        // The ids are coordinates from one moment in one app. If another app came
        // to the front, they point into the wrong window; if they're a few
        // seconds old, the UI may have scrolled or re-laid out. Re-check first.
        const age = Date.now() - cache.timestamp;
        const front = await getFrontmostApp();
        if (front && cache.pid && cache.wasFront && front.pid !== cache.pid) {
            return JSON.stringify({
                success: false,
                error: `The frontmost app changed since os_inspect (was ${cache.app}, now ${front.name}). Run os_inspect again.`,
            });
        }
        if (age > CLICK_ID_FRESH_MS) {
            const fresh = await dumpAccessibilityTree({
                pid: cache.pid || undefined,
                depth: Math.max(cache.depth, DEFAULT_INSPECT_DEPTH),
            });
            if (fresh.error)
                return JSON.stringify({ success: false, error: `Could not re-check the element: ${fresh.error}` });
            // A cut-short tree may just be missing the target: don't report it as gone.
            if (fresh.partial)
                return JSON.stringify({
                    success: false,
                    error: "Could not re-check the element: the app was slow and its tree came back incomplete. Retry, or run os_inspect again.",
                });
            const target = el;
            const same = flattenInteractive(fresh)
                .filter(
                    (e) =>
                        e.role === target.role &&
                        e.label === target.label &&
                        (e.value === target.value || (!!e.label && STATE_VALUE_ROLES.has(e.role))),
                )
                .sort(
                    (a, b) =>
                        Math.hypot(a.center.x - target.center.x, a.center.y - target.center.y) -
                        Math.hypot(b.center.x - target.center.x, b.center.y - target.center.y),
                );
            if (!same.length) {
                return JSON.stringify({
                    success: false,
                    error: `"${target.label || target.role}" is no longer on screen (inspect is ${Math.round(age / 1000)}s old). Run os_inspect again.`,
                });
            }
            el = same[0];
        }
        if (el.offscreen) {
            return JSON.stringify({
                success: false,
                error: `"${el.label}" is scrolled out of view; scroll it into view (or use os_smart_click) and inspect again.`,
            });
        }

        // Dispatch via the shared os_computer_action infrastructure to keep one execution path.
        const { osComputerAction } = await import("./os-computer-action.js");
        const result = await osComputerAction.handler({
            action: action === "double_click" ? "double_click" : action === "right_click" ? "right_click" : "click",
            coord: [el.center.x, el.center.y],
            coordSystem: "screen",
        });
        const parsed = JSON.parse(result);
        return JSON.stringify({
            success: parsed.success ?? false,
            clicked_element: { id: el.id, role: el.role, label: el.label, value: el.value },
            screen: el.center,
            action,
            elapsed_ms: cache.timestamp ? Date.now() - cache.timestamp : null,
            dispatch_result: parsed,
        });
    },
};

function truncate(s: string, max: number): string {
    if (!s) return "";
    return s.length <= max ? s : s.slice(0, max) + "…";
}
