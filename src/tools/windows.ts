// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Windows OS Tools ──────────────────────────
// Windows equivalents for macOS tools in macos.ts.
// Uses PowerShell + Win32 API (user32.dll) for mouse/keyboard,
// PowerShell System.Drawing for screenshots,
// and Windows.Media.Ocr for OCR.

import { execFile } from "node:child_process";
import { existsSync, promises as fs, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gridScreenshot } from "../screen/grid-overlay.js";
import { getScreenDimensions, percentageToScreen, scaleImageToScreen } from "../screen/screen-dimensions.js";
import type { ToolDefinition } from "./get-current-time.js";
import {
    captureScreenshot,
    getFrontmostApp,
    getScreenResolution,
    runPowerShell,
    runPowerShellInline,
} from "./platform.js";
import { getTelegramContext } from "./send-file.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const execFileAsync = promisify(execFile);

// ── OCR Script Resolver ───────────────────────

function findOcrScript(): string | null {
    // process.resourcesPath is injected by Electron at runtime; not in Node types
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const candidates = [
        // Dev: src/tools/ -> ../../scripts/
        join(__dirname, "..", "..", "scripts", "ocr_screen.ps1"),
        // Compiled: dist/tools/ -> ../../scripts/
        join(__dirname, "..", "..", "scripts", "ocr_screen.ps1"),
        // CWD fallback
        join(process.cwd(), "scripts", "ocr_screen.ps1"),
        // Electron packaged: process.resourcesPath/scripts/
        ...(resourcesPath ? [join(resourcesPath, "scripts", "ocr_screen.ps1")] : []),
        // Electron packaged: process.resourcesPath/bot/scripts/
        ...(resourcesPath ? [join(resourcesPath, "bot", "scripts", "ocr_screen.ps1")] : []),
    ];
    for (const p of candidates) {
        if (existsSync(p)) return p;
    }
    return null;
}

// ── Constants ─────────────────────────────────

const MAX_OUTPUT = 10000;
const DEFAULT_TIMEOUT = 30000;

// Screen calibration
let lastScreenWidth = 0;
let lastScreenHeight = 0;

// ── PowerShell Script Tool ────────────────────

export const powerShellScript: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "powershell_script",
            description:
                "Execute a PowerShell script on Windows. Use for controlling apps, system settings, and automation. Equivalent of apple_script on macOS. IMPORTANT: To LAUNCH apps, use: Start-Process 'AppName' — do NOT use browser automation tools for native Windows apps.",
            parameters: {
                type: "object",
                properties: {
                    script: {
                        type: "string",
                        description:
                            "The PowerShell script to execute. Write raw PowerShell, no extra escaping needed.",
                    },
                    timeout: { type: "number", description: "Timeout in ms (default 30000)" },
                },
                required: ["script"],
            },
        },
    },

    async handler(input) {
        if (process.platform !== "win32") {
            return JSON.stringify({ error: "powershell_script tool is only available on Windows." });
        }

        const script = input.script as string;
        const timeout = (input.timeout as number) || DEFAULT_TIMEOUT;

        // Browser-launch guard (same logic as macOS)
        const BROWSER_PATTERNS = [
            /start-process\s+['"](chrome|firefox|msedge|brave|iexplore)['"]/i,
            /start\s+['"](chrome|firefox|msedge|brave)['"]/i,
            /start-process\s+['"]?https?:\/\//i,
            /start\s+['"]?https?:\/\//i,
        ];
        if (BROWSER_PATTERNS.some((p) => p.test(script))) {
            return JSON.stringify({
                error: "BLOCKED: Do NOT open native browsers for web tasks. Use browser_navigate with the URL directly instead.",
                fix: "Call browser_navigate with the target URL.",
            });
        }

        try {
            const result = await runPowerShell(script, timeout);
            return JSON.stringify({
                success: true,
                stdout: result.substring(0, MAX_OUTPUT),
                truncated: result.length > MAX_OUTPUT,
            });
        } catch (err) {
            const error = err as { message?: string; code?: number; killed?: boolean };
            return JSON.stringify({
                success: false,
                error: error.message || "PowerShell execution failed",
                code: error.code,
                killed: error.killed,
            });
        }
    },
};

// ── OS Screenshot Tool (Windows) ──────────────

export const winOsScreenshot: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_screenshot",
            description:
                "Takes a screenshot of the current Windows screen. Returns the image, which app is focused, screen resolution, and coordinate mapping info. ALWAYS take a screenshot after os_click or os_type to verify your action worked.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },

    async handler() {
        if (process.platform !== "win32") {
            return JSON.stringify({ error: "This Windows os_screenshot handler should not be called on non-Windows." });
        }

        const tmpPng = join(tmpdir(), `atlas_screen_${Date.now()}.png`);

        try {
            // Get dims for the focused monitor (multi-monitor aware).
            const dims = await getScreenDimensions({ focusedWindow: true, force: true });
            const screen = { width: dims.width, height: dims.height };
            lastScreenWidth = screen.width;
            lastScreenHeight = screen.height;

            // Capture screenshot
            await captureScreenshot(tmpPng);

            // Resize to 1920px width for LLM coordinate accuracy, with the coordinate grid
            const RESIZE_WIDTH = 1920;
            const gridded = await gridScreenshot(await fs.readFile(tmpPng), RESIZE_WIDTH, 200);
            if (!gridded) {
                // sharp unusable: resize via PowerShell and send the PNG without the grid
                try {
                    await runPowerShell(
                        `
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile("${tmpPng.replace(/\\/g, "\\\\")}")
$ratio = ${RESIZE_WIDTH} / $img.Width
$newHeight = [int]($img.Height * $ratio)
$bmp = New-Object System.Drawing.Bitmap(${RESIZE_WIDTH}, $newHeight)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($img, 0, 0, ${RESIZE_WIDTH}, $newHeight)
$g.Dispose()
$img.Dispose()
$bmp.Save("${tmpPng.replace(/\\/g, "\\\\")}", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
`,
                        10000,
                    );
                } catch {
                    /* proceed with raw size */
                }
            }
            const buffer = gridded?.buf ?? (await fs.readFile(tmpPng));
            const base64 = buffer.toString("base64");
            const mimeType = gridded?.mime ?? "image/png";

            // Cleanup
            await fs.unlink(tmpPng).catch(() => {});

            // Scale factor
            const scaleFactor = screen.width / RESIZE_WIDTH;

            // Get frontmost app
            const frontmostApp = await getFrontmostApp();

            return JSON.stringify({
                success: true,
                screenshot_base64: base64,
                mime_type: mimeType,
                screen: { width: screen.width, height: screen.height },
                image_width: RESIZE_WIDTH,
                scale_factor: Math.round(scaleFactor * 1000) / 1000,
                frontmost_app: frontmostApp,
                tip: `Image is ${RESIZE_WIDTH}px wide with a coordinate GRID overlay. Use the grid lines and labels to pick PRECISE x,y coordinates. Pass them to os_click — auto-scaled to screen. ALWAYS verify with another screenshot after clicking.`,
            });
        } catch (err) {
            await fs.unlink(tmpPng).catch(() => {});
            const error = err as { message?: string };
            return JSON.stringify({
                success: false,
                error: error.message || "Failed to capture screen",
            });
        }
    },
};

// ── OS Click Tool (Windows) ───────────────────

export const winOsClick: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_click",
            description:
                "Click, double-click, right-click, or move the mouse on Windows. PREFERRED: pass percent_x/percent_y in [0..1] (resolution-independent, works on any monitor/DPI). LEGACY: pass x/y image-pixel coords from os_screenshot.",
            parameters: {
                type: "object",
                properties: {
                    x: { type: "number", description: "X coordinate from the screenshot image (legacy)" },
                    y: { type: "number", description: "Y coordinate from the screenshot image (legacy)" },
                    percent_x: { type: "number", description: "X position as 0..1 fraction. PREFERRED." },
                    percent_y: { type: "number", description: "Y position as 0..1 fraction. PREFERRED." },
                    action: {
                        type: "string",
                        enum: ["click", "double_click", "right_click", "move"],
                        description: "Mouse action (default: click)",
                    },
                    raw: {
                        type: "boolean",
                        description:
                            "If true, treat x/y as raw screen pixels without scaling. Ignored when percent_x/y are given.",
                    },
                },
                required: [],
            },
        },
    },

    async handler(input) {
        if (process.platform !== "win32") {
            return JSON.stringify({ error: "os_click is only available on Windows." });
        }

        const action = (input.action as string) || "click";
        const useRaw = input.raw as boolean;
        const pctX = input.percent_x as number | undefined;
        const pctY = input.percent_y as number | undefined;
        const rawX = input.x as number | undefined;
        const rawY = input.y as number | undefined;

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
            const RESIZE_WIDTH = 1920;
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

        // PowerShell script using user32.dll
        let mouseFlags: string;
        switch (action) {
            case "move":
                mouseFlags = `[WinAPI]::SetCursorPos(${x}, ${y}) | Out-Null; "moved"`;
                break;
            case "right_click":
                mouseFlags = `
[WinAPI]::SetCursorPos(${x}, ${y}) | Out-Null
Start-Sleep -Milliseconds 50
[WinAPI]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)  # RIGHTDOWN
Start-Sleep -Milliseconds 50
[WinAPI]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)  # RIGHTUP
"right_clicked"`;
                break;
            case "double_click":
                mouseFlags = `
[WinAPI]::SetCursorPos(${x}, ${y}) | Out-Null
Start-Sleep -Milliseconds 50
[WinAPI]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)  # LEFTDOWN
Start-Sleep -Milliseconds 20
[WinAPI]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)  # LEFTUP
Start-Sleep -Milliseconds 50
[WinAPI]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)  # LEFTDOWN
Start-Sleep -Milliseconds 20
[WinAPI]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)  # LEFTUP
"double_clicked"`;
                break;
            default: // "click"
                mouseFlags = `
[WinAPI]::SetCursorPos(${x}, ${y}) | Out-Null
Start-Sleep -Milliseconds 50
[WinAPI]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)  # LEFTDOWN
Start-Sleep -Milliseconds 50
[WinAPI]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)  # LEFTUP
"clicked"`;
                break;
        }

        const psScript = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinAPI {
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
'@
${mouseFlags}
`;

        try {
            const result = await runPowerShell(psScript, 5000);
            return JSON.stringify({ success: true, action, x, y, result: result.trim() });
        } catch (err) {
            const error = err as { message?: string };
            return JSON.stringify({ success: false, error: error.message || "Mouse action failed" });
        }
    },
};

// ── OS Type Tool (Windows) ────────────────────

/**
 * A PowerShell expression that evaluates to `s`. The text travels as base64
 * inside a single-quoted literal, so nothing in it is parsed as PowerShell
 * (no `$(...)`, backticks or quote breakout) and non-ASCII survives as UTF-8.
 */
export function psLiteral(s: string): string {
    const b64 = Buffer.from(s, "utf-8").toString("base64");
    return `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'))`;
}

export const winOsType: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_type",
            description:
                "Type text or press keys/hotkeys at the OS level on Windows. Works on ANY focused application. Use for typing into native apps, pressing shortcuts (Ctrl+C, Ctrl+V, etc.).",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "Text to type (types character by character)" },
                    key: {
                        type: "string",
                        description:
                            "Special key to press: return, tab, escape, delete, space, up, down, left, right, f1-f12",
                    },
                    combo: {
                        type: "string",
                        description:
                            "Hotkey combo like 'ctrl+c', 'ctrl+shift+s', 'alt+tab'. Use + to separate modifiers and key.",
                    },
                    delay_ms: { type: "number", description: "Delay in ms after action (default: 200)" },
                },
                required: [],
            },
        },
    },

    async handler(input) {
        if (process.platform !== "win32") {
            return JSON.stringify({ error: "os_type is only available on Windows." });
        }

        const delayMs = Math.max(0, Math.floor(Number(input.delay_ms) || 200));
        let psScript: string;

        if (input.combo) {
            // Parse combo like "ctrl+shift+s"
            const parts = (input.combo as string)
                .toLowerCase()
                .split("+")
                .map((s) => s.trim());
            const key = parts.pop() || "";
            const modifiers: string[] = [];

            for (const mod of parts) {
                if (mod === "ctrl" || mod === "control") modifiers.push("^");
                else if (mod === "shift") modifiers.push("+");
                else if (mod === "alt" || mod === "option") modifiers.push("%");
                else if (mod === "win" || mod === "command" || mod === "cmd") modifiers.push("^{ESC}"); // approximate
            }

            // Map special keys to SendKeys format
            const specialKeyMap: Record<string, string> = {
                return: "{ENTER}",
                enter: "{ENTER}",
                tab: "{TAB}",
                escape: "{ESC}",
                esc: "{ESC}",
                delete: "{DELETE}",
                del: "{DELETE}",
                backspace: "{BACKSPACE}",
                space: " ",
                up: "{UP}",
                down: "{DOWN}",
                left: "{LEFT}",
                right: "{RIGHT}",
                f1: "{F1}",
                f2: "{F2}",
                f3: "{F3}",
                f4: "{F4}",
                f5: "{F5}",
                f6: "{F6}",
                f7: "{F7}",
                f8: "{F8}",
                f9: "{F9}",
                f10: "{F10}",
                f11: "{F11}",
                f12: "{F12}",
                home: "{HOME}",
                end: "{END}",
                pageup: "{PGUP}",
                pagedown: "{PGDN}",
            };

            const mappedKey = specialKeyMap[key] || key;
            const modPrefix = modifiers.join("");

            psScript = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait(${psLiteral(modPrefix + mappedKey)})
Start-Sleep -Milliseconds ${delayMs}
`;
        } else if (input.key) {
            const key = (input.key as string).toLowerCase();
            const specialKeyMap: Record<string, string> = {
                return: "{ENTER}",
                enter: "{ENTER}",
                tab: "{TAB}",
                escape: "{ESC}",
                esc: "{ESC}",
                delete: "{DELETE}",
                del: "{DELETE}",
                backspace: "{BACKSPACE}",
                space: " ",
                up: "{UP}",
                down: "{DOWN}",
                left: "{LEFT}",
                right: "{RIGHT}",
                f1: "{F1}",
                f2: "{F2}",
                f3: "{F3}",
                f4: "{F4}",
                f5: "{F5}",
                f6: "{F6}",
                f7: "{F7}",
                f8: "{F8}",
                f9: "{F9}",
                f10: "{F10}",
                f11: "{F11}",
                f12: "{F12}",
            };
            const mapped = specialKeyMap[key] || `{${key.toUpperCase()}}`;

            psScript = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait(${psLiteral(mapped)})
Start-Sleep -Milliseconds ${delayMs}
`;
        } else if (input.text) {
            // Escape special SendKeys characters: +, ^, %, ~, (, ), {, }, [, ]
            const escaped = (input.text as string).replace(/([+^%~(){}[\]])/g, "{$1}");
            psScript = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait(${psLiteral(escaped)})
Start-Sleep -Milliseconds ${delayMs}
`;
        } else {
            return JSON.stringify({ error: "Provide 'text', 'key', or 'combo'" });
        }

        try {
            const result = await runPowerShell(psScript, 10000);
            return JSON.stringify({
                success: true,
                ...(input.text ? { typed_chars: String(input.text).length } : { pressed: input.key || input.combo }),
                stdout: (result || "").substring(0, 500),
            });
        } catch (err) {
            const error = err as { message?: string };
            return JSON.stringify({ success: false, error: error.message || "Keyboard action failed" });
        }
    },
};

// ── OCR Helpers (Windows) ─────────────────────

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
    threshold = 0.55,
): { element: OcrElement; score: number } | null {
    let best: { element: OcrElement; score: number } | null = null;
    for (const el of elements) {
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

/** Run OCR on a screenshot using Windows.Media.Ocr */
async function runWinOcr(screenshotPath: string | null): Promise<OcrResult | null> {
    // If no path given, capture fresh screenshot
    let imgPath = screenshotPath;
    let tempCapture = false;
    if (!imgPath) {
        imgPath = join(tmpdir(), `atlas_ocr_${Date.now()}.png`);
        await captureScreenshot(imgPath);
        tempCapture = true;
    }

    const ocrScript = findOcrScript();
    if (!ocrScript) return null;

    try {
        const { stdout } = await execFileAsync(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ocrScript, imgPath],
            { timeout: 20000 },
        );

        if (tempCapture) await fs.unlink(imgPath).catch(() => {});

        const parsed = JSON.parse(stdout.trim()) as OcrResult;
        return parsed;
    } catch {
        if (tempCapture && imgPath) await fs.unlink(imgPath).catch(() => {});
        return null;
    }
}

/** Perform a native click at screen coordinates on Windows. */
async function winNativeClick(x: number, y: number): Promise<boolean> {
    try {
        await runPowerShell(
            `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinAPI {
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
'@
[WinAPI]::SetCursorPos(${x}, ${y}) | Out-Null
Start-Sleep -Milliseconds 60
[WinAPI]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 70
[WinAPI]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
`,
            5000,
        );
        return true;
    } catch {
        return false;
    }
}

// ── OS OCR Click Tool (Windows) ───────────────

export const winOsOcrClick: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_ocr_click",
            description:
                "PREFERRED click method for native Windows apps. Finds a UI element by its visible text label using OCR (Windows.Media.Ocr), then clicks it. Includes an automatic retry loop with coordinate jitter + visual verification.",
            parameters: {
                type: "object",
                properties: {
                    label: {
                        type: "string",
                        description:
                            "The visible text of the element to click (e.g. 'Send', 'Open', 'Cancel'). Fuzzy matched — partial text is fine.",
                    },
                    max_attempts: { type: "number", description: "Max retry attempts (default: 3)" },
                    verify_appears: { type: "string", description: "Text that should APPEAR after clicking" },
                    verify_gone: { type: "boolean", description: "If true, confirm the label text disappeared" },
                },
                required: ["label"],
            },
        },
    },

    async handler(input) {
        if (process.platform !== "win32") {
            return JSON.stringify({ error: "os_ocr_click: Windows only." });
        }

        const label = input.label as string;
        const maxAttempts = (input.max_attempts as number) || 3;
        const verifyAppears = input.verify_appears as string | undefined;
        const verifyGone = (input.verify_gone as boolean) || false;

        const attemptLog: Array<{
            attempt: number;
            matched_text: string | null;
            score: number | null;
            x: number | null;
            y: number | null;
            outcome: string;
        }> = [];

        const jitterOffsets = [
            { dx: 0, dy: 0 },
            { dx: 5, dy: 3 },
            { dx: -5, dy: -3 },
            { dx: 8, dy: -5 },
            { dx: -8, dy: 5 },
        ];

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            console.log(`  🔍 [OCR-CLICK] Attempt ${attempt + 1}/${maxAttempts} — looking for "${label}"`);

            const ocrResult = await runWinOcr(null);
            if (!ocrResult || ocrResult.elements.length === 0) {
                attemptLog.push({ attempt, matched_text: null, score: null, x: null, y: null, outcome: "ocr_failed" });
                await new Promise((r) => setTimeout(r, 600));
                continue;
            }

            const match = findBestMatch(ocrResult.elements, label);
            if (!match) {
                attemptLog.push({
                    attempt,
                    matched_text: null,
                    score: null,
                    x: null,
                    y: null,
                    outcome: `no_match (${ocrResult.elements.length} elements)`,
                });
                await new Promise((r) => setTimeout(r, 600));
                continue;
            }

            const jitter = jitterOffsets[Math.min(attempt, jitterOffsets.length - 1)];
            const clickX = Math.round(match.element.cx_screen + jitter.dx);
            const clickY = Math.round(match.element.cy_screen + jitter.dy);

            console.log(
                `  🎯 [OCR-CLICK] Matched "${match.element.text}" (score=${match.score.toFixed(2)}) → screen(${clickX}, ${clickY})`,
            );

            const clicked = await winNativeClick(clickX, clickY);
            if (!clicked) {
                attemptLog.push({
                    attempt,
                    matched_text: match.element.text,
                    score: match.score,
                    x: clickX,
                    y: clickY,
                    outcome: "click_failed",
                });
                continue;
            }

            await new Promise((r) => setTimeout(r, 500));

            // Verification
            if (verifyAppears || verifyGone) {
                const verifyOcr = await runWinOcr(null);
                if (verifyOcr) {
                    if (verifyAppears) {
                        const found = findBestMatch(verifyOcr.elements, verifyAppears, 0.6);
                        if (found) {
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
                                clicked: { x: clickX, y: clickY },
                                attempts: attempt + 1,
                                verification: `verified_appears: "${found.element.text}"`,
                                attempts_log: attemptLog,
                            });
                        }
                    }
                    if (verifyGone) {
                        const stillThere = findBestMatch(verifyOcr.elements, label, 0.7);
                        if (!stillThere) {
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
                                clicked: { x: clickX, y: clickY },
                                attempts: attempt + 1,
                                verification: `verified_gone: "${label}" no longer on screen`,
                                attempts_log: attemptLog,
                            });
                        }
                    }
                }
                attemptLog.push({
                    attempt,
                    matched_text: match.element.text,
                    score: match.score,
                    x: clickX,
                    y: clickY,
                    outcome: "verification_failed",
                });
                continue;
            }

            // No verification — trust click
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
                clicked: { x: clickX, y: clickY },
                attempts: attempt + 1,
                verification: "not_requested",
                tip: "Take an os_screenshot to visually confirm the action worked.",
                attempts_log: attemptLog,
            });
        }

        return JSON.stringify({
            success: false,
            error: `Could not find and click "${label}" after ${maxAttempts} attempts.`,
            attempts_log: attemptLog,
        });
    },
};

// ── OS Visual Verify Tool (Windows) ───────────

export const winOsVisualVerify: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_visual_verify",
            description:
                "Visually verify task completion by checking if specific text is visible on screen — or has disappeared. Use this at the END of any OS task to confirm success.",
            parameters: {
                type: "object",
                properties: {
                    expect_text: { type: "string", description: "Text that should be VISIBLE on screen" },
                    expect_gone: { type: "string", description: "Text that should NO LONGER be visible" },
                    description: { type: "string", description: "What you are verifying" },
                },
                required: [],
            },
        },
    },

    async handler(input) {
        if (process.platform !== "win32") {
            return JSON.stringify({ error: "os_visual_verify: Windows only." });
        }

        // expected_text is what older prompts told the model to pass.
        const expectText = (input.expect_text ?? input.expected_text) as string | undefined;
        const expectGone = input.expect_gone as string | undefined;
        const description = (input.description as string) || "task completion";

        if (!expectText && !expectGone) {
            return JSON.stringify({ error: "Provide at least one of: expect_text or expect_gone." });
        }

        const ocrResult = await runWinOcr(null);
        if (!ocrResult) {
            return JSON.stringify({ success: false, error: "OCR failed during verification." });
        }

        const results: Record<string, unknown> = { description, element_count: ocrResult.element_count };
        let overallSuccess = true;

        if (expectText) {
            const found = findBestMatch(ocrResult.elements, expectText, 0.6);
            const pass = !!found;
            results.expect_text = {
                query: expectText,
                found: pass,
                matched: found?.element.text ?? null,
                score: found ? Number(found.score.toFixed(3)) : null,
            };
            if (!pass) overallSuccess = false;
        }

        if (expectGone) {
            const stillThere = findBestMatch(ocrResult.elements, expectGone, 0.7);
            const pass = !stillThere;
            results.expect_gone = { query: expectGone, still_visible: !pass, pass };
            if (!pass) overallSuccess = false;
        }

        results.success = overallSuccess;
        results.verdict = overallSuccess ? `✅ Verified: ${description}` : `❌ Verification FAILED: ${description}`;

        return JSON.stringify(results);
    },
};

// ── OS Context Tool (Windows) ─────────────────

export const winOsContext: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_context",
            description:
                "Get current OS context: which app is focused, window title, and screen resolution. Very fast (no screenshot).",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },

    async handler() {
        if (process.platform !== "win32") {
            return JSON.stringify({ error: "os_context: Windows only." });
        }

        try {
            const result = await runPowerShell(
                `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinAPI {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
Add-Type -AssemblyName System.Windows.Forms
$hwnd = [WinAPI]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder(256)
[WinAPI]::GetWindowText($hwnd, $sb, 256) | Out-Null
$title = $sb.ToString()
$pid = 0
[WinAPI]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
$proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
$appName = if ($proc) { $proc.ProcessName } else { "unknown" }
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
"$appName|$title|$($screen.Width)|$($screen.Height)"
`,
                3000,
            );

            const parts = result.split("|");
            const screen = await getScreenResolution();
            lastScreenWidth = screen.width;
            lastScreenHeight = screen.height;

            return JSON.stringify({
                success: true,
                frontmost_app: parts[0] || "unknown",
                window_title: parts[1] || "",
                screen: { width: screen.width, height: screen.height },
            });
        } catch (err) {
            const error = err as { message?: string };
            return JSON.stringify({ success: false, error: error.message || "Failed to get OS context" });
        }
    },
};

// ── Set Brightness Tool (Windows) ─────────────

export const winSetBrightness: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "set_brightness",
            description: "Set the Windows display brightness to a specific level (0-100).",
            parameters: {
                type: "object",
                properties: {
                    level: {
                        type: "number",
                        description: "Brightness level from 0 to 100.",
                    },
                },
                required: ["level"],
            },
        },
    },

    async handler(input) {
        if (process.platform !== "win32") {
            return JSON.stringify({ error: "set_brightness: Windows only." });
        }

        const rawLevel = input.level as number;
        const clamped = Math.max(0, Math.min(100, Math.round(rawLevel)));

        try {
            await runPowerShell(
                `
(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1, ${clamped})
`,
                5000,
            );
            return JSON.stringify({
                success: true,
                brightness: clamped,
                method: "WMI",
            });
        } catch {
            // Fallback: use PowerShell with modern API
            try {
                await runPowerShellInline(
                    `powershell -Command "(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods).WmiSetBrightness(1,${clamped})"`,
                    5000,
                );
                return JSON.stringify({
                    success: true,
                    brightness: clamped,
                    method: "CIM",
                });
            } catch (err) {
                return JSON.stringify({
                    success: false,
                    error: (err as Error).message,
                    note: "Brightness control may not be available on desktop monitors (only laptops).",
                });
            }
        }
    },
};

// ── Send Screenshot Tool (Windows) ────────────

export const winSendScreenshot: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "send_screenshot",
            description: "Capture a screenshot and send it to the user on Telegram. All-in-one tool.",
            parameters: {
                type: "object",
                properties: {
                    caption: { type: "string", description: "Optional caption (default: 'Here is your screen')" },
                },
                required: [],
            },
        },
    },

    async handler(input) {
        if (process.platform !== "win32") {
            return JSON.stringify({ error: "send_screenshot: Windows only." });
        }

        const caption = (input.caption as string) || "Here's your screen 📸";
        const { bot, chatId } = getTelegramContext();

        if (!bot || !chatId) {
            return JSON.stringify({ error: "Telegram context not available." });
        }

        const tmpPng = join(tmpdir(), `atlas_sendscreen_${Date.now()}.png`);

        try {
            await captureScreenshot(tmpPng);

            if (!existsSync(tmpPng)) {
                return JSON.stringify({ error: "Screenshot failed — file not created." });
            }

            const stats = statSync(tmpPng);
            if (stats.size === 0) {
                await fs.unlink(tmpPng).catch(() => {});
                return JSON.stringify({ error: "Screenshot produced an empty file." });
            }

            const fileBuffer = readFileSync(tmpPng);
            const { InputFile } = await import("grammy");
            const inputFile = new InputFile(fileBuffer, `screenshot_${Date.now()}.png`);
            await bot.api.sendPhoto(chatId, inputFile, { caption });

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
            });
        }
    },
};

// ── Exported screen dimensions for other tools ─

export function getLastScreenDimensions(): { width: number; height: number } {
    return { width: lastScreenWidth, height: lastScreenHeight };
}
