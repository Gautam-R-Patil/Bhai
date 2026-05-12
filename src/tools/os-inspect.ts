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
    type AxFlatElement,
    dumpAccessibilityTree,
    findElementByLabel,
    flattenInteractive,
} from "../screen/ax-dump.js";
import type { ToolDefinition } from "./get-current-time.js";

// In-process cache of the last flattened list for os_click_id lookup.
interface InspectCache {
    elements: AxFlatElement[];
    app: string;
    pid: number;
    timestamp: number;
}

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
                        description: "Max tree depth (default 12, max 30). Higher = more elements but slower.",
                    },
                    max_elements: {
                        type: "number",
                        description:
                            "Cap the returned element list at this many (default 100). Avoids overwhelming the LLM.",
                    },
                },
                required: [],
            },
        },
    },

    async handler(input) {
        const pid = typeof input.pid === "number" ? input.pid : 0;
        const depth = typeof input.depth === "number" ? Math.max(1, Math.min(30, input.depth)) : 12;
        const maxElements =
            typeof input.max_elements === "number" ? Math.max(5, Math.min(500, input.max_elements)) : 100;

        try {
            const dump = await dumpAccessibilityTree({ pid: pid || undefined, depth });
            if (dump.error) {
                return JSON.stringify({
                    success: false,
                    error: dump.error,
                    hint:
                        dump.source === "swift" && dump.error === "not_trusted"
                            ? "Grant ATLAS Accessibility permission in System Settings → Privacy & Security → Accessibility."
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
                elements,
                app: dump.app,
                pid: dump.pid,
                timestamp: Date.now(),
            };

            const summary = elements
                .map(
                    (e) =>
                        `[${e.id}] (${e.role}) "${truncate(e.label || e.value, 60)}" at (${e.center.x},${e.center.y})${e.enabled ? "" : " [disabled]"}`,
                )
                .join("\n");

            return JSON.stringify({
                success: true,
                app: dump.app,
                pid: dump.pid,
                elapsed_ms: dump.elapsedMs,
                source: dump.source,
                element_count: elements.length,
                total_count: all.length,
                truncated: all.length > maxElements,
                elements: summary,
                tip: `Use os_click_id with id=<number> to click an element. Or query by text: os_click_id with text="<query>". Cache TTL: ${INSPECT_CACHE_TTL_MS}ms.`,
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
            el = findElementByLabel(cache.elements, text, 0.5);
            if (!el) return JSON.stringify({ success: false, error: `No element matching "${text}" in last inspect.` });
        } else {
            return JSON.stringify({ success: false, error: "Provide either id (number) or text (string)." });
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
