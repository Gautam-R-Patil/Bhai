// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import {
    clampToMonitor,
    getScreenDimensions,
    percentageToScreen,
    type ScreenDimensions,
    scaleImageToScreen,
} from "./screen-dimensions.js";

/**
 * Structured computer-action schema modeled on Anthropic's `computer_20251124`
 * tool, with first-class support for resolution-independent percentage coords
 * (the Self-Operating-Computer approach).
 *
 * Three coord forms are accepted; all resolve to screen points at execution time:
 *   1. `coord: [x, y]` with `coordSystem: "screen"` — already in screen pt
 *   2. `coord: [x, y]` with `coordSystem: "image"` + `imageWidth: N` — image px → screen pt via scaleImageToScreen
 *   3. `coord: [percentX, percentY]` with `coordSystem: "percent"` — 0..1 → screen pt via percentageToScreen
 */

export type ComputerCoordSystem = "screen" | "image" | "percent";

export interface ComputerActionCommon {
    coordSystem?: ComputerCoordSystem; // default "percent" (safest for cross-resolution)
    imageWidth?: number; // required when coordSystem === "image"
    monitorId?: string; // optional pin to a specific monitor (default: focused window's monitor)
}

export type ComputerAction =
    | (ComputerActionCommon & {
          action: "click";
          coord: [number, number];
          button?: "left" | "right" | "middle";
          modifiers?: ComputerModifier[];
      })
    | (ComputerActionCommon & { action: "double_click"; coord: [number, number]; button?: "left" | "right" | "middle" })
    | (ComputerActionCommon & { action: "triple_click"; coord: [number, number] })
    | (ComputerActionCommon & { action: "right_click"; coord: [number, number] })
    | (ComputerActionCommon & { action: "mouse_move"; coord: [number, number] })
    | (ComputerActionCommon & { action: "drag"; path: Array<[number, number]> })
    | (ComputerActionCommon & { action: "scroll"; coord: [number, number]; scrollDx?: number; scrollDy: number })
    | { action: "type"; text: string }
    | { action: "key"; text: string }
    | { action: "hold_key"; text: string; durationMs: number }
    | { action: "wait"; durationMs: number }
    | { action: "screenshot" }
    | (ComputerActionCommon & { action: "zoom"; region: [number, number, number, number] });

export type ComputerModifier = "command" | "control" | "shift" | "option" | "alt" | "ctrl" | "cmd" | "meta";

export interface ResolvedCoord {
    x: number;
    y: number;
    monitorId: string;
    scaleFactor: number;
}

export interface ValidationFailure {
    ok: false;
    error: string;
}

export interface ValidationSuccess {
    ok: true;
    action: ComputerAction;
}

/** Parse any of {object, JSON string, plain text} into a ComputerAction. */
export function parseComputerAction(input: unknown): ValidationSuccess | ValidationFailure {
    let obj: unknown = input;
    if (typeof input === "string") {
        try {
            obj = JSON.parse(input);
        } catch {
            return { ok: false, error: "Input is not valid JSON" };
        }
    }
    if (!obj || typeof obj !== "object") return { ok: false, error: "Action must be an object" };
    const raw = obj as Record<string, unknown>;
    const action = String(raw.action || "").toLowerCase();
    if (!action) return { ok: false, error: "Missing required field: action" };

    const common: ComputerActionCommon = {};
    if (raw.coordSystem !== undefined) {
        const cs = String(raw.coordSystem).toLowerCase();
        if (cs !== "screen" && cs !== "image" && cs !== "percent") {
            return { ok: false, error: `Invalid coordSystem: ${raw.coordSystem}` };
        }
        common.coordSystem = cs as ComputerCoordSystem;
    }
    if (typeof raw.imageWidth === "number" && raw.imageWidth > 0) common.imageWidth = raw.imageWidth;
    if (typeof raw.monitorId === "string") common.monitorId = raw.monitorId;

    const needsCoord = [
        "click",
        "double_click",
        "triple_click",
        "right_click",
        "mouse_move",
        "scroll",
        "zoom",
    ].includes(action);
    let coord: [number, number] | null = null;
    if (needsCoord) {
        const c = raw.coord;
        if (!Array.isArray(c) || c.length !== 2 || typeof c[0] !== "number" || typeof c[1] !== "number") {
            return { ok: false, error: `Action "${action}" requires coord: [x, y]` };
        }
        coord = [c[0], c[1]];
        if (common.coordSystem === "image" && !common.imageWidth) {
            return { ok: false, error: "coordSystem=image requires imageWidth" };
        }
    }

    // Narrow `coord` for the cases that require it. The `needsCoord` block above
    // already returned an error if coord was missing — this guard satisfies TS flow.
    const needsCoordCase = needsCoord && action !== "drag";
    if (needsCoordCase && !coord) {
        return { ok: false, error: `Action "${action}" requires coord (internal: should be unreachable)` };
    }

    switch (action) {
        case "click": {
            const button = (typeof raw.button === "string" ? raw.button.toLowerCase() : "left") as
                | "left"
                | "right"
                | "middle";
            if (button !== "left" && button !== "right" && button !== "middle")
                return { ok: false, error: `Invalid button: ${button}` };
            const modifiers = parseModifiers(raw.modifiers);
            return {
                ok: true,
                action: { action: "click", coord: coord as [number, number], button, modifiers, ...common },
            };
        }
        case "double_click":
        case "triple_click":
        case "right_click":
        case "mouse_move":
            return {
                ok: true,
                action: {
                    action: action as "double_click" | "triple_click" | "right_click" | "mouse_move",
                    coord: coord as [number, number],
                    ...common,
                },
            };
        case "drag": {
            const path = raw.path;
            if (!Array.isArray(path) || path.length < 2)
                return { ok: false, error: "drag requires path: [[x,y], [x,y], ...] (>=2 points)" };
            // Bound path length — each point spawns an exec call on Linux.
            const MAX_DRAG_POINTS = 200;
            if (path.length > MAX_DRAG_POINTS)
                return { ok: false, error: `drag.path too long (max ${MAX_DRAG_POINTS} points)` };
            const points: Array<[number, number]> = [];
            for (const p of path) {
                if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== "number" || typeof p[1] !== "number") {
                    return { ok: false, error: "drag.path entries must be [x, y]" };
                }
                points.push([p[0], p[1]]);
            }
            return { ok: true, action: { action: "drag", path: points, ...common } };
        }
        case "scroll": {
            const scrollDy =
                typeof raw.scrollDy === "number"
                    ? raw.scrollDy
                    : typeof raw.scrollAmount === "number"
                      ? raw.scrollAmount
                      : 0;
            const scrollDx = typeof raw.scrollDx === "number" ? raw.scrollDx : 0;
            if (scrollDx === 0 && scrollDy === 0) return { ok: false, error: "scroll needs scrollDx or scrollDy != 0" };
            // Bound velocity — Linux dispatches O(|dy|) exec calls. Cap at ±10000 px-equivalent.
            const MAX_SCROLL = 10_000;
            if (Math.abs(scrollDx) > MAX_SCROLL || Math.abs(scrollDy) > MAX_SCROLL)
                return { ok: false, error: `scroll velocity too large (max ±${MAX_SCROLL} per axis)` };
            return {
                ok: true,
                action: { action: "scroll", coord: coord as [number, number], scrollDx, scrollDy, ...common },
            };
        }
        case "type":
            if (typeof raw.text !== "string" || raw.text.length === 0)
                return { ok: false, error: "type requires non-empty text" };
            // Bound text length — pasting MBs blocks osascript / clipboard for seconds.
            if (raw.text.length > 100_000) return { ok: false, error: "type.text too long (max 100000 chars)" };
            return { ok: true, action: { action: "type", text: raw.text } };
        case "key":
            if (typeof raw.text !== "string" || raw.text.length === 0)
                return { ok: false, error: "key requires text (e.g. 'enter', 'ctrl+c')" };
            if (raw.text.length > 200) return { ok: false, error: "key.text too long (max 200 chars)" };
            return { ok: true, action: { action: "key", text: raw.text } };
        case "hold_key":
            if (typeof raw.text !== "string" || raw.text.length === 0)
                return { ok: false, error: "hold_key requires text" };
            if (raw.text.length > 200) return { ok: false, error: "hold_key.text too long (max 200 chars)" };
            if (typeof raw.durationMs !== "number" || raw.durationMs <= 0)
                return { ok: false, error: "hold_key requires durationMs > 0" };
            // Cap duration to prevent agent from locking input for hours/days.
            if (raw.durationMs > 60_000) return { ok: false, error: "hold_key.durationMs must be <= 60000" };
            return { ok: true, action: { action: "hold_key", text: raw.text, durationMs: raw.durationMs } };
        case "wait": {
            const durationMs =
                typeof raw.durationMs === "number" ? raw.durationMs : typeof raw.delay === "number" ? raw.delay : 1000;
            if (durationMs <= 0 || durationMs > 60_000)
                return { ok: false, error: "wait.durationMs must be in (0, 60000]" };
            return { ok: true, action: { action: "wait", durationMs } };
        }
        case "screenshot":
            return { ok: true, action: { action: "screenshot" } };
        case "zoom": {
            const r = raw.region;
            if (!Array.isArray(r) || r.length !== 4 || !r.every((v) => typeof v === "number"))
                return { ok: false, error: "zoom requires region: [x0,y0,x1,y1]" };
            return {
                ok: true,
                action: {
                    action: "zoom",
                    region: [r[0] as number, r[1] as number, r[2] as number, r[3] as number],
                    ...common,
                },
            };
        }
        default:
            return { ok: false, error: `Unknown action: ${action}` };
    }
}

function parseModifiers(input: unknown): ComputerModifier[] | undefined {
    if (!Array.isArray(input)) return undefined;
    const out: ComputerModifier[] = [];
    for (const m of input) {
        const s = String(m).toLowerCase();
        if (
            s === "command" ||
            s === "control" ||
            s === "shift" ||
            s === "option" ||
            s === "alt" ||
            s === "ctrl" ||
            s === "cmd" ||
            s === "meta"
        ) {
            out.push(s as ComputerModifier);
        }
    }
    return out.length > 0 ? out : undefined;
}

/** Resolve coord (image-px, percent, or screen) to a concrete screen point. */
export async function resolveCoord(
    coord: [number, number],
    common: ComputerActionCommon,
    overrideDims?: ScreenDimensions,
): Promise<ResolvedCoord> {
    const system = common.coordSystem || "percent";
    const dims = overrideDims || (await getScreenDimensions({ focusedWindow: true }));
    if (system === "percent") {
        const { x, y } = percentageToScreen({ percentX: coord[0], percentY: coord[1], dims });
        return { x, y, monitorId: dims.monitorId, scaleFactor: 1 };
    }
    if (system === "image") {
        const imageWidth = common.imageWidth || 0;
        const { x, y, scaleFactor } = scaleImageToScreen({ rawX: coord[0], rawY: coord[1], imageWidth, dims });
        return { x, y, monitorId: dims.monitorId, scaleFactor };
    }
    // screen — global CG/display coords, NOT monitor-relative. We clamp to the picked
    // monitor for defence-in-depth (a Number.MAX_SAFE_INTEGER from a malicious LLM
    // should not reach CGEventCreateMouseEvent / SetCursorPos).
    const clamped = clampToMonitor(coord[0], coord[1], dims);
    return { x: clamped.x, y: clamped.y, monitorId: dims.monitorId, scaleFactor: 1 };
}
