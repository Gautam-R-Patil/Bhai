// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ToolDefinition } from "./get-current-time.js";
import { getTelegramContext } from "./send-file.js";
import { hideOverlayForAgent, showOverlayForAgent } from "../overlay/overlay-chat.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const execFileAsync = promisify(execFile);

// ── Constants ─────────────────────────────────

const MAX_OUTPUT = 10000;
const DEFAULT_TIMEOUT = 30000; // 30s

// Screen calibration: store actual screen dimensions so os_click can auto-scale from screenshot coords
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

// ── Element Map Cache (for os_scan → os_click_element flow) ──
interface ScanElement {
    label: number;
    text: string;
    role: string;
    x: number;  // screen logical coords
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
            description: "Execute raw AppleScript on macOS. Use for controlling native apps. IMPORTANT: To LAUNCH/ACTIVATE apps, ALWAYS use: do shell script \"open -a 'AppName'\" — NEVER use 'tell application X to activate' as it may resolve to the wrong binary. After launching, you can use 'tell application' for commands.",
            parameters: {
                type: "object",
                properties: {
                    script: {
                        type: "string",
                        description: "The multi-line AppleScript or JXA script to execute. Do NOT escape quotes, just write the raw script."
                    },
                    language: {
                        type: "string",
                        enum: ["AppleScript", "JavaScript"],
                        description: "The language of the script (default: AppleScript). Use JavaScript for JXA."
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
        if (BROWSER_PATTERNS.some(p => p.test(script))) {
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
            await fs.unlink(tmpFile).catch(() => { });

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
            await fs.unlink(tmpFile).catch(() => { });

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
            description: "Takes a screenshot of the current macOS screen. Returns the image, which app is focused, screen resolution, and coordinate mapping info. ALWAYS take a screenshot after os_click or os_type to verify your action worked.",
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

        const tmpPng = join(tmpdir(), `atlas_screen_${Date.now()}.png`);
        const tmpJpg = join(tmpdir(), `atlas_screen_${Date.now()}.jpg`);

        try {
            // Get logical screen resolution (points, not pixels)
            let screenWidth = 1440;
            let screenHeight = 900;
            try {
                const { stdout: spOut } = await execFileAsync("osascript", ["-l", "JavaScript", "-e",
                    'ObjC.import("AppKit"); var f = $.NSScreen.mainScreen.frame; `${f.size.width},${f.size.height}`'
                ], { timeout: 3000 });
                const [w, h] = spOut.trim().split(",").map(Number);
                if (w > 0 && h > 0) { screenWidth = w; screenHeight = h; }
            } catch {
                try {
                    const { stdout: resOut } = await execFileAsync("osascript", ["-e",
                        'tell application "Finder" to get bounds of window of desktop'], { timeout: 3000 });
                    const parts = resOut.trim().split(", ");
                    if (parts.length >= 4) {
                        screenWidth = parseInt(parts[2]) || 1440;
                        screenHeight = parseInt(parts[3]) || 900;
                    }
                } catch { /* use defaults */ }
            }

            lastScreenWidth = screenWidth;
            lastScreenHeight = screenHeight;

            // Hide overlay so it doesn't appear in the screenshot
            hideOverlayForAgent();
            await new Promise(r => setTimeout(r, 100)); // Wait for opacity transition

            // Capture screenshot (Retina: captures at 2x pixel density)
            await execFileAsync("screencapture", ["-x", tmpPng], { timeout: 10000 });

            // Show overlay again
            showOverlayForAgent();

            // Resize to 1280px width for better LLM coordinate accuracy
            const RESIZE_WIDTH = 1280;
            try {
                await execFileAsync("sips", ["--resampleWidth", String(RESIZE_WIDTH), tmpPng], { timeout: 5000 });
            } catch { /* proceed with raw */ }

            // Add coordinate grid overlay using Python + Pillow for accurate LLM coordinate picking
            // __dirname points to src/tools or dist/tools, so go up 2 levels to project root
            const projectRoot = join(__dirname, "..", "..");
            const gridScript = join(projectRoot, "scripts", "grid_overlay.py");
            try {
                await execFileAsync("python3", [gridScript, tmpPng, tmpJpg, "160"], { timeout: 5000 });
            } catch {
                // Fallback: convert to JPEG without grid
                try {
                    await execFileAsync("sips", [
                        "-s", "format", "jpeg", "-s", "formatOptions", "85",
                        tmpPng, "--out", tmpJpg
                    ], { timeout: 3000 });
                } catch { /* use PNG */ }
            }

            // Read whichever file we produced
            const finalFile = await fs.access(tmpJpg).then(() => tmpJpg).catch(() => tmpPng);
            const buffer = await fs.readFile(finalFile);
            _lastScreenshotBuffer = buffer; // Store for caching and diff
            const base64 = buffer.toString("base64");
            const mimeType = finalFile.endsWith('.jpg') ? 'image/jpeg' : 'image/png';

            // Cleanup
            await fs.unlink(tmpPng).catch(() => { });
            await fs.unlink(tmpJpg).catch(() => { });

            // Scale factor: maps image coordinates to logical screen points
            const scaleFactor = screenWidth / RESIZE_WIDTH;

            // Get frontmost app info
            let frontmostApp = "unknown";
            try {
                const { stdout: appOut } = await execFileAsync("osascript", ["-e",
                    'tell application "System Events" to get name of first process whose frontmost is true'
                ], { timeout: 2000 });
                frontmostApp = appOut.trim();
            } catch { /* ignore */ }

            return JSON.stringify({
                success: true,
                screenshot_base64: base64,
                mime_type: mimeType,
                screen: { width: screenWidth, height: screenHeight },
                image_width: RESIZE_WIDTH,
                scale_factor: Math.round(scaleFactor * 1000) / 1000,
                frontmost_app: frontmostApp,
                tip: `Image is ${RESIZE_WIDTH}px wide with a coordinate GRID overlay. Use the grid lines and labels to pick PRECISE x,y coordinates. Pass them to os_click — auto-scaled to screen. ALWAYS verify with another screenshot after clicking. Prefer os_scan + os_click_element for more reliable element-based clicking.`
            });
        } catch (err) {
            showOverlayForAgent(); // Ensure overlay comes back on error
            await fs.unlink(tmpPng).catch(() => { });
            await fs.unlink(tmpJpg).catch(() => { });

            const error = err as { message?: string };
            return JSON.stringify({
                success: false,
                error: error.message || "Failed to capture screen",
            });
        }
    },
};

// ── Screenshot Diff ─────────────────────────────
function computeScreenDiff(before: Buffer, after: Buffer): number {
    // Quick pixel-sampling comparison
    // Returns 0.0 (identical) to 1.0 (completely different)
    const sampleCount = 500;
    const minLen = Math.min(before.length, after.length);
    if (minLen < sampleCount) return 1.0; // Can't compare, assume different

    const step = Math.max(1, Math.floor(minLen / sampleCount));
    let diffCount = 0;
    let totalSampled = 0;

    for (let i = 0; i < minLen; i += step) {
        totalSampled++;
        if (Math.abs(before[i] - after[i]) > 10) { // threshold: ignore compression artifacts
            diffCount++;
        }
    }

    return totalSampled > 0 ? diffCount / totalSampled : 1.0;
}

// ── OS Click Tool (Native Mouse Control) ──────

export const osClick: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_click",
            description: "Click, double-click, right-click, or move the mouse on macOS. Pass x,y coordinates as you see them in the os_screenshot image — they are auto-scaled to actual screen resolution.",
            parameters: {
                type: "object",
                properties: {
                    x: { type: "number", description: "X coordinate from the screenshot image" },
                    y: { type: "number", description: "Y coordinate from the screenshot image" },
                    action: {
                        type: "string",
                        enum: ["click", "double_click", "right_click", "move"],
                        description: "Mouse action (default: click)"
                    },
                    raw: { type: "boolean", description: "If true, treat x/y as raw screen pixels without scaling (default: false)" },
                },
                required: ["x", "y"],
            },
        },
    },

    async handler(input) {
        if (process.platform !== "darwin") {
            return JSON.stringify({ error: "os_click is only available on macOS." });
        }

        const rawX = input.x as number;
        const rawY = input.y as number;
        const action = (input.action as string) || "click";
        const useRaw = input.raw as boolean;

        // Auto-scale from screenshot coordinates (1280px wide) to logical screen points
        let x = rawX;
        let y = rawY;
        if (!useRaw && lastScreenWidth > 0) {
            const RESIZE_WIDTH = 1280;
            const scaleFactor = lastScreenWidth / RESIZE_WIDTH;
            x = Math.round(rawX * scaleFactor);
            y = Math.round(rawY * scaleFactor);
            console.log(`  🖱️  Click: image(${rawX},${rawY}) → screen(${x},${y}) [scale=${scaleFactor.toFixed(3)}]`);
        }

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
            await fs.writeFile(tmpFile, eventScript, "utf-8");
            const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", tmpFile], { timeout: 5000 });
            await fs.unlink(tmpFile).catch(() => { });

            const response: Record<string, unknown> = {
                success: true,
                action,
                x,
                y,
                result: stdout.trim(),
                tip: "For more reliable clicking, use os_scan + os_click_element instead of coordinate-based clicking.",
            };

            // Phase 8: Screenshot diff verification
            try {
                if (_lastScreenshotBuffer) {
                    const beforeBuf = _lastScreenshotBuffer;
                    await new Promise(r => setTimeout(r, 500));
                    const tmpDiffPng = join(tmpdir(), `atlas_diff_${Date.now()}.png`);
                    await execFileAsync("screencapture", ["-x", tmpDiffPng], { timeout: 8000 });
                    const afterBuf = await fs.readFile(tmpDiffPng);
                    await fs.unlink(tmpDiffPng).catch(() => { });
                    const diff = computeScreenDiff(beforeBuf, afterBuf);
                    response.screen_changed = diff > 0.05;
                    response.diff_percent = Math.round(diff * 100);
                    if (diff < 0.01) {
                        response.warning = "Click may not have had an effect. Verify with os_screenshot or os_visual_verify.";
                    }
                }
            } catch { /* diff check is non-blocking — ignore errors */ }

            return JSON.stringify(response);
        } catch (err) {
            await fs.unlink(tmpFile).catch(() => { });
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
            description: "Type text or press keys/hotkeys at the OS level using System Events. Works on ANY focused application. Use for typing into native apps, pressing shortcuts (Cmd+C, Cmd+V, etc.).",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "Text to type (types character by character)" },
                    key: { type: "string", description: "Special key to press: return, tab, escape, delete, space, up, down, left, right, f1-f12" },
                    combo: { type: "string", description: "Hotkey combo like 'command+c', 'command+shift+s', 'option+tab'. Use + to separate modifiers and key." },
                    delay_ms: { type: "number", description: "Delay in ms after action (default: 200)" },
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

        if (input.combo) {
            // Parse combo like "command+shift+s"
            const parts = (input.combo as string).toLowerCase().split("+").map(s => s.trim());
            const key = parts.pop() || "";
            const modifiers: string[] = [];
            for (const mod of parts) {
                if (mod === "command" || mod === "cmd") modifiers.push("command down");
                else if (mod === "shift") modifiers.push("shift down");
                else if (mod === "option" || mod === "alt") modifiers.push("option down");
                else if (mod === "control" || mod === "ctrl") modifiers.push("control down");
            }
            const modStr = modifiers.length > 0 ? ` using {${modifiers.join(", ")}}` : "";

            // Check if key is a special key name or a character
            const specialKeys = ["return", "tab", "escape", "delete", "space", "up arrow", "down arrow", "left arrow", "right arrow"];
            const mappedKey = key === "up" ? "up arrow" : key === "down" ? "down arrow" : key === "left" ? "left arrow" : key === "right" ? "right arrow" : key;

            if (specialKeys.includes(mappedKey)) {
                script = `tell application "System Events"\n  key code ${getKeyCode(mappedKey)}${modStr}\nend tell\ndelay ${delaySec}`;
            } else {
                script = `tell application "System Events"\n  keystroke "${key}"${modStr}\nend tell\ndelay ${delaySec}`;
            }
        } else if (input.key) {
            const key = (input.key as string).toLowerCase();
            const mappedKey = key === "up" ? "up arrow" : key === "down" ? "down arrow" : key === "left" ? "left arrow" : key === "right" ? "right arrow" : key;
            script = `tell application "System Events"\n  key code ${getKeyCode(mappedKey)}\nend tell\ndelay ${delaySec}`;
        } else if (input.text) {
            // Use clipboard method for reliability (handles Unicode, emoji, special chars)
            const textToType = input.text as string;
            const escapedForAS = textToType.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
            script = `
-- Save current clipboard
set oldClipboard to ""
try
    set oldClipboard to the clipboard as text
end try

-- Set clipboard to target text
set the clipboard to "${escapedForAS}"

-- Paste via Cmd+V
tell application "System Events"
    keystroke "v" using command down
end tell

-- Small delay then restore clipboard
delay 0.3
try
    set the clipboard to oldClipboard
end try
delay ${delaySec}`;

            // Try clipboard method first, fall back to keystroke on failure
            const tmpFileClip = join(tmpdir(), `atlas_type_clip_${Date.now()}.scpt`);
            try {
                await fs.writeFile(tmpFileClip, script, "utf-8");
                const { stdout, stderr } = await execFileAsync("osascript", [tmpFileClip], { timeout: 10000 });
                await fs.unlink(tmpFileClip).catch(() => { });
                return JSON.stringify({
                    success: true,
                    typed: textToType,
                    method: "clipboard",
                    stdout: (stdout || "").substring(0, 500),
                    stderr: (stderr || "").substring(0, 500),
                });
            } catch (clipErr) {
                await fs.unlink(tmpFileClip).catch(() => { });
                // Fallback: use keystroke method
                console.log(`  ⌨️  [OS-TYPE] Clipboard method failed, falling back to keystroke`);
                const keystrokeEscaped = textToType.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
                script = `tell application "System Events"\n  keystroke "${keystrokeEscaped}"\nend tell\ndelay ${delaySec}`;
            }
        } else {
            return JSON.stringify({ error: "Provide 'text', 'key', or 'combo'" });
        }

        const tmpFile = join(tmpdir(), `atlas_type_${Date.now()}.scpt`);
        try {
            await fs.writeFile(tmpFile, script, "utf-8");
            const { stdout, stderr } = await execFileAsync("osascript", [tmpFile], { timeout: 10000 });
            await fs.unlink(tmpFile).catch(() => { });
            return JSON.stringify({
                success: true,
                typed: input.text || input.key || input.combo,
                stdout: (stdout || "").substring(0, 500),
                stderr: (stderr || "").substring(0, 500),
            });
        } catch (err) {
            await fs.unlink(tmpFile).catch(() => { });
            const error = err as { message?: string };
            return JSON.stringify({ success: false, error: error.message || "Keyboard action failed" });
        }
    },
};

// Key code mapping for macOS special keys
function getKeyCode(key: string): number {
    const codes: Record<string, number> = {
        "return": 36, "tab": 48, "escape": 53, "delete": 51,
        "space": 49, "up arrow": 126, "down arrow": 125,
        "left arrow": 123, "right arrow": 124,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118,
        "f5": 96, "f6": 97, "f7": 98, "f8": 100,
        "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    };
    return codes[key] ?? 36; // default to Return
}

// ── OCR Helpers ───────────────────────────────
// Levenshtein distance for fuzzy text matching
function levenshtein(a: string, b: string): number {
    const m = a.length, n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
        Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
    );
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

// Similarity score [0.0 – 1.0]
function similarity(a: string, b: string): number {
    const al = a.toLowerCase(), bl = b.toLowerCase();
    if (al === bl) return 1.0;
    if (bl.includes(al) || al.includes(bl)) return 0.9;
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
async function runOcr(screenshotPath: string | null, mode: "fast" | "accurate" = "accurate", screenshotBuffer?: Buffer): Promise<OcrResult | null> {
    // Check cache
    if (screenshotBuffer) {
        const hash = computeScreenshotHash(screenshotBuffer);
        if (_ocrCache && _ocrCache.hash === hash && (Date.now() - _ocrCache.timestamp) < OCR_CACHE_TTL_MS) {
            return _ocrCache.result;
        }
    }

    const projectRoot = join(__dirname, "..", "..");
    const swiftScript = join(projectRoot, "scripts", "ocr_screen.swift");

    // Prefer compiled binary for speed (saves 1-3s compilation overhead)
    const compiledBin = join(projectRoot, "scripts", "ocr_screen_bin");
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
function findBestMatch(elements: OcrElement[], label: string, threshold = 0.45): { element: OcrElement; score: number } | null {
    let best: { element: OcrElement; score: number } | null = null;
    const labelLower = label.toLowerCase();

    for (const el of elements) {
        // Try exact substring match first (highest confidence)
        const textLower = el.text.toLowerCase();
        if (textLower === labelLower || textLower.includes(labelLower) || labelLower.includes(textLower)) {
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
    return best;
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
        await fs.writeFile(tmpFile, eventScript, "utf-8");
        await execFileAsync("osascript", ["-l", "JavaScript", tmpFile], { timeout: 5000 });
        await fs.unlink(tmpFile).catch(() => { });
        return true;
    } catch {
        await fs.unlink(tmpFile).catch(() => { });
        return false;
    }
}

// ── Accessibility Elements Helper ────────────

async function getAccessibilityElements(): Promise<Array<{name: string; role: string; x: number; y: number; w: number; h: number}>> {
    try {
        const { stdout } = await execFileAsync("osascript", ["-e", `
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
        `], { timeout: 5000 });

        const elements: Array<{name: string; role: string; x: number; y: number; w: number; h: number}> = [];
        for (const line of stdout.split("\n")) {
            const parts = line.split("|||");
            if (parts.length >= 6) {
                elements.push({
                    role: parts[0].trim(),
                    name: parts[1].trim(),
                    x: parseInt(parts[2]) || 0,
                    y: parseInt(parts[3]) || 0,
                    w: parseInt(parts[4]) || 0,
                    h: parseInt(parts[5]) || 0,
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
            description: "Fast, lightweight screen element list using accessibility (no screenshot). Returns numbered list of all interactive elements (buttons, text fields, links, etc.) in the frontmost app. Use os_click_element with text= to click by text match (preferred) or label= for label number. 10x faster than os_scan — prefer this for native macOS apps. Fall back to os_scan only for visual layout understanding or web content.",
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
                appTarget = `process "${(input.app as string).replace(/"/g, '\\"')}"`;
            }

            // Query accessibility tree with role filtering for interactive elements
            const { stdout } = await execFileAsync("osascript", ["-e", `
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
            `], { timeout: 5000 });

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
                    const x = parseInt(parts[2]) || 0;
                    const y = parseInt(parts[3]) || 0;
                    const w = parseInt(parts[4]) || 0;
                    const h = parseInt(parts[5]) || 0;
                    elements.push({
                        label: labelCounter++,
                        text: name,
                        role: parts[0].trim().replace("AX", ""),
                        x: x + Math.round(w / 2),
                        y: y + Math.round(h / 2),
                        w, h,
                    });
                }
            }

            // Update the shared element map (same as os_scan)
            _scanElements = elements;
            _scanTimestamp = Date.now();

            // Build compact text summary
            const summary = elements.map(el =>
                `[${el.label}] (${el.role}) "${el.text}" at (${el.x},${el.y})`
            ).join("\n");

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
            description: "PREFERRED click method for native Mac apps. Finds a UI element by its visible text label using OCR (Vision framework), then clicks it. Includes an automatic retry loop with coordinate jitter + visual verification. Use this instead of manually reading coordinates from os_screenshot whenever a clickable element has readable text.",
            parameters: {
                type: "object",
                properties: {
                    label: {
                        type: "string",
                        description: "The visible text of the element to click (e.g. 'Send', 'Desktop', 'Open', 'Cancel'). Fuzzy matched — partial text is fine.",
                    },
                    max_attempts: {
                        type: "number",
                        description: "Max retry attempts if click fails (default: 3). Each retry uses a slightly different coordinate offset.",
                    },
                    verify_appears: {
                        type: "string",
                        description: "Optional: text that should APPEAR on screen after a successful click (e.g. 'Saving...'). Used to confirm success.",
                    },
                    verify_gone: {
                        type: "boolean",
                        description: "If true, confirms success by checking that the original label text is no longer visible after clicking (e.g. a Submit button disappearing). Default: false.",
                    },
                    ocr_mode: {
                        type: "string",
                        enum: ["accurate", "fast"],
                        description: "OCR recognition mode (default: fast). Automatically escalates to accurate if fast finds no match.",
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
        let ocrMode = ((input.ocr_mode as string) || "fast") as "fast" | "accurate";

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
            try {
                await execFileAsync("screencapture", ["-x", tmpPng], { timeout: 8000 });
                capBuffer = await fs.readFile(tmpPng);
            } catch (err) {
                attemptLog.push({ attempt, matched_text: null, score: null, x: null, y: null, outcome: "screenshot_failed" });
                continue;
            }

            // Escalate to accurate on later retries
            const effectiveMode = attempt >= 1 ? "accurate" as const : ocrMode;

            let ocrResult = await runOcr(tmpPng, effectiveMode, capBuffer);

            // Fast-mode fallback: if fast found 0 elements, retry with accurate
            if (ocrResult && ocrResult.elements.length === 0 && effectiveMode === "fast") {
                ocrResult = await runOcr(tmpPng, "accurate", capBuffer);
            }

            if (!ocrResult || ocrResult.elements.length === 0) {
                await fs.unlink(tmpPng).catch(() => { });

                // Attempt 3: Accessibility tree fallback when OCR finds nothing
                if (attempt === maxAttempts - 1) {
                    const axElements = await getAccessibilityElements();
                    if (axElements.length > 0) {
                        let bestAxMatch: typeof axElements[0] | null = null;
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
                            console.log(`  🎯 [OCR-CLICK] Accessibility fallback: "${bestAxMatch.name}" (score=${bestAxScore.toFixed(2)}) → screen(${axClickX}, ${axClickY})`);
                            const axClicked = await nativeClick(axClickX, axClickY);
                            if (axClicked) {
                                attemptLog.push({ attempt, matched_text: bestAxMatch.name, score: bestAxScore, x: axClickX, y: axClickY, outcome: "success_accessibility_fallback" });
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

                attemptLog.push({ attempt, matched_text: null, score: null, x: null, y: null, outcome: "ocr_failed_no_elements" });
                // Wait a moment for UI to settle before retry
                await new Promise(r => setTimeout(r, 600));
                continue;
            }

            lastElementCount = ocrResult.elements.length;

            // Step 2: Fuzzy-match label against OCR elements
            let match = findBestMatch(ocrResult.elements, label);

            // Fast-mode fallback: if best score < 0.4, retry with accurate
            if ((!match || match.score < 0.4) && effectiveMode === "fast") {
                const accurateResult = await runOcr(tmpPng, "accurate", capBuffer);
                if (accurateResult && accurateResult.elements.length > 0) {
                    ocrResult = accurateResult;
                    lastElementCount = ocrResult.elements.length;
                    match = findBestMatch(ocrResult.elements, label);
                }
            }

            // Clean up screenshot temp file after all OCR passes
            await fs.unlink(tmpPng).catch(() => { });

            if (!match) {
                // Attempt 3: Accessibility tree fallback when OCR match fails
                if (attempt === maxAttempts - 1) {
                    const axElements = await getAccessibilityElements();
                    if (axElements.length > 0) {
                        let bestAxMatch: typeof axElements[0] | null = null;
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
                            console.log(`  🎯 [OCR-CLICK] Accessibility fallback: "${bestAxMatch.name}" (score=${bestAxScore.toFixed(2)}) → screen(${axClickX}, ${axClickY})`);
                            const axClicked = await nativeClick(axClickX, axClickY);
                            if (axClicked) {
                                attemptLog.push({ attempt, matched_text: bestAxMatch.name, score: bestAxScore, x: axClickX, y: axClickY, outcome: "success_accessibility_fallback" });
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

                attemptLog.push({ attempt, matched_text: null, score: null, x: null, y: null, outcome: `no_match_above_threshold (${ocrResult.elements.length} elements scanned)` });
                await new Promise(r => setTimeout(r, 600));
                continue;
            }

            // Step 3: Click at matched element center (no jitter — fallback chain is better)
            const clickX = Math.round(match.element.cx_screen);
            const clickY = Math.round(match.element.cy_screen);

            console.log(`  🎯 [OCR-CLICK] Matched "${match.element.text}" (score=${match.score.toFixed(2)}, conf=${match.element.confidence.toFixed(2)}) → screen(${clickX}, ${clickY})`);

            // Step 4: Click
            const clicked = await nativeClick(clickX, clickY);
            if (!clicked) {
                attemptLog.push({ attempt, matched_text: match.element.text, score: match.score, x: clickX, y: clickY, outcome: "click_event_failed" });
                continue;
            }

            // Step 5: Wait for UI to react
            await new Promise(r => setTimeout(r, 500));

            // Step 6: Visual verification
            let verificationOutcome = "not_checked";
            if (verifyAppears || verifyGone) {
                const tmpVerify = join(tmpdir(), `atlas_verify_${Date.now()}.png`);
                try {
                    await execFileAsync("screencapture", ["-x", tmpVerify], { timeout: 8000 });
                    const verifyBuf = await fs.readFile(tmpVerify);
                    const verifyOcr = await runOcr(tmpVerify, "fast", verifyBuf);
                    await fs.unlink(tmpVerify).catch(() => { });

                    if (verifyOcr) {
                        if (verifyAppears) {
                            const found = findBestMatch(verifyOcr.elements, verifyAppears, 0.6);
                            if (found) {
                                verificationOutcome = `verified_appears: "${found.element.text}" (score=${found.score.toFixed(2)})`;
                                attemptLog.push({ attempt, matched_text: match.element.text, score: match.score, x: clickX, y: clickY, outcome: "success_verified" });
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
                                attemptLog.push({ attempt, matched_text: match.element.text, score: match.score, x: clickX, y: clickY, outcome: "success_verified_gone" });
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
                attemptLog.push({ attempt, matched_text: match.element.text, score: match.score, x: clickX, y: clickY, outcome: verificationOutcome });
                await new Promise(r => setTimeout(r, 400));
                continue;
            }

            // No verification requested — trust the click succeeded
            attemptLog.push({ attempt, matched_text: match.element.text, score: match.score, x: clickX, y: clickY, outcome: "clicked_no_verify" });
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
            description: "Visually verify task completion by checking if specific text is visible on screen — or has disappeared. Use this at the END of any OS task to confirm success before reporting back to the user. Much faster than os_screenshot + manual inspection.",
            parameters: {
                type: "object",
                properties: {
                    expect_text: {
                        type: "string",
                        description: "Text that should be VISIBLE on screen for the task to be considered complete (e.g. 'Message sent', 'File saved', 'Desktop').",
                    },
                    expect_gone: {
                        type: "string",
                        description: "Text that should NO LONGER be visible for the task to be complete (e.g. 'Sending...', 'Loading').",
                    },
                    description: {
                        type: "string",
                        description: "Human-readable description of what you are verifying (e.g. 'Confirm message was sent in WhatsApp').",
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

        const expectText = input.expect_text as string | undefined;
        const expectGone = input.expect_gone as string | undefined;
        const description = (input.description as string) || "task completion";

        if (!expectText && !expectGone) {
            return JSON.stringify({ error: "Provide at least one of: expect_text or expect_gone." });
        }

        // Capture screen + run fast OCR
        const tmpPng = join(tmpdir(), `atlas_verify_${Date.now()}.png`);
        let verifyBuffer: Buffer | undefined;
        try {
            await execFileAsync("screencapture", ["-x", tmpPng], { timeout: 8000 });
            verifyBuffer = await fs.readFile(tmpPng);
        } catch (err) {
            return JSON.stringify({ success: false, error: "Screenshot failed during verification." });
        }

        const ocrResult = await runOcr(tmpPng, "fast", verifyBuffer);
        await fs.unlink(tmpPng).catch(() => { });

        if (!ocrResult) {
            return JSON.stringify({ success: false, error: "OCR failed during verification." });
        }

        const results: Record<string, unknown> = {
            description,
            element_count: ocrResult.element_count,
        };

        let overallSuccess = true;

        if (expectText) {
            const found = findBestMatch(ocrResult.elements, expectText, 0.6);
            const pass = !!found;
            results.expect_text = {
                query: expectText,
                found: pass,
                matched: found?.element.text ?? null,
                score: found ? Number(found.score.toFixed(3)) : null,
                position: found ? { x: found.element.cx_screen, y: found.element.cy_screen } : null,
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

// ── OS Context Tool (App Awareness) ───────────

export const osContext: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_context",
            description: "Get current OS context: which app is focused, window title, and screen resolution. Use this BEFORE os_type or os_click to verify the correct app is in focus. Very fast (no screenshot).",
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
            await fs.unlink(tmpFile).catch(() => { });

            const parts = stdout.trim().split("|");
            const appName = parts[0] || "unknown";
            const bundleId = parts[1] || "";
            const windowTitle = parts[2] || "";

            // Get screen resolution
            let screenWidth = lastScreenWidth || 1440;
            let screenHeight = lastScreenHeight || 900;
            if (!lastScreenWidth) {
                try {
                    const { stdout: resOut } = await execFileAsync("osascript", ["-l", "JavaScript", "-e",
                        'ObjC.import("AppKit"); var f = $.NSScreen.mainScreen.frame; `${f.size.width},${f.size.height}`'
                    ], { timeout: 2000 });
                    const [w, h] = resOut.trim().split(",").map(Number);
                    if (w > 0 && h > 0) { screenWidth = w; screenHeight = h; lastScreenWidth = w; lastScreenHeight = h; }
                } catch { /* use defaults */ }
            }

            return JSON.stringify({
                success: true,
                frontmost_app: appName,
                bundle_id: bundleId,
                window_title: windowTitle,
                screen: { width: screenWidth, height: screenHeight },
            });
        } catch (err) {
            await fs.unlink(tmpFile).catch(() => { });
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
            description: "Set the macOS display brightness to a specific level. Much more reliable than simulating brightness keys via AppleScript.",
            parameters: {
                type: "object",
                properties: {
                    level: {
                        type: "number",
                        description: "Brightness level from 0 (completely dark) to 100 (maximum brightness). Example: 50 for half brightness, 0 for screen off, 100 for full brightness.",
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
                await fs.unlink(tmpFile).catch(() => { });
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
                const stepsUp = Math.round(clamped / 100 * 16);
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
                    await fs.unlink(tmpFile).catch(() => { });
                    return JSON.stringify({
                        success: true,
                        brightness: clamped,
                        fraction,
                        method: "key-simulation",
                        note: "Used key simulation — brightness may not be exact. Install 'brightness' CLI (brew install brightness) for precise control.",
                    });
                } catch (err) {
                    await fs.unlink(tmpFile).catch(() => { });
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
            description: "Capture a screenshot of the current macOS screen and send it directly to the user on Telegram. This is an all-in-one tool — do NOT use shell_exec + send_file separately. Always use this when the user asks to see their screen.",
            parameters: {
                type: "object",
                properties: {
                    caption: { type: "string", description: "Optional caption to send with the screenshot (default: 'Here is your screen')" },
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
            await execFileAsync("screencapture", ["-x", tmpPng], { timeout: 10000 });

            // Step 2: Verify the file was created
            if (!existsSync(tmpPng)) {
                return JSON.stringify({ error: "Screenshot capture failed — file was not created. Check screen recording permissions in System Settings > Privacy & Security > Screen Recording." });
            }

            const stats = statSync(tmpPng);
            if (stats.size === 0) {
                await fs.unlink(tmpPng).catch(() => { });
                return JSON.stringify({ error: "Screenshot capture produced an empty file." });
            }

            // Step 3: Read and send via Telegram
            const fileBuffer = readFileSync(tmpPng);
            const { InputFile } = await import("grammy");
            const inputFile = new InputFile(fileBuffer, `screenshot_${Date.now()}.png`);
            await bot.api.sendPhoto(chatId, inputFile, { caption });

            // Step 4: Cleanup
            await fs.unlink(tmpPng).catch(() => { });

            return JSON.stringify({
                success: true,
                sent: true,
                size_kb: Math.round(stats.size / 1024),
            });
        } catch (err) {
            await fs.unlink(tmpPng).catch(() => { });
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
            description: "Get the accessibility tree of the focused macOS application. Returns structured UI elements with names, roles, and positions — more reliable than OCR for native apps. Use this to understand the UI of desktop apps before clicking.",
            parameters: {
                type: "object",
                properties: {
                    app_name: { type: "string", description: "Optional: specific app name to inspect. If not provided, uses the frontmost app." },
                    max_depth: { type: "number", description: "Max tree depth to traverse (default: 3). Higher values give more detail but more output." },
                },
                required: [],
            },
        },
    },
    async handler(input) {
        const appName = input.app_name as string || "";
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
            description: "Scans the current screen and identifies all interactive elements with numbered labels. Returns a labeled screenshot and element list. Use os_click_element with a label number to click. This is the PREFERRED way to interact with macOS apps — much more reliable than coordinate-based clicking.",
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

            // 1. Get screen dimensions
            let screenWidth = 1440, screenHeight = 900;
            try {
                const { stdout: resOut } = await execFileAsync("osascript", ["-l", "JavaScript", "-e",
                    'ObjC.import("AppKit"); var f = $.NSScreen.mainScreen.frame; JSON.stringify({w: f.size.width, h: f.size.height})'],
                    { timeout: 3000 });
                const dim = JSON.parse(resOut.trim());
                if (dim.w > 0 && dim.h > 0) { screenWidth = dim.w; screenHeight = dim.h; }
            } catch { /* use defaults */ }

            lastScreenWidth = screenWidth;
            lastScreenHeight = screenHeight;

            // 2. Hide overlay, capture screenshot
            hideOverlayForAgent();
            await new Promise(r => setTimeout(r, 100));
            await execFileAsync("screencapture", ["-x", tmpPng], { timeout: 10000 });
            showOverlayForAgent();

            // 3. Resize to 1280px width
            const RESIZE_WIDTH = 1280;
            try {
                await execFileAsync("sips", ["--resampleWidth", String(RESIZE_WIDTH), tmpPng], { timeout: 5000 });
            } catch { /* proceed with raw */ }

            // 4. Run OCR (accurate mode for reliable text) + accessibility in parallel
            const [ocrResult, axElements] = await Promise.all([
                runOcr(tmpPng, "accurate"),
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
                const overlaps = mergedElements.some(m =>
                    Math.abs(m.x - (ax.x + ax.w / 2)) < 15 && Math.abs(m.y - (ax.y + ax.h / 2)) < 15
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
                    const match = mergedElements.find(m =>
                        Math.abs(m.x - (ax.x + ax.w / 2)) < 15 && Math.abs(m.y - (ax.y + ax.h / 2)) < 15
                    );
                    if (match && match.role === "text") {
                        match.role = ax.role.replace("AX", "");
                    }
                }
            }

            // 6. Generate SoM overlay
            const elementsJson = join(tmpdir(), `atlas-scan-elements-${Date.now()}.json`);
            // Convert screen coords to image coords for the overlay
            const imageElements = mergedElements.map(el => ({
                label: el.label,
                text: el.text,
                x: Math.round(el.x / scaleFactor),
                y: Math.round(el.y / scaleFactor),
                w: Math.round(el.w / scaleFactor),
                h: Math.round(el.h / scaleFactor),
            }));
            await fs.writeFile(elementsJson, JSON.stringify(imageElements));

            const projectRoot = join(__dirname, "..", "..");
            const somScript = join(projectRoot, "scripts", "som_overlay.py");
            try {
                await execFileAsync("python3", [somScript, tmpPng, elementsJson, tmpJpg], { timeout: 5000 });
            } catch {
                // Fallback: convert without overlay
                try {
                    await execFileAsync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "85", tmpPng, "--out", tmpJpg], { timeout: 3000 });
                } catch { /* use PNG */ }
            }

            // 7. Read result
            const finalFile = await fs.access(tmpJpg).then(() => tmpJpg).catch(() => tmpPng);
            const buffer = await fs.readFile(finalFile);
            const base64 = buffer.toString("base64");
            const mimeType = finalFile.endsWith('.jpg') ? 'image/jpeg' : 'image/png';

            // 8. Cache elements
            _scanElements = mergedElements;
            _scanTimestamp = Date.now();

            // 9. Cleanup
            await fs.unlink(tmpPng).catch(() => {});
            await fs.unlink(tmpJpg).catch(() => {});
            await fs.unlink(elementsJson).catch(() => {});

            // 10. Build element summary for LLM
            const elementSummary = mergedElements.slice(0, 50).map(el =>
                `[${el.label}] ${el.role !== "text" ? `(${el.role}) ` : ""}${el.text}`
            ).join("\n");

            return JSON.stringify({
                success: true,
                screenshot_base64: base64,
                mime_type: mimeType,
                element_count: mergedElements.length,
                elements: elementSummary,
                tip: "Use os_click_element with a label number to click any element. Example: os_click_element label=5"
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
            description: "Click an element from os_scan or os_nav. You can click by LABEL NUMBER or by TEXT MATCH (preferred — more reliable). Text match finds the element whose text contains your query. Run os_scan or os_nav first.",
            parameters: {
                type: "object",
                properties: {
                    label: { type: "number", description: "Element label number from os_scan/os_nav" },
                    text: { type: "string", description: "Text to search for in elements (e.g., 'Perfect', 'Send', 'amma'). Finds best matching element. MORE RELIABLE than label numbers." },
                    action: { type: "string", enum: ["click", "double_click", "right_click"], description: "Click type (default: click)" },
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
            return JSON.stringify({ success: false, error: "Provide 'label' (number) or 'text' (string to search for)." });
        }

        // Parse label if provided
        let label: number | undefined;
        if (labelInput !== undefined) {
            label = typeof labelInput === "string" ? parseInt(labelInput, 10) : (labelInput as number);
            if (isNaN(label)) label = undefined;
        }

        // Ensure element map is populated — auto-refresh if expired
        const mapAge = Date.now() - _scanTimestamp;
        if (!_scanElements.length || mapAge > SCAN_CACHE_TTL_MS) {
            console.log(`  🔄 os_click_element: Element map expired — quick accessibility refresh...`);
            try {
                await quickAccessibilityRefresh();
            } catch (err) {
                return JSON.stringify({ success: false, error: `Element map refresh failed: ${(err as Error).message}. Run os_scan manually.` });
            }
        }

        // ── Resolve element: by TEXT search (preferred) or by LABEL number ──
        let resolvedElement: ScanElement | undefined;

        if (textSearch) {
            // TEXT-BASED SEARCH — programmatic matching, 100% reliable
            const query = textSearch.toLowerCase();
            // Exact match first
            resolvedElement = _scanElements.find(el => el.text.toLowerCase() === query);
            // Substring match
            if (!resolvedElement) {
                resolvedElement = _scanElements.find(el => el.text.toLowerCase().includes(query));
            }
            // Reverse substring (query contains element text)
            if (!resolvedElement) {
                resolvedElement = _scanElements.find(el => query.includes(el.text.toLowerCase()) && el.text.length > 2);
            }
            // Fuzzy: find closest match by shared words
            if (!resolvedElement) {
                const queryWords = query.split(/\s+/);
                let bestScore = 0;
                for (const el of _scanElements) {
                    const elLower = el.text.toLowerCase();
                    const matchedWords = queryWords.filter(w => elLower.includes(w));
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
                    resolvedElement = _scanElements.find(el => el.text.toLowerCase().includes(query));
                    if (!resolvedElement) {
                        resolvedElement = _scanElements.find(el => query.includes(el.text.toLowerCase()) && el.text.length > 2);
                    }
                } catch { /* fall through to error */ }
            }

            if (!resolvedElement) {
                const available = _scanElements.slice(0, 20).map(e => `"${e.text}"`).join(", ");
                return JSON.stringify({
                    success: false,
                    error: `No element matching "${textSearch}" found. Available: ${available}. Try os_nav or os_scan to refresh, or use a different search text.`,
                });
            }
            console.log(`  🎯 os_click_element: Text match "${textSearch}" → [${resolvedElement.label}] "${resolvedElement.text}" at (${resolvedElement.x},${resolvedElement.y})`);
        } else if (label !== undefined) {
            // LABEL-BASED LOOKUP
            resolvedElement = _scanElements.find(el => el.label === label);
            if (!resolvedElement) {
                // Auto-refresh once
                try {
                    await quickAccessibilityRefresh();
                    resolvedElement = _scanElements.find(el => el.label === label);
                } catch { /* ignore */ }
            }
            if (!resolvedElement) {
                return JSON.stringify({
                    success: false,
                    error: `Label ${label} not found. Available: ${_scanElements.map(e => e.label).join(", ")}. Use text= parameter for more reliable matching.`,
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
                    const frontApp = await execFileAsync("osascript", ["-e",
                        'tell application "System Events" to return name of first process whose frontmost is true'
                    ], { timeout: 2000 });
                    const appName = frontApp.stdout.trim().toLowerCase();
                    const doubleClickApps = ["spotify", "music", "finder", "itunes", "vlc", "vox"];
                    if (doubleClickApps.some(a => appName.includes(a))) {
                        effectiveAction = "double_click";
                        console.log(`  🖱️ os_click_element: Auto-upgraded to double-click (${appName} list item)`);
                    }
                } catch { /* keep single click */ }
            }

            const clickType = effectiveAction === "double_click" ? "double" : effectiveAction === "right_click" ? "right" : "click";
            // Generate the JXA click script using screen coordinates directly
            const jxa = `
ObjC.import('CoreGraphics');
var pt = $.CGPointMake(${el.x}, ${el.y});
${clickType === "double"
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
            await fs.writeFile(tmpFile, jxa, "utf-8");
            await execFileAsync("osascript", ["-l", "JavaScript", tmpFile], { timeout: 5000 });
            await fs.unlink(tmpFile).catch(() => {});

            const response: Record<string, unknown> = {
                success: true,
                clicked: { label: el.label, text: el.text, role: el.role, x: el.x, y: el.y },
                action: clickType,
                tip: "Take a screenshot or run os_visual_verify to confirm the click worked.",
            };

            // Phase 8: Screenshot diff verification
            try {
                if (_lastScreenshotBuffer) {
                    const beforeBuf = _lastScreenshotBuffer;
                    await new Promise(r => setTimeout(r, 500));
                    const tmpDiffPng = join(tmpdir(), `atlas_diff_elem_${Date.now()}.png`);
                    await execFileAsync("screencapture", ["-x", tmpDiffPng], { timeout: 8000 });
                    const afterBuf = await fs.readFile(tmpDiffPng);
                    await fs.unlink(tmpDiffPng).catch(() => { });
                    const diff = computeScreenDiff(beforeBuf, afterBuf);
                    response.screen_changed = diff > 0.05;
                    response.diff_percent = Math.round(diff * 100);
                    if (diff < 0.01) {
                        response.warning = "Click may not have had an effect. Verify with os_screenshot or os_visual_verify.";
                    }
                }
            } catch { /* diff check is non-blocking — ignore errors */ }

            return JSON.stringify(response);
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
            description: "Execute multiple OS actions in sequence (click, type, key, wait, verify). Reduces round-trips. Use this for common sequences like click→type→enter.",
            parameters: {
                type: "object",
                properties: {
                    actions: {
                        type: "array",
                        description: "Array of actions to execute sequentially",
                        items: {
                            type: "object",
                            properties: {
                                action: { type: "string", enum: ["click", "click_label", "type", "key", "combo", "wait", "screenshot", "verify"], description: "Action type" },
                                x: { type: "number", description: "X coord (for click)" },
                                y: { type: "number", description: "Y coord (for click)" },
                                label: { type: "number", description: "Element label from os_scan (for click_label)" },
                                text: { type: "string", description: "Text to type (for type) or expected text (for verify)" },
                                key: { type: "string", description: "Key name (for key) or combo like 'command+s' (for combo)" },
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
            try { rawActions = JSON.parse(rawActions); } catch { return JSON.stringify({ error: `Failed to parse actions JSON: ${(rawActions as string).substring(0, 100)}` }); }
        }
        const actions = (Array.isArray(rawActions) ? rawActions : []).slice(0, maxActions);
        const results: Array<{ action: string; ok: boolean; error?: string; detail?: any }> = [];

        for (const act of actions) {
            try {
                switch (act.action) {
                    case "click": {
                        // Use same scaling as os_click
                        const RESIZE_WIDTH = 1280;
                        const scaleFactor = (lastScreenWidth || 1440) / RESIZE_WIDTH;
                        const sx = Math.round((act.x || 0) * scaleFactor);
                        const sy = Math.round((act.y || 0) * scaleFactor);
                        const jxa = `ObjC.import('CoreGraphics');var pt=$.CGPointMake(${sx},${sy});var m=$.CGEventCreateMouseEvent(null,$.kCGEventMouseMoved,pt,0);$.CGEventPost($.kCGHIDEventTap,m);delay(0.05);var d=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseDown,pt,0);$.CGEventPost($.kCGHIDEventTap,d);delay(0.05);var u=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseUp,pt,0);$.CGEventPost($.kCGHIDEventTap,u);`;
                        await execFileAsync("osascript", ["-l", "JavaScript", "-e", jxa], { timeout: 5000 });
                        results.push({ action: "click", ok: true, detail: { x: act.x, y: act.y } });
                        break;
                    }
                    case "click_label": {
                        // Auto-refresh scan if expired
                        if (!_scanElements.length || (Date.now() - _scanTimestamp) > SCAN_CACHE_TTL_MS) {
                            try { await osScan.handler({}); } catch { /* fallthrough to error below */ }
                        }
                        const element = _scanElements.find(el => el.label === act.label);
                        if (!element) {
                            results.push({ action: "click_label", ok: false, error: `Label ${act.label} not found after refresh` });
                            if (stopOnError) return JSON.stringify({ results, stopped_early: true });
                            break;
                        }
                        const jxa = `ObjC.import('CoreGraphics');var pt=$.CGPointMake(${element.x},${element.y});var m=$.CGEventCreateMouseEvent(null,$.kCGEventMouseMoved,pt,0);$.CGEventPost($.kCGHIDEventTap,m);delay(0.05);var d=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseDown,pt,0);$.CGEventPost($.kCGHIDEventTap,d);delay(0.05);var u=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseUp,pt,0);$.CGEventPost($.kCGHIDEventTap,u);`;
                        await execFileAsync("osascript", ["-l", "JavaScript", "-e", jxa], { timeout: 5000 });
                        results.push({ action: "click_label", ok: true, detail: { label: act.label, text: element.text } });
                        break;
                    }
                    case "type": {
                        // Use clipboard method for reliability
                        const escaped = (act.text || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
                        const script = `set the clipboard to "${escaped}"\ntell application "System Events" to keystroke "v" using command down`;
                        await execFileAsync("osascript", ["-e", script], { timeout: 5000 });
                        results.push({ action: "type", ok: true, detail: { text: act.text } });
                        break;
                    }
                    case "key": {
                        // LLM may send key name in act.key, act.text, or act.combo
                        const keyInput = (act.key || act.text || "").toString().toLowerCase().trim();

                        // If it contains "+", treat as combo (e.g., "cmd+f", "command+v")
                        if (keyInput.includes("+")) {
                            // Redirect to combo handling
                            act.action = "combo";
                            act.key = keyInput;
                            // Fall through to combo case below by re-entering switch
                            const comboParts = keyInput.split("+");
                            const modifiers: string[] = [];
                            let mainKey = "";
                            for (const p of comboParts) {
                                const t = p.trim();
                                if (["cmd", "command", "⌘"].includes(t)) modifiers.push("command down");
                                else if (["shift", "⇧"].includes(t)) modifiers.push("shift down");
                                else if (["alt", "option", "⌥"].includes(t)) modifiers.push("option down");
                                else if (["ctrl", "control", "⌃"].includes(t)) modifiers.push("control down");
                                else mainKey = t;
                            }
                            const modStr = modifiers.length > 0 ? ` using {${modifiers.join(", ")}}` : "";
                            const script = `tell application "System Events" to keystroke "${mainKey}"${modStr}`;
                            await execFileAsync("osascript", ["-e", script], { timeout: 3000 });
                            results.push({ action: "combo", ok: true, detail: { key: keyInput } });
                            break;
                        }

                        // Map common key names to key codes
                        const keyCodes: Record<string, number> = {
                            return: 36, enter: 36, tab: 48, escape: 53, esc: 53,
                            delete: 51, backspace: 51, space: 49,
                            up: 126, down: 125, left: 123, right: 124,
                        };
                        const code = keyCodes[keyInput];
                        if (code !== undefined) {
                            const jxa = `ObjC.import('CoreGraphics');var e=$.CGEventCreateKeyboardEvent(null,${code},true);$.CGEventPost($.kCGHIDEventTap,e);delay(0.05);var u=$.CGEventCreateKeyboardEvent(null,${code},false);$.CGEventPost($.kCGHIDEventTap,u);`;
                            await execFileAsync("osascript", ["-l", "JavaScript", "-e", jxa], { timeout: 3000 });
                        } else if (keyInput.length === 1) {
                            // Single character — use keystroke
                            const script = `tell application "System Events" to keystroke "${keyInput}"`;
                            await execFileAsync("osascript", ["-e", script], { timeout: 3000 });
                        } else {
                            results.push({ action: "key", ok: false, error: `Unknown key: "${keyInput}". Use: return, tab, escape, delete, space, up, down, left, right, or single characters.` });
                            if (stopOnError) return JSON.stringify({ results, stopped_early: true });
                            break;
                        }
                        results.push({ action: "key", ok: true, detail: { key: keyInput } });
                        break;
                    }
                    case "combo": {
                        const parts = (act.key || act.text || "").split("+");
                        const mainKey = parts.pop() || "";
                        const modifiers = parts.map((m: string) => m.trim() + " down").join(", ");
                        const script = `tell application "System Events"\n    keystroke "${mainKey}" using {${modifiers}}\nend tell`;
                        await execFileAsync("osascript", ["-e", script], { timeout: 3000 });
                        results.push({ action: "combo", ok: true, detail: { combo: act.key } });
                        break;
                    }
                    case "wait": {
                        await new Promise(r => setTimeout(r, Math.min(act.ms || 500, 5000)));
                        results.push({ action: "wait", ok: true, detail: { ms: act.ms || 500 } });
                        break;
                    }
                    case "screenshot": {
                        // Quick screenshot capture, store buffer
                        const tmp = join(tmpdir(), `atlas-multi-${Date.now()}.png`);
                        await execFileAsync("screencapture", ["-x", tmp], { timeout: 8000 });
                        const buf = await fs.readFile(tmp);
                        _lastScreenshotBuffer = buf;
                        await fs.unlink(tmp).catch(() => {});
                        results.push({ action: "screenshot", ok: true, detail: { captured: true } });
                        break;
                    }
                    case "verify": {
                        // Quick OCR verification
                        const tmp = join(tmpdir(), `atlas-verify-${Date.now()}.png`);
                        await execFileAsync("screencapture", ["-x", tmp], { timeout: 8000 });
                        const ocrResult = await runOcr(tmp, "fast");
                        await fs.unlink(tmp).catch(() => {});
                        const found = ocrResult && (ocrResult as any).elements?.some((el: any) =>
                            similarity((act.text || "").toLowerCase(), (el.text || "").toLowerCase()) >= 0.6
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

        return JSON.stringify({ success: results.every(r => r.ok), results });
    },
};

// ── Region Zoom Tool ────────────────────────

export const osZoomRegion: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_zoom_region",
            description: "Zoom into a region of the last screenshot for detailed inspection. Useful for small icons, dense toolbars, or crowded menus. Pass coordinates from the last screenshot.",
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
            return JSON.stringify({ success: false, error: "No screenshot available. Take a screenshot first with os_screenshot or os_scan." });
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
                tip: "This is a 2x zoomed view of the selected region. Use os_click with the ORIGINAL screenshot coordinates (not zoomed coordinates) to interact."
            });
        } catch (err) {
            return JSON.stringify({ success: false, error: (err as Error).message });
        }
    },
};

// ── Keyboard Shortcut Database ───────────────

const APP_SHORTCUTS: Record<string, Record<string, string>> = {
    "Finder": {
        "New window": "Cmd+N", "New folder": "Cmd+Shift+N", "Go to folder": "Cmd+Shift+G",
        "Search": "Cmd+F", "Info": "Cmd+I", "Delete": "Cmd+Delete", "Empty trash": "Cmd+Shift+Delete",
        "Copy": "Cmd+C", "Paste": "Cmd+V", "Select all": "Cmd+A", "Undo": "Cmd+Z",
    },
    "Terminal": {
        "New tab": "Cmd+T", "New window": "Cmd+N", "Clear": "Cmd+K", "Close tab": "Cmd+W",
        "Copy": "Cmd+C", "Paste": "Cmd+V", "Find": "Cmd+F", "Split pane": "Cmd+D",
    },
    "Visual Studio Code": {
        "Command palette": "Cmd+Shift+P", "Quick open": "Cmd+P", "Toggle terminal": "Ctrl+`",
        "Find": "Cmd+F", "Replace": "Cmd+H", "Find in files": "Cmd+Shift+F",
        "Go to line": "Ctrl+G", "Go to definition": "F12", "Peek definition": "Alt+F12",
        "Toggle sidebar": "Cmd+B", "New file": "Cmd+N", "Save": "Cmd+S", "Save all": "Cmd+Alt+S",
        "Close tab": "Cmd+W", "Split editor": "Cmd+\\", "Toggle comment": "Cmd+/",
        "Format document": "Shift+Alt+F", "Rename symbol": "F2", "Undo": "Cmd+Z", "Redo": "Cmd+Shift+Z",
    },
    "Chrome": {
        "New tab": "Cmd+T", "Close tab": "Cmd+W", "Reopen tab": "Cmd+Shift+T",
        "Next tab": "Ctrl+Tab", "Prev tab": "Ctrl+Shift+Tab", "Address bar": "Cmd+L",
        "Find": "Cmd+F", "Refresh": "Cmd+R", "Hard refresh": "Cmd+Shift+R",
        "Dev tools": "Cmd+Alt+I", "Bookmarks": "Cmd+Shift+B", "History": "Cmd+Y",
        "New window": "Cmd+N", "Incognito": "Cmd+Shift+N", "Zoom in": "Cmd++", "Zoom out": "Cmd+-",
    },
    "Safari": {
        "New tab": "Cmd+T", "Close tab": "Cmd+W", "Address bar": "Cmd+L",
        "Find": "Cmd+F", "Refresh": "Cmd+R", "Back": "Cmd+[", "Forward": "Cmd+]",
        "Dev tools": "Cmd+Alt+I", "Private window": "Cmd+Shift+N",
    },
    "Notes": {
        "New note": "Cmd+N", "Bold": "Cmd+B", "Italic": "Cmd+I", "Underline": "Cmd+U",
        "Find": "Cmd+F", "Checklist": "Cmd+Shift+L", "Table": "Cmd+Alt+T",
    },
    "Global": {
        "Spotlight": "Cmd+Space", "Force quit": "Cmd+Alt+Esc", "Screenshot": "Cmd+Shift+3",
        "Screenshot area": "Cmd+Shift+4", "Screenshot window": "Cmd+Shift+4 then Space",
        "Lock screen": "Cmd+Ctrl+Q", "Mission control": "Ctrl+Up", "Show desktop": "F11",
        "Switch app": "Cmd+Tab", "Quit app": "Cmd+Q", "Close window": "Cmd+W",
        "Minimize": "Cmd+M", "Full screen": "Cmd+Ctrl+F", "Preferences": "Cmd+,",
        "Cut": "Cmd+X", "Copy": "Cmd+C", "Paste": "Cmd+V", "Undo": "Cmd+Z", "Redo": "Cmd+Shift+Z",
        "Select all": "Cmd+A", "Find": "Cmd+F",
    },
};

export const osKeyboardShortcuts: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_keyboard_shortcuts",
            description: "Get keyboard shortcuts for a macOS application. Using shortcuts is 5-10x faster than navigating menus or clicking buttons. Always check shortcuts before resorting to mouse-based navigation.",
            parameters: {
                type: "object",
                properties: {
                    app_name: { type: "string", description: "App to get shortcuts for (e.g., 'Visual Studio Code', 'Chrome', 'Finder'). Use 'Global' for system-wide shortcuts." },
                },
                required: ["app_name"],
            },
        },
    },
    async handler(input) {
        const appName = input.app_name as string;
        const shortcuts = APP_SHORTCUTS[appName] || APP_SHORTCUTS["Global"];
        const globalShortcuts = APP_SHORTCUTS["Global"];

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
