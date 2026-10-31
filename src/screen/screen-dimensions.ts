// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { withCursorHidden } from "./agent-cursor.js";

const execFileAsync = promisify(execFile);

export interface ScreenDimensions {
    width: number;
    height: number;
    scale: number;
    monitorId: string;
    originX: number;
    originY: number;
    focusedWindow?: { x: number; y: number; w: number; h: number };
    /** Every display in global screen points (macOS), so a point on another monitor isn't clamped away. */
    displays?: Rect[];
}

export type Rect = { x: number; y: number; w: number; h: number };

export interface ScreenDimensionsOptions {
    focusedWindow?: boolean;
    force?: boolean;
}

const DEFAULTS: ScreenDimensions = {
    width: 1440,
    height: 900,
    scale: 1,
    monitorId: "fallback",
    originX: 0,
    originY: 0,
};

/**
 * Returns true when the dims object is the silent-fallback value from a failed
 * platform probe. Callers that learn from clicks (click-memory, drift-calibration)
 * MUST refuse to record samples when this is true — otherwise the stored
 * normalized coords are relative to the made-up 1440x900 instead of the actual
 * monitor, and every recall on the real monitor lands at the wrong place.
 */
export function isFallbackDims(dims: ScreenDimensions): boolean {
    return dims.monitorId === "fallback";
}

const CACHE_TTL_MS = 500;
const PROBE_TIMEOUT_MS = 2500;

interface CacheEntry {
    value: ScreenDimensions;
    expiresAt: number;
    focusedWindow: boolean;
}

let _cache: CacheEntry | null = null;

export function clearScreenDimensionsCache(): void {
    _cache = null;
}

export async function getScreenDimensions(opts: ScreenDimensionsOptions = {}): Promise<ScreenDimensions> {
    const wantFocused = opts.focusedWindow !== false;
    if (!opts.force && _cache && _cache.expiresAt > Date.now() && _cache.focusedWindow === wantFocused) {
        return _cache.value;
    }

    let dims: ScreenDimensions | null = null;
    try {
        if (process.platform === "darwin") {
            dims = await probeMacOS(wantFocused);
        } else if (process.platform === "win32") {
            dims = await probeWindows(wantFocused);
        } else if (process.platform === "linux") {
            dims = await probeLinux(wantFocused);
        }
    } catch {
        dims = null;
    }

    if (dims) {
        // Only cache successful probes — never authoritative-cache the fallback DEFAULTS.
        _cache = { value: dims, expiresAt: Date.now() + CACHE_TTL_MS, focusedWindow: wantFocused };
        return dims;
    }
    // On failure: return DEFAULTS but DO NOT cache them. Next call re-probes immediately.
    return { ...DEFAULTS };
}

async function probeMacOS(wantFocused: boolean): Promise<ScreenDimensions> {
    // NSScreen.frame uses Cocoa coords (Y-up, origin at bottom-left of primary).
    // CGEvent / cliclick / System Events use CG coords (Y-down, origin at top-left of primary).
    // We convert NSScreen origins to CG before any comparison so vertical-stack multi-monitor works.
    // Formula: cgY = primaryHeight - (cocoaY + screenHeight)
    const script = wantFocused
        ? `
ObjC.import("AppKit");
var screens = $.NSScreen.screens;
// The "primary" screen for Cocoa→CG conversion is screens[0] (which contains the menu bar).
var primary = screens.objectAtIndex(0);
var primaryHeight = primary.frame.size.height;
var allScreens = [];
for (var i = 0; i < screens.count; i++) {
    var s = screens.objectAtIndex(i);
    var f = s.frame;
    var cgY = primaryHeight - (f.origin.y + f.size.height);
    allScreens.push({ id: String(i), x: f.origin.x, y: cgY, w: f.size.width, h: f.size.height, scale: s.backingScaleFactor });
}
var focus = null;
// The front app's frontmost normal window, from the window server: half the time of
// asking System Events, and no Accessibility permission needed. Bounds are CG coords.
try {
    ObjC.import("CoreGraphics");
    var pid = $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    var list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0));
    for (var k = 0; k < list.count; k++) {
        var w = list.objectAtIndex(k);
        if (w.objectForKey("kCGWindowOwnerPID").intValue !== pid || w.objectForKey("kCGWindowLayer").intValue !== 0) continue;
        var b = w.objectForKey("kCGWindowBounds");
        focus = { x: b.objectForKey("X").doubleValue, y: b.objectForKey("Y").doubleValue, w: b.objectForKey("Width").doubleValue, h: b.objectForKey("Height").doubleValue };
        break;
    }
} catch (e) { /* fall through to the primary screen */ }
var picked = allScreens[0];
if (focus) {
    var cx = focus.x + focus.w / 2;
    var cy = focus.y + focus.h / 2;
    for (var j = 0; j < allScreens.length; j++) {
        var s2 = allScreens[j];
        if (cx >= s2.x && cx < s2.x + s2.w && cy >= s2.y && cy < s2.y + s2.h) {
            picked = s2;
            break;
        }
    }
}
JSON.stringify({ picked: picked, focus: focus, all: allScreens });
`.trim()
        : `
ObjC.import("AppKit");
var s = $.NSScreen.mainScreen;
var f = s.frame;
// Primary screen in CG is (0,0); no conversion needed for the no-focus path.
JSON.stringify({
    picked: { id: "main", x: 0, y: 0, w: f.size.width, h: f.size.height, scale: s.backingScaleFactor },
    focus: null
});
`.trim();
    const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script], {
        timeout: PROBE_TIMEOUT_MS,
    });
    const parsed = JSON.parse(stdout.trim()) as {
        picked: { id: string; x: number; y: number; w: number; h: number; scale: number };
        focus: { x: number; y: number; w: number; h: number } | null;
        all?: Rect[];
    };
    if (!parsed?.picked) return { ...DEFAULTS };
    return {
        displays: parsed.all?.map((d) => ({
            x: Math.round(d.x),
            y: Math.round(d.y),
            w: Math.round(d.w),
            h: Math.round(d.h),
        })),
        width: Math.round(parsed.picked.w),
        height: Math.round(parsed.picked.h),
        scale: parsed.picked.scale || 1,
        monitorId: `mac-${parsed.picked.id}`,
        originX: Math.round(parsed.picked.x),
        originY: Math.round(parsed.picked.y),
        focusedWindow: parsed.focus
            ? {
                  x: Math.round(parsed.focus.x),
                  y: Math.round(parsed.focus.y),
                  w: Math.round(parsed.focus.w),
                  h: Math.round(parsed.focus.h),
              }
            : undefined,
    };
}

async function probeWindows(wantFocused: boolean): Promise<ScreenDimensions> {
    // Query DPI via [System.Windows.Forms.SystemInformation]::ScreenDpi (96 = 100%, 120 = 125%, etc.)
    // Divide raw pixel bounds by scale to report LOGICAL pixels — cursor APIs operate in logical
    // pixels in DPI-aware processes on Win 8.1+.
    const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win32Probe {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$hwnd = [Win32Probe]::GetForegroundWindow()
$rect = New-Object Win32Probe+RECT
$haveFocus = ${wantFocused ? "$true" : "$false"} -and [Win32Probe]::GetWindowRect($hwnd, [ref]$rect)
$screens = [System.Windows.Forms.Screen]::AllScreens
$picked = [System.Windows.Forms.Screen]::PrimaryScreen
$pickedIdx = 0
if ($haveFocus) {
    $cx = ($rect.Left + $rect.Right) / 2
    $cy = ($rect.Top + $rect.Bottom) / 2
    for ($i = 0; $i -lt $screens.Length; $i++) {
        $b = $screens[$i].Bounds
        if ($cx -ge $b.X -and $cx -lt ($b.X + $b.Width) -and $cy -ge $b.Y -and $cy -lt ($b.Y + $b.Height)) {
            $picked = $screens[$i]
            $pickedIdx = $i
            break
        }
    }
} else {
    for ($i = 0; $i -lt $screens.Length; $i++) {
        if ($screens[$i].Primary) { $pickedIdx = $i; break }
    }
}
$b = $picked.Bounds
# Query the desktop DPI. Falls back to 96 (100%) if anything goes wrong.
$dpi = 96
try {
    $g = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
    $dpi = $g.DpiX
    $g.Dispose()
} catch { $dpi = 96 }
$scale = [double]$dpi / 96.0
if ($scale -le 0) { $scale = 1.0 }
# Bounds are PHYSICAL pixels in a DPI-unaware process. Cursor APIs (SetCursorPos) expect
# PHYSICAL pixels as well in this context. Report PHYSICAL pixels but expose scale so callers
# can adjust if/when they upgrade to per-monitor DPI awareness.
$focusObj = $null
if ($haveFocus) {
    $focusObj = @{ x = $rect.Left; y = $rect.Top; w = $rect.Right - $rect.Left; h = $rect.Bottom - $rect.Top }
}
$out = @{
    picked = @{ id = "$pickedIdx"; x = $b.X; y = $b.Y; w = $b.Width; h = $b.Height; scale = $scale }
    focus = $focusObj
}
$out | ConvertTo-Json -Compress
`.trim();
    const { stdout } = await execFileAsync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        { timeout: PROBE_TIMEOUT_MS },
    );
    const parsed = JSON.parse(stdout.trim()) as {
        picked: { id: string; x: number; y: number; w: number; h: number; scale: number };
        focus: { x: number; y: number; w: number; h: number } | null;
    };
    if (!parsed?.picked) return { ...DEFAULTS };
    return {
        width: parsed.picked.w,
        height: parsed.picked.h,
        scale: parsed.picked.scale || 1,
        monitorId: `win-${parsed.picked.id}`,
        originX: parsed.picked.x,
        originY: parsed.picked.y,
        focusedWindow: parsed.focus || undefined,
    };
}

async function probeLinux(wantFocused: boolean): Promise<ScreenDimensions> {
    let focus: { x: number; y: number; w: number; h: number } | null = null;
    if (wantFocused) {
        try {
            const { stdout } = await execFileAsync(
                "bash",
                ["-c", "xdotool getactivewindow getwindowgeometry --shell"],
                { timeout: PROBE_TIMEOUT_MS },
            );
            const env: Record<string, string> = {};
            for (const line of stdout.split("\n")) {
                const m = line.match(/^(\w+)=(\d+)$/);
                if (m) env[m[1]] = m[2];
            }
            if (env.X !== undefined && env.Y !== undefined && env.WIDTH && env.HEIGHT) {
                focus = {
                    x: parseInt(env.X, 10),
                    y: parseInt(env.Y, 10),
                    w: parseInt(env.WIDTH, 10),
                    h: parseInt(env.HEIGHT, 10),
                };
            }
        } catch {
            /* xdotool unavailable or Wayland — fall through */
        }
    }

    const monitors: Array<{ id: string; x: number; y: number; w: number; h: number; primary: boolean }> = [];
    try {
        const { stdout } = await execFileAsync("bash", ["-c", "xrandr --listmonitors"], { timeout: PROBE_TIMEOUT_MS });
        for (const line of stdout.split("\n")) {
            const m = line.match(/^\s*(\d+):\s+([+*]+)?(\S+)\s+(\d+)\/\d+x(\d+)\/\d+\+(\d+)\+(\d+)/);
            if (m) {
                monitors.push({
                    id: m[1],
                    x: parseInt(m[6], 10),
                    y: parseInt(m[7], 10),
                    w: parseInt(m[4], 10),
                    h: parseInt(m[5], 10),
                    primary: (m[2] || "").includes("*"),
                });
            }
        }
    } catch {
        /* xrandr unavailable */
    }

    let picked = monitors.find((m) => m.primary) || monitors[0];
    if (focus && monitors.length > 1) {
        const cx = focus.x + focus.w / 2;
        const cy = focus.y + focus.h / 2;
        const match = monitors.find((m) => cx >= m.x && cx < m.x + m.w && cy >= m.y && cy < m.y + m.h);
        if (match) picked = match;
    }

    if (!picked) return { ...DEFAULTS, focusedWindow: focus || undefined };
    return {
        width: picked.w,
        height: picked.h,
        scale: 1,
        monitorId: `linux-${picked.id}`,
        originX: picked.x,
        originY: picked.y,
        focusedWindow: focus || undefined,
    };
}

/**
 * Screenshot one screen rect (global points) to `out` — the focused monitor or
 * window, so the pixels match what clicks are scaled against (Bhai's own cursor
 * and glow hidden). macOS + Windows;
 * false elsewhere or on failure (callers fall back to a full-screen capture).
 */
export async function captureRegionToFile(r: Rect, out: string, type: "png" | "jpg" = "png"): Promise<boolean> {
    if (r.w <= 0 || r.h <= 0) return false;
    const [x, y, w, h] = [r.x, r.y, r.w, r.h].map(Math.round);
    try {
        if (process.platform === "darwin") {
            await withCursorHidden(() =>
                execFileAsync("screencapture", ["-x", "-t", type, `-R${x},${y},${w},${h}`, out], { timeout: 8000 }),
            );
            return true;
        }
        if (process.platform === "win32") {
            const ps =
                `Add-Type -AssemblyName System.Drawing,System.Windows.Forms;` +
                `$b = New-Object System.Drawing.Bitmap(${w}, ${h});` +
                `$g = [System.Drawing.Graphics]::FromImage($b);` +
                `$g.CopyFromScreen(${x}, ${y}, 0, 0, $b.Size);` +
                `$b.Save('${out.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png);` +
                `$g.Dispose(); $b.Dispose()`;
            await withCursorHidden(() =>
                execFileAsync("powershell", ["-NoProfile", "-Command", ps], { timeout: 8000 }),
            );
            return true;
        }
    } catch {
        /* fall through */
    }
    return false;
}

/** captureRegionToFile into memory. */
export async function captureRegion(r: Rect): Promise<Buffer | null> {
    const out = join(tmpdir(), `bhai_region_${randomBytes(6).toString("hex")}.png`);
    try {
        return (await captureRegionToFile(r, out)) ? await fs.readFile(out) : null;
    } catch {
        return null;
    } finally {
        await fs.unlink(out).catch(() => {});
    }
}

/** The monitor `dims` describes, as a capture rect (null for the made-up fallback). */
export function monitorRect(dims: ScreenDimensions): Rect | null {
    return isFallbackDims(dims) ? null : { x: dims.originX, y: dims.originY, w: dims.width, h: dims.height };
}

/** True when (x, y) lies on one of the displays `dims` knows about (or on its monitor). */
export function onSomeDisplay(x: number, y: number, dims: ScreenDimensions): boolean {
    const rects = dims.displays?.length
        ? dims.displays
        : [{ x: dims.originX, y: dims.originY, w: dims.width, h: dims.height }];
    return rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
}

export function clampToMonitor(x: number, y: number, dims: ScreenDimensions): { x: number; y: number } {
    const minX = dims.originX;
    const maxX = dims.originX + dims.width - 1;
    const minY = dims.originY;
    const maxY = dims.originY + dims.height - 1;
    return {
        x: Math.max(minX, Math.min(maxX, Math.round(x))),
        y: Math.max(minY, Math.min(maxY, Math.round(y))),
    };
}

export interface ScalingInputs {
    rawX: number;
    rawY: number;
    imageWidth: number;
    dims: ScreenDimensions;
    raw?: boolean;
}

export function scaleImageToScreen(opts: ScalingInputs): { x: number; y: number; scaleFactor: number } {
    if (opts.raw || !opts.imageWidth || opts.imageWidth <= 0 || opts.dims.width <= 0) {
        return { x: Math.round(opts.rawX), y: Math.round(opts.rawY), scaleFactor: 1 };
    }
    const scaleFactor = opts.dims.width / opts.imageWidth;
    const screenX = opts.dims.originX + opts.rawX * scaleFactor;
    const screenY = opts.dims.originY + opts.rawY * scaleFactor;
    const clamped = clampToMonitor(screenX, screenY, opts.dims);
    return { x: clamped.x, y: clamped.y, scaleFactor: Math.round(scaleFactor * 10000) / 10000 };
}

export interface PercentageInputs {
    percentX: number;
    percentY: number;
    dims: ScreenDimensions;
}

export function percentageToScreen(opts: PercentageInputs): { x: number; y: number } {
    const px = Math.max(0, Math.min(1, opts.percentX));
    const py = Math.max(0, Math.min(1, opts.percentY));
    // Clamp final coord — at percent=1.0 the naive formula yields originX+width which is
    // one past the last valid pixel (max = originX+width-1). Use clampToMonitor.
    return clampToMonitor(
        opts.dims.originX + px * opts.dims.width,
        opts.dims.originY + py * opts.dims.height,
        opts.dims,
    );
}
