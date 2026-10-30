// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execFile } from "node:child_process";
import { existsSync, promises as fs, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getScriptsDir } from "../config/paths.js";
import { hideOverlayForAgent, showOverlayForAgent } from "../overlay/overlay-chat.js";
import { cursorClick, cursorMove, withCursorHidden, withCursorTyping } from "../screen/agent-cursor.js";
import { frontmostMatches, getFrontmostApp, pidOfApp, restoreFrontIfStolen, waitForFrontmost } from "../screen/frontmost.js";
import { gridScreenshot } from "../screen/grid-overlay.js";
import {
    captureRegionToFile,
    getScreenDimensions,
    monitorRect,
    percentageToScreen,
    type ScreenDimensions,
    scaleImageToScreen,
} from "../screen/screen-dimensions.js";
import type { ToolDefinition } from "./get-current-time.js";
import { MAC_KEY_CODES, macKeyScript, typeTextMac } from "./os-computer-action.js";
import { getTelegramContext } from "./send-file.js";

const execFileAsync = promisify(execFile);

// ── Constants ─────────────────────────────────

const MAX_OUTPUT = 10000;
const DEFAULT_TIMEOUT = 30000; // 30s

// Legacy module-level cache. Kept for backwards compatibility with code that
// reads it directly (e.g. os_scan / quickAccessibilityRefresh). The authoritative
// source is getScreenDimensions() — these vars are best-effort snapshots only.
let lastScreenWidth = 0;
let lastScreenHeight = 0;

// ── OCR Cache ────────────────────────────────
// Caches the last OCR result to avoid redundant runs when screen hasn't changed.
// Cache key is a fast pixel-sample hash of the screenshot.
interface OcrCacheEntry {
    result: any;
    hash: string;
    timestamp: number;
}
let _ocrCache: OcrCacheEntry | null = null;
const OCR_CACHE_TTL_MS = 10_000; // 10 seconds — allows reuse during multi-step interactions

function computeScreenshotHash(buffer: Buffer): string {
    // Sample 200 pixels at fixed positions for a fast fingerprint
    const step = Math.max(1, Math.floor(buffer.length / 200));
    let hash = 0;
    for (let i = 0; i < buffer.length; i += step) {
        hash = ((hash << 5) - hash + buffer[i]) | 0;
    }
    return hash.toString(36);
}

let _lastScreenshotBuffer: Buffer | null = null;

/**
 * Capture the focused window's monitor — the one os_click scales image and
 * percent coords against — instead of `screencapture -x`'s main display, which
 * is a different screen whenever the app sits on a second monitor.
 * Returns the monitor captured, or undefined when it fell back to the main
 * display (the OCR helper's own main-display mapping is then the right one).
 */
async function captureFocusedDisplay(
    out: string,
    dims?: ScreenDimensions,
    type: "png" | "jpg" = "png",
): Promise<ScreenDimensions | undefined> {
    const d = dims ?? (await getScreenDimensions({ focusedWindow: true, force: true }));
    const rect = monitorRect(d);
    if (rect && (await captureRegionToFile(rect, out, type))) return d;
    await withCursorHidden(() => execFileAsync("screencapture", ["-x", "-t", type, out], { timeout: 10000 }));
    return undefined;
}

// ── Element Map Cache (for os_scan → os_click_element flow) ──
interface ScanElement {
    label: number;
    text: string;
    role: string;
    x: number; // screen logical coords
    y: number;
    w: number;
    h: number;
}
let _scanElements: ScanElement[] = [];
let _scanTimestamp: number = 0;
const SCAN_CACHE_TTL_MS = 30_000; // 30 seconds — allows multiple LLM round-trips between scans
const SCAN_STALE_WARNING_MS = 15_000; // Warn if map is older than 15s but still usable

// ── AppleScript Tool ──────────────────────────

export const appleScript: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "apple_script",
            description:
                "Execute raw AppleScript on macOS. Use for controlling native apps. IMPORTANT: To LAUNCH/ACTIVATE apps, ALWAYS use: do shell script \"open -a 'AppName'\" — NEVER use 'tell application X to activate' as it may resolve to the wrong binary. After launching, you can use 'tell application' for commands.",
            parameters: {
                type: "object",
                properties: {
                    script: {
                        type: "string",
                        description:
                            "The multi-line AppleScript or JXA script to execute. Do NOT escape quotes, just write the raw script.",
                    },
                    language: {
                        type: "string",
                        enum: ["AppleScript", "JavaScript"],
                        description: "The language of the script (default: AppleScript). Use JavaScript for JXA.",
                    },
                    timeout: { type: "number", description: "Timeout in ms (default 30000)" },
                },
                required: ["script"],
            },
        },
    },

    async handler(input) {
        if (process.platform !== "darwin") {
            return JSON.stringify({ error: "apple_script tool is only available on macOS." });
        }

        const script = input.script as string;

        // ── Browser-launch guard ──────────────────────────────────────────
        // The browser_* tools use their own Playwright Chromium instance.
        // Launching native Chrome/Safari/Firefox/Arc/Edge via apple_script has
        // ZERO effect on the Playwright browser and just opens a useless window.
        // Block it here so the agent is forced onto the correct code path.
        const BROWSER_PATTERNS = [
            /open\s+-a\s+['"]?(google\s+chrome|safari|firefox|microsoft\s+edge|arc|chromium|brave)['"]?/i,
            /tell\s+application\s+['"]?(google\s+chrome|safari|firefox|microsoft\s+edge|arc|chromium|brave)['"]?/i,
            /open\s+['"]?https?:\/\//i,
        ];
        if (BROWSER_PATTERNS.some((p) => p.test(script))) {
            return JSON.stringify({
                error: "BLOCKED: Do NOT open native browser apps for web tasks. The browser_* tools have their own built-in Playwright browser. Use browser_navigate with the URL directly instead.",
                fix: "Call browser_navigate with the target URL — no need to open Chrome or any other browser first.",
            });
        }
        // ─────────────────────────────────────────────────────────────────
        const language = (input.language as string) || "AppleScript";
        const timeout = (input.timeout as number) || DEFAULT_TIMEOUT;

        // Create a temporary file to avoid bash escaping/quoting hell
        const tmpFile = join(tmpdir(), `atlas_osascript_${Date.now()}.scpt`);

        try {
            await fs.writeFile(tmpFile, script, "utf-8");

            const args = language === "JavaScript" ? ["-l", "JavaScript", tmpFile] : [tmpFile];

            const { stdout, stderr } = await execFileAsync("osascript", args, {
                timeout,
            });

            // Cleanup the temp file
            await fs.unlink(tmpFile).catch(() => {});

            const output = (stdout || "").substring(0, MAX_OUTPUT);
            const errors = (stderr || "").substring(0, MAX_OUTPUT);

            return JSON.stringify({
                success: true,
                stdout: output,
                stderr: errors,
                truncated: (stdout || "").length > MAX_OUTPUT,
            });
        } catch (err) {
            // Ensure cleanup happens even on execution error
            await fs.unlink(tmpFile).catch(() => {});

            const error = err as { message?: string; code?: number; killed?: boolean };
            return JSON.stringify({
                success: false,
                error: error.message || "AppleScript execution failed",
                code: error.code,
                killed: error.killed,
            });
        }
    },
};

// ── OS Screenshot Tool ────────────────────────

export const osScreenshot: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_screenshot",
            description:
                "Takes a screenshot of the current macOS screen. Returns the image, which app is focused, screen resolution, and coordinate mapping info. ALWAYS take a screenshot after os_click or os_type to verify your action worked.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },

    async handler() {
        if (process.platform !== "darwin") {
            return JSON.stringify({ error: "os_screenshot tool is only available on macOS." });
        }

        const tmpJpg = join(tmpdir(), `atlas_screen_${Date.now()}.jpg`);

        try {
            // The frontmost app is looked up alongside the capture, not after it.
            const frontmost = getFrontmostApp();
            // Hide overlay so it doesn't appear in the screenshot; while it fades, find the
            // screen containing the focused window (multi-monitor aware; falls back to
            // primary if AX permission isn't granted).
            hideOverlayForAgent();
            const [dims] = await Promise.all([
                getScreenDimensions({ focusedWindow: true, force: true }),
                new Promise((r) => setTimeout(r, 100)), // opacity transition
            ]);
            const screenWidth = dims.width;
            const screenHeight = dims.height;

            lastScreenWidth = screenWidth;
            lastScreenHeight = screenHeight;

            // Capture the focused window's monitor (Retina: at 2x pixel density) —
            // the same monitor os_click maps this image's coordinates onto. JPEG is
            // ~2x faster to capture than PNG and is what we send anyway.
            await captureFocusedDisplay(tmpJpg, dims, "jpg");

            // Show overlay again
            showOverlayForAgent();

            // Resize to 1280px width for better LLM coordinate accuracy, with the coordinate grid.
            // Labels stay in image pixels: os_click scales x/y from this
            // 1280-wide image to the screen, so screen-point labels got scaled twice.
            const RESIZE_WIDTH = 1280;
            const gridded = await gridScreenshot(await fs.readFile(tmpJpg), RESIZE_WIDTH, 160);
            if (!gridded) {
                // sharp unusable: still resize, so os_click's 1280-wide scaling holds.
                await execFileAsync(
                    "sips",
                    ["--resampleWidth", String(RESIZE_WIDTH), "-s", "formatOptions", "85", tmpJpg],
                    { timeout: 5000 },
                ).catch(() => {});
            }
            const buffer = gridded?.buf ?? (await fs.readFile(tmpJpg));
            _lastScreenshotBuffer = buffer; // Store for caching and diff
            const base64 = buffer.toString("base64");
            const mimeType = "image/jpeg";

            // Cleanup
            await fs.unlink(tmpJpg).catch(() => {});

            // Scale factor: maps image coordinates to logical screen points
            const scaleFactor = screenWidth / RESIZE_WIDTH;

            const frontmostApp = (await frontmost)?.name || "unknown";

            return JSON.stringify({
                success: true,
                screenshot_base64: base64,
                mime_type: mimeType,
                screen: { width: screenWidth, height: screenHeight },
                image_width: RESIZE_WIDTH,
                scale_factor: Math.round(scaleFactor * 1000) / 1000,
                frontmost_app: frontmostApp,
                tip: `Image is ${RESIZE_WIDTH}px wide with a coordinate GRID overlay. Use the grid lines and labels to pick PRECISE x,y coordinates. Pass them to os_click — auto-scaled to screen. ALWAYS verify with another screenshot after clicking. Prefer os_scan + os_click_element for more reliable element-based clicking.`,
            });
        } catch (err) {
            showOverlayForAgent(); // Ensure overlay comes back on error
            await fs.unlink(tmpJpg).catch(() => {});

            const error = err as { message?: string };
            return JSON.stringify({
                success: false,
                error: error.message || "Failed to capture screen",
            });
        }
    },
};

// ── OS Click Tool (Native Mouse Control) ──────

export const osClick: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_click",
            description:
                "Click, double-click, right-click, or move the mouse on macOS. PREFERRED: pass percent_x/percent_y in [0..1] (resolution-independent, works on any monitor/DPI). LEGACY: pass x/y image-pixel coords from os_screenshot — they are auto-scaled to actual screen resolution.",
            parameters: {
                type: "object",
                properties: {
                    x: {
                        type: "number",
                        description: "X coordinate from the screenshot image (legacy — prefer percent_x)",
                    },
                    y: {
                        type: "number",
                        description: "Y coordinate from the screenshot image (legacy — prefer percent_y)",
                    },
                    percent_x: {
                        type: "number",
                        description:
                            "X position as 0..1 fraction of focused-monitor width. PREFERRED — resolution-independent.",
                    },
                    percent_y: {
                        type: "number",
                        description:
                            "Y position as 0..1 fraction of focused-monitor height. PREFERRED — resolution-independent.",
                    },
                    action: {
                        type: "string",
                        enum: ["click", "double_click", "right_click", "move"],
                        description: "Mouse action (default: click)",
                    },
                    raw: {
                        type: "boolean",
                        description:
                            "If true, treat x/y as raw screen pixels without scaling (default: false). Ignored when percent_x/percent_y are given.",
                    },
                },
                required: [],
            },
        },
    },

    async handler(input) {
        if (process.platform !== "darwin") {
            return JSON.stringify({ error: "os_click is only available on macOS." });
        }

        const action = (input.action as string) || "click";
        const useRaw = input.raw as boolean;
        // x/y both strictly between 0 and 1 are fractions put in the pixel fields (seen from
        // gpt-4.1-nano: x=0.614 clicked pixel 1,1, the Apple menu corner). No pixel is there.
        const inUnit = (v: unknown) => typeof v === "number" && v > 0 && v < 1;
        const fractions = input.percent_x === undefined && inUnit(input.x) && inUnit(input.y);
        const pctX = (fractions ? input.x : input.percent_x) as number | undefined;
        const pctY = (fractions ? input.y : input.percent_y) as number | undefined;
        const rawX = (fractions ? undefined : input.x) as number | undefined;
        const rawY = (fractions ? undefined : input.y) as number | undefined;

        // Validate: must have either pixel coords or percentage coords
        const hasPercent = typeof pctX === "number" && typeof pctY === "number";
        const hasPixel = typeof rawX === "number" && typeof rawY === "number";
        if (!hasPercent && !hasPixel) {
            return JSON.stringify({
                error: "os_click requires either (percent_x, percent_y) [preferred] or (x, y) coordinates.",
            });
        }
        if (hasPercent && hasPixel) {
            return JSON.stringify({
                error: "os_click: provide EITHER (percent_x, percent_y) OR (x, y), not both — they would conflict.",
            });
        }

        const dims = await getScreenDimensions({ focusedWindow: true });
        let x: number;
        let y: number;
        let coordMode: string;
        if (hasPercent) {
            const resolved = percentageToScreen({ percentX: pctX, percentY: pctY, dims });
            x = resolved.x;
            y = resolved.y;
            coordMode = "percent";
        } else {
            const RESIZE_WIDTH = 1280;
            const scaled = scaleImageToScreen({
                rawX: rawX as number,
                rawY: rawY as number,
                imageWidth: RESIZE_WIDTH,
                dims,
                raw: useRaw,
            });
            x = scaled.x;
            y = scaled.y;
            coordMode = useRaw ? "raw" : `image(scale=${scaled.scaleFactor})`;
        }
        console.log(
            `  🖱️  Click: ${coordMode}(${hasPercent ? `${pctX},${pctY}` : `${rawX},${rawY}`}) → screen(${x},${y}) [monitor=${dims.monitorId} origin=(${dims.originX},${dims.originY})]`,
        );

        // Use JXA with CoreGraphics CGEvent for native mouse control
        // This is zero-dependency and works with accessibility permissions
        let eventScript: string;

        switch (action) {
            case "move":
                eventScript = `
ObjC.import('CoreGraphics');
var point = $.CGPointMake(${x}, ${y});
var event = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, point, $.kCGMouseButtonLeft);
$.CGEventPost($.kCGHIDEventTap, event);
"moved"`;
                break;

            case "right_click":
                eventScript = `
ObjC.import('CoreGraphics');
var point = $.CGPointMake(${x}, ${y});
var move = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, point, $.kCGMouseButtonRight);
$.CGEventPost($.kCGHIDEventTap, move);
delay(0.05);
var down = $.CGEventCreateMouseEvent(null, $.kCGEventRightMouseDown, point, $.kCGMouseButtonRight);
$.CGEventPost($.kCGHIDEventTap, down);
delay(0.05);
var up = $.CGEventCreateMouseEvent(null, $.kCGEventRightMouseUp, point, $.kCGMouseButtonRight);
$.CGEventPost($.kCGHIDEventTap, up);
"right_clicked"`;
                break;

            case "double_click":
                eventScript = `
ObjC.import('CoreGraphics');
var point = $.CGPointMake(${x}, ${y});
var move = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, point, $.kCGMouseButtonLeft);
$.CGEventPost($.kCGHIDEventTap, move);
delay(0.05);
var down1 = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, point, $.kCGMouseButtonLeft);
$.CGEventSetIntegerValueField(down1, $.kCGMouseEventClickState, 1);
$.CGEventPost($.kCGHIDEventTap, down1);
delay(0.02);
var up1 = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, point, $.kCGMouseButtonLeft);
$.CGEventSetIntegerValueField(up1, $.kCGMouseEventClickState, 1);
$.CGEventPost($.kCGHIDEventTap, up1);
delay(0.05);
var down2 = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, point, $.kCGMouseButtonLeft);
$.CGEventSetIntegerValueField(down2, $.kCGMouseEventClickState, 2);
$.CGEventPost($.kCGHIDEventTap, down2);
delay(0.02);
var up2 = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, point, $.kCGMouseButtonLeft);
$.CGEventSetIntegerValueField(up2, $.kCGMouseEventClickState, 2);
$.CGEventPost($.kCGHIDEventTap, up2);
"double_clicked"`;
                break;

            default: // "click"
                eventScript = `
ObjC.import('CoreGraphics');
var point = $.CGPointMake(${x}, ${y});
var move = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, point, $.kCGMouseButtonLeft);
$.CGEventPost($.kCGHIDEventTap, move);
delay(0.05);
var down = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, point, $.kCGMouseButtonLeft);
$.CGEventPost($.kCGHIDEventTap, down);
delay(0.05);
var up = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, point, $.kCGMouseButtonLeft);
$.CGEventPost($.kCGHIDEventTap, up);
"clicked"`;
                break;
        }

        const tmpFile = join(tmpdir(), `atlas_click_${Date.now()}.js`);
        try {
            if (action === "move") await cursorMove(x, y);
            else
                await cursorClick(x, y, action === "right_click" ? "right" : "left", action === "double_click" ? 2 : 1);
            await fs.writeFile(tmpFile, eventScript, "utf-8");
            const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", tmpFile], { timeout: 5000 });
            await fs.unlink(tmpFile).catch(() => {});

            // No before/after diff here: the last os_screenshot is a gridded 1280px
            // JPEG and a fresh capture is a raw Retina PNG, so a byte compare said
            // "changed" every time and cost ~600ms per click.
            return JSON.stringify({
                success: true,
                action,
                x,
                y,
                result: stdout.trim(),
                tip: "For more reliable clicking, use os_scan + os_click_element instead of coordinate-based clicking.",
            });
        } catch (err) {
            await fs.unlink(tmpFile).catch(() => {});
            const error = err as { message?: string };
            return JSON.stringify({ success: false, error: error.message || "Mouse action failed" });
        }
    },
};

// ── OS Type Tool (Native Keyboard Control) ────

export const osType: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_type",
            description:
                "Type text or press keys/hotkeys at the OS level using System Events. Works on ANY focused application. Use for typing into native apps, pressing shortcuts (Cmd+C, Cmd+V, etc.).",
            parameters: {
                type: "object",
                properties: {
                    text: {
                        type: "string",
                        description:
                            "Text to type. Can be combined with key: types the text, then presses the key (text='45*12', key='return').",
                    },
                    key: {
                        type: "string",
                        description:
                            "Special key to press: return, tab, escape, delete (backspace), forward delete, space, up, down, left, right, home, end, pageup, pagedown, f1-f12",
                    },
                    combo: {
                        type: "string",
                        description:
                            "Hotkey combo like 'command+c', 'command+shift+s', 'option+tab'. Use + to separate modifiers and key.",
                    },
                    delay_ms: { type: "number", description: "Delay in ms after action (default: 200)" },
                    app: {
                        type: "string",
                        description:
                            "Type text into this app (e.g. 'TextEdit') at its cursor without bringing it to the front, so the user keeps their window. Falls back to bringing it forward when its field won't take text that way.",
                    },
                },
                required: [],
            },
        },
    },

    async handler(input) {
        if (process.platform !== "darwin") {
            return JSON.stringify({ error: "os_type is only available on macOS." });
        }

        const delayMs = (input.delay_ms as number) || 200;
        const delaySec = delayMs / 1000;
        let script: string;

        // Background typing (trycua/cua): text for a named app that isn't in front goes into
        // its focused field, read back to confirm; the user's front window keeps the keyboard.
        let raisedFor: string | undefined;
        const bgApp = typeof input.app === "string" ? input.app.trim() : "";
        if (bgApp && typeof input.text === "string" && input.text && !input.key && !input.combo) {
            const front = await getFrontmostApp();
            if (!front || !frontmostMatches(bgApp, front)) {
                const pid = await pidOfApp(bgApp);
                const { axInsertText } = await import("../screen/ax-dump.js");
                const r =
                    pid && process.env.ATLAS_NO_BACKGROUND_TYPE !== "true"
                        ? await axInsertText(pid, input.text)
                        : { ok: false, error: pid ? "off" : "not_running" };
                if (r.ok) {
                    return JSON.stringify({
                        success: true,
                        typed_chars: input.text.length,
                        method: "background",
                        into: bgApp,
                        note: `Typed at ${bgApp}'s cursor without bringing it forward.`,
                    });
                }
                // Web content, a terminal, no field: bring it forward and type as usual.
                await execFileAsync("open", ["-a", bgApp], { timeout: 5000 }).catch(() => {});
                if (await waitForFrontmost(bgApp, 5000)) raisedFor = `${bgApp} (background typing: ${r.error})`;
            }
        } else if (bgApp && (input.key || input.combo)) {
            // A key for a named app goes to that app: gpt-4.1-nano sent key "return" with app
            // "Calculator" while TextEdit was in front, and TextEdit got it.
            const front = await getFrontmostApp();
            if (!front || !frontmostMatches(bgApp, front)) {
                await execFileAsync("open", ["-a", bgApp], { timeout: 5000 }).catch(() => {});
                if (await waitForFrontmost(bgApp, 5000)) raisedFor = bgApp;
                else return JSON.stringify({ success: false, error: `${bgApp} didn't come to the front, so nothing was pressed.` });
            }
        }
        // Another app took the front since Bhai's last step: put Bhai's app back first
        // (not when this call just brought its own app forward).
        const refocused = raisedFor ? undefined : await restoreFrontIfStolen();

        // text "return" alone means the key (gpt-4.1-nano typed the word into Calculator).
        const keyWord = typeof input.text === "string" ? input.text.trim().toLowerCase() : "";
        if (!input.key && !input.combo && /^(return|enter|escape|esc|tab)$/.test(keyWord)) {
            input = { ...input, key: keyWord === "esc" ? "escape" : keyWord, text: undefined };
        }
        // key: "command+c" is a shortcut, not a key name.
        if (typeof input.key === "string" && input.key.includes("+") && !input.combo) {
            input = { ...input, combo: input.key, key: undefined };
        }
        // ...and "cmd+space" / "command+n" as text means the shortcut.
        if (!input.key && !input.combo && /^((cmd|command|ctrl|control|alt|option|shift)\+)+[a-z0-9]+$/.test(keyWord)) {
            input = { ...input, combo: keyWord, text: undefined };
        }

        // TextEdit opens on its Open panel: gpt-4.1-nano typed the document's text into the
        // panel's search box and reported it written, past a note saying a dialog was in front.
        if (input.text && (await frontIsOpenPanel())) {
            return JSON.stringify({
                success: false,
                error: "Not typed: the front window is the app's Open file panel, so the text would go into its search box, not a document.",
                next: "For a new document press os_type combo='command+n' (or click 'New Document'), then type. To open a file, use open_in_app.",
            });
        }

        // Calculator, only for text that looks like arithmetic (no extra lookup otherwise).
        if (
            typeof input.text === "string" &&
            /\d/.test(input.text) &&
            /^[\w\s.,+\-*/×÷()%=]+$/.test(input.text) &&
            /^calculator$/i.test((await getFrontmostApp())?.name ?? "")
        ) {
            // It reads letters as keys: gpt-4.1-nano typed "123 times 45" and n became natural log.
            const expr = input.text
                .toLowerCase()
                .replace(/\bmultiplied by\b|\btimes\b|\bx\b|×/g, "*")
                .replace(/\bdivided by\b|÷/g, "/")
                .replace(/\bplus\b/g, "+")
                .replace(/\bminus\b/g, "-")
                .replace(/\bequals\b/g, "=");
            if (/[a-z]/.test(expr)) {
                return JSON.stringify({
                    success: false,
                    error: `Not typed: Calculator reads letters as function keys. Type the expression with digits and + - * / ( ) %, e.g. "123*45", then key "return".`,
                });
            }
            input = { ...input, text: expr };
            // It keeps its last entry, even across a relaunch: "42*3" typed after "75 + 2" made
            // 75 + 242 × 3 = 801. A whole new expression starts from a cleared display.
            if (/\d\s*[-+*/]\s*\d/.test(expr)) {
                await execFileAsync("osascript", [
                    "-e",
                    'tell application "System Events" to repeat 2 times\nkey code 53\ndelay 0.05\nend repeat',
                ]).catch(() => {});
            }
        }

        // text plus key/combo in one call ("45*12" then return): type, then press.
        // Taking only the key dropped the text while reporting success.
        let typedFirst = 0;
        if (input.text && (input.key || input.combo)) {
            try {
                await withCursorTyping(() => typeTextMac(String(input.text)));
                typedFirst = String(input.text).length;
            } catch (err) {
                return JSON.stringify({ success: false, error: `Typing failed: ${(err as Error).message}` });
            }
        }

        if (input.combo) {
            // Parse combo like "command+shift+s"
            const parts = (input.combo as string)
                .toLowerCase()
                .split("+")
                .map((s) => s.trim());
            const key = parts.pop() || "";
            const modifiers: string[] = [];
            for (const mod of parts) {
                if (mod === "command" || mod === "cmd") modifiers.push("command down");
                else if (mod === "shift") modifiers.push("shift down");
                else if (mod === "option" || mod === "alt") modifiers.push("option down");
                else if (mod === "control" || mod === "ctrl") modifiers.push("control down");
            }
            const modStr = modifiers.length > 0 ? ` using {${modifiers.join(", ")}}` : "";

            const code = keyCode(key);
            if (code !== undefined) {
                script = `tell application "System Events"\n  key code ${code}${modStr}\nend tell\ndelay ${delaySec}`;
            } else if (key.length === 1) {
                script = `tell application "System Events"\n  keystroke "${key.replace(/[\\"]/g, "\\$&")}"${modStr}\nend tell\ndelay ${delaySec}`;
            } else {
                return JSON.stringify({ success: false, error: unknownKey(key) });
            }
        } else if (input.key) {
            const key = (input.key as string).toLowerCase().trim();
            const code = keyCode(key);
            if (code === undefined) return JSON.stringify({ success: false, error: unknownKey(key) });
            script = `tell application "System Events"\n  key code ${code}\nend tell\ndelay ${delaySec}`;
        } else if (input.text) {
            const text = input.text as string;
            try {
                const method = await withCursorTyping(() => typeTextMac(text));
                const [into] = await Promise.all([getFrontmostApp(), new Promise((r) => setTimeout(r, delayMs))]);
                // Which app got the text, so a wrong window shows up now rather than at the end.
                return JSON.stringify({
                    success: true,
                    typed_chars: text.length, // not echoed: it may be a secret
                    method,
                    into: into?.name,
                    ...(raisedFor ? { brought_forward: raisedFor } : {}),
                    ...(refocused ? { refocused: `${refocused} had lost the front; brought it back first` } : {}),
                    next: "Typed only. To submit or evaluate it (search box, form, calculator =), press os_type key='return'.",
                });
            } catch (err) {
                return JSON.stringify({ success: false, error: `Typing failed: ${(err as Error).message}` });
            }
        } else {
            return JSON.stringify({ error: "Provide 'text', 'key', or 'combo'" });
        }

        const tmpFile = join(tmpdir(), `atlas_type_${Date.now()}.scpt`);
        try {
            await fs.writeFile(tmpFile, script, "utf-8");
            const { stdout, stderr } = await execFileAsync("osascript", [tmpFile], { timeout: 10000 });
            await fs.unlink(tmpFile).catch(() => {});
            // After Return/Enter, what the window now shows (a calculator's result, a form's
            // error): gpt-4.1-nano pressed "=" and then wrote a made-up product instead of
            // reading the display.
            const submitted = /^(return|enter)$/i.test(String(input.key ?? ""));
            const shows = submitted ? await frontWindowText() : [];
            return JSON.stringify({
                success: true,
                ...(typedFirst ? { typed_chars: typedFirst } : {}),
                pressed: input.key || input.combo,
                ...(raisedFor ? { brought_forward: raisedFor } : {}),
                ...(shows.length ? { window_shows: shows } : {}),
                ...(refocused ? { refocused: `${refocused} had lost the front; brought it back first` } : {}),
                stdout: (stdout || "").substring(0, 500),
                stderr: (stderr || "").substring(0, 500),
            });
        } catch (err) {
            await fs.unlink(tmpFile).catch(() => {});
            const error = err as { message?: string };
            return JSON.stringify({ success: false, error: error.message || "Keyboard action failed" });
        }
    },
};

// macOS virtual key codes live with os_computer_action (MAC_KEY_CODES), shared by every key path.
const KEY_CODES = MAC_KEY_CODES;

function keyCode(key: string): number | undefined {
    return Object.hasOwn(KEY_CODES, key) ? KEY_CODES[key] : undefined;
}

function unknownKey(key: string): string {
    return `Unknown key "${key}". Use one of: ${Object.keys(KEY_CODES).join(", ")}, or a single character in a combo.`;
}

// ── OCR Helpers ───────────────────────────────
// Levenshtein distance for fuzzy text matching
function levenshtein(a: string, b: string): number {
    const m = a.length,
        n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
        Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
    );
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] =
                a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

// Similarity score [0.0 – 1.0]
function similarity(a: string, b: string): number {
    const al = a.toLowerCase(),
        bl = b.toLowerCase();
    if (al === bl) return 1.0;
    // The query inside a longer OCR line counts; a short OCR fragment inside the
    // query ("ok" in "message sent") only when it covers most of it.
    if (bl.includes(al) || (al.includes(bl) && bl.length >= al.length * 0.6)) return 0.9;
    const dist = levenshtein(al, bl);
    return Math.max(0, 1 - dist / Math.max(al.length, bl.length, 1));
}

interface OcrElement {
    text: string;
    cx_norm: number;
    cy_norm: number;
    w_norm: number;
    h_norm: number;
    cx_screen: number;
    cy_screen: number;
    confidence: number;
}

interface OcrResult {
    screen_width: number;
    screen_height: number;
    image_width: number;
    image_height: number;
    elements: OcrElement[];
    element_count: number;
}

/** Run the Swift OCR script on a given screenshot (or fresh capture if null). */
async function runOcr(
    screenshotPath: string | null,
    mode: "fast" | "accurate" = "accurate",
    screenshotBuffer?: Buffer,
    /** The monitor the screenshot shows (from captureFocusedDisplay); maps OCR boxes onto it. */
    region?: ScreenDimensions,
): Promise<OcrResult | null> {
    // Check cache
    if (screenshotBuffer) {
        const hash = computeScreenshotHash(screenshotBuffer);
        if (_ocrCache && _ocrCache.hash === hash && Date.now() - _ocrCache.timestamp < OCR_CACHE_TTL_MS) {
            return _ocrCache.result;
        }
    }

    const sdir = getScriptsDir();
    const swiftScript = join(sdir, "ocr_screen.swift");

    // Prefer compiled binary for speed (saves 1-3s compilation overhead)
    const compiledBin = join(sdir, "ocr_screen_bin");
    let ocrExecutable: string;
    let ocrArgs: string[];
    if (existsSync(compiledBin)) {
        ocrExecutable = compiledBin;
        ocrArgs = screenshotPath ? [screenshotPath, mode] : [mode];
    } else {
        ocrExecutable = "swift";
        ocrArgs = screenshotPath ? [swiftScript, screenshotPath, mode] : [swiftScript, mode];
    }

    try {
        const { stdout } = await execFileAsync(ocrExecutable, ocrArgs, { timeout: 20000 });
        const parsedResult = JSON.parse(stdout.trim()) as OcrResult;
        // The helper maps boxes onto the MAIN display; a capture of another
        // monitor needs that monitor's origin and size instead.
        if (region) {
            for (const el of parsedResult.elements as Array<OcrElement & { w_screen?: number; h_screen?: number }>) {
                el.cx_screen = region.originX + el.cx_norm * region.width;
                el.cy_screen = region.originY + el.cy_norm * region.height;
                el.w_screen = el.w_norm * region.width;
                el.h_screen = el.h_norm * region.height;
            }
        }

        // Update cache
        if (screenshotBuffer) {
            _ocrCache = { result: parsedResult, hash: computeScreenshotHash(screenshotBuffer), timestamp: Date.now() };
        }

        return parsedResult;
    } catch {
        return null;
    }
}

/** Find best-matching OCR element for a given label. Returns null if none found above threshold. */
// Text split across OCR elements (one per word on Windows, one per wrapped
// line on macOS) still matches: test the query against all of it joined in the
// helper's reading order. Returns the element where the match starts.
function matchAcrossElements(elements: OcrElement[], label: string): OcrElement | null {
    const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
    const q = norm(label);
    if (!q.includes(" ")) return null;
    let joined = "";
    const starts: number[] = [];
    for (const el of elements) {
        starts.push(joined.length);
        joined += `${norm(el.text)} `;
    }
    const at = joined.indexOf(q);
    if (at < 0) return null;
    let i = 0;
    while (i + 1 < starts.length && starts[i + 1] <= at) i++;
    return elements[i];
}

function findBestMatch(
    elements: OcrElement[],
    label: string,
    threshold = 0.45,
): { element: OcrElement; score: number } | null {
    let best: { element: OcrElement; score: number } | null = null;
    const labelLower = label.toLowerCase();

    for (const el of elements) {
        // Try exact substring match first (highest confidence)
        const textLower = el.text.toLowerCase();
        if (
            textLower.includes(labelLower) ||
            (labelLower.includes(textLower) && textLower.length >= labelLower.length * 0.6)
        ) {
            const exactScore = textLower === labelLower ? 1.0 : 0.85;
            if (exactScore > (best?.score ?? threshold)) {
                best = { element: el, score: exactScore };
                if (exactScore === 1.0) return best; // Perfect match, stop searching
            }
            continue;
        }

        // Fuzzy match via Levenshtein
        const score = similarity(label, el.text);
        if (score > (best?.score ?? threshold)) {
            best = { element: el, score };
        }
    }
    if (!best || best.score < 0.8) {
        const spanned = matchAcrossElements(elements, label);
        if (spanned) return { element: spanned, score: 0.8 };
    }
    return best;
}

export { findBestMatch as _findBestMatchForTest };

/**
 * Where os_visual_verify's expected text counts. It read the whole display with a loose
 * fuzzy match, so "display shows 0" passed on the menu-bar clock ("Fri Oct 30 …") and
 * "shows 7" on another window's title. Now: never the menu bar; the focused window first;
 * elsewhere (a toast, a notification) only a strong match of longer text; and a short
 * expected value ("0", "7", "OK") must be a whole word in the window, not a fragment of "30".
 */
export function findVerifyMatch(
    elements: OcrElement[],
    expect: string,
    win?: { x: number; y: number; w: number; h: number },
    menuBarBottom = 25,
): { element: OcrElement; score: number } | null {
    const q = expect.trim().toLowerCase();
    if (!q) return null;
    const words = (t: string) =>
        t
            .toLowerCase()
            .split(/[^\p{L}\p{N}.,]+/u)
            .filter(Boolean);
    const short = q.length <= 3;
    const candidates = elements.filter((el) => el.cy_screen >= menuBarBottom);
    const inWin = win
        ? candidates.filter(
              (el) =>
                  el.cx_screen >= win.x &&
                  el.cx_screen <= win.x + win.w &&
                  el.cy_screen >= win.y &&
                  el.cy_screen <= win.y + win.h,
          )
        : candidates;
    const pick = (els: OcrElement[], minScore: number) => {
        if (short) {
            const el = els.find((e) => e.text.trim().toLowerCase() === q || words(e.text).includes(q));
            return el ? { element: el, score: 1 } : null;
        }
        const m = findBestMatch(els, expect, minScore);
        return m && m.score >= minScore ? m : null;
    };
    // A short value ("0", "7", "OK") is everywhere on a screen: only the window counts.
    return (
        pick(inWin, 0.6) ??
        (win && !short
            ? pick(
                  candidates.filter((el) => !inWin.includes(el)),
                  0.85,
              )
            : null)
    );
}

/** Perform a native click at logical screen coordinates. */
async function nativeClick(x: number, y: number): Promise<boolean> {
    const eventScript = `
ObjC.import('CoreGraphics');
var point = $.CGPointMake(${x}, ${y});
var move = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, point, $.kCGMouseButtonLeft);
$.CGEventPost($.kCGHIDEventTap, move);
delay(0.06);
var down = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, point, $.kCGMouseButtonLeft);
$.CGEventPost($.kCGHIDEventTap, down);
delay(0.07);
var up = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, point, $.kCGMouseButtonLeft);
$.CGEventPost($.kCGHIDEventTap, up);
"clicked"`;

    const tmpFile = join(tmpdir(), `atlas_click_${Date.now()}.js`);
    try {
        await cursorClick(x, y);
        await fs.writeFile(tmpFile, eventScript, "utf-8");
        await execFileAsync("osascript", ["-l", "JavaScript", tmpFile], { timeout: 5000 });
        await fs.unlink(tmpFile).catch(() => {});
        return true;
    } catch {
        await fs.unlink(tmpFile).catch(() => {});
        return false;
    }
}

// ── Accessibility Elements Helper ────────────

async function getAccessibilityElements(): Promise<
    Array<{ name: string; role: string; x: number; y: number; w: number; h: number }>
> {
    try {
        const { stdout } = await execFileAsync(
            "osascript",
            [
                "-e",
                `
            tell application "System Events"
                set frontApp to first process whose frontmost is true
                set appName to name of frontApp
                try
                    set uiElements to entire contents of window 1 of frontApp
                    set output to ""
                    set maxCount to 80
                    set counter to 0
                    repeat with elem in uiElements
                        if counter >= maxCount then exit repeat
                        try
                            set elemRole to role of elem
                            set elemName to name of elem
                            if elemName is missing value then set elemName to ""
                            set elemPos to position of elem
                            set elemSize to size of elem
                            set output to output & elemRole & "|||" & elemName & "|||" & (item 1 of elemPos) & "|||" & (item 2 of elemPos) & "|||" & (item 1 of elemSize) & "|||" & (item 2 of elemSize) & "\\n"
                            set counter to counter + 1
                        end try
                    end repeat
                    return output
                end try
            end tell
        `,
            ],
            { timeout: 5000 },
        );

        const elements: Array<{ name: string; role: string; x: number; y: number; w: number; h: number }> = [];
        for (const line of stdout.split("\n")) {
            const parts = line.split("|||");
            if (parts.length >= 6) {
                elements.push({
                    role: parts[0].trim(),
                    name: parts[1].trim(),
                    x: parseInt(parts[2], 10) || 0,
                    y: parseInt(parts[3], 10) || 0,
                    w: parseInt(parts[4], 10) || 0,
                    h: parseInt(parts[5], 10) || 0,
                });
            }
        }
        return elements;
    } catch {
        return [];
    }
}

// ── Quick Accessibility Refresh ──────────────
// Lightweight alternative to full os_scan — runs accessibility only (~200ms vs ~5-10s)
// Used for auto-refresh in os_click_element and os_nav

async function quickAccessibilityRefresh(): Promise<ScanElement[]> {
    const axElements = await getAccessibilityElements();
    const refreshed: ScanElement[] = [];
    let labelCounter = 1;
    for (const ax of axElements) {
        if (!ax.name || ax.name.length === 0) continue;
        refreshed.push({
            label: labelCounter++,
            text: ax.name,
            role: ax.role.replace("AX", ""),
            x: ax.x + Math.round(ax.w / 2),
            y: ax.y + Math.round(ax.h / 2),
            w: ax.w,
            h: ax.h,
        });
    }
    _scanElements = refreshed;
    _scanTimestamp = Date.now();
    return refreshed;
}

// ── OS Nav Tool (Accessibility-First Navigation) ──
// 10x faster than os_scan: queries accessibility tree only (~200ms, ~500 tokens)
// No screenshot, no OCR, no SoM overlay — just structured element data

export const osNav: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_nav",
            description:
                "Fast, lightweight screen element list using accessibility (no screenshot). Returns numbered list of all interactive elements (buttons, text fields, links, etc.) in the frontmost app. Use os_click_element with text= to click by text match (preferred) or label= for label number. 10x faster than os_scan — prefer this for native macOS apps. Fall back to os_scan only for visual layout understanding or web content.",
            parameters: {
                type: "object",
                properties: {
                    app: {
                        type: "string",
                        description: "Optional: specific app name to scan (default: frontmost app)",
                    },
                },
                required: [],
            },
        },
    },

    async handler(input) {
        if (process.platform !== "darwin") {
            return JSON.stringify({ error: "os_nav is only available on macOS." });
        }

        try {
            const startTime = Date.now();

            // Get frontmost app info
            let appTarget = "first process whose frontmost is true";
            if (input.app) {
                appTarget = `process "${(input.app as string).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
            }

            // Query accessibility tree with role filtering for interactive elements
            const { stdout } = await execFileAsync(
                "osascript",
                [
                    "-e",
                    `
                tell application "System Events"
                    set frontProc to ${appTarget}
                    set appName to name of frontProc
                    try
                        set uiElements to entire contents of window 1 of frontProc
                        set output to appName & "\\n"
                        set maxCount to 60
                        set counter to 0
                        set interactiveRoles to {"AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXLink", "AXSlider", "AXIncrementor", "AXComboBox", "AXTabGroup", "AXTable", "AXRow", "AXMenuItem", "AXStaticText", "AXImage", "AXGroup"}
                        repeat with elem in uiElements
                            if counter >= maxCount then exit repeat
                            try
                                set elemRole to role of elem
                                if interactiveRoles contains elemRole then
                                    set elemName to ""
                                    try
                                        set elemName to name of elem
                                    end try
                                    if elemName is missing value then set elemName to ""
                                    try
                                        set elemVal to value of elem
                                        if elemVal is not missing value and elemVal is not "" and elemName is "" then
                                            set elemName to elemVal as text
                                        end if
                                    end try
                                    if elemName is not "" then
                                        set elemPos to position of elem
                                        set elemSz to size of elem
                                        set elemEnabled to true
                                        try
                                            set elemEnabled to enabled of elem
                                        end try
                                        set output to output & elemRole & "|||" & elemName & "|||" & (item 1 of elemPos) & "|||" & (item 2 of elemPos) & "|||" & (item 1 of elemSz) & "|||" & (item 2 of elemSz) & "|||" & elemEnabled & "\\n"
                                        set counter to counter + 1
                                    end if
                                end if
                            end try
                        end repeat
                        return output
                    end try
                end tell
            `,
                ],
                { timeout: 5000 },
            );

            // Parse results
            const lines = stdout.split("\n").filter(Boolean);
            const appName = lines[0] || "Unknown";
            const elements: ScanElement[] = [];
            let labelCounter = 1;

            for (let i = 1; i < lines.length; i++) {
                const parts = lines[i].split("|||");
                if (parts.length >= 6) {
                    const name = parts[1].trim();
                    if (!name) continue;
                    const x = parseInt(parts[2], 10) || 0;
                    const y = parseInt(parts[3], 10) || 0;
                    const w = parseInt(parts[4], 10) || 0;
                    const h = parseInt(parts[5], 10) || 0;
                    elements.push({
                        label: labelCounter++,
                        text: name,
                        role: parts[0].trim().replace("AX", ""),
                        x: x + Math.round(w / 2),
                        y: y + Math.round(h / 2),
                        w,
                        h,
                    });
                }
            }

            // Update the shared element map (same as os_scan)
            _scanElements = elements;
            _scanTimestamp = Date.now();

            // Build compact text summary
            const summary = elements
                .map((el) => `[${el.label}] (${el.role}) "${el.text}" at (${el.x},${el.y})`)
                .join("\n");

            const elapsed = Date.now() - startTime;

            return JSON.stringify({
                success: true,
                app: appName,
                element_count: elements.length,
                elements: summary,
                elapsed_ms: elapsed,
                tip: "Use os_click_element with text= to click by text match (preferred) or label= for label number. Example: os_click_element label=3 action=click. For double-click: action=double_click.",
            });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ── OS OCR Click Tool ─────────────────────────

export const osOcrClick: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_ocr_click",
            description:
                "LEGACY OCR-based clicker. Prefer `os_smart_click` for click-by-description tasks — it cascades AX → OmniParser → UI-TARS automatically and is faster, more reliable, and learns from prior clicks. Use os_ocr_click only when the agent has already tried os_smart_click and explicitly wants pure-OCR fallback (no AX, no vision grounding). Takes a text label and tries to find it visually in a screen capture.",
            parameters: {
                type: "object",
                properties: {
                    label: {
                        type: "string",
                        description:
                            "The visible text of the element to click (e.g. 'Send', 'Desktop', 'Open', 'Cancel'). Fuzzy matched — partial text is fine.",
                    },
                    max_attempts: {
                        type: "number",
                        description:
                            "Max retry attempts if click fails (default: 3). Each retry uses a slightly different coordinate offset.",
                    },
                    verify_appears: {
                        type: "string",
                        description:
                            "Optional: text that should APPEAR on screen after a successful click (e.g. 'Saving...'). Used to confirm success.",
                    },
                    verify_gone: {
                        type: "boolean",
                        description:
                            "If true, confirms success by checking that the original label text is no longer visible after clicking (e.g. a Submit button disappearing). Default: false.",
                    },
                    ocr_mode: {
                        type: "string",
                        enum: ["accurate", "fast"],
                        description:
                            "OCR recognition mode (default: fast). Automatically escalates to accurate if fast finds no match.",
                    },
                },
                required: ["label"],
            },
        },
    },

    async handler(input) {
        if (process.platform !== "darwin") {
            return JSON.stringify({ error: "os_ocr_click is only available on macOS." });
        }

        const label = input.label as string;
        const maxAttempts = (input.max_attempts as number) || 3;
        const verifyAppears = input.verify_appears as string | undefined;
        const verifyGone = (input.verify_gone as boolean) || false;
        const ocrMode = ((input.ocr_mode as string) || "fast") as "fast" | "accurate";

        let lastElementCount = 0;

        const attemptLog: Array<{
            attempt: number;
            matched_text: string | null;
            score: number | null;
            x: number | null;
            y: number | null;
            outcome: string;
        }> = [];

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            console.log(`  🔍 [OCR-CLICK] Attempt ${attempt + 1}/${maxAttempts} — looking for "${label}"`);

            // Step 1: Capture screenshot + run OCR
            const tmpPng = join(tmpdir(), `atlas_ocr_cap_${Date.now()}.png`);
            let capBuffer: Buffer | undefined;
            let capDims: ScreenDimensions | undefined;
            try {
                capDims = await captureFocusedDisplay(tmpPng);
                capBuffer = await fs.readFile(tmpPng);
            } catch (err) {
                attemptLog.push({
                    attempt,
                    matched_text: null,
                    score: null,
                    x: null,
                    y: null,
                    outcome: "screenshot_failed",
                });
                continue;
            }

            // Escalate to accurate on later retries
            const effectiveMode = attempt >= 1 ? ("accurate" as const) : ocrMode;

            let ocrResult = await runOcr(tmpPng, effectiveMode, capBuffer, capDims);

            // Fast-mode fallback: if fast found 0 elements, retry with accurate
            if (ocrResult && ocrResult.elements.length === 0 && effectiveMode === "fast") {
                ocrResult = await runOcr(tmpPng, "accurate", capBuffer, capDims);
            }

            if (!ocrResult || ocrResult.elements.length === 0) {
                await fs.unlink(tmpPng).catch(() => {});

                // Attempt 3: Accessibility tree fallback when OCR finds nothing
                if (attempt === maxAttempts - 1) {
                    const axElements = await getAccessibilityElements();
                    if (axElements.length > 0) {
                        let bestAxMatch: (typeof axElements)[0] | null = null;
                        let bestAxScore = 0;
                        for (const ax of axElements) {
                            if (ax.name) {
                                const score = similarity(label.toLowerCase(), ax.name.toLowerCase());
                                if (score > bestAxScore) {
                                    bestAxScore = score;
                                    bestAxMatch = ax;
                                }
                            }
                        }
                        if (bestAxMatch && bestAxScore >= 0.5) {
                            const axClickX = bestAxMatch.x + Math.round(bestAxMatch.w / 2);
                            const axClickY = bestAxMatch.y + Math.round(bestAxMatch.h / 2);
                            console.log(
                                `  🎯 [OCR-CLICK] Accessibility fallback: "${bestAxMatch.name}" (score=${bestAxScore.toFixed(2)}) → screen(${axClickX}, ${axClickY})`,
                            );
                            const axClicked = await nativeClick(axClickX, axClickY);
                            if (axClicked) {
                                attemptLog.push({
                                    attempt,
                                    matched_text: bestAxMatch.name,
                                    score: bestAxScore,
                                    x: axClickX,
                                    y: axClickY,
                                    outcome: "success_accessibility_fallback",
                                });
                                return JSON.stringify({
                                    success: true,
                                    matched_text: bestAxMatch.name,
                                    similarity_score: bestAxScore,
                                    method: "accessibility_fallback",
                                    clicked: { x: axClickX, y: axClickY },
                                    attempts: attempt + 1,
                                    verification: "not_requested",
                                    tip: "Take an os_screenshot to visually confirm the action worked.",
                                    attempts_log: attemptLog,
                                });
                            }
                        }
                    }
                }

                attemptLog.push({
                    attempt,
                    matched_text: null,
                    score: null,
                    x: null,
                    y: null,
                    outcome: "ocr_failed_no_elements",
                });
                // Wait a moment for UI to settle before retry
                await new Promise((r) => setTimeout(r, 600));
                continue;
            }

            lastElementCount = ocrResult.elements.length;

            // Step 2: Fuzzy-match label against OCR elements
            let match = findBestMatch(ocrResult.elements, label);

            // Fast-mode fallback: if best score < 0.4, retry with accurate
            if ((!match || match.score < 0.4) && effectiveMode === "fast") {
                const accurateResult = await runOcr(tmpPng, "accurate", capBuffer, capDims);
                if (accurateResult && accurateResult.elements.length > 0) {
                    ocrResult = accurateResult;
                    lastElementCount = ocrResult.elements.length;
                    match = findBestMatch(ocrResult.elements, label);
                }
            }

            // Clean up screenshot temp file after all OCR passes
            await fs.unlink(tmpPng).catch(() => {});

            if (!match) {
                // Attempt 3: Accessibility tree fallback when OCR match fails
                if (attempt === maxAttempts - 1) {
                    const axElements = await getAccessibilityElements();
                    if (axElements.length > 0) {
                        let bestAxMatch: (typeof axElements)[0] | null = null;
                        let bestAxScore = 0;
                        for (const ax of axElements) {
                            if (ax.name) {
                                const score = similarity(label.toLowerCase(), ax.name.toLowerCase());
                                if (score > bestAxScore) {
                                    bestAxScore = score;
                                    bestAxMatch = ax;
                                }
                            }
                        }
                        if (bestAxMatch && bestAxScore >= 0.5) {
                            const axClickX = bestAxMatch.x + Math.round(bestAxMatch.w / 2);
                            const axClickY = bestAxMatch.y + Math.round(bestAxMatch.h / 2);
                            console.log(
                                `  🎯 [OCR-CLICK] Accessibility fallback: "${bestAxMatch.name}" (score=${bestAxScore.toFixed(2)}) → screen(${axClickX}, ${axClickY})`,
                            );
                            const axClicked = await nativeClick(axClickX, axClickY);
                            if (axClicked) {
                                attemptLog.push({
                                    attempt,
                                    matched_text: bestAxMatch.name,
                                    score: bestAxScore,
                                    x: axClickX,
                                    y: axClickY,
                                    outcome: "success_accessibility_fallback",
                                });
                                return JSON.stringify({
                                    success: true,
                                    matched_text: bestAxMatch.name,
                                    similarity_score: bestAxScore,
                                    method: "accessibility_fallback",
                                    clicked: { x: axClickX, y: axClickY },
                                    attempts: attempt + 1,
                                    verification: "not_requested",
                                    tip: "Take an os_screenshot to visually confirm the action worked.",
                                    attempts_log: attemptLog,
                                });
                            }
                        }
                    }
                }

                attemptLog.push({
                    attempt,
                    matched_text: null,
                    score: null,
                    x: null,
                    y: null,
                    outcome: `no_match_above_threshold (${ocrResult.elements.length} elements scanned)`,
                });
                await new Promise((r) => setTimeout(r, 600));
                continue;
            }

            // Step 3: Click at matched element center (no jitter — fallback chain is better)
            const clickX = Math.round(match.element.cx_screen);
            const clickY = Math.round(match.element.cy_screen);

            console.log(
                `  🎯 [OCR-CLICK] Matched "${match.element.text}" (score=${match.score.toFixed(2)}, conf=${match.element.confidence.toFixed(2)}) → screen(${clickX}, ${clickY})`,
            );

            // Step 4: Click
            const clicked = await nativeClick(clickX, clickY);
            if (!clicked) {
                attemptLog.push({
                    attempt,
                    matched_text: match.element.text,
                    score: match.score,
                    x: clickX,
                    y: clickY,
                    outcome: "click_event_failed",
                });
                continue;
            }

            // Step 5: Wait for UI to react
            await new Promise((r) => setTimeout(r, 500));

            // Step 6: Visual verification
            let verificationOutcome = "not_checked";
            if (verifyAppears || verifyGone) {
                const tmpVerify = join(tmpdir(), `atlas_verify_${Date.now()}.png`);
                try {
                    const verifyDims = await captureFocusedDisplay(tmpVerify);
                    const verifyBuf = await fs.readFile(tmpVerify);
                    const verifyOcr = await runOcr(tmpVerify, "fast", verifyBuf, verifyDims);
                    await fs.unlink(tmpVerify).catch(() => {});

                    if (verifyOcr) {
                        if (verifyAppears) {
                            const found = findBestMatch(verifyOcr.elements, verifyAppears, 0.6);
                            if (found) {
                                verificationOutcome = `verified_appears: "${found.element.text}" (score=${found.score.toFixed(2)})`;
                                attemptLog.push({
                                    attempt,
                                    matched_text: match.element.text,
                                    score: match.score,
                                    x: clickX,
                                    y: clickY,
                                    outcome: "success_verified",
                                });
                                return JSON.stringify({
                                    success: true,
                                    matched_text: match.element.text,
                                    similarity_score: match.score,
                                    ocr_confidence: match.element.confidence,
                                    clicked: { x: clickX, y: clickY },
                                    attempts: attempt + 1,
                                    verification: verificationOutcome,
                                    attempts_log: attemptLog,
                                });
                            } else {
                                verificationOutcome = `verify_appears_not_found: "${verifyAppears}"`;
                            }
                        }

                        if (verifyGone) {
                            const stillThere = findBestMatch(verifyOcr.elements, label, 0.7);
                            if (!stillThere) {
                                verificationOutcome = `verified_gone: "${label}" no longer on screen`;
                                attemptLog.push({
                                    attempt,
                                    matched_text: match.element.text,
                                    score: match.score,
                                    x: clickX,
                                    y: clickY,
                                    outcome: "success_verified_gone",
                                });
                                return JSON.stringify({
                                    success: true,
                                    matched_text: match.element.text,
                                    similarity_score: match.score,
                                    ocr_confidence: match.element.confidence,
                                    clicked: { x: clickX, y: clickY },
                                    attempts: attempt + 1,
                                    verification: verificationOutcome,
                                    attempts_log: attemptLog,
                                });
                            } else {
                                verificationOutcome = `verify_gone_failed: "${label}" still visible`;
                            }
                        }
                    }
                } catch {
                    verificationOutcome = "verification_screenshot_failed";
                }

                // Verification said it didn't work — retry
                attemptLog.push({
                    attempt,
                    matched_text: match.element.text,
                    score: match.score,
                    x: clickX,
                    y: clickY,
                    outcome: verificationOutcome,
                });
                await new Promise((r) => setTimeout(r, 400));
                continue;
            }

            // No verification requested — trust the click succeeded
            attemptLog.push({
                attempt,
                matched_text: match.element.text,
                score: match.score,
                x: clickX,
                y: clickY,
                outcome: "clicked_no_verify",
            });
            return JSON.stringify({
                success: true,
                matched_text: match.element.text,
                similarity_score: match.score,
                ocr_confidence: match.element.confidence,
                clicked: { x: clickX, y: clickY },
                attempts: attempt + 1,
                verification: "not_requested",
                tip: "Take an os_screenshot to visually confirm the action worked.",
                attempts_log: attemptLog,
            });
        }

        // All attempts exhausted
        return JSON.stringify({
            success: false,
            error: `Could not find "${label}" after ${maxAttempts} attempts. Try: 1) Run os_scan to see all visible elements, 2) Use os_click_element with a label number, 3) Check os_context to verify the correct app is focused.`,
            attempts: maxAttempts,
            elements_found: lastElementCount || 0,
            attempts_log: attemptLog,
        });
    },
};

// ── OS Visual Verify Tool ─────────────────────

export const osVisualVerify: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_visual_verify",
            description:
                "Visually verify task completion by checking if specific text is visible on screen — or has disappeared. Use this at the END of any OS task to confirm success before reporting back to the user. Much faster than os_screenshot + manual inspection.",
            parameters: {
                type: "object",
                properties: {
                    expect_text: {
                        type: "string",
                        description:
                            "Text that should be VISIBLE on screen for the task to be considered complete (e.g. 'Message sent', 'File saved', 'Desktop').",
                    },
                    expect_gone: {
                        type: "string",
                        description:
                            "Text that should NO LONGER be visible for the task to be complete (e.g. 'Sending...', 'Loading').",
                    },
                    description: {
                        type: "string",
                        description:
                            "Human-readable description of what you are verifying (e.g. 'Confirm message was sent in WhatsApp').",
                    },
                },
                required: [],
            },
        },
    },

    async handler(input) {
        if (process.platform !== "darwin") {
            return JSON.stringify({ error: "os_visual_verify is only available on macOS." });
        }

        // expected_text is what older prompts told the model to pass.
        const expectText = (input.expect_text ?? input.expected_text) as string | undefined;
        const expectGone = input.expect_gone as string | undefined;
        const description = (input.description as string) || "task completion";

        if (!expectText && !expectGone) {
            return JSON.stringify({ error: "Provide at least one of: expect_text or expect_gone." });
        }

        // Capture screen + run fast OCR
        const tmpPng = join(tmpdir(), `atlas_verify_${Date.now()}.png`);
        let verifyBuffer: Buffer | undefined;
        let verifyDims: ScreenDimensions | undefined;
        try {
            verifyDims = await captureFocusedDisplay(tmpPng);
            verifyBuffer = await fs.readFile(tmpPng);
        } catch (err) {
            return JSON.stringify({ success: false, error: "Screenshot failed during verification." });
        }

        const ocrResult = await runOcr(tmpPng, "fast", verifyBuffer, verifyDims);
        await fs.unlink(tmpPng).catch(() => {});

        if (!ocrResult) {
            return JSON.stringify({ success: false, error: "OCR failed during verification." });
        }

        const results: Record<string, unknown> = {
            description,
            element_count: ocrResult.element_count,
        };

        let overallSuccess = true;

        if (expectText) {
            const found = findVerifyMatch(
                ocrResult.elements,
                expectText,
                verifyDims?.focusedWindow,
                (verifyDims?.originY ?? 0) + 25,
            );
            // OCR misses some text (Calculator's large thin digits read as nothing, and a
            // model then re-pressed "=" to check). The front app's accessibility text is
            // exact: a hit there counts. Only found/not-found comes back, never a field's text.
            const inAx = !found && (await frontAppHasText(expectText));
            const pass = !!found || inAx;
            results.expect_text = {
                query: expectText,
                found: pass,
                matched: found?.element.text ?? (inAx ? expectText : null),
                score: found ? Number(found.score.toFixed(3)) : inAx ? 1 : null,
                position: found ? { x: found.element.cx_screen, y: found.element.cy_screen } : null,
                ...(inAx ? { source: "accessibility" } : {}),
            };
            if (!pass) overallSuccess = false;
        }

        if (expectGone) {
            const stillThere = findBestMatch(ocrResult.elements, expectGone, 0.7);
            const pass = !stillThere;
            results.expect_gone = {
                query: expectGone,
                still_visible: !pass,
                matched: stillThere?.element.text ?? null,
                pass,
            };
            if (!pass) overallSuccess = false;
        }

        results.success = overallSuccess;
        results.verdict = overallSuccess
            ? `✅ Verified: ${description}`
            : `❌ Verification FAILED: ${description}. The expected text was not found. Try: 1) Take a fresh screenshot to verify the current state, 2) The action may need more time — try wait(ms=1000) before verifying.`;

        return JSON.stringify(results);
    },
};

/** Up to 4 short read-only texts the front app's window shows (static text values only). */
/** The front window is an Open file panel with no sheet (e.g. Go to Folder) over it. */
async function frontIsOpenPanel(): Promise<boolean> {
    const { dumpAccessibilityTree } = await import("../screen/ax-dump.js");
    const dump = await dumpAccessibilityTree({ depth: 2, timeoutMs: 1500, budgetMs: 500 }).catch(() => null);
    const win = dump && !dump.error ? dump.root.children.find((n) => n.role === "AXWindow") : undefined;
    return !!win && /^open$/i.test(win.label?.trim() ?? "") && !win.children.some((c) => c.role === "AXSheet");
}

async function frontWindowText(): Promise<string[]> {
    await new Promise((r) => setTimeout(r, 150)); // the result draws a moment after the key
    const { dumpAccessibilityTree } = await import("../screen/ax-dump.js");
    const dump = await dumpAccessibilityTree({ depth: 12, timeoutMs: 2000, budgetMs: 800 }).catch(() => null);
    const win = dump && !dump.error ? dump.root.children.find((n) => n.role === "AXWindow") : undefined;
    const out: string[] = [];
    const stack = win ? [win] : [];
    for (let n = stack.shift(); n && out.length < 4; n = stack.shift()) {
        const v = n.role === "AXStaticText" ? (n.value || n.label || "").trim() : "";
        if (v && v.length <= 60 && !out.includes(v)) out.push(v);
        stack.push(...n.children);
    }
    return out;
}

/** Whether the frontmost app's accessibility tree shows `text` (labels and values, case and spacing ignored). */
async function frontAppHasText(text: string): Promise<boolean> {
    const flat = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
    const want = flat(text);
    if (!want) return false;
    const { dumpAccessibilityTree } = await import("../screen/ax-dump.js");
    const dump = await dumpAccessibilityTree({ depth: 20, timeoutMs: 3000 }).catch(() => null);
    if (!dump || dump.error) return false;
    const stack = [dump.root];
    for (let n = stack.pop(); n; n = stack.pop()) {
        for (const t of [n.label, n.value]) if (t && t !== "[secure]" && flat(t).includes(want)) return true;
        stack.push(...n.children);
    }
    return false;
}

// ── OS Context Tool (App Awareness) ───────────

export const osContext: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_context",
            description:
                "Get current OS context: which app is focused, window title, and screen resolution. Use this BEFORE os_type or os_click to verify the correct app is in focus. Very fast (no screenshot).",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },

    async handler() {
        if (process.platform !== "darwin") {
            return JSON.stringify({ error: "os_context is only available on macOS." });
        }

        const script = `
tell application "System Events"
    set frontApp to name of first process whose frontmost is true
    set frontAppId to bundle identifier of first process whose frontmost is true
end tell

tell application frontApp
    try
        set winTitle to name of front window
    on error
        set winTitle to "(no window)"
    end try
end tell

return frontApp & "|" & frontAppId & "|" & winTitle`;

        const tmpFile = join(tmpdir(), `atlas_ctx_${Date.now()}.scpt`);
        try {
            await fs.writeFile(tmpFile, script, "utf-8");
            const { stdout } = await execFileAsync("osascript", [tmpFile], { timeout: 3000 });
            await fs.unlink(tmpFile).catch(() => {});

            const parts = stdout.trim().split("|");
            const appName = parts[0] || "unknown";
            const bundleId = parts[1] || "";
            const windowTitle = parts[2] || "";

            // Get screen resolution via the multi-monitor-aware helper (cached, fresh, focused-window aware).
            const _ctxDims = await getScreenDimensions({ focusedWindow: true });
            const screenWidth = _ctxDims.width;
            const screenHeight = _ctxDims.height;
            lastScreenWidth = screenWidth;
            lastScreenHeight = screenHeight;

            return JSON.stringify({
                success: true,
                frontmost_app: appName,
                bundle_id: bundleId,
                window_title: windowTitle,
                screen: { width: screenWidth, height: screenHeight },
            });
        } catch (err) {
            await fs.unlink(tmpFile).catch(() => {});
            const error = err as { message?: string };
            return JSON.stringify({ success: false, error: error.message || "Failed to get OS context" });
        }
    },
};

// ── Set Brightness Tool ───────────────────────

export const setBrightness: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "set_brightness",
            description:
                "Set the macOS display brightness to a specific level. Much more reliable than simulating brightness keys via AppleScript.",
            parameters: {
                type: "object",
                properties: {
                    level: {
                        type: "number",
                        description:
                            "Brightness level from 0 (completely dark) to 100 (maximum brightness). Example: 50 for half brightness, 0 for screen off, 100 for full brightness.",
                    },
                },
                required: ["level"],
            },
        },
    },

    async handler(input) {
        if (process.platform !== "darwin") {
            return JSON.stringify({ error: "set_brightness is only available on macOS." });
        }

        const rawLevel = input.level as number;
        // Clamp to 0–100 and convert to 0.0–1.0
        const clamped = Math.max(0, Math.min(100, rawLevel));
        const fraction = clamped / 100;

        // Fallback chain: brightness CLI tool → CoreDisplay JXA → key simulation
        try {
            // First try the 'brightness' CLI tool (brew install brightness)
            const { stdout } = await execFileAsync("brightness", [String(fraction)], { timeout: 5000 });
            return JSON.stringify({
                success: true,
                brightness: clamped,
                fraction,
                method: "brightness-cli",
            });
        } catch {
            // Fallback: Use osascript with JXA + private CoreDisplay API
            const jxaScript = `
ObjC.import('Cocoa');
const lib = ObjC.unwrap($.NSBundle.bundleWithPath("/System/Library/Frameworks/CoreDisplay.framework").load());
$.CFRelease = ObjC.castRefToObject($.objc_getClass("NSObject"));
// CoreDisplay_Display_SetUserBrightness is available on macOS 10.12+
const CGDirectDisplayID = 0; // main display
ObjC.bindFunction('CoreDisplay_Display_SetUserBrightness', ['void', ['unsigned int', 'double']]);
$.CoreDisplay_Display_SetUserBrightness(CGDirectDisplayID, ${fraction});
'done'`;

            try {
                const tmpFile = join(tmpdir(), `atlas_brightness_${Date.now()}.js`);
                await fs.writeFile(tmpFile, jxaScript, "utf-8");
                await execFileAsync("osascript", ["-l", "JavaScript", tmpFile], { timeout: 5000 });
                await fs.unlink(tmpFile).catch(() => {});
                return JSON.stringify({
                    success: true,
                    brightness: clamped,
                    fraction,
                    method: "CoreDisplay",
                });
            } catch {
                // Last resort: simulate key presses (less precise but always works)
                // Key code 144 = brightness down, 145 = brightness up (F1/F2 without fn)
                // Press brightness down 16 times to reach 0, then up the right number
                const stepsUp = Math.round((clamped / 100) * 16);
                const keyScript = `tell application "System Events"
    -- First go to 0 (key code 144 = brightness down / F1)
    repeat 16 times
        key code 144
    end repeat
    -- Then go up to desired level (key code 145 = brightness up / F2)
    repeat ${stepsUp} times
        key code 145
    end repeat
end tell`;
                const tmpFile = join(tmpdir(), `atlas_brightness_${Date.now()}.scpt`);
                try {
                    await fs.writeFile(tmpFile, keyScript, "utf-8");
                    await execFileAsync("osascript", [tmpFile], { timeout: 15000 });
                    await fs.unlink(tmpFile).catch(() => {});
                    return JSON.stringify({
                        success: true,
                        brightness: clamped,
                        fraction,
                        method: "key-simulation",
                        note: "Used key simulation — brightness may not be exact. Install 'brightness' CLI (brew install brightness) for precise control.",
                    });
                } catch (err) {
                    await fs.unlink(tmpFile).catch(() => {});
                    const error = err as { message?: string };
                    return JSON.stringify({ success: false, error: error.message || "Failed to set brightness" });
                }
            }
        }
    },
};

// ── Send Screenshot Tool ──────────────────────

export const sendScreenshot: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "send_screenshot",
            description:
                "Capture a screenshot of the current macOS screen and send it directly to the user on Telegram. This is an all-in-one tool — do NOT use shell_exec + send_file separately. Always use this when the user asks to see their screen.",
            parameters: {
                type: "object",
                properties: {
                    caption: {
                        type: "string",
                        description: "Optional caption to send with the screenshot (default: 'Here is your screen')",
                    },
                },
                required: [],
            },
        },
    },

    async handler(input) {
        if (process.platform !== "darwin") {
            return JSON.stringify({ error: "send_screenshot is only available on macOS." });
        }

        const caption = (input.caption as string) || "Here's your screen 📸";
        const { bot, chatId } = getTelegramContext();

        if (!bot || !chatId) {
            return JSON.stringify({ error: "Telegram context not available. Cannot send screenshot." });
        }

        const tmpPng = join(tmpdir(), `atlas_sendscreen_${Date.now()}.png`);

        try {
            // Step 1: Capture screenshot
            await withCursorHidden(() => execFileAsync("screencapture", ["-x", tmpPng], { timeout: 10000 }));

            // Step 2: Verify the file was created
            if (!existsSync(tmpPng)) {
                return JSON.stringify({
                    error: "Screenshot capture failed — file was not created. Check screen recording permissions in System Settings > Privacy & Security > Screen Recording.",
                });
            }

            const stats = statSync(tmpPng);
            if (stats.size === 0) {
                await fs.unlink(tmpPng).catch(() => {});
                return JSON.stringify({ error: "Screenshot capture produced an empty file." });
            }

            // Step 3: Read and send via Telegram
            const fileBuffer = readFileSync(tmpPng);
            const { InputFile } = await import("grammy");
            const inputFile = new InputFile(fileBuffer, `screenshot_${Date.now()}.png`);
            await bot.api.sendPhoto(chatId, inputFile, { caption });

            // Step 4: Cleanup
            await fs.unlink(tmpPng).catch(() => {});

            return JSON.stringify({
                success: true,
                sent: true,
                size_kb: Math.round(stats.size / 1024),
            });
        } catch (err) {
            await fs.unlink(tmpPng).catch(() => {});
            const error = err as { message?: string };
            return JSON.stringify({
                success: false,
                error: error.message || "Failed to capture or send screenshot",
                hint: "Ensure Screen Recording permission is granted in System Settings > Privacy & Security > Screen Recording for the terminal/Node process.",
            });
        }
    },
};

// ── Accessibility Tree Tool ──────────────────

export const osAccessibilityTree: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_accessibility_tree",
            description:
                "Get the accessibility tree of the focused macOS application. Returns structured UI elements with names, roles, and positions — more reliable than OCR for native apps. Use this to understand the UI of desktop apps before clicking.",
            parameters: {
                type: "object",
                properties: {
                    app_name: {
                        type: "string",
                        description: "Optional: specific app name to inspect. If not provided, uses the frontmost app.",
                    },
                    max_depth: {
                        type: "number",
                        description:
                            "Max tree depth to traverse (default: 3). Higher values give more detail but more output.",
                    },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        const appName = (input.app_name as string) || "";
        const maxDepth = (input.max_depth as number) || 3;

        const appTarget = appName
            ? `application process "${appName}"`
            : `(first application process whose frontmost is true)`;

        // AppleScript to extract accessibility tree
        const script = `
tell application "System Events"
    set targetProc to ${appTarget}
    set appName to name of targetProc
    set output to "App: " & appName & return

    set uiElems to entire contents of window 1 of targetProc
    set elemCount to 0
    repeat with elem in uiElems
        if elemCount > 100 then exit repeat
        try
            set elemRole to role of elem
            set elemName to ""
            try
                set elemName to name of elem
            end try
            set elemDesc to ""
            try
                set elemDesc to description of elem
            end try
            set elemValue to ""
            try
                set elemValue to value of elem as text
            end try
            set posStr to ""
            try
                set elemPos to position of elem
                set elemSize to size of elem
                set posStr to " @(" & (item 1 of elemPos) & "," & (item 2 of elemPos) & " " & (item 1 of elemSize) & "x" & (item 2 of elemSize) & ")"
            end try

            if elemName is not "" or elemRole is not "AXGroup" then
                set output to output & elemRole & ": " & elemName
                if elemDesc is not "" then set output to output & " [" & elemDesc & "]"
                if elemValue is not "" and (length of elemValue) < 50 then set output to output & " =" & elemValue
                set output to output & posStr & return
                set elemCount to elemCount + 1
            end if
        end try
    end repeat
    return output
end tell`;

        try {
            const { stdout } = await execFileAsync("osascript", ["-e", script], {
                timeout: DEFAULT_TIMEOUT,
                maxBuffer: 1024 * 1024,
            });
            return JSON.stringify({
                success: true,
                tree: stdout.trim(),
                element_count: (stdout.match(/\n/g) || []).length,
                hint: "Use os_click with coordinates from the @(x,y WxH) positions above.",
            });
        } catch (err) {
            return JSON.stringify({
                success: false,
                error: (err as Error).message,
                hint: "Ensure Accessibility permission is granted in System Settings > Privacy & Security > Accessibility.",
            });
        }
    },
};

// ── OS Scan Tool (Set-of-Mark) ───────────────

export const osScan: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_scan",
            description:
                "LEGACY screen inspector. For click-by-description tasks, prefer `os_smart_click` (does cascade-perception automatically). Use os_scan only when you need to ENUMERATE all interactive elements with numbered labels — e.g., to give the user a screenshot annotated with what's clickable. Returns a labeled screenshot and element list.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },

    async handler() {
        if (process.platform !== "darwin") {
            return JSON.stringify({ error: "os_scan is only available on macOS." });
        }

        try {
            const tmpPng = join(tmpdir(), `atlas-scan-${Date.now()}.png`);
            const tmpJpg = join(tmpdir(), `atlas-scan-${Date.now()}.jpg`);

            // 1. Get screen dimensions for the focused monitor (multi-monitor aware).
            const dims = await getScreenDimensions({ focusedWindow: true, force: true });
            const screenWidth = dims.width;
            const screenHeight = dims.height;

            lastScreenWidth = screenWidth;
            lastScreenHeight = screenHeight;

            // 2. Hide overlay, capture screenshot
            hideOverlayForAgent();
            await new Promise((r) => setTimeout(r, 100));
            const ocrDims = await captureFocusedDisplay(tmpPng, dims);
            showOverlayForAgent();

            // 3. Resize to 1280px width
            const RESIZE_WIDTH = 1280;
            try {
                await execFileAsync("sips", ["--resampleWidth", String(RESIZE_WIDTH), tmpPng], { timeout: 5000 });
            } catch {
                /* proceed with raw */
            }

            // 4. Run OCR (accurate mode for reliable text) + accessibility in parallel
            const [ocrResult, axElements] = await Promise.all([
                runOcr(tmpPng, "accurate", undefined, ocrDims),
                getAccessibilityElements(),
            ]);

            // 5. Merge OCR elements + accessibility elements
            const mergedElements: ScanElement[] = [];
            let labelCounter = 1;
            const scaleFactor = screenWidth / RESIZE_WIDTH;

            // Add OCR elements first (these have image coordinates)
            if (ocrResult) {
                for (const el of (ocrResult as any).elements || []) {
                    if (el.text && el.text.trim().length > 1 && el.confidence > 0.5) {
                        mergedElements.push({
                            label: labelCounter++,
                            text: el.text.trim(),
                            role: "text",
                            x: Math.round(el.cx_screen),
                            y: Math.round(el.cy_screen),
                            w: Math.round(el.w_screen || 0),
                            h: Math.round(el.h_screen || 0),
                        });
                    }
                }
            }

            // Add accessibility elements (these are already in screen coords)
            for (const ax of axElements) {
                if (!ax.name || ax.name.length === 0) continue;
                // Check if this overlaps with an existing OCR element (within 15px)
                const overlaps = mergedElements.some(
                    (m) => Math.abs(m.x - (ax.x + ax.w / 2)) < 15 && Math.abs(m.y - (ax.y + ax.h / 2)) < 15,
                );
                if (!overlaps) {
                    mergedElements.push({
                        label: labelCounter++,
                        text: ax.name,
                        role: ax.role.replace("AX", ""),
                        x: ax.x + Math.round(ax.w / 2),
                        y: ax.y + Math.round(ax.h / 2),
                        w: ax.w,
                        h: ax.h,
                    });
                } else {
                    // Enrich existing OCR element with role info
                    const match = mergedElements.find(
                        (m) => Math.abs(m.x - (ax.x + ax.w / 2)) < 15 && Math.abs(m.y - (ax.y + ax.h / 2)) < 15,
                    );
                    if (match && match.role === "text") {
                        match.role = ax.role.replace("AX", "");
                    }
                }
            }

            // 6. Generate SoM overlay
            const elementsJson = join(tmpdir(), `atlas-scan-elements-${Date.now()}.json`);
            // Convert screen coords to image coords for the overlay (image = this monitor)
            const imageElements = mergedElements.map((el) => ({
                label: el.label,
                text: el.text,
                x: Math.round((el.x - dims.originX) / scaleFactor),
                y: Math.round((el.y - dims.originY) / scaleFactor),
                w: Math.round(el.w / scaleFactor),
                h: Math.round(el.h / scaleFactor),
            }));
            await fs.writeFile(elementsJson, JSON.stringify(imageElements));

            const somScript = join(getScriptsDir(), "som_overlay.py");
            try {
                await execFileAsync("python3", [somScript, tmpPng, elementsJson, tmpJpg], { timeout: 5000 });
            } catch {
                // Fallback: convert without overlay
                try {
                    await execFileAsync(
                        "sips",
                        ["-s", "format", "jpeg", "-s", "formatOptions", "85", tmpPng, "--out", tmpJpg],
                        { timeout: 3000 },
                    );
                } catch {
                    /* use PNG */
                }
            }

            // 7. Read result
            const finalFile = await fs
                .access(tmpJpg)
                .then(() => tmpJpg)
                .catch(() => tmpPng);
            const buffer = await fs.readFile(finalFile);
            const base64 = buffer.toString("base64");
            const mimeType = finalFile.endsWith(".jpg") ? "image/jpeg" : "image/png";

            // 8. Cache elements
            _scanElements = mergedElements;
            _scanTimestamp = Date.now();

            // 9. Cleanup
            await fs.unlink(tmpPng).catch(() => {});
            await fs.unlink(tmpJpg).catch(() => {});
            await fs.unlink(elementsJson).catch(() => {});

            // 10. Build element summary for LLM
            const elementSummary = mergedElements
                .slice(0, 50)
                .map((el) => `[${el.label}] ${el.role !== "text" ? `(${el.role}) ` : ""}${el.text}`)
                .join("\n");

            return JSON.stringify({
                success: true,
                screenshot_base64: base64,
                mime_type: mimeType,
                element_count: mergedElements.length,
                elements: elementSummary,
                tip: "Use os_click_element with a label number to click any element. Example: os_click_element label=5",
            });
        } catch (err) {
            showOverlayForAgent(); // Ensure overlay comes back on error
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ── OS Click Element Tool ────────────────────

export const osClickElement: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_click_element",
            description:
                "LEGACY label-based clicker. Used together with `os_scan` / `os_nav`. For most click-by-description tasks, prefer `os_smart_click` directly (one tool call instead of scan+click). Use os_click_element only when you've already run os_scan and want to click a specific labelled element by its number.",
            parameters: {
                type: "object",
                properties: {
                    label: { type: "number", description: "Element label number from os_scan/os_nav" },
                    text: {
                        type: "string",
                        description:
                            "Text to search for in elements (e.g., 'Perfect', 'Send', 'amma'). Finds best matching element. MORE RELIABLE than label numbers.",
                    },
                    action: {
                        type: "string",
                        enum: ["click", "double_click", "right_click"],
                        description: "Click type (default: click)",
                    },
                },
                required: [],
            },
        },
    },

    async handler(input) {
        if (process.platform !== "darwin") {
            return JSON.stringify({ error: "os_click_element is only available on macOS." });
        }

        const labelInput = input.label;
        const textSearch = input.text as string | undefined;
        const action = (input.action as string) || "click";

        if (!labelInput && !textSearch) {
            return JSON.stringify({
                success: false,
                error: "Provide 'label' (number) or 'text' (string to search for).",
            });
        }

        // Parse label if provided
        let label: number | undefined;
        if (labelInput !== undefined) {
            label = typeof labelInput === "string" ? parseInt(labelInput, 10) : (labelInput as number);
            if (Number.isNaN(label)) label = undefined;
        }

        // Ensure element map is populated — auto-refresh if expired
        const mapAge = Date.now() - _scanTimestamp;
        if (!_scanElements.length || mapAge > SCAN_CACHE_TTL_MS) {
            console.log(`  🔄 os_click_element: Element map expired — quick accessibility refresh...`);
            try {
                await quickAccessibilityRefresh();
            } catch (err) {
                return JSON.stringify({
                    success: false,
                    error: `Element map refresh failed: ${(err as Error).message}. Run os_scan manually.`,
                });
            }
        }

        // ── Resolve element: by TEXT search (preferred) or by LABEL number ──
        let resolvedElement: ScanElement | undefined;

        if (textSearch) {
            // TEXT-BASED SEARCH — programmatic matching, 100% reliable
            const query = textSearch.toLowerCase();
            // Exact match first
            resolvedElement = _scanElements.find((el) => el.text.toLowerCase() === query);
            // Substring match
            if (!resolvedElement) {
                resolvedElement = _scanElements.find((el) => el.text.toLowerCase().includes(query));
            }
            // Reverse substring (query contains element text)
            if (!resolvedElement) {
                resolvedElement = _scanElements.find(
                    (el) => query.includes(el.text.toLowerCase()) && el.text.length > 2,
                );
            }
            // Fuzzy: find closest match by shared words
            if (!resolvedElement) {
                const queryWords = query.split(/\s+/);
                let bestScore = 0;
                for (const el of _scanElements) {
                    const elLower = el.text.toLowerCase();
                    const matchedWords = queryWords.filter((w) => elLower.includes(w));
                    const score = matchedWords.length / queryWords.length;
                    if (score > bestScore && score >= 0.5) {
                        bestScore = score;
                        resolvedElement = el;
                    }
                }
            }

            if (!resolvedElement) {
                // Auto-refresh and retry once
                try {
                    await quickAccessibilityRefresh();
                    resolvedElement = _scanElements.find((el) => el.text.toLowerCase().includes(query));
                    if (!resolvedElement) {
                        resolvedElement = _scanElements.find(
                            (el) => query.includes(el.text.toLowerCase()) && el.text.length > 2,
                        );
                    }
                } catch {
                    /* fall through to error */
                }
            }

            if (!resolvedElement) {
                const available = _scanElements
                    .slice(0, 20)
                    .map((e) => `"${e.text}"`)
                    .join(", ");
                return JSON.stringify({
                    success: false,
                    error: `No element matching "${textSearch}" found. Available: ${available}. Try os_nav or os_scan to refresh, or use a different search text.`,
                });
            }
            console.log(
                `  🎯 os_click_element: Text match "${textSearch}" → [${resolvedElement.label}] "${resolvedElement.text}" at (${resolvedElement.x},${resolvedElement.y})`,
            );
        } else if (label !== undefined) {
            // LABEL-BASED LOOKUP
            resolvedElement = _scanElements.find((el) => el.label === label);
            if (!resolvedElement) {
                // Auto-refresh once
                try {
                    await quickAccessibilityRefresh();
                    resolvedElement = _scanElements.find((el) => el.label === label);
                } catch {
                    /* ignore */
                }
            }
            if (!resolvedElement) {
                return JSON.stringify({
                    success: false,
                    error: `Label ${label} not found. Available: ${_scanElements.map((e) => e.label).join(", ")}. Use text= parameter for more reliable matching.`,
                });
            }
        }

        try {
            const el = resolvedElement!;

            // App-aware click: auto-upgrade to double-click in music/list apps
            // In Spotify, Music, Finder etc., single-click selects but double-click opens/plays
            let effectiveAction = action;
            if (action === "click" && el.role === "text") {
                try {
                    const frontApp = await execFileAsync(
                        "osascript",
                        [
                            "-e",
                            'tell application "System Events" to return name of first process whose frontmost is true',
                        ],
                        { timeout: 2000 },
                    );
                    const appName = frontApp.stdout.trim().toLowerCase();
                    const doubleClickApps = ["spotify", "music", "finder", "itunes", "vlc", "vox"];
                    if (doubleClickApps.some((a) => appName.includes(a))) {
                        effectiveAction = "double_click";
                        console.log(`  🖱️ os_click_element: Auto-upgraded to double-click (${appName} list item)`);
                    }
                } catch {
                    /* keep single click */
                }
            }

            const clickType =
                effectiveAction === "double_click" ? "double" : effectiveAction === "right_click" ? "right" : "click";
            // Generate the JXA click script using screen coordinates directly
            const jxa = `
ObjC.import('CoreGraphics');
var pt = $.CGPointMake(${el.x}, ${el.y});
${
    clickType === "double"
        ? `var move = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, pt, $.kCGMouseButtonLeft);
$.CGEventPost($.kCGHIDEventTap, move);
delay(0.05);
var down1 = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, pt, $.kCGMouseButtonLeft);
$.CGEventSetIntegerValueField(down1, $.kCGMouseEventClickState, 1);
$.CGEventPost($.kCGHIDEventTap, down1);
delay(0.05);
var up1 = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, pt, $.kCGMouseButtonLeft);
$.CGEventSetIntegerValueField(up1, $.kCGMouseEventClickState, 1);
$.CGEventPost($.kCGHIDEventTap, up1);
delay(0.05);
var down2 = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, pt, $.kCGMouseButtonLeft);
$.CGEventSetIntegerValueField(down2, $.kCGMouseEventClickState, 2);
$.CGEventPost($.kCGHIDEventTap, down2);
delay(0.05);
var up2 = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, pt, $.kCGMouseButtonLeft);
$.CGEventSetIntegerValueField(up2, $.kCGMouseEventClickState, 2);
$.CGEventPost($.kCGHIDEventTap, up2);`
        : clickType === "right"
          ? `var move = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, pt, $.kCGMouseButtonRight);
$.CGEventPost($.kCGHIDEventTap, move);
delay(0.05);
var down = $.CGEventCreateMouseEvent(null, $.kCGEventRightMouseDown, pt, $.kCGMouseButtonRight);
$.CGEventPost($.kCGHIDEventTap, down);
delay(0.05);
var up = $.CGEventCreateMouseEvent(null, $.kCGEventRightMouseUp, pt, $.kCGMouseButtonRight);
$.CGEventPost($.kCGHIDEventTap, up);`
          : `var move = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, pt, $.kCGMouseButtonLeft);
$.CGEventPost($.kCGHIDEventTap, move);
delay(0.05);
var down = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, pt, $.kCGMouseButtonLeft);
$.CGEventPost($.kCGHIDEventTap, down);
delay(0.05);
var up = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, pt, $.kCGMouseButtonLeft);
$.CGEventPost($.kCGHIDEventTap, up);`
}
"done"`;

            const tmpFile = join(tmpdir(), `atlas_click_elem_${Date.now()}.js`);
            await cursorClick(el.x, el.y, clickType === "right" ? "right" : "left", clickType === "double" ? 2 : 1);
            await fs.writeFile(tmpFile, jxa, "utf-8");
            await execFileAsync("osascript", ["-l", "JavaScript", tmpFile], { timeout: 5000 });
            await fs.unlink(tmpFile).catch(() => {});

            // (No screenshot byte-diff: it compared differently-encoded images and always said "changed".)
            return JSON.stringify({
                success: true,
                clicked: { label: el.label, text: el.text, role: el.role, x: el.x, y: el.y },
                action: clickType,
                tip: "Take a screenshot or run os_visual_verify to confirm the click worked.",
            });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ── Multi-Action Batch Tool ─────────────────

export const osMultiAction: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_multi_action",
            description:
                "Execute multiple OS actions in sequence (click, type, key, wait, verify). Reduces round-trips. Use this for common sequences like click→type→enter.",
            parameters: {
                type: "object",
                properties: {
                    actions: {
                        type: "array",
                        description: "Array of actions to execute sequentially",
                        items: {
                            type: "object",
                            properties: {
                                action: {
                                    type: "string",
                                    enum: [
                                        "click",
                                        "click_label",
                                        "type",
                                        "key",
                                        "combo",
                                        "wait",
                                        "screenshot",
                                        "verify",
                                    ],
                                    description: "Action type",
                                },
                                x: { type: "number", description: "X coord (for click)" },
                                y: { type: "number", description: "Y coord (for click)" },
                                label: { type: "number", description: "Element label from os_scan (for click_label)" },
                                text: {
                                    type: "string",
                                    description: "Text to type (for type) or expected text (for verify)",
                                },
                                key: {
                                    type: "string",
                                    description: "Key name (for key) or combo like 'command+s' (for combo)",
                                },
                                ms: { type: "number", description: "Milliseconds to wait (for wait, default 500)" },
                            },
                            required: ["action"],
                        },
                    },
                    stop_on_error: { type: "boolean", description: "Stop executing on first error (default true)" },
                },
                required: ["actions"],
            },
        },
    },

    async handler(input) {
        if (process.platform !== "darwin") {
            return JSON.stringify({ error: "os_multi_action is only available on macOS." });
        }

        const args = input as { actions: Array<any> | string; stop_on_error?: boolean };
        const stopOnError = args.stop_on_error !== false;
        const maxActions = 20;
        // Handle actions as JSON string (LLM often stringifies arrays) or direct array
        let rawActions = args.actions || [];
        if (typeof rawActions === "string") {
            try {
                rawActions = JSON.parse(rawActions);
            } catch {
                return JSON.stringify({
                    error: `Failed to parse actions JSON: ${(rawActions as string).substring(0, 100)}`,
                });
            }
        }
        const actions = (Array.isArray(rawActions) ? rawActions : []).slice(0, maxActions);
        const results: Array<{ action: string; ok: boolean; error?: string; detail?: any }> = [];

        for (const act of actions) {
            try {
                switch (act.action) {
                    case "click": {
                        // Use the multi-monitor-aware helper (matches os_click). Adds monitor-origin
                        // offset + clamping that the previous bare lastScreenWidth read silently lost.
                        const RESIZE_WIDTH = 1280;
                        const dims = await getScreenDimensions({ focusedWindow: true });
                        const scaled = scaleImageToScreen({
                            rawX: act.x || 0,
                            rawY: act.y || 0,
                            imageWidth: RESIZE_WIDTH,
                            dims,
                        });
                        const sx = scaled.x;
                        const sy = scaled.y;
                        await cursorClick(sx, sy);
                        const jxa = `ObjC.import('CoreGraphics');var pt=$.CGPointMake(${sx},${sy});var m=$.CGEventCreateMouseEvent(null,$.kCGEventMouseMoved,pt,0);$.CGEventPost($.kCGHIDEventTap,m);delay(0.05);var d=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseDown,pt,0);$.CGEventPost($.kCGHIDEventTap,d);delay(0.05);var u=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseUp,pt,0);$.CGEventPost($.kCGHIDEventTap,u);`;
                        await execFileAsync("osascript", ["-l", "JavaScript", "-e", jxa], { timeout: 5000 });
                        results.push({
                            action: "click",
                            ok: true,
                            detail: { x: act.x, y: act.y, screen_x: sx, screen_y: sy },
                        });
                        break;
                    }
                    case "click_label": {
                        // Auto-refresh scan if expired
                        if (!_scanElements.length || Date.now() - _scanTimestamp > SCAN_CACHE_TTL_MS) {
                            try {
                                await osScan.handler({});
                            } catch {
                                /* fallthrough to error below */
                            }
                        }
                        const element = _scanElements.find((el) => el.label === act.label);
                        if (!element) {
                            results.push({
                                action: "click_label",
                                ok: false,
                                error: `Label ${act.label} not found after refresh`,
                            });
                            if (stopOnError) return JSON.stringify({ results, stopped_early: true });
                            break;
                        }
                        await cursorClick(element.x, element.y);
                        const jxa = `ObjC.import('CoreGraphics');var pt=$.CGPointMake(${element.x},${element.y});var m=$.CGEventCreateMouseEvent(null,$.kCGEventMouseMoved,pt,0);$.CGEventPost($.kCGHIDEventTap,m);delay(0.05);var d=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseDown,pt,0);$.CGEventPost($.kCGHIDEventTap,d);delay(0.05);var u=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseUp,pt,0);$.CGEventPost($.kCGHIDEventTap,u);`;
                        await execFileAsync("osascript", ["-l", "JavaScript", "-e", jxa], { timeout: 5000 });
                        results.push({
                            action: "click_label",
                            ok: true,
                            detail: { label: act.label, text: element.text },
                        });
                        break;
                    }
                    case "type": {
                        await withCursorTyping(() => typeTextMac(act.text || ""));
                        results.push({ action: "type", ok: true, detail: { text: act.text } });
                        break;
                    }
                    case "key": {
                        // LLM may send key name in act.key, act.text, or act.combo
                        // "enter", "home", "f5", "cmd+f", "command+shift+s" — one shared
                        // key table; an unknown name throws (caught below) instead of
                        // typing the word or sending "cmd down" AppleScript can't parse.
                        const keyInput = (act.key || act.text || "").toString().trim();
                        await execFileAsync("osascript", ["-e", macKeyScript(keyInput)], { timeout: 3000 });
                        results.push({ action: "key", ok: true, detail: { key: keyInput } });
                        break;
                    }
                    case "combo": {
                        const combo = (act.key || act.text || "").toString().trim();
                        await execFileAsync("osascript", ["-e", macKeyScript(combo)], { timeout: 3000 });
                        results.push({ action: "combo", ok: true, detail: { combo } });
                        break;
                    }
                    case "wait": {
                        await new Promise((r) => setTimeout(r, Math.min(act.ms || 500, 5000)));
                        results.push({ action: "wait", ok: true, detail: { ms: act.ms || 500 } });
                        break;
                    }
                    case "screenshot": {
                        // Quick screenshot capture, store buffer
                        const tmp = join(tmpdir(), `atlas-multi-${Date.now()}.png`);
                        await captureFocusedDisplay(tmp);
                        const buf = await fs.readFile(tmp);
                        _lastScreenshotBuffer = buf;
                        await fs.unlink(tmp).catch(() => {});
                        results.push({ action: "screenshot", ok: true, detail: { captured: true } });
                        break;
                    }
                    case "verify": {
                        // Quick OCR verification
                        const tmp = join(tmpdir(), `atlas-verify-${Date.now()}.png`);
                        const vDims = await captureFocusedDisplay(tmp);
                        const ocrResult = await runOcr(tmp, "fast", undefined, vDims);
                        await fs.unlink(tmp).catch(() => {});
                        const found =
                            ocrResult &&
                            (ocrResult as any).elements?.some(
                                (el: any) =>
                                    similarity((act.text || "").toLowerCase(), (el.text || "").toLowerCase()) >= 0.6,
                            );
                        results.push({ action: "verify", ok: !!found, detail: { expected: act.text, found } });
                        if (!found && stopOnError) return JSON.stringify({ results, stopped_early: true });
                        break;
                    }
                    default:
                        results.push({ action: act.action, ok: false, error: `Unknown action: ${act.action}` });
                        if (stopOnError) return JSON.stringify({ results, stopped_early: true });
                }
            } catch (err) {
                results.push({ action: act.action, ok: false, error: (err as Error).message });
                if (stopOnError) return JSON.stringify({ results, stopped_early: true });
            }
        }

        return JSON.stringify({ success: results.every((r) => r.ok), results });
    },
};

// ── Region Zoom Tool ────────────────────────

export const osZoomRegion: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_zoom_region",
            description:
                "Zoom into a region of the last screenshot for detailed inspection. Useful for small icons, dense toolbars, or crowded menus. Pass coordinates from the last screenshot.",
            parameters: {
                type: "object",
                properties: {
                    x: { type: "number", description: "Left X coordinate in screenshot" },
                    y: { type: "number", description: "Top Y coordinate in screenshot" },
                    width: { type: "number", description: "Width of region to zoom" },
                    height: { type: "number", description: "Height of region to zoom" },
                },
                required: ["x", "y", "width", "height"],
            },
        },
    },

    async handler(input) {
        if (process.platform !== "darwin") {
            return JSON.stringify({ error: "os_zoom_region is only available on macOS." });
        }

        const args = input as { x: number; y: number; width: number; height: number };

        if (!_lastScreenshotBuffer) {
            return JSON.stringify({
                success: false,
                error: "No screenshot available. Take a screenshot first with os_screenshot or os_scan.",
            });
        }

        try {
            const tmpIn = join(tmpdir(), `atlas-zoom-in-${Date.now()}.png`);
            const tmpOut = join(tmpdir(), `atlas-zoom-out-${Date.now()}.jpg`);

            // Write the last screenshot to disk
            await fs.writeFile(tmpIn, _lastScreenshotBuffer);

            // Crop and zoom using Python/Pillow
            const cropScript = `
from PIL import Image
import sys
img = Image.open("${tmpIn}")
x, y, w, h = ${args.x}, ${args.y}, ${args.width}, ${args.height}
# Clamp to image bounds
x = max(0, min(x, img.width - 1))
y = max(0, min(y, img.height - 1))
w = min(w, img.width - x)
h = min(h, img.height - y)
cropped = img.crop((x, y, x + w, y + h))
# Scale up 2x for detail
zoomed = cropped.resize((w * 2, h * 2), Image.LANCZOS)
zoomed.save("${tmpOut}", "JPEG", quality=90)
print(f"{zoomed.width}x{zoomed.height}")
`;
            const { stdout } = await execFileAsync("python3", ["-c", cropScript], { timeout: 5000 });

            const buffer = await fs.readFile(tmpOut);
            const base64 = buffer.toString("base64");

            await fs.unlink(tmpIn).catch(() => {});
            await fs.unlink(tmpOut).catch(() => {});

            return JSON.stringify({
                success: true,
                zoomed_base64: base64,
                mime_type: "image/jpeg",
                region: { x: args.x, y: args.y, width: args.width, height: args.height },
                zoomed_size: stdout.trim(),
                tip: "This is a 2x zoomed view of the selected region. Use os_click with the ORIGINAL screenshot coordinates (not zoomed coordinates) to interact.",
            });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ── Keyboard Shortcut Database ───────────────

const APP_SHORTCUTS: Record<string, Record<string, string>> = {
    Finder: {
        "New window": "Cmd+N",
        "New folder": "Cmd+Shift+N",
        "Go to folder": "Cmd+Shift+G",
        Search: "Cmd+F",
        Info: "Cmd+I",
        Delete: "Cmd+Delete",
        "Empty trash": "Cmd+Shift+Delete",
        Copy: "Cmd+C",
        Paste: "Cmd+V",
        "Select all": "Cmd+A",
        Undo: "Cmd+Z",
    },
    Terminal: {
        "New tab": "Cmd+T",
        "New window": "Cmd+N",
        Clear: "Cmd+K",
        "Close tab": "Cmd+W",
        Copy: "Cmd+C",
        Paste: "Cmd+V",
        Find: "Cmd+F",
        "Split pane": "Cmd+D",
    },
    "Visual Studio Code": {
        "Command palette": "Cmd+Shift+P",
        "Quick open": "Cmd+P",
        "Toggle terminal": "Ctrl+`",
        Find: "Cmd+F",
        Replace: "Cmd+H",
        "Find in files": "Cmd+Shift+F",
        "Go to line": "Ctrl+G",
        "Go to definition": "F12",
        "Peek definition": "Alt+F12",
        "Toggle sidebar": "Cmd+B",
        "New file": "Cmd+N",
        Save: "Cmd+S",
        "Save all": "Cmd+Alt+S",
        "Close tab": "Cmd+W",
        "Split editor": "Cmd+\\",
        "Toggle comment": "Cmd+/",
        "Format document": "Shift+Alt+F",
        "Rename symbol": "F2",
        Undo: "Cmd+Z",
        Redo: "Cmd+Shift+Z",
    },
    Chrome: {
        "New tab": "Cmd+T",
        "Close tab": "Cmd+W",
        "Reopen tab": "Cmd+Shift+T",
        "Next tab": "Ctrl+Tab",
        "Prev tab": "Ctrl+Shift+Tab",
        "Address bar": "Cmd+L",
        Find: "Cmd+F",
        Refresh: "Cmd+R",
        "Hard refresh": "Cmd+Shift+R",
        "Dev tools": "Cmd+Alt+I",
        Bookmarks: "Cmd+Shift+B",
        History: "Cmd+Y",
        "New window": "Cmd+N",
        Incognito: "Cmd+Shift+N",
        "Zoom in": "Cmd++",
        "Zoom out": "Cmd+-",
    },
    Safari: {
        "New tab": "Cmd+T",
        "Close tab": "Cmd+W",
        "Address bar": "Cmd+L",
        Find: "Cmd+F",
        Refresh: "Cmd+R",
        Back: "Cmd+[",
        Forward: "Cmd+]",
        "Dev tools": "Cmd+Alt+I",
        "Private window": "Cmd+Shift+N",
    },
    Notes: {
        "New note": "Cmd+N",
        Bold: "Cmd+B",
        Italic: "Cmd+I",
        Underline: "Cmd+U",
        Find: "Cmd+F",
        Checklist: "Cmd+Shift+L",
        Table: "Cmd+Alt+T",
    },
    Global: {
        Spotlight: "Cmd+Space",
        "Force quit": "Cmd+Alt+Esc",
        Screenshot: "Cmd+Shift+3",
        "Screenshot area": "Cmd+Shift+4",
        "Screenshot window": "Cmd+Shift+4 then Space",
        "Lock screen": "Cmd+Ctrl+Q",
        "Mission control": "Ctrl+Up",
        "Show desktop": "F11",
        "Switch app": "Cmd+Tab",
        "Quit app": "Cmd+Q",
        "Close window": "Cmd+W",
        Minimize: "Cmd+M",
        "Full screen": "Cmd+Ctrl+F",
        Preferences: "Cmd+,",
        Cut: "Cmd+X",
        Copy: "Cmd+C",
        Paste: "Cmd+V",
        Undo: "Cmd+Z",
        Redo: "Cmd+Shift+Z",
        "Select all": "Cmd+A",
        Find: "Cmd+F",
    },
};

export const osKeyboardShortcuts: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_keyboard_shortcuts",
            description:
                "Get keyboard shortcuts for a macOS application. Using shortcuts is 5-10x faster than navigating menus or clicking buttons. Always check shortcuts before resorting to mouse-based navigation.",
            parameters: {
                type: "object",
                properties: {
                    app_name: {
                        type: "string",
                        description:
                            "App to get shortcuts for (e.g., 'Visual Studio Code', 'Chrome', 'Finder'). Use 'Global' for system-wide shortcuts.",
                    },
                },
                required: ["app_name"],
            },
        },
    },
    async handler(input) {
        const appName = input.app_name as string;
        const shortcuts = APP_SHORTCUTS[appName] || APP_SHORTCUTS.Global;
        const globalShortcuts = APP_SHORTCUTS.Global;

        const result: Record<string, string> = {};
        if (appName !== "Global" && shortcuts !== globalShortcuts) {
            Object.assign(result, shortcuts);
        }
        // Always include global shortcuts
        Object.assign(result, globalShortcuts);

        return JSON.stringify({
            app: appName,
            shortcuts: result,
            tip: "Use apple_script with 'keystroke' or browser_keyboard to execute these shortcuts.",
        });
    },
};
