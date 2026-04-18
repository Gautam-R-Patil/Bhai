// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Linux OS Tools ───────────────────────────────
// Linux equivalents for macOS/Windows tools.
// Uses xdotool, xclip, xdg-open, scrot/gnome-screenshot,
// xdg-screensaver, notify-send, pactl/amixer, etc.
// Supports both X11 and basic Wayland (via wl-* tools).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ToolDefinition } from "./get-current-time.js";
import { getTelegramContext } from "./send-file.js";
import { captureScreenshot, getScreenResolution } from "./platform.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const execFileAsync = promisify(execFile);

// ── Constants ─────────────────────────────────

const MAX_OUTPUT = 10000;
const DEFAULT_TIMEOUT = 30000;

// Screen calibration
let lastScreenWidth = 0;
let lastScreenHeight = 0;

// ── Wayland Detection ────────────────────────

function isWayland(): boolean {
    return !!(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland");
}

// ── Shell Script Tool ────────────────────────

export const linuxShellScript: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "linux_shell_script",
            description: "Execute a shell script on Linux for system automation. Use for controlling apps, system settings, and desktop automation. Equivalent of apple_script on macOS. IMPORTANT: To LAUNCH apps, use the app name directly or xdg-open.",
            parameters: {
                type: "object",
                properties: {
                    script: {
                        type: "string",
                        description: "The bash script to execute. Write raw bash commands."
                    },
                    timeout: { type: "number", description: "Timeout in ms (default 30000)" },
                },
                required: ["script"],
            },
        },
    },

    async handler(input) {
        if (process.platform !== "linux") {
            return JSON.stringify({ error: "linux_shell_script tool is only available on Linux." });
        }

        const script = input.script as string;
        const timeout = (input.timeout as number) || DEFAULT_TIMEOUT;

        // Browser-launch guard (same logic as macOS/Windows)
        const BROWSER_PATTERNS = [
            /(?:google-chrome|firefox|chromium|brave-browser|microsoft-edge)\s/i,
            /xdg-open\s+['"]?https?:\/\//i,
        ];
        if (BROWSER_PATTERNS.some(p => p.test(script))) {
            return JSON.stringify({
                error: "BLOCKED: Do NOT open native browsers for web tasks. Use browser_navigate with the URL directly instead.",
                fix: "Call browser_navigate with the target URL.",
            });
        }

        const tmpFile = join(tmpdir(), `atlas_linux_${Date.now()}.sh`);
        try {
            await fs.writeFile(tmpFile, script, { mode: 0o755 });
            const { stdout, stderr } = await execFileAsync("bash", [tmpFile], { timeout });
            await fs.unlink(tmpFile).catch(() => {});
            const output = stdout.trim();
            return JSON.stringify({
                success: true,
                stdout: output.substring(0, MAX_OUTPUT),
                stderr: (stderr || "").substring(0, 2000),
                truncated: output.length > MAX_OUTPUT,
            });
        } catch (err) {
            await fs.unlink(tmpFile).catch(() => {});
            const error = err as { message?: string; code?: number; killed?: boolean };
            return JSON.stringify({
                success: false,
                error: error.message || "Script execution failed",
                code: error.code,
                killed: error.killed,
            });
        }
    },
};

// ── OS Screenshot Tool (Linux) ──────────────

export const linuxOsScreenshot: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_screenshot",
            description: "Takes a screenshot of the current Linux screen. Returns the image, which app is focused, screen resolution, and coordinate mapping info. ALWAYS take a screenshot after os_click or os_type to verify your action worked.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },

    async handler() {
        if (process.platform !== "linux") {
            return JSON.stringify({ error: "This Linux os_screenshot handler should not be called on non-Linux." });
        }

        const tmpPng = join(tmpdir(), `atlas_screen_${Date.now()}.png`);
        const tmpJpg = join(tmpdir(), `atlas_screen_${Date.now()}.jpg`);

        try {
            // Get screen resolution
            const screen = await getScreenResolution();
            lastScreenWidth = screen.width;
            lastScreenHeight = screen.height;

            // Capture screenshot
            await captureScreenshot(tmpPng);

            // Resize to 1920px width for LLM coordinate accuracy
            const RESIZE_WIDTH = 1920;
            try {
                await execFileAsync("convert", [
                    tmpPng, "-resize", `${RESIZE_WIDTH}x`, tmpPng
                ], { timeout: 10000 });
            } catch {
                // ImageMagick not available; proceed with raw size
            }

            // Add grid overlay using Python + Pillow
            const projectRoot = join(__dirname, "..", "..");
            const gridScript = join(projectRoot, "scripts", "grid_overlay.py");
            try {
                await execFileAsync("python3", [gridScript, tmpPng, tmpJpg, "200"], { timeout: 5000 });
            } catch {
                try {
                    await execFileAsync("python", [gridScript, tmpPng, tmpJpg, "200"], { timeout: 5000 });
                } catch {
                    // Fallback: convert to JPEG via ImageMagick
                    try {
                        await execFileAsync("convert", [
                            tmpPng, "-quality", "85", tmpJpg
                        ], { timeout: 5000 });
                    } catch { /* use PNG */ }
                }
            }

            // Read whichever file we produced
            const finalFile = existsSync(tmpJpg) ? tmpJpg : tmpPng;
            const buffer = await fs.readFile(finalFile);
            const base64 = buffer.toString("base64");
            const mimeType = finalFile.endsWith('.jpg') ? 'image/jpeg' : 'image/png';

            // Cleanup
            await fs.unlink(tmpPng).catch(() => {});
            await fs.unlink(tmpJpg).catch(() => {});

            // Scale factor
            const scaleFactor = screen.width / RESIZE_WIDTH;

            // Get frontmost app
            let frontmostApp = "unknown";
            try {
                if (isWayland()) {
                    const { stdout } = await execFileAsync("bash", ["-c",
                        `swaymsg -t get_tree 2>/dev/null | grep -o '"app_id":"[^"]*"' | head -1 | sed 's/"app_id":"\\(.*\\)"/\\1/' || echo unknown`
                    ], { timeout: 2000 });
                    frontmostApp = stdout.trim() || "unknown";
                } else {
                    const { stdout } = await execFileAsync("xdotool", [
                        "getactivewindow", "getwindowname"
                    ], { timeout: 2000 });
                    frontmostApp = stdout.trim() || "unknown";
                }
            } catch { /* unknown */ }

            return JSON.stringify({
                success: true,
                screenshot_base64: base64,
                mime_type: mimeType,
                screen: { width: screen.width, height: screen.height },
                image_width: RESIZE_WIDTH,
                scale_factor: Math.round(scaleFactor * 1000) / 1000,
                frontmost_app: frontmostApp,
                tip: `Image is ${RESIZE_WIDTH}px wide with a coordinate GRID overlay. Use the grid lines and labels to pick PRECISE x,y coordinates. Pass them to os_click — auto-scaled to screen. ALWAYS verify with another screenshot after clicking.`
            });
        } catch (err) {
            await fs.unlink(tmpPng).catch(() => {});
            await fs.unlink(tmpJpg).catch(() => {});
            const error = err as { message?: string };
            return JSON.stringify({
                success: false,
                error: error.message || "Failed to capture screen",
            });
        }
    },
};

// ── OS Click Tool (Linux) ───────────────────

export const linuxOsClick: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_click",
            description: "Click, double-click, right-click, or move the mouse on Linux. Pass x,y coordinates as you see them in the os_screenshot image — they are auto-scaled to actual screen resolution.",
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
        if (process.platform !== "linux") {
            return JSON.stringify({ error: "os_click is only available on Linux." });
        }

        const rawX = input.x as number;
        const rawY = input.y as number;
        const action = (input.action as string) || "click";
        const useRaw = input.raw as boolean;

        let x = rawX;
        let y = rawY;
        if (!useRaw && lastScreenWidth > 0) {
            const RESIZE_WIDTH = 1920;
            const scaleFactor = lastScreenWidth / RESIZE_WIDTH;
            x = Math.round(rawX * scaleFactor);
            y = Math.round(rawY * scaleFactor);
            console.log(`  [CLICK] image(${rawX},${rawY}) -> screen(${x},${y}) [scale=${scaleFactor.toFixed(3)}]`);
        }

        try {
            if (isWayland()) {
                // Wayland: try ydotool (needs root or ydotoold running)
                const ydoArgs: string[] = [];
                switch (action) {
                    case "move":
                        await execFileAsync("ydotool", ["mousemove", "--absolute", "-x", String(x), "-y", String(y)], { timeout: 3000 });
                        break;
                    case "right_click":
                        await execFileAsync("ydotool", ["mousemove", "--absolute", "-x", String(x), "-y", String(y)], { timeout: 3000 });
                        await execFileAsync("ydotool", ["click", "0xC0"], { timeout: 3000 }); // right click
                        break;
                    case "double_click":
                        await execFileAsync("ydotool", ["mousemove", "--absolute", "-x", String(x), "-y", String(y)], { timeout: 3000 });
                        await execFileAsync("ydotool", ["click", "0x40", "0x40"], { timeout: 3000 });
                        break;
                    default: // click
                        await execFileAsync("ydotool", ["mousemove", "--absolute", "-x", String(x), "-y", String(y)], { timeout: 3000 });
                        await execFileAsync("ydotool", ["click", "0x40"], { timeout: 3000 }); // left click
                        break;
                }
                return JSON.stringify({ success: true, action, x, y, method: "ydotool" });
            }

            // X11: use xdotool
            switch (action) {
                case "move":
                    await execFileAsync("xdotool", ["mousemove", String(x), String(y)], { timeout: 3000 });
                    break;
                case "right_click":
                    await execFileAsync("xdotool", ["mousemove", String(x), String(y)], { timeout: 3000 });
                    await execFileAsync("xdotool", ["click", "3"], { timeout: 3000 });
                    break;
                case "double_click":
                    await execFileAsync("xdotool", ["mousemove", String(x), String(y)], { timeout: 3000 });
                    await execFileAsync("xdotool", ["click", "--repeat", "2", "--delay", "100", "1"], { timeout: 3000 });
                    break;
                default: // click
                    await execFileAsync("xdotool", ["mousemove", String(x), String(y)], { timeout: 3000 });
                    await execFileAsync("xdotool", ["click", "1"], { timeout: 3000 });
                    break;
            }
            return JSON.stringify({ success: true, action, x, y, method: "xdotool" });
        } catch (err) {
            const error = err as { message?: string };
            return JSON.stringify({ success: false, error: error.message || "Mouse action failed" });
        }
    },
};

// ── OS Type Tool (Linux) ────────────────────

export const linuxOsType: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_type",
            description: "Type text or press keys/hotkeys at the OS level on Linux. Works on ANY focused application. Use for typing into native apps, pressing shortcuts (Ctrl+C, Ctrl+V, etc.).",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "Text to type (types character by character)" },
                    key: { type: "string", description: "Special key to press: Return, Tab, Escape, Delete, space, Up, Down, Left, Right, F1-F12" },
                    combo: { type: "string", description: "Hotkey combo like 'ctrl+c', 'ctrl+shift+s', 'alt+tab'. Use + to separate modifiers and key." },
                    delay_ms: { type: "number", description: "Delay in ms after action (default: 200)" },
                },
                required: [],
            },
        },
    },

    async handler(input) {
        if (process.platform !== "linux") {
            return JSON.stringify({ error: "os_type is only available on Linux." });
        }

        const delayMs = (input.delay_ms as number) || 200;
        const tool = isWayland() ? "ydotool" : "xdotool";

        try {
            if (input.combo) {
                // Parse combo like "ctrl+shift+s"
                const parts = (input.combo as string).toLowerCase().split("+").map(s => s.trim());

                if (tool === "xdotool") {
                    // xdotool key combos use modifier+key format
                    const modMap: Record<string, string> = {
                        "ctrl": "ctrl", "control": "ctrl",
                        "shift": "shift", "alt": "alt", "option": "alt",
                        "super": "super", "win": "super", "command": "super", "cmd": "super",
                        "meta": "super",
                    };

                    const keyParts = parts.map(p => modMap[p] || p);
                    const combo = keyParts.join("+");
                    await execFileAsync("xdotool", ["key", combo], { timeout: 5000 });
                } else {
                    // ydotool key combos
                    const modMap: Record<string, string> = {
                        "ctrl": "29:1", "control": "29:1",
                        "shift": "42:1", "alt": "56:1",
                        "super": "125:1", "win": "125:1",
                    };
                    const releaseMap: Record<string, string> = {
                        "ctrl": "29:0", "control": "29:0",
                        "shift": "42:0", "alt": "56:0",
                        "super": "125:0", "win": "125:0",
                    };
                    const key = parts.pop() || "";
                    const presses = parts.map(p => modMap[p]).filter(Boolean);
                    const releases = parts.map(p => releaseMap[p]).filter(Boolean).reverse();
                    // This is simplified; ydotool keycodes are complex
                    await execFileAsync("ydotool", ["key", ...presses, key, ...releases], { timeout: 5000 });
                }

                return JSON.stringify({
                    success: true,
                    typed: input.combo,
                    method: tool,
                });
            }

            if (input.key) {
                const key = (input.key as string);
                const keyMap: Record<string, string> = {
                    "return": "Return", "enter": "Return", "tab": "Tab",
                    "escape": "Escape", "esc": "Escape", "delete": "Delete",
                    "backspace": "BackSpace", "space": "space",
                    "up": "Up", "down": "Down", "left": "Left", "right": "Right",
                    "f1": "F1", "f2": "F2", "f3": "F3", "f4": "F4",
                    "f5": "F5", "f6": "F6", "f7": "F7", "f8": "F8",
                    "f9": "F9", "f10": "F10", "f11": "F11", "f12": "F12",
                    "home": "Home", "end": "End", "pageup": "Prior", "pagedown": "Next",
                };

                const mapped = keyMap[key.toLowerCase()] || key;

                if (tool === "xdotool") {
                    await execFileAsync("xdotool", ["key", mapped], { timeout: 5000 });
                } else {
                    await execFileAsync("ydotool", ["key", mapped], { timeout: 5000 });
                }

                return JSON.stringify({
                    success: true,
                    typed: key,
                    method: tool,
                });
            }

            if (input.text) {
                const text = input.text as string;

                if (tool === "xdotool") {
                    await execFileAsync("xdotool", ["type", "--clearmodifiers", "--delay", "12", text], { timeout: 15000 });
                } else {
                    await execFileAsync("ydotool", ["type", text], { timeout: 15000 });
                }

                return JSON.stringify({
                    success: true,
                    typed: text,
                    method: tool,
                });
            }

            return JSON.stringify({ error: "Provide 'text', 'key', or 'combo'" });
        } catch (err) {
            const error = err as { message?: string };
            return JSON.stringify({ success: false, error: error.message || "Keyboard action failed" });
        }
    },
};

// ── OS Context Tool (Linux) ─────────────────

export const linuxOsContext: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "os_context",
            description: "Get current OS context: which app is focused, window title, and screen resolution. Very fast (no screenshot).",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },

    async handler() {
        if (process.platform !== "linux") {
            return JSON.stringify({ error: "os_context: Linux only." });
        }

        try {
            const screen = await getScreenResolution();
            lastScreenWidth = screen.width;
            lastScreenHeight = screen.height;

            let appName = "unknown";
            let windowTitle = "";

            if (isWayland()) {
                try {
                    const { stdout } = await execFileAsync("bash", ["-c",
                        `swaymsg -t get_tree 2>/dev/null | python3 -c "
import sys, json
tree = json.load(sys.stdin)
def find_focused(node):
    if node.get('focused'):
        return node
    for n in node.get('nodes', []) + node.get('floating_nodes', []):
        r = find_focused(n)
        if r: return r
    return None
f = find_focused(tree)
if f:
    print(f.get('app_id', f.get('name', 'unknown')) + '|||' + f.get('name', ''))
else:
    print('unknown|||')
"`
                    ], { timeout: 3000 });
                    const [app, title] = stdout.trim().split("|||");
                    appName = app || "unknown";
                    windowTitle = title || "";
                } catch { /* fallback */ }
            } else {
                try {
                    const { stdout: winName } = await execFileAsync("xdotool", [
                        "getactivewindow", "getwindowname"
                    ], { timeout: 2000 });
                    windowTitle = winName.trim();

                    try {
                        const { stdout: pidStr } = await execFileAsync("xdotool", [
                            "getactivewindow", "getwindowpid"
                        ], { timeout: 2000 });
                        const { stdout: comm } = await execFileAsync("ps", [
                            "-p", pidStr.trim(), "-o", "comm="
                        ], { timeout: 2000 });
                        appName = comm.trim() || "unknown";
                    } catch { /* pid not available for all windows */ }
                } catch { /* fallback */ }
            }

            return JSON.stringify({
                success: true,
                frontmost_app: appName,
                window_title: windowTitle,
                screen: { width: screen.width, height: screen.height },
                session_type: isWayland() ? "wayland" : "x11",
            });
        } catch (err) {
            const error = err as { message?: string };
            return JSON.stringify({ success: false, error: error.message || "Failed to get OS context" });
        }
    },
};

// ── Set Brightness Tool (Linux) ─────────────

export const linuxSetBrightness: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "set_brightness",
            description: "Set the Linux display brightness to a specific level (0-100).",
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
        if (process.platform !== "linux") {
            return JSON.stringify({ error: "set_brightness: Linux only." });
        }

        const rawLevel = input.level as number;
        const clamped = Math.max(0, Math.min(100, Math.round(rawLevel)));

        // Try brightnessctl first (most common on modern distros)
        try {
            await execFileAsync("brightnessctl", [
                "set", `${clamped}%`
            ], { timeout: 5000 });
            return JSON.stringify({
                success: true,
                brightness: clamped,
                method: "brightnessctl",
            });
        } catch { /* fallback */ }

        // Try xbacklight
        try {
            await execFileAsync("xbacklight", [
                "-set", String(clamped)
            ], { timeout: 5000 });
            return JSON.stringify({
                success: true,
                brightness: clamped,
                method: "xbacklight",
            });
        } catch { /* fallback */ }

        // Direct sysfs fallback
        try {
            const backlightDir = "/sys/class/backlight";
            const { stdout: lsOut } = await execFileAsync("ls", [backlightDir], { timeout: 2000 });
            const device = lsOut.trim().split("\n")[0];
            if (device) {
                const maxBrightness = parseInt(
                    await fs.readFile(join(backlightDir, device, "max_brightness"), "utf-8")
                );
                const target = Math.round((clamped / 100) * maxBrightness);
                await fs.writeFile(
                    join(backlightDir, device, "brightness"),
                    String(target)
                );
                return JSON.stringify({
                    success: true,
                    brightness: clamped,
                    method: "sysfs",
                });
            }
        } catch { /* no backlight control */ }

        return JSON.stringify({
            success: false,
            error: "No brightness control method available. Install brightnessctl or xbacklight.",
        });
    },
};

// ── Send Screenshot Tool (Linux) ────────────

export const linuxSendScreenshot: ToolDefinition = {
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
        if (process.platform !== "linux") {
            return JSON.stringify({ error: "send_screenshot: Linux only." });
        }

        const caption = (input.caption as string) || "Here's your screen";
        const { bot, chatId } = getTelegramContext();

        if (!bot || !chatId) {
            return JSON.stringify({ error: "Telegram context not available." });
        }

        const tmpPng = join(tmpdir(), `atlas_sendscreen_${Date.now()}.png`);

        try {
            await captureScreenshot(tmpPng);

            if (!existsSync(tmpPng)) {
                return JSON.stringify({ error: "Screenshot failed -- file not created." });
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
