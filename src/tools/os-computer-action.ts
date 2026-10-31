// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * os_computer_action — single structured-action tool modeled on Anthropic's
 * computer_20251124. Routes one well-typed action through the per-OS execution
 * path. The agent emits a JSON object; Bhai validates + executes.
 *
 * Prefer this over the multiple legacy os_* tools when emitting complex action
 * sequences — the schema is unambiguous and resolution-independent (percent coords).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cursorClick, cursorDrag, cursorMove, cursorScroll, withCursorTyping } from "../screen/agent-cursor.js";
import { type ComputerAction, parseComputerAction, resolveCoord } from "../screen/computer-action.js";
import { captureRegion, getScreenDimensions, monitorRect, type ScreenDimensions } from "../screen/screen-dimensions.js";
import type { ToolDefinition } from "./get-current-time.js";
import { takeScreenshot } from "./platform-bridge.js";

const execFileAsync = promisify(execFile);

const SCHEMA_DESCRIPTION = `Execute a single computer action with a structured, unambiguous schema. PREFERRED over legacy os_click/os_type/os_press.

Action format (one of):
  click:        { "action":"click", "coord":[0.5,0.3], "coordSystem":"percent", "button":"left", "modifiers":["shift"] }
  double_click: { "action":"double_click", "coord":[0.5,0.3], "coordSystem":"percent" }
  right_click:  { "action":"right_click", "coord":[0.5,0.3], "coordSystem":"percent" }
  mouse_move:   { "action":"mouse_move", "coord":[0.5,0.3], "coordSystem":"percent" }
  drag:         { "action":"drag", "path":[[0.1,0.1],[0.4,0.5]], "coordSystem":"percent" }
  scroll:       { "action":"scroll", "coord":[0.5,0.5], "scrollDy":-120, "coordSystem":"percent" }
  type:         { "action":"type", "text":"hello" }
  key:          { "action":"key", "text":"ctrl+s" }
  hold_key:     { "action":"hold_key", "text":"shift", "durationMs":1500 }
  wait:         { "action":"wait", "durationMs":500 }
  screenshot:   { "action":"screenshot" }
  zoom:         { "action":"zoom", "region":[0.2,0.2,0.6,0.6], "coordSystem":"percent" }

coordSystem: "percent" (DEFAULT, 0..1, resolution-independent) | "image" (image-px, needs imageWidth) | "screen" (already in screen pt)`;

export const osComputerAction: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_computer_action",
            description: SCHEMA_DESCRIPTION,
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        description:
                            "One of: click, double_click, right_click, mouse_move, drag, scroll, type, key, hold_key, wait, screenshot, zoom",
                    },
                    coord: {
                        type: "array",
                        items: { type: "number" },
                        description:
                            "Coordinate as [x, y]. With coordSystem='percent' (default) values are 0..1. Required for click/double_click/right_click/mouse_move/scroll. (zoom uses `region` instead.)",
                    },
                    coordSystem: {
                        type: "string",
                        enum: ["percent", "image", "screen"],
                        description:
                            "How to interpret coord. Default 'percent' (resolution-independent). 'image' requires imageWidth.",
                    },
                    imageWidth: {
                        type: "number",
                        description:
                            "Image width when coordSystem='image' (the screenshot's pixel width as shown to the model).",
                    },
                    button: {
                        type: "string",
                        enum: ["left", "right", "middle"],
                        description: "Click button (click action only). Default 'left'.",
                    },
                    modifiers: {
                        type: "array",
                        items: { type: "string" },
                        description: "Modifier keys for click: shift, command, control, option, alt, ctrl, cmd, meta.",
                    },
                    path: { type: "array", description: "Drag path: array of [x,y] points (>=2)." },
                    scrollDx: { type: "number", description: "Horizontal scroll velocity (positive=right)." },
                    scrollDy: { type: "number", description: "Vertical scroll velocity (positive=down)." },
                    text: {
                        type: "string",
                        description: "Text to type, key combo (e.g. 'ctrl+s'), or hold_key value.",
                    },
                    durationMs: { type: "number", description: "Duration in ms for wait/hold_key (max 60000)." },
                    region: { type: "array", items: { type: "number" }, description: "Zoom region [x0,y0,x1,y1]." },
                    monitorId: {
                        type: "string",
                        description: "Optional pin to a specific monitor; default uses focused window's monitor.",
                    },
                },
                required: ["action"],
            },
        },
    },

    async handler(input) {
        const parsed = parseComputerAction(input);
        if (!parsed.ok) {
            return JSON.stringify({ success: false, error: parsed.error });
        }
        const act = parsed.action;
        try {
            const result = await executeStructuredAction(act);
            return JSON.stringify({ success: true, ...result });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

/**
 * The zoom region as a screen rect: each corner resolved exactly like a click
 * (percent / image + imageWidth / screen → screen points on the focused monitor).
 * It used to crop the main display's raw capture instead, so on Retina an image or
 * screen region cropped about half the intended area, its offset was in physical
 * pixels (clicks from it landed 2x off), and percent zoomed a different monitor.
 */
export async function zoomRect(
    act: Extract<ComputerAction, { action: "zoom" }>,
    dims: ScreenDimensions,
): Promise<{ x: number; y: number; w: number; h: number }> {
    const [x0, y0, x1, y1] = act.region;
    const a = await resolveCoord([x0, y0], act, dims);
    const b = await resolveCoord([x1, y1], act, dims);
    return {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        w: Math.max(1, Math.abs(b.x - a.x)),
        h: Math.max(1, Math.abs(b.y - a.y)),
    };
}

/**
 * Capture a region of the screen at full resolution and return it as base64, so a
 * VLM/grounder can read small dense UI (Figma/Canva toolbars, tiny menu items) that
 * it would otherwise miss in a downscaled full-screen frame. Mirrors Anthropic's
 * computer_20251124 `zoom`. Region is [x0,y0,x1,y1] in the action's coordSystem.
 */
async function executeZoom(
    act: Extract<ComputerAction, { action: "zoom" }>,
    dims?: ScreenDimensions,
): Promise<Record<string, unknown>> {
    const d = dims ?? (await getScreenDimensions({ focusedWindow: true, force: true }));
    const rect = await zoomRect(act, d);
    // macOS captures exactly these points at full pixel density; Linux has no region
    // capture, so crop its full shot (root pixels = screen coords).
    let shot = await captureRegion(rect);
    if (!shot) shot = await cropToRect(await takeScreenshot(), rect, isWayland());
    if (!shot) return { action: "zoom", error: "could_not_capture_region" };
    const sharp = (await import("sharp")).default;
    const meta = await sharp(shot).metadata();
    const imageWidth = meta.width || rect.w;
    return {
        action: "zoom",
        zoomed_base64: (await sharp(shot).png().toBuffer()).toString("base64"),
        region: rect,
        imageWidth,
        imageHeight: meta.height || rect.h,
        note: `Screen points (${rect.x},${rect.y}) to (${rect.x + rect.w},${rect.y + rect.h}) at full resolution. To click something seen here: x = ${rect.x} + px × ${rect.w}/${imageWidth} (same for y with ${rect.y}, ${rect.h}), coordSystem "screen".`,
    };
}

/**
 * Crop `img` (whose pixels are screen coords from 0,0) to `r`; null when `r` doesn't fit inside it.
 * `scaled` (Wayland: grim captures physical pixels, xrandr reports logical ones): pixels aren't
 * screen coords, so the frame is `r` only when it has `r`'s shape, else null.
 */
export async function cropToRect(
    img: Buffer,
    r: { x: number; y: number; w: number; h: number },
    scaled = false,
): Promise<Buffer | null> {
    const sharp = (await import("sharp")).default;
    const { width = 0, height = 0 } = await sharp(img).metadata();
    // ponytail: a scaled 2x2 grid of same-shape monitors passes this check; scale r by the frame if that bites.
    if (scaled) return height > 0 && Math.abs(width / height - r.w / r.h) < 0.01 ? img : null;
    if (r.x < 0 || r.y < 0 || r.x + r.w > width || r.y + r.h > height) return null;
    if (r.x === 0 && r.y === 0 && r.w === width && r.h === height) return img;
    return sharp(img).extract({ left: r.x, top: r.y, width: r.w, height: r.h }).png().toBuffer();
}

/** Run one parsed action. `dims` (the focused monitor) skips a re-probe when the caller already has it. */
export async function executeStructuredAction(
    act: ComputerAction,
    dims?: ScreenDimensions,
): Promise<Record<string, unknown>> {
    switch (act.action) {
        case "click":
        case "double_click":
        case "triple_click":
        case "right_click":
        case "mouse_move": {
            const coord = await resolveCoord(act.coord, act, dims);
            await dispatchMouse(
                act.action,
                coord.x,
                coord.y,
                "button" in act ? act.button : undefined,
                "modifiers" in act ? act.modifiers : undefined,
            );
            return { action: act.action, x: coord.x, y: coord.y, monitorId: coord.monitorId };
        }
        case "drag": {
            const points: Array<{ x: number; y: number }> = [];
            for (const p of act.path) {
                const r = await resolveCoord(p, act, dims);
                points.push({ x: r.x, y: r.y });
            }
            await dispatchDrag(points);
            return { action: "drag", points };
        }
        case "scroll": {
            const coord = await resolveCoord(act.coord, act, dims);
            await dispatchScroll(coord.x, coord.y, act.scrollDx || 0, act.scrollDy);
            return { action: "scroll", x: coord.x, y: coord.y, scrollDx: act.scrollDx || 0, scrollDy: act.scrollDy };
        }
        case "type":
            await withCursorTyping(() => dispatchType(act.text));
            return { action: "type", typed_chars: act.text.length }; // not echoed: it may be a secret
        case "key":
            await dispatchKey(act.text);
            return { action: "key", pressed: act.text };
        case "hold_key":
            await dispatchHoldKey(act.text, act.durationMs);
            return { action: "hold_key", held: act.text, durationMs: act.durationMs };
        case "wait":
            await new Promise((r) => setTimeout(r, Math.max(0, Math.min(60_000, act.durationMs))));
            return { action: "wait", durationMs: act.durationMs };
        case "screenshot": {
            // The focused window's monitor — the same one percent/image coords resolve against.
            const d = dims ?? (await getScreenDimensions({ focusedWindow: true, force: true }));
            const rect = monitorRect(d);
            let raw = rect && (await captureRegion(rect));
            // Linux has no region capture and its full shot spans every monitor (root
            // pixels = screen coords): crop it to this monitor, or say the frame is off.
            let wholeDesktop = false;
            if (!raw) {
                const full = await takeScreenshot();
                raw = full;
                if (process.platform === "linux" && rect) {
                    const cropped = await cropToRect(full, rect, isWayland());
                    if (cropped) raw = cropped;
                    else wholeDesktop = true;
                }
            }
            const { downscaleForVision } = await import("../screen/ui-tars.js");
            const img = await downscaleForVision(raw, { jpeg: true });
            return {
                action: "screenshot",
                screenshot_base64: img.buf.toString("base64"),
                mime_type: img.mime,
                imageWidth: img.width,
                imageHeight: img.height,
                ...(wholeDesktop
                    ? {
                          note: 'Whole desktop, not one monitor: image/percent coords will not line up. Use coordSystem "screen" or os_screenshot.',
                      }
                    : {
                          monitor: d.monitorId,
                          note: `Click with coordSystem "image" + imageWidth ${img.width}, or coordSystem "percent".`,
                      }),
            };
        }
        case "zoom":
            return await executeZoom(act, dims);
        default: {
            const _exhaustive: never = act;
            throw new Error(`Unhandled action: ${JSON.stringify(_exhaustive)}`);
        }
    }
}

async function dispatchMouse(
    action: "click" | "double_click" | "triple_click" | "right_click" | "mouse_move",
    x: number,
    y: number,
    button?: "left" | "right" | "middle",
    modifiers?: ReadonlyArray<string>,
): Promise<void> {
    if (action === "mouse_move") await cursorMove(x, y);
    else {
        const count = action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
        await cursorClick(x, y, action === "right_click" ? "right" : button || "left", count);
    }
    if (process.platform === "darwin") {
        const jxa = buildMacMouseJxa(action, x, y, button, modifiers);
        await execFileAsync("osascript", ["-l", "JavaScript", "-e", jxa], { timeout: 5000 });
        return;
    }
    if (process.platform === "win32") {
        // A shift-click sent as a plain click would report a success it didn't have.
        if (modifiers?.length)
            throw new Error("click modifiers are not supported on Windows; use a key action instead");
        const ps = buildWinMousePs(action, x, y, button);
        await execFileAsync(
            "powershell",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
            { timeout: 5000 },
        );
        return;
    }
    if (process.platform === "linux") {
        await dispatchLinuxMouse(action, x, y, button, modifiers);
        return;
    }
    throw new Error(`Unsupported platform: ${process.platform}`);
}

type MouseAction = "click" | "double_click" | "triple_click" | "right_click" | "mouse_move";

function clickCount(action: MouseAction): number {
    return action === "double_click" ? 2 : action === "triple_click" ? 3 : action === "mouse_move" ? 0 : 1;
}

// CGEventFlags masks (numeric: the JXA bridge has no names for them).
const MAC_MODIFIER_FLAGS: Record<string, number> = {
    shift: 0x20000,
    control: 0x40000,
    ctrl: 0x40000,
    option: 0x80000,
    alt: 0x80000,
    command: 0x100000,
    cmd: 0x100000,
    meta: 0x100000,
};

/** JXA for a move / click with any button, click count and held modifiers (posted on the down/up events). */
export function buildMacMouseJxa(
    action: MouseAction,
    x: number,
    y: number,
    button: "left" | "right" | "middle" = "left",
    modifiers?: ReadonlyArray<string>,
): string {
    const flags = (modifiers ?? []).reduce((f, m) => f | (MAC_MODIFIER_FLAGS[m] ?? 0), 0);
    // post(type, button, clickState, withFlags). kCGEventMouseMoved = 5.
    let js = `ObjC.import('CoreGraphics');var pt=$.CGPointMake(${x},${y});function post(t,b,n,f){var e=$.CGEventCreateMouseEvent(null,t,pt,b);if(n)$.CGEventSetIntegerValueField(e,$.kCGMouseEventClickState,n);if(f)$.CGEventSetFlags(e,${flags});$.CGEventPost($.kCGHIDEventTap,e);}post(5,0,0,0);`;
    const b = action === "right_click" ? "right" : button;
    // [down, up, CGMouseButton]: left 1/2/0, right 3/4/1, other (middle) 25/26/2.
    const [down, up, code] = b === "right" ? [3, 4, 1] : b === "middle" ? [25, 26, 2] : [1, 2, 0];
    for (let n = 1; n <= clickCount(action); n++) {
        js += `delay(0.05);post(${down},${code},${n},1);delay(0.02);post(${up},${code},${n},1);`;
    }
    return `${js}"${action}"`;
}

function buildWinMousePs(action: MouseAction, x: number, y: number, button?: "left" | "right" | "middle"): string {
    // Coords are pre-rounded ints (no injection risk). mouse_event flags: down/up per button.
    const b = action === "right_click" ? "right" : button;
    const [down, up] =
        b === "right" ? ["0x0008", "0x0010"] : b === "middle" ? ["0x0020", "0x0040"] : ["0x0002", "0x0004"];
    const one = `[WinMouse]::mouse_event(${down}, 0, 0, 0, [UIntPtr]::Zero); [WinMouse]::mouse_event(${up}, 0, 0, 0, [UIntPtr]::Zero)`;
    const events = Array.from({ length: clickCount(action) }, () => one).join("; Start-Sleep -Milliseconds 50; ");
    return `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinMouse {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
"@
[WinMouse]::SetCursorPos(${x}, ${y}) | Out-Null
Start-Sleep -Milliseconds 50
${events}
`.trim();
}

async function dispatchLinuxMouse(
    action: "click" | "double_click" | "triple_click" | "right_click" | "mouse_move",
    x: number,
    y: number,
    button?: "left" | "right" | "middle",
    modifiers?: ReadonlyArray<string>,
): Promise<void> {
    const b = action === "right_click" ? "right" : button;
    const repeats = clickCount(action);
    if (isWayland()) {
        if (modifiers?.length) throw new Error("click modifiers are not supported under Wayland (ydotool)");
        await ensureYdotoold();
        await execFileAsync("ydotool", ["mousemove", "--absolute", "-x", String(x), "-y", String(y)], {
            timeout: 3000,
        });
        // ydotool button codes: 0xC0=left, 0xC1=right, 0xC2=middle (USB HID codes)
        const btn = b === "right" ? "0xC1" : b === "middle" ? "0xC2" : "0xC0";
        for (let i = 0; i < repeats; i++) {
            await execFileAsync("ydotool", ["click", btn], { timeout: 3000 });
            if (i < repeats - 1) await new Promise((r) => setTimeout(r, 50));
        }
        return;
    }
    await execFileAsync("xdotool", ["mousemove", String(x), String(y)], { timeout: 3000 });
    if (!repeats) return;
    const mods = (modifiers ?? []).map((m) => xdotoolKeySpec(m)).join("+");
    const btn = b === "right" ? "3" : b === "middle" ? "2" : "1";
    // One chained xdotool call: hold modifiers, click, release.
    const args = [
        ...(mods ? ["keydown", mods] : []),
        "click",
        "--repeat",
        String(repeats),
        "--delay",
        "50",
        btn,
        ...(mods ? ["keyup", mods] : []),
    ];
    await execFileAsync("xdotool", args, { timeout: 3000 });
}

async function dispatchDrag(points: Array<{ x: number; y: number }>): Promise<void> {
    if (points.length < 2) return;
    await cursorDrag(points);
    if (process.platform === "darwin") {
        const ops: string[] = [
            `ObjC.import('CoreGraphics');var pt0=$.CGPointMake(${points[0].x},${points[0].y});$.CGEventPost($.kCGHIDEventTap,$.CGEventCreateMouseEvent(null,$.kCGEventMouseMoved,pt0,$.kCGMouseButtonLeft));delay(0.05);$.CGEventPost($.kCGHIDEventTap,$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseDown,pt0,$.kCGMouseButtonLeft));`,
        ];
        for (let i = 1; i < points.length; i++) {
            ops.push(
                `delay(0.03);var p${i}=$.CGPointMake(${points[i].x},${points[i].y});$.CGEventPost($.kCGHIDEventTap,$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseDragged,p${i},$.kCGMouseButtonLeft));`,
            );
        }
        const last = points[points.length - 1];
        ops.push(
            `delay(0.05);$.CGEventPost($.kCGHIDEventTap,$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseUp,$.CGPointMake(${last.x},${last.y}),$.kCGMouseButtonLeft));"dragged"`,
        );
        await execFileAsync("osascript", ["-l", "JavaScript", "-e", ops.join("")], { timeout: 10000 });
        return;
    }
    if (process.platform === "linux") {
        await execFileAsync("xdotool", ["mousemove", String(points[0].x), String(points[0].y)], { timeout: 3000 });
        await execFileAsync("xdotool", ["mousedown", "1"], { timeout: 3000 });
        for (let i = 1; i < points.length; i++) {
            await execFileAsync("xdotool", ["mousemove", String(points[i].x), String(points[i].y)], { timeout: 3000 });
        }
        await execFileAsync("xdotool", ["mouseup", "1"], { timeout: 3000 });
        return;
    }
    if (process.platform === "win32") {
        // SetCursorPos + mouse_event LEFTDOWN at p0 → move through intermediate
        // points → LEFTUP at the last. mouse_event flags: 0x0002 LEFTDOWN, 0x0004 LEFTUP.
        const moves = points
            .map((p, idx) => {
                if (idx === 0) {
                    return `[WinDrag]::SetCursorPos(${p.x}, ${p.y}) | Out-Null; Start-Sleep -Milliseconds 40; [WinDrag]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)`;
                }
                return `Start-Sleep -Milliseconds 30; [WinDrag]::SetCursorPos(${p.x}, ${p.y}) | Out-Null`;
            })
            .join("\n");
        const last = points[points.length - 1];
        const ps = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinDrag {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);
}
"@
${moves}
Start-Sleep -Milliseconds 50
[WinDrag]::SetCursorPos(${last.x}, ${last.y}) | Out-Null
[WinDrag]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
`.trim();
        await execFileAsync(
            "powershell",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
            { timeout: 15000 },
        );
        return;
    }
    throw new Error(`drag not yet implemented for platform: ${process.platform}`);
}

async function dispatchScroll(x: number, y: number, dx: number, dy: number): Promise<void> {
    await cursorScroll(x, y, dx, dy);
    if (process.platform === "darwin") {
        // CGEventCreateScrollWheelEvent: positive Y = scroll UP. Our API convention is
        // positive Y = scroll DOWN (matches DOM wheel events). So we NEGATE.
        const lines = Math.round(dy / 40); // ~40 px per scroll line
        const ddx = Math.round(dx / 40);
        const jxa = `ObjC.import('CoreGraphics');$.CGEventPost($.kCGHIDEventTap,$.CGEventCreateMouseEvent(null,$.kCGEventMouseMoved,$.CGPointMake(${x},${y}),$.kCGMouseButtonLeft));delay(0.03);$.CGEventPost($.kCGHIDEventTap,$.CGEventCreateScrollWheelEvent(null,$.kCGScrollEventUnitLine,2,${-lines},${ddx}));"scrolled"`;
        await execFileAsync("osascript", ["-l", "JavaScript", "-e", jxa], { timeout: 5000 });
        return;
    }
    if (process.platform === "linux") {
        const useWayland = isWayland();
        if (useWayland) {
            await ensureYdotoold();
            await execFileAsync("ydotool", ["mousemove", "--absolute", "-x", String(x), "-y", String(y)], {
                timeout: 3000,
            });
            // ydotool has no wheel buttons (`click 4/5` does nothing); the wheel is
            // `mousemove --wheel`, where positive y is up (REL_WHEEL), so negate ours.
            const ticks = Math.max(1, Math.abs(Math.round(dy / 40)));
            await execFileAsync("ydotool", ["mousemove", "--wheel", "-x", "0", "-y", String(dy > 0 ? -ticks : ticks)], {
                timeout: 3000,
            });
            return;
        }
        await execFileAsync("xdotool", ["mousemove", String(x), String(y)], { timeout: 3000 });
        const ticks = Math.max(1, Math.abs(Math.round(dy / 40)));
        const button = dy > 0 ? "5" : "4";
        for (let i = 0; i < ticks; i++) {
            await execFileAsync("xdotool", ["click", button], { timeout: 2000 });
        }
        return;
    }
    if (process.platform === "win32") {
        // Windows scroll: use SendInput WHEEL via P/Invoke. Coords are pre-rounded ints, dy/dx
        // come from parser which caps at ±10000.
        const wheelDelta = Math.round(dy); // mouse_event takes WHEEL_DELTA (120 = one notch); we treat dy as already-scaled
        const ps = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinScroll {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);
}
"@
[WinScroll]::SetCursorPos(${x}, ${y}) | Out-Null
Start-Sleep -Milliseconds 30
[WinScroll]::mouse_event(0x0800, 0, 0, ${-wheelDelta}, [UIntPtr]::Zero)
`.trim();
        await execFileAsync(
            "powershell",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
            { timeout: 5000 },
        );
        return;
    }
    throw new Error(`scroll not yet implemented for platform: ${process.platform}`);
}

/** Detect Wayland session on Linux. Mirrors src/tools/linux.ts isWayland(). */
function isWayland(): boolean {
    if (process.platform !== "linux") return false;
    if (process.env.WAYLAND_DISPLAY) return true;
    if (process.env.XDG_SESSION_TYPE === "wayland") return true;
    return false;
}

/** Best-effort start of ydotoold daemon. Mirrors src/tools/linux.ts. */
async function ensureYdotoold(): Promise<void> {
    try {
        await execFileAsync("pgrep", ["ydotoold"], { timeout: 1500 });
        return;
    } catch {
        try {
            const { spawn } = await import("node:child_process");
            spawn("ydotoold", [], { detached: true, stdio: "ignore" }).unref();
            await new Promise((r) => setTimeout(r, 500));
        } catch {
            /* not installed — caller may still fail */
        }
    }
}

// Real synthetic keystrokes (not clipboard-paste) are required for games,
// terminals, key-repeat-sensitive fields, and to avoid clobbering the user's
// clipboard. We use real keystrokes for short ASCII text and fall back to the
// (faster, unicode-safe) clipboard-paste only for long or non-ASCII strings.
// BHAI_TYPE_VIA_CLIPBOARD=true forces the old paste behavior everywhere.
export function shouldRealKeystroke(text: string): boolean {
    if (process.env.BHAI_TYPE_VIA_CLIPBOARD === "true") return false;
    // ASCII printable only, and short enough that per-char synthesis isn't slow.
    return text.length <= 200 && /^[\x20-\x7e]*$/.test(text);
}

// The text comes in on stdin: it may be a revealed OTP or card number, and a
// command line is visible to every process. Paste mode snapshots every item and
// type on the pasteboard (images and files too, not just text), marks the pasted
// text so clipboard managers skip it (nspasteboard.org), and puts it all back.
export const MAC_TYPE_JXA = `ObjC.import('AppKit');
function run(argv) {
    const text = $.NSString.alloc.initWithDataEncoding($.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile, $.NSUTF8StringEncoding).js;
    const se = Application('System Events');
    if (argv[0] === 'keys') { se.keystroke(text); return; }
    const pb = $.NSPasteboard.generalPasteboard;
    const saved = [];
    const items = pb.pasteboardItems;
    for (let i = 0; i < items.count; i++) {
        const it = items.objectAtIndex(i), types = it.types, entry = [];
        for (let j = 0; j < types.count; j++) {
            const t = types.objectAtIndex(j), d = it.dataForType(t);
            if (!d.isNil()) entry.push([t, d]);
        }
        saved.push(entry);
    }
    pb.clearContents;
    pb.setStringForType($(text), $.NSPasteboardTypeString);
    pb.setStringForType($(''), $('org.nspasteboard.ConcealedType'));
    pb.setStringForType($(''), $('org.nspasteboard.TransientType'));
    se.keystroke('v', { using: 'command down' });
    // Restore only after the app has taken the paste: a window still opening
    // (Cmd+N just before) read the pasteboard late and got the user's own
    // clipboard. An accessibility round-trip to the frontmost app returns only
    // once its main thread is free, which it isn't until the queued paste ran.
    delay(0.15);
    try { const front = se.processes.whose({ frontmost: true })[0]; front.windows.length; front.windows[0].name(); } catch (e) {}
    delay(0.35);
    pb.clearContents;
    if (saved.length) {
        pb.writeObjects($(saved.map((entry) => {
            const it = $.NSPasteboardItem.alloc.init;
            entry.forEach(([t, d]) => it.setDataForType(d, t));
            return it;
        })));
    }
}`;

/** Type `text` into the focused app on macOS: real keystrokes when short ASCII, else paste. */
export async function typeTextMac(text: string): Promise<"keystroke" | "paste"> {
    const mode = shouldRealKeystroke(text) ? "keystroke" : "paste";
    const { spawn } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
        const child = spawn(
            "osascript",
            ["-l", "JavaScript", "-e", MAC_TYPE_JXA, mode === "keystroke" ? "keys" : "paste"],
            {
                stdio: ["pipe", "ignore", "pipe"],
            },
        );
        let stderr = "";
        child.stderr.on("data", (d) => {
            stderr += d;
        });
        const t = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("typing timed out"));
        }, 15_000);
        child.on("exit", (code) => {
            clearTimeout(t);
            if (code === 0) resolve();
            else reject(new Error(stderr.trim().slice(0, 300) || `osascript exited with ${code}`));
        });
        child.on("error", (err) => {
            clearTimeout(t);
            reject(err);
        });
        child.stdin.on("error", () => {}); // EPIPE if osascript died first: the exit handler reports it
        child.stdin.end(text, "utf-8");
    });
    return mode;
}

export async function dispatchType(text: string): Promise<void> {
    if (process.platform === "darwin") {
        await typeTextMac(text);
        return;
    }
    if (process.platform === "linux") {
        if (isWayland()) {
            await ensureYdotoold();
            await execFileAsync("ydotool", ["type", "--", text], { timeout: 10000 });
            return;
        }
        // xdotool already correctly uses `--` separator (no flag injection risk).
        await execFileAsync("xdotool", ["type", "--", text], { timeout: 10000 });
        return;
    }
    if (process.platform === "win32") {
        if (shouldRealKeystroke(text)) {
            // Real keystrokes via SendKeys of the literal text (stdin-fed, base64
            // command — text never hits a command line). SendKeys treats
            // +^%~(){}[] as metacharacters, so they're brace-escaped.
            await typeWindowsViaStdin(text);
            return;
        }
        // SECURITY: pass the text via stdin to a base64-encoded PS command. The PS
        // -EncodedCommand arg is base64 (no shell-meta interpretation), and we read
        // the text from stdin so the actual string never appears in any command line.
        await pasteWindowsViaStdin(text);
        return;
    }
    throw new Error(`type not yet implemented for platform: ${process.platform}`);
}

// [Console]::In decodes stdin with the OEM code page and mangles non-ASCII;
// read the raw bytes and decode them as the UTF-8 we write.
const PS_READ_STDIN_UTF8 =
    "$ms = New-Object System.IO.MemoryStream; [Console]::OpenStandardInput().CopyTo($ms); " +
    "$txt = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())";

/**
 * Type literal text on Windows via real synthetic keystrokes (SendKeys), reading
 * the text from stdin so it never appears on a command line. Escapes SendKeys
 * metacharacters {}+^%~()[] by brace-wrapping each.
 */
async function typeWindowsViaStdin(text: string): Promise<void> {
    const psScript = `
${PS_READ_STDIN_UTF8}
$esc = ($txt.ToCharArray() | ForEach-Object {
    if ('+^%~(){}[]'.Contains($_)) { '{' + $_ + '}' } else { [string]$_ }
}) -join ''
(New-Object -ComObject WScript.Shell).SendKeys($esc)
`.trim();
    const encoded = Buffer.from(psScript, "utf16le").toString("base64");
    const { spawn } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
        const child = spawn(
            "powershell",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
            { stdio: ["pipe", "pipe", "pipe"] },
        );
        const t = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("typeWindowsViaStdin timeout"));
        }, 15_000);
        child.on("exit", (code) => {
            clearTimeout(t);
            if (code === 0) resolve();
            else reject(new Error(`powershell exited with ${code}`));
        });
        child.on("error", (err) => {
            clearTimeout(t);
            reject(err);
        });
        child.stdin.end(text, "utf-8");
    });
}

/**
 * Set the Windows clipboard to arbitrary text and paste via Ctrl+V, without ever
 * interpolating the text into a command line. We base64-encode a tiny PS script that
 * reads from stdin and writes to clipboard, then pipe the text in.
 */
async function pasteWindowsViaStdin(text: string): Promise<void> {
    const psScript = `
${PS_READ_STDIN_UTF8}
Set-Clipboard -Value $txt
Start-Sleep -Milliseconds 50
(New-Object -ComObject WScript.Shell).SendKeys('^v')
`.trim();
    const encoded = Buffer.from(psScript, "utf16le").toString("base64");
    const { spawn } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
        const child = spawn(
            "powershell",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
            { stdio: ["pipe", "pipe", "pipe"] },
        );
        const t = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("pasteWindowsViaStdin timeout"));
        }, 10_000);
        child.on("exit", (code) => {
            clearTimeout(t);
            if (code === 0) resolve();
            else reject(new Error(`powershell exited with ${code}`));
        });
        child.on("error", (err) => {
            clearTimeout(t);
            reject(err);
        });
        child.stdin.end(text, "utf-8");
    });
}

// macOS virtual key codes. Unknown names are an error, never a guess: a
// Return fallback once turned "esc" into confirming the dialog it meant to
// close, and typing the literal word "home" is no better.
export const MAC_KEY_CODES: Record<string, number> = {
    return: 36,
    enter: 36,
    tab: 48,
    escape: 53,
    esc: 53,
    delete: 51,
    backspace: 51,
    "forward delete": 117,
    forwarddelete: 117,
    space: 49,
    up: 126,
    down: 125,
    left: 123,
    right: 124,
    "up arrow": 126,
    "down arrow": 125,
    "left arrow": 123,
    "right arrow": 124,
    home: 115,
    end: 119,
    pageup: 116,
    "page up": 116,
    pagedown: 121,
    "page down": 121,
    f1: 122,
    f2: 120,
    f3: 99,
    f4: 118,
    f5: 96,
    f6: 97,
    f7: 98,
    f8: 100,
    f9: 101,
    f10: 109,
    f11: 103,
    f12: 111,
};

const MAC_MOD_DOWN: Record<string, string> = {
    command: "command down",
    cmd: "command down",
    meta: "command down",
    shift: "shift down",
    option: "option down",
    alt: "option down",
    control: "control down",
    ctrl: "control down",
    "⌘": "command down",
    "⇧": "shift down",
    "⌥": "option down",
    "⌃": "control down",
};

/**
 * Split "cmd+shift+s" into lowercased modifiers + key; "cmd++", "cmd + +" and "+" press
 * the plus key, " " is space. A lone key keeps its case ("Y" stays "Y"); a single
 * character under modifiers is lowercased. An empty segment ("cmd+shift+") throws instead of pressing only the
 * modifiers.
 */
export function splitCombo(combo: string): { mods: string[]; key: string } {
    const s = combo.trim();
    if (!s) {
        if (combo) return { mods: [], key: "space" };
        throw new Error("Empty key.");
    }
    if (s === "+") return { mods: [], key: "+" };
    const plusKey = /\+\s*\+$/.test(s);
    const rest = plusKey ? s.replace(/\+\s*\+$/, "").trim() : s;
    if (plusKey && !rest) return { mods: [], key: "+" };
    const parts = rest.split("+").map((p) => p.trim());
    if (parts.some((p) => !p)) throw new Error(`Malformed combo "${combo}": empty key between "+" signs.`);
    const key = plusKey ? "+" : (parts.pop() as string);
    const mods = parts.map((m) => m.toLowerCase());
    // Names keep their case (X keysyms like Page_Down are case-sensitive); a letter
    // under modifiers is lowercased so "ctrl+A" doesn't become ctrl+shift+a.
    return { mods, key: mods.length && [...key].length === 1 ? key.toLowerCase() : key };
}

/** The AppleScript line for a key or combo ("enter", "cmd+shift+s", "home", "f5"). Throws on an unknown name. */
export function macKeyScript(combo: string): string {
    const { mods, key } = splitCombo(combo);
    const bad = mods.find((m) => !MAC_MOD_DOWN[m]);
    if (bad) throw new Error(`Unknown modifier "${bad}". Use command, shift, option or control.`);
    const using = mods.length ? ` using {${mods.map((m) => MAC_MOD_DOWN[m]).join(", ")}}` : "";
    const named = key.toLowerCase();
    if (Object.hasOwn(MAC_KEY_CODES, named))
        return `tell application "System Events" to key code ${MAC_KEY_CODES[named]}${using}`;
    if ([...key].length === 1)
        return `tell application "System Events" to keystroke "${escapeApplescript(key)}"${using}`;
    throw new Error(
        `Unknown key "${key}". Use one of: ${Object.keys(MAC_KEY_CODES).join(", ")}, or a single character.`,
    );
}

// X11 keysyms for the names agents use (xdotool needs "Return", not "enter").
const XDO_KEYS: Record<string, string> = {
    return: "Return",
    enter: "Return",
    tab: "Tab",
    escape: "Escape",
    esc: "Escape",
    backspace: "BackSpace",
    delete: "Delete",
    "forward delete": "Delete",
    forwarddelete: "Delete",
    space: "space",
    up: "Up",
    down: "Down",
    left: "Left",
    right: "Right",
    home: "Home",
    end: "End",
    pageup: "Prior",
    "page up": "Prior",
    pagedown: "Next",
    "page down": "Next",
    insert: "Insert",
    ctrl: "ctrl",
    control: "ctrl",
    shift: "shift",
    alt: "alt",
    option: "alt",
    super: "super",
    win: "super",
    cmd: "super",
    command: "super",
    meta: "super",
    "+": "plus",
    plus: "plus",
    capslock: "Caps_Lock",
    print: "Print",
    menu: "Menu",
    pause: "Pause",
};
// Single punctuation characters → their keysym names ("ctrl+-" → "ctrl+minus").
const XDO_PUNCT: Record<string, string> = {
    " ": "space",
    "-": "minus",
    "=": "equal",
    ",": "comma",
    ".": "period",
    "/": "slash",
    "\\": "backslash",
    ";": "semicolon",
    "'": "apostrophe",
    "`": "grave",
    "[": "bracketleft",
    "]": "bracketright",
    "!": "exclam",
    "@": "at",
    "#": "numbersign",
    $: "dollar",
    "%": "percent",
    "^": "asciicircum",
    "&": "ampersand",
    "*": "asterisk",
    "(": "parenleft",
    ")": "parenright",
    _: "underscore",
    "{": "braceleft",
    "}": "braceright",
    "|": "bar",
    ":": "colon",
    '"': "quotedbl",
    "<": "less",
    ">": "greater",
    "?": "question",
    "~": "asciitilde",
};
// Lowercase X keysym names agents spell out ("ctrl+minus", "ctrl+bracketleft").
const XDO_NAMED_PUNCT = new Set(Object.values(XDO_PUNCT));
// Real capitalized X keysyms, keyed by lowercase so "page_down" also works. xdotool exits 0 on an
// unknown keysym and presses nothing, so anything not listed here throws instead of passing through.
// ponytail: hand-picked subset of keysymdef.h/XF86keysym.h; add names as agents need them.
const XDO_KEYSYMS = new Map(
    [
        "BackSpace Tab Return Escape Delete Insert Home End Left Right Up Down Prior Next Page_Up Page_Down Begin",
        "Print Sys_Req Pause Break Scroll_Lock Num_Lock Caps_Lock Menu Clear Select Execute Find Cancel Help Undo Redo",
        "Shift_L Shift_R Control_L Control_R Alt_L Alt_R Meta_L Meta_R Super_L Super_R Hyper_L Hyper_R",
        "ISO_Left_Tab ISO_Level3_Shift Mode_switch Multi_key",
        "KP_0 KP_1 KP_2 KP_3 KP_4 KP_5 KP_6 KP_7 KP_8 KP_9 KP_Add KP_Subtract KP_Multiply KP_Divide KP_Decimal",
        "KP_Separator KP_Enter KP_Equal KP_Home KP_End KP_Left KP_Right KP_Up KP_Down KP_Prior KP_Next",
        "KP_Page_Up KP_Page_Down KP_Insert KP_Delete KP_Begin",
        "XF86AudioMute XF86AudioLowerVolume XF86AudioRaiseVolume XF86AudioMicMute XF86AudioPlay XF86AudioPause",
        "XF86AudioStop XF86AudioPrev XF86AudioNext XF86AudioRecord XF86AudioRewind XF86AudioForward XF86AudioMedia",
        "XF86MonBrightnessUp XF86MonBrightnessDown XF86KbdBrightnessUp XF86KbdBrightnessDown XF86KbdLightOnOff",
        "XF86Calculator XF86Mail XF86WWW XF86HomePage XF86Search XF86Explorer XF86Back XF86Forward XF86Refresh",
        "XF86Favorites XF86Sleep XF86PowerOff XF86Eject XF86Display XF86WLAN XF86TouchpadToggle XF86ScreenSaver",
    ]
        .join(" ")
        .split(" ")
        .map((k) => [k.toLowerCase(), k]),
);

/** One key name → xdotool keysym. Throws on a name xdotool would silently ignore. */
export function xdotoolKeySpec(name: string): string {
    if (Object.hasOwn(XDO_PUNCT, name)) return XDO_PUNCT[name];
    const raw = name.trim();
    const k = raw.toLowerCase();
    if (Object.hasOwn(XDO_KEYS, k)) return XDO_KEYS[k];
    if (XDO_NAMED_PUNCT.has(k)) return k;
    const f = /^f([1-9]|[12]\d|3[0-5])$/.exec(k);
    if (f) return `F${f[1]}`;
    if (/^[a-z0-9]$/i.test(raw)) return raw;
    if (Object.hasOwn(XDO_PUNCT, raw)) return XDO_PUNCT[raw];
    const sym = XDO_KEYSYMS.get(k);
    if (sym) return sym;
    throw new Error(
        `Unknown key "${name}". Use a letter/digit/punctuation, F1-F35, an X keysym (e.g. Page_Down, KP_Add, XF86AudioMute), or one of: ${Object.keys(XDO_KEYS).join(", ")}.`,
    );
}

/** hold_key on X11: exactly the named key; "W" holds w, not shift+w (matches the ydotool path). */
export function xdotoolHoldKeySpec(name: string): string {
    const raw = name.trim();
    return xdotoolKeySpec(/^[A-Za-z]$/.test(raw) ? raw.toLowerCase() : name);
}

/** "ctrl+enter" → "ctrl+Return". */
export function xdotoolCombo(combo: string): string {
    const { mods, key } = splitCombo(combo);
    return [...mods, key].map(xdotoolKeySpec).join("+");
}

// Linux evdev key codes, for ydotool ≥1.0 ("<code>:1" press, "<code>:0" release).
const EVDEV: Record<string, number> = {
    esc: 1,
    escape: 1,
    backspace: 14,
    tab: 15,
    return: 28,
    enter: 28,
    ctrl: 29,
    control: 29,
    shift: 42,
    alt: 56,
    option: 56,
    space: 57,
    super: 125,
    win: 125,
    cmd: 125,
    command: 125,
    meta: 125,
    home: 102,
    up: 103,
    pageup: 104,
    left: 105,
    right: 106,
    end: 107,
    down: 108,
    pagedown: 109,
    insert: 110,
    delete: 111,
    f11: 87,
    f12: 88,
    minus: 12,
    "-": 12,
    equal: 13,
    "=": 13,
    bracketleft: 26,
    "[": 26,
    bracketright: 27,
    "]": 27,
    semicolon: 39,
    ";": 39,
    apostrophe: 40,
    "'": 40,
    grave: 41,
    "`": 41,
    backslash: 43,
    "\\": 43,
    comma: 51,
    ",": 51,
    period: 52,
    ".": 52,
    slash: 53,
    "/": 53,
};
for (const [row, start] of [
    ["1234567890", 2],
    ["qwertyuiop", 16],
    ["asdfghjkl", 30],
    ["zxcvbnm", 44],
] as const) {
    [...row].forEach((c, i) => {
        EVDEV[c] = start + i;
    });
}
for (let i = 1; i <= 10; i++) EVDEV[`f${i}`] = 58 + i;

function evdevCode(name: string): number {
    const k = name === " " ? "space" : name.toLowerCase().trim();
    if (!Object.hasOwn(EVDEV, k)) throw new Error(`Unknown key "${name}" for ydotool.`);
    return EVDEV[k];
}

/** ydotool `key` args for a combo: press modifiers + key, release in reverse. */
export function ydotoolKeyArgs(combo: string): string[] {
    const { mods, key } = splitCombo(combo);
    // A lone uppercase letter ("Y") needs shift; evdev codes are case-less.
    const codes = [...(/^[A-Z]$/.test(key) ? ["shift"] : []), ...mods, key].map(evdevCode);
    return [...codes.map((c) => `${c}:1`), ...codes.reverse().map((c) => `${c}:0`)];
}

async function dispatchKey(text: string): Promise<void> {
    if (process.platform === "darwin") {
        await execFileAsync("osascript", ["-e", macKeyScript(text)], { timeout: 5000 });
        return;
    }
    if (process.platform === "linux") {
        // Mapped names only: an unknown name is an error, not a silent no-op.
        if (isWayland()) {
            const args = ydotoolKeyArgs(text);
            await ensureYdotoold();
            await execFileAsync("ydotool", ["key", ...args], { timeout: 5000 });
            return;
        }
        await execFileAsync("xdotool", ["key", "--", xdotoolCombo(text)], { timeout: 5000 });
        return;
    }
    if (process.platform === "win32") {
        // SECURITY: SendKeys() argument is built safely, then passed to PS via
        // stdin → EncodedCommand. The actual SendKeys string never touches a command line.
        const sendKeys = mapKeyComboToSendKeys(text);
        await sendKeysWindowsViaStdin(sendKeys);
        return;
    }
    throw new Error(`key not yet implemented for platform: ${process.platform}`);
}

async function sendKeysWindowsViaStdin(sendKeysStr: string): Promise<void> {
    const psScript = `
${PS_READ_STDIN_UTF8}
$keys = $txt
(New-Object -ComObject WScript.Shell).SendKeys($keys)
`.trim();
    const encoded = Buffer.from(psScript, "utf16le").toString("base64");
    const { spawn } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
        const child = spawn(
            "powershell",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
            { stdio: ["pipe", "pipe", "pipe"] },
        );
        const t = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("sendKeysWindowsViaStdin timeout"));
        }, 5_000);
        child.on("exit", (code) => {
            clearTimeout(t);
            if (code === 0) resolve();
            else reject(new Error(`powershell exited with ${code}`));
        });
        child.on("error", (err) => {
            clearTimeout(t);
            reject(err);
        });
        child.stdin.end(sendKeysStr, "utf-8");
    });
}

// macOS Carbon virtual keycodes for letters, digits, arrows, and named keys.
// Lets hold_key (and game movement: w/a/s/d) work for any common key instead of
// only a handful of modifiers. Returns undefined for unknown single tokens.
const MAC_KEYCODES: Record<string, number> = {
    a: 0,
    s: 1,
    d: 2,
    f: 3,
    h: 4,
    g: 5,
    z: 6,
    x: 7,
    c: 8,
    v: 9,
    b: 11,
    q: 12,
    w: 13,
    e: 14,
    r: 15,
    y: 16,
    t: 17,
    o: 31,
    u: 32,
    i: 34,
    p: 35,
    l: 37,
    j: 38,
    k: 40,
    n: 45,
    m: 46,
    "1": 18,
    "2": 19,
    "3": 20,
    "4": 21,
    "5": 23,
    "6": 22,
    "7": 26,
    "8": 28,
    "9": 25,
    "0": 29,
    shift: 56,
    control: 59,
    ctrl: 59,
    option: 58,
    alt: 58,
    command: 55,
    cmd: 55,
    ...MAC_KEY_CODES,
};
function macKeyCode(token: string): number | undefined {
    return MAC_KEYCODES[token];
}

// Windows virtual-key codes. Letters/digits map to their ASCII-uppercase code
// (VK_A=0x41 … VK_0=0x30), so 'w'/'a'/'s'/'d' and any alphanumeric hold works.
const WIN_VK_NAMED: Record<string, number> = {
    shift: 0x10,
    control: 0x11,
    ctrl: 0x11,
    alt: 0x12,
    menu: 0x12,
    enter: 0x0d,
    return: 0x0d,
    space: 0x20,
    tab: 0x09,
    escape: 0x1b,
    esc: 0x1b,
    backspace: 0x08,
    delete: 0x2e,
    up: 0x26,
    down: 0x28,
    left: 0x25,
    right: 0x27,
};
function winVkCode(token: string): number | undefined {
    if (token in WIN_VK_NAMED) return WIN_VK_NAMED[token];
    if (token.length === 1) {
        const c = token.toUpperCase().charCodeAt(0);
        if ((c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39)) return c; // A-Z, 0-9
    }
    return undefined;
}

async function dispatchHoldKey(text: string, durationMs: number): Promise<void> {
    if (process.platform === "darwin") {
        const lower = text.toLowerCase();
        const code = macKeyCode(lower);
        // ERROR on unknown — silent fallback to shift is destructive.
        if (code === undefined) {
            throw new Error(
                `hold_key on macOS: unsupported key '${text}'. Use a letter/digit (e.g. 'w'), an arrow, or a named key.`,
            );
        }
        const seconds = Math.max(0, Math.min(60, durationMs / 1000));
        const jxa = `ObjC.import('CoreGraphics');var down=$.CGEventCreateKeyboardEvent(null,${code},true);$.CGEventPost($.kCGHIDEventTap,down);delay(${seconds});var up=$.CGEventCreateKeyboardEvent(null,${code},false);$.CGEventPost($.kCGHIDEventTap,up);"held"`;
        await execFileAsync("osascript", ["-l", "JavaScript", "-e", jxa], { timeout: durationMs + 5000 });
        return;
    }
    if (process.platform === "linux") {
        const hold = Math.max(0, Math.min(60_000, durationMs));
        if (isWayland()) {
            const code = evdevCode(text);
            await ensureYdotoold();
            await execFileAsync("ydotool", ["key", `${code}:1`], { timeout: 3000 });
            await new Promise((r) => setTimeout(r, hold));
            await execFileAsync("ydotool", ["key", `${code}:0`], { timeout: 3000 });
            return;
        }
        const key = xdotoolHoldKeySpec(text);
        // Add `--` to prevent flag injection.
        await execFileAsync("xdotool", ["keydown", "--", key], { timeout: 3000 });
        await new Promise((r) => setTimeout(r, hold));
        await execFileAsync("xdotool", ["keyup", "--", key], { timeout: 3000 });
        return;
    }
    if (process.platform === "win32") {
        // Best-effort: SendInput doesn't support a "hold" primitive via SendKeys.
        // We use P/Invoke keybd_event with vk-code lookup. Unknown keys throw.
        const lower = text.toLowerCase();
        const code = winVkCode(lower);
        if (code === undefined) {
            throw new Error(
                `hold_key on Windows: unsupported key '${text}'. Use a letter/digit, an arrow, or a named key.`,
            );
        }
        const ps = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinHold {
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@
[WinHold]::keybd_event(${code}, 0, 0x0000, [UIntPtr]::Zero)
Start-Sleep -Milliseconds ${Math.max(0, Math.min(60_000, durationMs))}
[WinHold]::keybd_event(${code}, 0, 0x0002, [UIntPtr]::Zero)
`.trim();
        await execFileAsync(
            "powershell",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
            { timeout: durationMs + 5000 },
        );
        return;
    }
    throw new Error(`hold_key not yet implemented for platform: ${process.platform}`);
}

function escapeApplescript(text: string): string {
    return (
        text
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/\n/g, "\\n")
            .replace(/\r/g, "\\r")
            .replace(/\t/g, "\\t")
            // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL filtered intentionally to prevent osascript injection.
            .replace(/[\u2028\u2029\x00]/g, "")
    );
}

function mapKeyComboToSendKeys(combo: string): string {
    // Map ctrl/alt/shift+key to SendKeys notation: ^=ctrl, %=alt, +=shift.
    // SECURITY: SendKeys treats `+ ^ % ~ ( ) { } [ ]` as control codes. Any non-alphanumeric
    // single-char target MUST be wrapped in `{}` so SendKeys treats it as a literal keypress.
    const parts = combo
        .toLowerCase()
        .split("+")
        .map((p) => p.trim())
        .filter(Boolean);
    if (parts.length === 0) return "";
    const target = parts.pop() || "";
    let prefix = "";
    for (const m of parts) {
        if (m === "ctrl" || m === "control") prefix += "^";
        else if (m === "alt" || m === "option") prefix += "%";
        else if (m === "shift") prefix += "+";
        else if (m === "cmd" || m === "command" || m === "meta") prefix += "^"; // Windows has no Cmd; treat as Ctrl
    }
    const keyMap: Record<string, string> = {
        enter: "{ENTER}",
        return: "{ENTER}",
        tab: "{TAB}",
        escape: "{ESC}",
        esc: "{ESC}",
        space: " ",
        backspace: "{BS}",
        delete: "{DEL}",
        up: "{UP}",
        down: "{DOWN}",
        left: "{LEFT}",
        right: "{RIGHT}",
        home: "{HOME}",
        end: "{END}",
        pageup: "{PGUP}",
        pagedown: "{PGDN}",
        insert: "{INSERT}",
    };
    let k: string;
    if (target in keyMap) {
        k = keyMap[target];
    } else if (target.length === 1 && /[a-z0-9]/.test(target)) {
        // Safe single alphanumeric — pass as-is.
        k = target;
    } else {
        // Any other char (`+`, `(`, etc.) or unknown name → wrap in `{}` so SendKeys
        // treats it as a literal keypress, not a control code.
        k = `{${target.toUpperCase()}}`;
    }
    return prefix + k;
}
