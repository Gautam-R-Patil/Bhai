// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Cross-Platform Abstraction Layer ──────────
// Central module for platform detection and shared utilities.
// macOS → osascript, screencapture, CoreGraphics
// Windows → powershell.exe, user32.dll, Windows.Media.Ocr

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { withCursorHidden } from "../screen/agent-cursor.js";

const execFileAsync = promisify(execFile);

// ── Platform Constants ────────────────────────

export const IS_MAC = process.platform === "darwin";
export const IS_WIN = process.platform === "win32";
export const IS_LINUX = process.platform === "linux";

// ── PowerShell Automation Helpers ─────────────

const PS_HELPERS = `
if (-not $env:ATLAS_PS_HELPERS_LOADED) {
    $env:ATLAS_PS_HELPERS_LOADED = "1"
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue

    $atlasWin32Code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class AtlasWin32 {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@
    if (-not ([System.Management.Automation.PSTypeName]'AtlasWin32').Type) {
        Add-Type -TypeDefinition $atlasWin32Code -ErrorAction SilentlyContinue
    }

    function Atlas-FocusApp([string]$Name) {
        $p = Get-Process $Name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
            [AtlasWin32]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
            [AtlasWin32]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
        }
    }
    function Atlas-GetFrontApp() {
        $hwnd = [AtlasWin32]::GetForegroundWindow()
        $sb = New-Object System.Text.StringBuilder 256
        [AtlasWin32]::GetWindowText($hwnd, $sb, 256) | Out-Null
        $sb.ToString()
    }
    function Atlas-SetDoNotDisturb([bool]$Enable) {
        $path = "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings"
        $val = if ($Enable) { 0 } else { 1 }
        Set-ItemProperty -Path $path -Name "NOC_GLOBAL_SETTING_TOASTS_ENABLED" -Value $val -Force -ErrorAction SilentlyContinue
    }
    function Atlas-GetRunningApps() {
        Get-Process | Where-Object { $_.MainWindowTitle -ne "" } |
            Select-Object ProcessName, Id, MainWindowTitle | ConvertTo-Json -Compress
    }
    function Atlas-LaunchApp([string]$App) { Start-Process $App }
    function Atlas-CloseApp([string]$Name) {
        Get-Process $Name -ErrorAction SilentlyContinue | Stop-Process -Force
    }
}`.trim();

// ── PowerShell Helper (Windows) ───────────────

/**
 * Execute a PowerShell script string on Windows.
 * Equivalent to runAppleScript on macOS.
 */
export async function runPowerShell(script: string, timeout = 10000): Promise<string> {
    if (!IS_WIN) throw new Error("runPowerShell is only available on Windows.");

    const tmpFile = join(tmpdir(), `atlas_ps_${Date.now()}.ps1`);
    try {
        await fs.writeFile(tmpFile, `${PS_HELPERS}\n${script}`, "utf-8");
        const { stdout } = await execFileAsync(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", tmpFile],
            { timeout },
        );
        await fs.unlink(tmpFile).catch(() => {});
        return stdout.trim();
    } catch (err) {
        await fs.unlink(tmpFile).catch(() => {});
        throw err;
    }
}

/**
 * Execute an inline PowerShell command (no temp file).
 */
export async function runPowerShellInline(command: string, timeout = 10000): Promise<string> {
    if (!IS_WIN) throw new Error("runPowerShellInline is only available on Windows.");

    const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
        { timeout },
    );
    return stdout.trim();
}

// ── Cross-Platform Screenshot ─────────────────

/**
 * Capture a screenshot to the given output path.
 * macOS: uses screencapture
 * Windows: uses PowerShell + System.Drawing
 */
export function captureScreenshot(outputPath: string): Promise<void> {
    return withCursorHidden(() => captureScreen(outputPath));
}

async function captureScreen(outputPath: string): Promise<void> {
    if (IS_MAC) {
        await execFileAsync("screencapture", ["-x", outputPath], { timeout: 10000 });
    } else if (IS_WIN) {
        try {
            // Fast path: screenshot-desktop (no PowerShell spawn)
            const { default: screenshot } = await import("screenshot-desktop");
            const imgBuffer = await screenshot();
            await fs.writeFile(outputPath, imgBuffer);
        } catch {
            // Fallback: PowerShell + System.Drawing
            const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screens = [System.Windows.Forms.Screen]::AllScreens
$bounds = [System.Drawing.Rectangle]::Empty
foreach ($s in $screens) { $bounds = [System.Drawing.Rectangle]::Union($bounds, $s.Bounds) }
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$g.Dispose()
$bmp.Save("${outputPath.replace(/\\/g, "\\\\")}")
$bmp.Dispose()
`;
            await runPowerShell(psScript, 15000);
        }
    } else {
        // Linux: try grim (Wayland-native), then scrot, then gnome-screenshot, then screenshot-desktop
        const wayland = process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland";
        if (wayland) {
            try {
                await execFileAsync("grim", [outputPath], { timeout: 10000 });
                return;
            } catch {
                /* fall through */
            }
        }
        try {
            await execFileAsync("scrot", [outputPath], { timeout: 10000 });
            return;
        } catch {
            /* fall through */
        }
        try {
            await execFileAsync("gnome-screenshot", ["-f", outputPath], { timeout: 10000 });
            return;
        } catch {
            /* fall through */
        }
        // Last resort: screenshot-desktop npm package
        try {
            const { default: screenshot } = await import("screenshot-desktop");
            const imgBuffer = await screenshot();
            await fs.writeFile(outputPath, imgBuffer);
        } catch {
            throw new Error("No screenshot tool available on Linux. Install grim (Wayland) or scrot (X11).");
        }
    }
}

// ── Cross-Platform Screen Resolution ──────────

/**
 * Get the primary screen's logical resolution.
 */
export async function getScreenResolution(): Promise<{ width: number; height: number }> {
    if (IS_MAC) {
        try {
            const { stdout } = await execFileAsync(
                "osascript",
                [
                    "-l",
                    "JavaScript",
                    "-e",
                    'ObjC.import("AppKit"); var f = $.NSScreen.mainScreen.frame; `${f.size.width},${f.size.height}`',
                ],
                { timeout: 3000 },
            );
            const [w, h] = stdout.trim().split(",").map(Number);
            if (w > 0 && h > 0) return { width: w, height: h };
        } catch {
            /* fallback */
        }
        return { width: 1440, height: 900 };
    } else if (IS_WIN) {
        try {
            const result = await runPowerShellInline(
                `$s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; "$($s.Width),$($s.Height)"`,
                3000,
            );
            const [w, h] = result.trim().split(",").map(Number);
            if (w > 0 && h > 0) return { width: w, height: h };
        } catch {
            /* fallback */
        }
        return { width: 1920, height: 1080 };
    }
    // Linux
    if (IS_LINUX) {
        try {
            // Try xdpyinfo first (X11)
            const { stdout } = await execFileAsync("xdpyinfo", [], { timeout: 3000 });
            const match = stdout.match(/dimensions:\s+(\d+)x(\d+)/);
            if (match) {
                const w = parseInt(match[1]);
                const h = parseInt(match[2]);
                if (w > 0 && h > 0) return { width: w, height: h };
            }
        } catch {
            /* not X11 or xdpyinfo not available */
        }

        try {
            // Wayland / fallback: try xrandr
            const { stdout } = await execFileAsync("xrandr", ["--current"], { timeout: 3000 });
            const match = stdout.match(/current\s+(\d+)\s*x\s*(\d+)/);
            if (match) {
                const w = parseInt(match[1]);
                const h = parseInt(match[2]);
                if (w > 0 && h > 0) return { width: w, height: h };
            }
        } catch {
            /* fallback */
        }

        try {
            // Wayland: try wlr-randr or swaymsg
            const { stdout } = await execFileAsync(
                "bash",
                [
                    "-c",
                    `swaymsg -t get_outputs 2>/dev/null | grep -o '"current_mode":{[^}]*}' | head -1 | grep -o '"width":[0-9]*,"height":[0-9]*'`,
                ],
                { timeout: 3000 },
            );
            const wMatch = stdout.match(/"width":(\d+)/);
            const hMatch = stdout.match(/"height":(\d+)/);
            if (wMatch && hMatch) {
                const w = parseInt(wMatch[1]);
                const h = parseInt(hMatch[1]);
                if (w > 0 && h > 0) return { width: w, height: h };
            }
        } catch {
            /* fallback */
        }
    }

    return { width: 1920, height: 1080 };
}

// ── Cross-Platform Frontmost App ──────────────

/**
 * Get the name of the currently focused application.
 */
export async function getFrontmostApp(): Promise<string> {
    if (IS_MAC) {
        try {
            const { stdout } = await execFileAsync(
                "osascript",
                ["-e", 'tell application "System Events" to get name of first process whose frontmost is true'],
                { timeout: 2000 },
            );
            return stdout.trim();
        } catch {
            return "unknown";
        }
    } else if (IS_WIN) {
        try {
            const result = await runPowerShell(`Atlas-GetFrontApp`);
            return result.trim() || "unknown";
        } catch {
            return "unknown";
        }
    }

    // Linux
    if (IS_LINUX) {
        try {
            const { stdout } = await execFileAsync("xdotool", ["getactivewindow", "getwindowname"], { timeout: 2000 });
            return stdout.trim() || "unknown";
        } catch {
            // Wayland fallback
            try {
                const { stdout } = await execFileAsync(
                    "bash",
                    [
                        "-c",
                        `swaymsg -t get_tree 2>/dev/null | grep -o '"focused":true' -A 5 | grep -o '"name":"[^"]*"' | head -1 | sed 's/"name":"\\(.*\\)"/\\1/'`,
                    ],
                    { timeout: 2000 },
                );
                return stdout.trim() || "unknown";
            } catch {
                return "unknown";
            }
        }
    }

    return "unknown";
}

// ── Cross-Platform "Open" ─────────────────────

/**
 * Maps common human-readable app names to their Windows executable names.
 * `cmd /c start` resolves short exe names via PATH; full paths must be quoted separately.
 */
const WIN_APP_MAP: Record<string, string> = {
    chrome: "chrome",
    "google chrome": "chrome",
    firefox: "firefox",
    "mozilla firefox": "firefox",
    edge: "msedge",
    "microsoft edge": "msedge",
    msedge: "msedge",
    brave: "brave",
    "brave browser": "brave",
    spotify: "spotify",
    notepad: "notepad",
    "notepad++": "notepad++",
    explorer: "explorer",
    "file explorer": "explorer",
    calculator: "calc",
    calc: "calc",
    paint: "mspaint",
    word: "winword",
    excel: "excel",
    powerpoint: "powerpnt",
    outlook: "outlook",
    teams: "teams",
    discord: "discord",
    slack: "slack",
    code: "code",
    vscode: "code",
    "visual studio code": "code",
};

/** A PowerShell single-quoted literal: nothing inside expands; ' (and its smart-quote forms) doubles. */
export function psQuote(s: string): string {
    return `'${s.replace(/['\u2018\u2019\u201A\u201B]/g, "''")}'`;
}

/**
 * Open a file, URL, or app using the system's default handler.
 * macOS: open
 * Windows: start / Start-Process
 */
export async function nativeOpen(target: string, app?: string): Promise<void> {
    if (IS_MAC) {
        const args = app ? ["-a", app, target] : [target];
        await execFileAsync("open", args, { timeout: 5000 });
    } else if (IS_WIN) {
        const normalised = app ? (WIN_APP_MAP[app.toLowerCase()] ?? app) : undefined;
        // cmd parses & | < > ^ % " in its arguments: a URL's "?a=1&b=2" would be cut at
        // the & and the rest run as another command. Those go through Start-Process.
        if (/[&|<>^%"]/.test(target + (normalised ?? ""))) {
            await runPowerShellInline(
                normalised
                    ? `Start-Process -FilePath ${psQuote(normalised)} -ArgumentList ${psQuote(`"${target}"`)}`
                    : `Start-Process -FilePath ${psQuote(target)}`,
                5000,
            );
            return;
        }
        if (normalised) {
            // `cmd /c start "" <app> <target>` — the empty-string first arg is the window title
            // (required when app contains spaces, to distinguish it from the title arg)
            await execFileAsync("cmd.exe", ["/c", "start", "", normalised, target], { timeout: 5000 });
        } else {
            await execFileAsync("cmd.exe", ["/c", "start", "", target], { timeout: 5000 });
        }
    } else {
        await execFileAsync("xdg-open", [target], { timeout: 5000 });
    }
}

// ── Cross-Platform Clipboard ──────────────────

export async function clipboardRead(): Promise<string> {
    if (IS_MAC) {
        const { stdout } = await execFileAsync("pbpaste", [], { timeout: 3000 });
        return stdout;
    } else if (IS_WIN) {
        try {
            const { default: clipboardy } = await import("clipboardy");
            return await clipboardy.read();
        } catch {
            return await runPowerShellInline("Get-Clipboard", 3000);
        }
    }
    // Linux — try multiple tools in order
    const wayland = process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland";
    if (wayland) {
        try {
            const { stdout } = await execFileAsync("wl-paste", ["--no-newline"], { timeout: 3000 });
            return stdout;
        } catch {
            /* fall through */
        }
    }
    try {
        const { stdout } = await execFileAsync("xclip", ["-selection", "clipboard", "-o"], { timeout: 3000 });
        return stdout;
    } catch {
        /* fall through */
    }
    try {
        const { stdout } = await execFileAsync("xsel", ["--clipboard", "--output"], { timeout: 3000 });
        return stdout;
    } catch {
        /* fall through */
    }
    return "";
}

export async function clipboardWrite(text: string): Promise<void> {
    if (IS_MAC) {
        const tmpFile = join(tmpdir(), `atlas_clip_${Date.now()}.txt`);
        await fs.writeFile(tmpFile, text, "utf-8");
        await execFileAsync("bash", ["-c", `cat "${tmpFile}" | pbcopy`], { timeout: 3000 });
        await fs.unlink(tmpFile).catch(() => {});
    } else if (IS_WIN) {
        try {
            const { default: clipboardy } = await import("clipboardy");
            await clipboardy.write(text);
        } catch {
            await runPowerShellInline(`Set-Clipboard -Value ${psQuote(text)}`, 3000);
        }
    } else {
        // Linux — try multiple tools in order
        const wayland = process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland";
        const tmpFile = join(tmpdir(), `atlas_clip_${Date.now()}.txt`);
        await fs.writeFile(tmpFile, text, "utf-8");
        let written = false;
        if (wayland) {
            try {
                await execFileAsync("bash", ["-c", `cat "${tmpFile}" | wl-copy`], { timeout: 3000 });
                written = true;
            } catch {
                /* fall through */
            }
        }
        if (!written) {
            try {
                await execFileAsync("bash", ["-c", `cat "${tmpFile}" | xclip -selection clipboard`], { timeout: 3000 });
                written = true;
            } catch {
                /* fall through */
            }
        }
        if (!written) {
            try {
                await execFileAsync("bash", ["-c", `cat "${tmpFile}" | xsel --clipboard --input`], { timeout: 3000 });
            } catch {
                /* fall through */
            }
        }
        await fs.unlink(tmpFile).catch(() => {});
    }
}
