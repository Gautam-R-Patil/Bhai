// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Platform Bridge ─────────────────────────────
// Unified cross-platform API for common OS operations.
// Delegates to platform-specific implementations based on process.platform.
// darwin → osascript/screencapture/pbcopy/pbpaste
// win32  → PowerShell/user32.dll/System.Drawing
// linux  → xdotool/xclip/scrot/xdg-open/xprintidle

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AxNode } from "../screen/ax-dump.js";
import {
    captureScreenshot,
    clipboardRead,
    clipboardWrite,
    getFrontmostApp,
    getScreenResolution,
    IS_LINUX,
    IS_MAC,
    IS_WIN,
    nativeOpen,
    runPowerShellInline,
} from "./platform.js";

const execFileAsync = promisify(execFile);

// ── Screenshot ──────────────────────────────────

/**
 * Capture a screenshot and return it as a Buffer.
 * Uses the platform-appropriate tool: screencapture (macOS),
 * System.Drawing (Windows), scrot/gnome-screenshot (Linux).
 */
export async function takeScreenshot(): Promise<Buffer> {
    const tmpPath = join(tmpdir(), `bhai_bridge_screenshot_${Date.now()}.png`);
    try {
        await captureScreenshot(tmpPath);
        const buffer = await fs.readFile(tmpPath);
        await fs.unlink(tmpPath).catch(() => {});
        return buffer;
    } catch (err) {
        await fs.unlink(tmpPath).catch(() => {});
        throw err;
    }
}

// ── Clipboard ───────────────────────────────────

/**
 * Read current clipboard contents as text.
 * macOS: pbpaste, Windows: Get-Clipboard, Linux: xclip
 */
export async function getClipboard(): Promise<string> {
    return clipboardRead();
}

/**
 * Write text to the system clipboard.
 * macOS: pbcopy, Windows: Set-Clipboard, Linux: xclip
 */
export async function setClipboard(text: string): Promise<void> {
    return clipboardWrite(text);
}

// ── Open URL ────────────────────────────────────

/**
 * Open a URL in the system's default browser.
 * macOS: open, Windows: start, Linux: xdg-open
 */
export async function openUrl(url: string): Promise<void> {
    return nativeOpen(url);
}

// ── Active Window ───────────────────────────────

/**
 * Get the currently focused/active window information.
 * Returns the application name and the window title.
 */
export async function getActiveWindow(): Promise<{ app: string; title: string }> {
    if (IS_MAC) {
        try {
            const { stdout: appName } = await execFileAsync(
                "osascript",
                ["-e", 'tell application "System Events" to get name of first process whose frontmost is true'],
                { timeout: 2000 },
            );

            let title = "";
            try {
                const { stdout: winTitle } = await execFileAsync(
                    "osascript",
                    [
                        "-e",
                        'tell application "System Events" to get name of front window of first process whose frontmost is true',
                    ],
                    { timeout: 2000 },
                );
                title = winTitle.trim();
            } catch {
                // Some apps don't expose window title via AppleScript
            }

            return { app: appName.trim(), title };
        } catch {
            return { app: "unknown", title: "" };
        }
    }

    if (IS_WIN) {
        try {
            const result = await runPowerShellInline(
                `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Text; public class WinAPI { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId); }'
$hwnd = [WinAPI]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder(256)
[WinAPI]::GetWindowText($hwnd, $sb, 256) | Out-Null
$title = $sb.ToString()
$pid = 0
[WinAPI]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
$proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
$appName = if ($proc) { $proc.ProcessName } else { "unknown" }
"$appName|||$title"
            `.trim(),
                5000,
            );

            const [app, title] = result.split("|||");
            return { app: (app || "unknown").trim(), title: (title || "").trim() };
        } catch {
            return { app: "unknown", title: "" };
        }
    }

    // Linux
    if (IS_LINUX) {
        try {
            const { stdout: windowName } = await execFileAsync("xdotool", ["getactivewindow", "getwindowname"], {
                timeout: 3000,
            });

            // Try to get the process name via xdotool + /proc
            let app = "unknown";
            try {
                const { stdout: pidStr } = await execFileAsync("xdotool", ["getactivewindow", "getwindowpid"], {
                    timeout: 2000,
                });
                const pid = pidStr.trim();
                if (pid) {
                    const { stdout: comm } = await execFileAsync("ps", ["-p", pid, "-o", "comm="], { timeout: 2000 });
                    app = comm.trim() || "unknown";
                }
            } catch {
                // xdotool may not return a PID for all windows
            }

            return { app, title: windowName.trim() };
        } catch {
            // Wayland fallback: try swaymsg or wlrctl
            try {
                const { stdout } = await execFileAsync(
                    "bash",
                    ["-c", `swaymsg -t get_tree | grep -o '"name":"[^"]*"' | head -1 | sed 's/"name":"\\(.*\\)"/\\1/'`],
                    { timeout: 3000 },
                );
                return { app: "unknown", title: stdout.trim() };
            } catch {
                return { app: "unknown", title: "" };
            }
        }
    }

    return { app: "unknown", title: "" };
}

// ── User Idle Time ──────────────────────────────

/**
 * Get the number of seconds the user has been idle (no keyboard/mouse input).
 * macOS: ioreg, Windows: GetLastInputInfo, Linux: xprintidle
 */
export async function getUserIdleSeconds(): Promise<number> {
    if (IS_MAC) {
        try {
            const { stdout } = await execFileAsync("ioreg", ["-c", "IOHIDSystem", "-d", "4"], { timeout: 5000 });
            const match = stdout.match(/HIDIdleTime.*?=\s*(\d+)/);
            if (match) {
                // HIDIdleTime is in nanoseconds
                return Math.floor(parseInt(match[1]) / 1_000_000_000);
            }
        } catch {
            /* fallback */
        }
        return 0;
    }

    if (IS_WIN) {
        try {
            const result = await runPowerShellInline(
                `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; } public class IdleTime { [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii); public static uint GetIdleMs() { LASTINPUTINFO lii = new LASTINPUTINFO(); lii.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO)); GetLastInputInfo(ref lii); return ((uint)Environment.TickCount - lii.dwTime); } }'
[Math]::Floor([IdleTime]::GetIdleMs() / 1000)
            `.trim(),
                5000,
            );
            return parseInt(result) || 0;
        } catch {
            return 0;
        }
    }

    // Linux
    if (IS_LINUX) {
        try {
            // xprintidle returns milliseconds
            const { stdout } = await execFileAsync("xprintidle", [], { timeout: 3000 });
            return Math.floor(parseInt(stdout.trim()) / 1000);
        } catch {
            // Fallback: try xssstate (from suckless-tools)
            try {
                const { stdout } = await execFileAsync("xssstate", ["-i"], { timeout: 3000 });
                return Math.floor(parseInt(stdout.trim()) / 1000);
            } catch {
                return 0;
            }
        }
    }

    return 0;
}

// ── System Info ─────────────────────────────────

export interface MacWifi {
    connected: boolean;
    ssid: string | null;
    /** Connected, but macOS hides the network's name from apps without Location Services access. */
    nameHidden: boolean;
}

export const WIFI_NAME_HIDDEN_HINT =
    "macOS hides the Wi-Fi name from apps without Location Services access. To read it, open the Wi-Fi pane (system_settings 'wifi') and read the network marked Connected with os_inspect.";

/**
 * networksetup alone said "not associated" whenever macOS redacted the name (recent
 * macOS does for apps without Location access), so Bhai reported a connected Mac as
 * disconnected. `ipconfig getsummary` still says whether the link is up.
 */
export function parseMacWifi(networksetupOut: string, summaryOut: string): MacWifi {
    const named = /Current Wi-Fi Network:\s*(.+)/.exec(networksetupOut)?.[1]?.trim();
    if (named) return { connected: true, ssid: named, nameHidden: false };
    const connected = /LinkStatusActive\s*:\s*TRUE/i.test(summaryOut);
    const ssid = /^\s*SSID\s*:\s*(.+)$/m.exec(summaryOut)?.[1]?.trim() ?? null;
    if (!connected) return { connected: false, ssid: null, nameHidden: false };
    return ssid && ssid !== "<redacted>" ? { connected, ssid, nameHidden: false } : { connected, ssid: null, nameHidden: true };
}

/**
 * The Wi-Fi pane's status group reads: "Wi-Fi", blurb, toggle, <network name>,
 * "Connected, …": the name is the text just before "Connected".
 * ponytail: English "Connected" only; other UI languages fall back to the hint.
 */
export function wifiNameFromPane(root: AxNode): string | null {
    const walk = (n: AxNode): string | null => {
        const kids = n.children ?? [];
        for (let i = 1; i < kids.length; i++) {
            const prev = kids[i - 1];
            const name = (prev.label || prev.value || "").trim();
            if (
                /^Connected\b/.test(kids[i].label || kids[i].value || "") &&
                prev.role === "AXStaticText" &&
                name &&
                name.length <= 64
            )
                return name;
        }
        for (const c of kids) {
            const hit = walk(c);
            if (hit) return hit;
        }
        return null;
    };
    return walk(root);
}

/**
 * The name macOS hides from command-line tools is on screen in System Settings: open
 * the Wi-Fi pane without bringing it forward and read it through Accessibility.
 */
export async function wifiNameFromSettings(): Promise<string | null> {
    try {
        await execFileAsync("open", ["-g", "x-apple.systempreferences:com.apple.wifi-settings-extension"], {
            timeout: 5000,
        });
        const { dumpAccessibilityTree } = await import("../screen/ax-dump.js");
        for (let attempt = 0; attempt < 3; attempt++) {
            await new Promise((r) => setTimeout(r, 1200));
            const pid = Number.parseInt(
                (await execFileAsync("pgrep", ["-x", "System Settings"], { timeout: 2000 }).catch(() => ({ stdout: "" })))
                    .stdout,
                10,
            );
            if (!pid) continue;
            const dump = await dumpAccessibilityTree({ pid, depth: 30, budgetMs: 8000, timeoutMs: 10_000 });
            const name = dump.root && !dump.error ? wifiNameFromPane(dump.root) : null;
            if (name) return name;
        }
    } catch {
        /* no Accessibility access, or System Settings didn't open */
    }
    return null;
}

export async function macWifi(iface = "en0"): Promise<MacWifi> {
    const run = (cmd: string, args: string[]) =>
        execFileAsync(cmd, args, { timeout: 3000 }).then(
            (r) => r.stdout,
            () => "",
        );
    const [ns, summary] = await Promise.all([
        run("networksetup", ["-getairportnetwork", iface]),
        run("ipconfig", ["getsummary", iface]),
    ]);
    return parseMacWifi(ns, summary);
}

interface SystemInfoResult {
    battery: number; // 0-100, -1 if no battery
    wifi: string; // SSID or "disconnected" or "unknown"
    volume: number; // 0-100
}

/**
 * Get basic system info: battery level, WiFi SSID, volume level.
 * Returns best-effort data; fields may be defaults if unavailable.
 */
export async function getSystemInfo(): Promise<SystemInfoResult> {
    if (IS_MAC) {
        const result: SystemInfoResult = { battery: -1, wifi: "unknown", volume: 50 };

        // Battery
        try {
            const { stdout } = await execFileAsync("pmset", ["-g", "batt"], { timeout: 3000 });
            const match = stdout.match(/(\d+)%/);
            if (match) result.battery = parseInt(match[1]);
        } catch {
            /* no battery info */
        }

        // WiFi (the old airport -I tool is gone from current macOS)
        const w = await macWifi();
        result.wifi = w.ssid ?? (w.nameHidden ? "connected (name hidden by macOS)" : "disconnected");

        // Volume
        try {
            const { stdout } = await execFileAsync("osascript", ["-e", "output volume of (get volume settings)"], {
                timeout: 2000,
            });
            result.volume = parseInt(stdout.trim()) || 50;
        } catch {
            /* default */
        }

        return result;
    }

    if (IS_WIN) {
        const result: SystemInfoResult = { battery: -1, wifi: "unknown", volume: 50 };

        // Battery
        try {
            const battResult = await runPowerShellInline(
                `(Get-CimInstance Win32_Battery).EstimatedChargeRemaining`,
                3000,
            );
            const val = parseInt(battResult);
            result.battery = isNaN(val) ? -1 : val;
        } catch {
            /* no battery */
        }

        // WiFi
        try {
            const wifiResult = await runPowerShellInline(
                `(netsh wlan show interfaces | Select-String 'SSID' | Select-Object -First 1).ToString().Split(':')[1].Trim()`,
                3000,
            );
            result.wifi = wifiResult || "disconnected";
        } catch {
            result.wifi = "unknown";
        }

        // Volume (approximate via registry or nircmd)
        try {
            const volResult = await runPowerShellInline(
                `try { $vol = [int]((& nircmd.exe getvolume '') 2>&1); $vol } catch { 50 }`,
                3000,
            );
            result.volume = parseInt(volResult) || 50;
        } catch {
            result.volume = 50;
        }

        return result;
    }

    // Linux
    if (IS_LINUX) {
        const result: SystemInfoResult = { battery: -1, wifi: "unknown", volume: 50 };

        // Battery: read from /sys
        try {
            const capacity = await fs.readFile("/sys/class/power_supply/BAT0/capacity", "utf-8");
            result.battery = parseInt(capacity.trim());
        } catch {
            try {
                const capacity = await fs.readFile("/sys/class/power_supply/BAT1/capacity", "utf-8");
                result.battery = parseInt(capacity.trim());
            } catch {
                // No battery or different path
            }
        }

        // WiFi: nmcli or iwgetid
        try {
            const { stdout } = await execFileAsync("nmcli", ["-t", "-f", "active,ssid", "dev", "wifi"], {
                timeout: 3000,
            });
            const activeLine = stdout.split("\n").find((l) => l.startsWith("yes:"));
            if (activeLine) {
                result.wifi = activeLine.split(":")[1] || "disconnected";
            } else {
                result.wifi = "disconnected";
            }
        } catch {
            try {
                const { stdout } = await execFileAsync("iwgetid", ["-r"], { timeout: 3000 });
                result.wifi = stdout.trim() || "disconnected";
            } catch {
                result.wifi = "unknown";
            }
        }

        // Volume: pactl or amixer
        try {
            const { stdout } = await execFileAsync("pactl", ["get-sink-volume", "@DEFAULT_SINK@"], { timeout: 3000 });
            const match = stdout.match(/(\d+)%/);
            if (match) result.volume = parseInt(match[1]);
        } catch {
            try {
                const { stdout } = await execFileAsync("amixer", ["get", "Master"], { timeout: 3000 });
                const match = stdout.match(/\[(\d+)%\]/);
                if (match) result.volume = parseInt(match[1]);
            } catch {
                /* default */
            }
        }

        return result;
    }

    return { battery: -1, wifi: "unknown", volume: 50 };
}

// ── Screen Resolution (convenience re-export) ───

/**
 * Get the primary screen resolution.
 */
export async function getScreenRes(): Promise<{ width: number; height: number }> {
    return getScreenResolution();
}

// ── Notification ────────────────────────────────

/**
 * Show a system notification.
 * macOS: osascript display notification
 * Windows: PowerShell BurntToast or basic balloon
 * Linux: notify-send
 */
export async function showNotification(title: string, body: string): Promise<void> {
    if (IS_MAC) {
        await execFileAsync(
            "osascript",
            [
                "-e",
                `display notification "${body.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" with title "${title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
            ],
            { timeout: 3000 },
        );
        return;
    }

    if (IS_WIN) {
        const escaped_title = title.replace(/'/g, "''");
        const escaped_body = body.replace(/'/g, "''");
        await runPowerShellInline(
            `
Add-Type -AssemblyName System.Windows.Forms
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.Visible = $true
$n.ShowBalloonTip(5000, '${escaped_title}', '${escaped_body}', [System.Windows.Forms.ToolTipIcon]::Info)
Start-Sleep -Seconds 1
$n.Dispose()
        `.trim(),
            10000,
        );
        return;
    }

    // Linux
    if (IS_LINUX) {
        try {
            await execFileAsync("notify-send", [title, body], { timeout: 3000 });
        } catch {
            // notify-send not available; silently fail
        }
    }
}

// ── Lock Screen ─────────────────────────────────

/**
 * Lock the screen / start the screensaver.
 */
export async function lockScreen(): Promise<void> {
    if (IS_MAC) {
        await execFileAsync(
            "osascript",
            ["-e", 'tell application "System Events" to keystroke "q" using {command down, control down}'],
            { timeout: 3000 },
        );
        return;
    }

    if (IS_WIN) {
        await runPowerShellInline("rundll32.exe user32.dll,LockWorkStation", 3000);
        return;
    }

    // Linux: try several methods
    if (IS_LINUX) {
        const commands = [
            ["loginctl", ["lock-session"]],
            ["xdg-screensaver", ["lock"]],
            ["gnome-screensaver-command", ["-l"]],
            ["xscreensaver-command", ["-lock"]],
        ] as const;

        for (const [cmd, args] of commands) {
            try {
                await execFileAsync(cmd, [...args], { timeout: 3000 });
                return;
            } catch {}
        }
    }
}
