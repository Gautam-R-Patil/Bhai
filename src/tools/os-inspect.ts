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
    dumpAccessibilityTree,
    flattenInteractive,
    isAxPermissionError,
    matchElementByLabel,
} from "../screen/ax-dump.js";
import { getFrontmostApp } from "../screen/frontmost.js";
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

export const osInspect: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_inspect",
            description:
                "FAST cross-OS accessibility tree dump. Returns a numbered list of interactive elements (buttons, links, text fields, etc.) for the focused app. ~100-300ms typical. After this, use os_click_id with the label number to click. PREFERRED over screenshot+grid for native apps — no vision call needed.",
            parameters: {
                type: "object",
                properties: {
                    pid: {
                        type: "number",
                        description: "Optional process ID to inspect. Default: frontmost app.",
                    },
                    depth: {
                        type: "number",
                        description: "Max tree depth (default 20, max 30). Higher = more elements but slower.",
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
        const pid = typeof input.pid === "number" ? input.pid : 0;
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
            const elements = all.slice(0, maxElements);

            _lastInspect = {
                elements: all, // os_click_id text= can match past the listed cap
                app: dump.app,
                pid: dump.pid,
                wasFront: !pid || (await getFrontmostApp())?.pid === dump.pid,
                depth,
                timestamp: Date.now(),
            };

            // SECURITY: summary uses ONLY `label`, never `value`. Text-field contents (which
            // include passwords, account numbers, etc. if a parent app's AX implementation is
            // imperfect) stay in the in-process cache for os_click_id disambiguation but never
            // reach the LLM's prompt context.
            // Also capped by bytes: past ~8KB the agent swaps the whole result for a
            // 2KB preview (non-Latin labels hit that well before 60 elements).
            const lines: string[] = [];
            let bytes = 0;
            for (const e of elements) {
                const display = e.label ? truncate(e.label, 60) : `<${e.role.toLowerCase()}>`;
                const line = `[${e.id}] (${e.role}) "${display}" at (${e.center.x},${e.center.y})${e.enabled ? "" : " [disabled]"}${e.offscreen ? " [offscreen]" : ""}`;
                bytes += Buffer.byteLength(line) + 1;
                if (bytes > 6000) break;
                lines.push(line);
            }
            const summary = lines.join("\n");

            // Phase 2 finding: empty AT-SPI tree on Linux often means Electron/Chromium without
            // --force-renderer-accessibility. Surface this as a hint.
            let hint: string | undefined;
            if (dump.source === "pyatspi" && all.length === 0) {
                hint =
                    "Empty tree — if targeting an Electron/Chromium app (VS Code, Slack, browsers), relaunch with --force-renderer-accessibility for AT-SPI to populate.";
            }
            if (dump.partial) {
                hint =
                    "Incomplete list: the app stopped answering mid-read, so some elements are missing. Retry os_inspect, or take a screenshot instead.";
            }

            return JSON.stringify({
                success: true,
                app: dump.app,
                pid: dump.pid,
                elapsed_ms: dump.elapsedMs,
                source: dump.source,
                element_count: lines.length,
                total_count: all.length,
                truncated: all.length > lines.length,
                elements: summary,
                hint,
                tip: `Use os_click_id with id=<number> to click an element. Or query by text: os_click_id with text="<query>". Cache TTL: ${Math.round(INSPECT_CACHE_TTL_MS / 1000)}s.`,
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
