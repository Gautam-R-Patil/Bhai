// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * os_computer_action — single structured-action tool modeled on Anthropic's
 * computer_20251124. Routes one well-typed action through the per-OS execution
 * path. The agent emits a JSON object; ATLAS validates + executes.
 *
 * Prefer this over the multiple legacy os_* tools when emitting complex action
 * sequences — the schema is unambiguous and resolution-independent (percent coords).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type ComputerAction, parseComputerAction, resolveCoord } from "../screen/computer-action.js";
import { getScreenDimensions } from "../screen/screen-dimensions.js";
import type { ToolDefinition } from "./get-current-time.js";

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
                            "Coordinate as [x, y]. With coordSystem='percent' (default) values are 0..1. Required for click/double_click/right_click/mouse_move/scroll/zoom.",
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

async function executeStructuredAction(act: ComputerAction): Promise<Record<string, unknown>> {
    switch (act.action) {
        case "click":
        case "double_click":
        case "triple_click":
        case "right_click":
        case "mouse_move": {
            const coord = await resolveCoord(act.coord, act);
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
                const r = await resolveCoord(p, act);
                points.push({ x: r.x, y: r.y });
            }
            await dispatchDrag(points);
            return { action: "drag", points };
        }
        case "scroll": {
            const coord = await resolveCoord(act.coord, act);
            await dispatchScroll(coord.x, coord.y, act.scrollDx || 0, act.scrollDy);
            return { action: "scroll", x: coord.x, y: coord.y, scrollDx: act.scrollDx || 0, scrollDy: act.scrollDy };
        }
        case "type":
            await dispatchType(act.text);
            return { action: "type", typed: act.text };
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
            const dims = await getScreenDimensions({ focusedWindow: true });
            return {
                action: "screenshot",
                note: "Use os_screenshot for the actual capture; this only acknowledges the intent.",
                monitor: dims.monitorId,
            };
        }
        case "zoom":
            return {
                action: "zoom",
                region: act.region,
                note: "Zoom region recorded; consumer (e.g. UI-TARS in Phase 3) will crop before grounding.",
            };
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
    _modifiers?: ReadonlyArray<string>,
): Promise<void> {
    if (process.platform === "darwin") {
        const macAction =
            action === "right_click"
                ? "right_click"
                : action === "mouse_move"
                  ? "move"
                  : action === "double_click"
                    ? "double_click"
                    : "click";
        const jxa = buildMacMouseJxa(macAction, x, y, button);
        await execFileAsync("osascript", ["-l", "JavaScript", "-e", jxa], { timeout: 5000 });
        return;
    }
    if (process.platform === "win32") {
        const ps = buildWinMousePs(action, x, y, button);
        await execFileAsync(
            "powershell",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
            { timeout: 5000 },
        );
        return;
    }
    if (process.platform === "linux") {
        await dispatchLinuxMouse(action, x, y, button);
        return;
    }
    throw new Error(`Unsupported platform: ${process.platform}`);
}

function buildMacMouseJxa(action: string, x: number, y: number, _button?: string): string {
    const common = `ObjC.import('CoreGraphics');var pt=$.CGPointMake(${x},${y});`;
    if (action === "move") {
        return `${common}$.CGEventPost($.kCGHIDEventTap,$.CGEventCreateMouseEvent(null,$.kCGEventMouseMoved,pt,$.kCGMouseButtonLeft));"moved"`;
    }
    if (action === "right_click") {
        return `${common}$.CGEventPost($.kCGHIDEventTap,$.CGEventCreateMouseEvent(null,$.kCGEventMouseMoved,pt,$.kCGMouseButtonRight));delay(0.05);$.CGEventPost($.kCGHIDEventTap,$.CGEventCreateMouseEvent(null,$.kCGEventRightMouseDown,pt,$.kCGMouseButtonRight));delay(0.05);$.CGEventPost($.kCGHIDEventTap,$.CGEventCreateMouseEvent(null,$.kCGEventRightMouseUp,pt,$.kCGMouseButtonRight));"right_clicked"`;
    }
    if (action === "double_click") {
        return `${common}$.CGEventPost($.kCGHIDEventTap,$.CGEventCreateMouseEvent(null,$.kCGEventMouseMoved,pt,$.kCGMouseButtonLeft));delay(0.05);var d1=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseDown,pt,$.kCGMouseButtonLeft);$.CGEventSetIntegerValueField(d1,$.kCGMouseEventClickState,1);$.CGEventPost($.kCGHIDEventTap,d1);delay(0.02);var u1=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseUp,pt,$.kCGMouseButtonLeft);$.CGEventSetIntegerValueField(u1,$.kCGMouseEventClickState,1);$.CGEventPost($.kCGHIDEventTap,u1);delay(0.05);var d2=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseDown,pt,$.kCGMouseButtonLeft);$.CGEventSetIntegerValueField(d2,$.kCGMouseEventClickState,2);$.CGEventPost($.kCGHIDEventTap,d2);delay(0.02);var u2=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseUp,pt,$.kCGMouseButtonLeft);$.CGEventSetIntegerValueField(u2,$.kCGMouseEventClickState,2);$.CGEventPost($.kCGHIDEventTap,u2);"double_clicked"`;
    }
    if (action === "triple_click") {
        // 3 down/up pairs with kCGMouseEventClickState 1, 2, 3.
        return `${common}$.CGEventPost($.kCGHIDEventTap,$.CGEventCreateMouseEvent(null,$.kCGEventMouseMoved,pt,$.kCGMouseButtonLeft));delay(0.05);var d1=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseDown,pt,$.kCGMouseButtonLeft);$.CGEventSetIntegerValueField(d1,$.kCGMouseEventClickState,1);$.CGEventPost($.kCGHIDEventTap,d1);delay(0.02);var u1=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseUp,pt,$.kCGMouseButtonLeft);$.CGEventSetIntegerValueField(u1,$.kCGMouseEventClickState,1);$.CGEventPost($.kCGHIDEventTap,u1);delay(0.05);var d2=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseDown,pt,$.kCGMouseButtonLeft);$.CGEventSetIntegerValueField(d2,$.kCGMouseEventClickState,2);$.CGEventPost($.kCGHIDEventTap,d2);delay(0.02);var u2=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseUp,pt,$.kCGMouseButtonLeft);$.CGEventSetIntegerValueField(u2,$.kCGMouseEventClickState,2);$.CGEventPost($.kCGHIDEventTap,u2);delay(0.05);var d3=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseDown,pt,$.kCGMouseButtonLeft);$.CGEventSetIntegerValueField(d3,$.kCGMouseEventClickState,3);$.CGEventPost($.kCGHIDEventTap,d3);delay(0.02);var u3=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseUp,pt,$.kCGMouseButtonLeft);$.CGEventSetIntegerValueField(u3,$.kCGMouseEventClickState,3);$.CGEventPost($.kCGHIDEventTap,u3);"triple_clicked"`;
    }
    // default left click
    return `${common}$.CGEventPost($.kCGHIDEventTap,$.CGEventCreateMouseEvent(null,$.kCGEventMouseMoved,pt,$.kCGMouseButtonLeft));delay(0.05);$.CGEventPost($.kCGHIDEventTap,$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseDown,pt,$.kCGMouseButtonLeft));delay(0.05);$.CGEventPost($.kCGHIDEventTap,$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseUp,pt,$.kCGMouseButtonLeft));"clicked"`;
}

function buildWinMousePs(action: string, x: number, y: number, _button?: string): string {
    // Triple-click added; coords are pre-rounded ints (no injection risk).
    const events =
        action === "mouse_move"
            ? ""
            : action === "right_click"
              ? "[WinMouse]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 50; [WinMouse]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)"
              : action === "double_click"
                ? "[WinMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); [WinMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 50; [WinMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); [WinMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)"
                : action === "triple_click"
                  ? "[WinMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); [WinMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 50; [WinMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); [WinMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 50; [WinMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); [WinMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)"
                  : "[WinMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); [WinMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)";
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
    _button?: string,
): Promise<void> {
    if (isWayland()) {
        await ensureYdotoold();
        await execFileAsync("ydotool", ["mousemove", "--absolute", "-x", String(x), "-y", String(y)], {
            timeout: 3000,
        });
        if (action === "mouse_move") return;
        // ydotool button codes: 0xC0=left, 0xC1=right, 0xC2=middle (USB HID codes)
        const btn = action === "right_click" ? "0xC1" : "0xC0";
        const repeats = action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
        for (let i = 0; i < repeats; i++) {
            await execFileAsync("ydotool", ["click", btn], { timeout: 3000 });
            if (i < repeats - 1) await new Promise((r) => setTimeout(r, 50));
        }
        return;
    }
    const tool = "xdotool";
    if (action === "mouse_move") {
        await execFileAsync(tool, ["mousemove", String(x), String(y)], { timeout: 3000 });
        return;
    }
    await execFileAsync(tool, ["mousemove", String(x), String(y)], { timeout: 3000 });
    if (action === "right_click") {
        await execFileAsync(tool, ["click", "3"], { timeout: 3000 });
    } else if (action === "double_click") {
        await execFileAsync(tool, ["click", "--repeat", "2", "--delay", "50", "1"], { timeout: 3000 });
    } else if (action === "triple_click") {
        await execFileAsync(tool, ["click", "--repeat", "3", "--delay", "50", "1"], { timeout: 3000 });
    } else {
        await execFileAsync(tool, ["click", "1"], { timeout: 3000 });
    }
}

async function dispatchDrag(points: Array<{ x: number; y: number }>): Promise<void> {
    if (points.length < 2) return;
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
    // Windows drag — for Phase 1 we fall through to consecutive moves; a proper SendInput-based
    // drag is in Phase 2's cross-OS AX/IO layer.
    throw new Error("drag not yet implemented for Windows in os_computer_action");
}

async function dispatchScroll(x: number, y: number, dx: number, dy: number): Promise<void> {
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
            // ydotool wheel sign is also "positive=up" historically; mirror our API by negating.
            await execFileAsync("ydotool", ["mousemove", "--absolute", "-x", String(x), "-y", String(y)], {
                timeout: 3000,
            });
            const ticks = Math.max(1, Math.abs(Math.round(dy / 40)));
            for (let i = 0; i < ticks; i++) {
                // ydotool: 4 = up, 5 = down (xdotool-compatible button numbers)
                await execFileAsync("ydotool", ["click", dy > 0 ? "0xC1" : "0xC0"], { timeout: 2000 }).catch(() => {});
            }
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

async function dispatchType(text: string): Promise<void> {
    if (process.platform === "darwin") {
        const escaped = escapeApplescript(text);
        const script = `
set oldClipboard to ""
try
    set oldClipboard to the clipboard as text
end try
set the clipboard to "${escaped}"
tell application "System Events"
    keystroke "v" using command down
end tell
delay 0.3
try
    set the clipboard to oldClipboard
end try`;
        await execFileAsync("osascript", ["-e", script], { timeout: 10000 });
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
        // SECURITY: pass the text via stdin to a base64-encoded PS command. The PS
        // -EncodedCommand arg is base64 (no shell-meta interpretation), and we read
        // the text from stdin so the actual string never appears in any command line.
        await pasteWindowsViaStdin(text);
        return;
    }
    throw new Error(`type not yet implemented for platform: ${process.platform}`);
}

/**
 * Set the Windows clipboard to arbitrary text and paste via Ctrl+V, without ever
 * interpolating the text into a command line. We base64-encode a tiny PS script that
 * reads from stdin and writes to clipboard, then pipe the text in.
 */
async function pasteWindowsViaStdin(text: string): Promise<void> {
    const psScript = `
$txt = [Console]::In.ReadToEnd()
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

async function dispatchKey(text: string): Promise<void> {
    if (process.platform === "darwin") {
        const lower = text.toLowerCase();
        const keyCodes: Record<string, number> = {
            return: 36,
            enter: 36,
            tab: 48,
            escape: 53,
            esc: 53,
            delete: 51,
            backspace: 51,
            space: 49,
            up: 126,
            down: 125,
            left: 123,
            right: 124,
        };
        if (lower.includes("+")) {
            const parts = lower.split("+").map((p) => p.trim());
            const target = parts.pop() || "";
            const mods: string[] = [];
            for (const m of parts) {
                if (m === "command" || m === "cmd") mods.push("command down");
                else if (m === "shift") mods.push("shift down");
                else if (m === "option" || m === "alt") mods.push("option down");
                else if (m === "control" || m === "ctrl") mods.push("control down");
            }
            const modStr = mods.length ? ` using {${mods.join(", ")}}` : "";
            if (target in keyCodes) {
                await execFileAsync(
                    "osascript",
                    ["-e", `tell application "System Events" to key code ${keyCodes[target]}${modStr}`],
                    { timeout: 5000 },
                );
            } else {
                await execFileAsync(
                    "osascript",
                    ["-e", `tell application "System Events" to keystroke "${escapeApplescript(target)}"${modStr}`],
                    { timeout: 5000 },
                );
            }
            return;
        }
        if (lower in keyCodes) {
            await execFileAsync(
                "osascript",
                ["-e", `tell application "System Events" to key code ${keyCodes[lower]}`],
                { timeout: 5000 },
            );
        } else {
            await execFileAsync(
                "osascript",
                ["-e", `tell application "System Events" to keystroke "${escapeApplescript(text)}"`],
                { timeout: 5000 },
            );
        }
        return;
    }
    if (process.platform === "linux") {
        // Add `--` to prevent flag injection (e.g. text starting with "-").
        if (isWayland()) {
            await ensureYdotoold();
            await execFileAsync("ydotool", ["key", "--", text], { timeout: 5000 });
            return;
        }
        await execFileAsync("xdotool", ["key", "--", text], { timeout: 5000 });
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
$keys = [Console]::In.ReadToEnd()
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

async function dispatchHoldKey(text: string, durationMs: number): Promise<void> {
    if (process.platform === "darwin") {
        const lower = text.toLowerCase();
        const keyCodes: Record<string, number> = {
            shift: 56,
            control: 59,
            option: 58,
            command: 55,
            return: 36,
            enter: 36,
            space: 49,
            tab: 48,
            escape: 53,
        };
        // ERROR on unknown — silent fallback to shift is destructive.
        if (!(lower in keyCodes)) {
            throw new Error(
                `hold_key on macOS: unsupported key '${text}'. Supported: ${Object.keys(keyCodes).join(", ")}`,
            );
        }
        const code = keyCodes[lower];
        const seconds = Math.max(0, Math.min(60, durationMs / 1000));
        const jxa = `ObjC.import('CoreGraphics');var down=$.CGEventCreateKeyboardEvent(null,${code},true);$.CGEventPost($.kCGHIDEventTap,down);delay(${seconds});var up=$.CGEventCreateKeyboardEvent(null,${code},false);$.CGEventPost($.kCGHIDEventTap,up);"held"`;
        await execFileAsync("osascript", ["-l", "JavaScript", "-e", jxa], { timeout: durationMs + 5000 });
        return;
    }
    if (process.platform === "linux") {
        const tool = isWayland() ? "ydotool" : "xdotool";
        if (tool === "ydotool") await ensureYdotoold();
        // Add `--` to prevent flag injection.
        await execFileAsync(tool, ["keydown", "--", text], { timeout: 3000 });
        await new Promise((r) => setTimeout(r, Math.max(0, Math.min(60_000, durationMs))));
        await execFileAsync(tool, ["keyup", "--", text], { timeout: 3000 });
        return;
    }
    if (process.platform === "win32") {
        // Best-effort: SendInput doesn't support a "hold" primitive via SendKeys.
        // We use P/Invoke keybd_event with vk-code lookup. Unknown keys throw.
        const lower = text.toLowerCase();
        const vk: Record<string, number> = {
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
        };
        if (!(lower in vk)) {
            throw new Error(`hold_key on Windows: unsupported key '${text}'. Supported: ${Object.keys(vk).join(", ")}`);
        }
        const code = vk[lower];
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
