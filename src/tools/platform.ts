// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Cross-Platform Abstraction Layer ──────────
// Central module for platform detection and shared utilities.
// macOS → osascript, screencapture, CoreGraphics
// Windows → powershell.exe, user32.dll, Windows.Media.Ocr

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

// ── Platform Constants ────────────────────────

export const IS_MAC = process.platform === "darwin";
export const IS_WIN = process.platform === "win32";
export const IS_LINUX = process.platform === "linux";

// ── PowerShell Helper (Windows) ───────────────

/**
 * Execute a PowerShell script string on Windows.
 * Equivalent to runAppleScript on macOS.
 */
export async function runPowerShell(script: string, timeout = 10000): Promise<string> {
    if (!IS_WIN) throw new Error("runPowerShell is only available on Windows.");

    const tmpFile = join(tmpdir(), `atlas_ps_${Date.now()}.ps1`);
    try {
        await fs.writeFile(tmpFile, script, "utf-8");
        const { stdout } = await execFileAsync("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy", "Bypass",
            "-File", tmpFile,
        ], { timeout });
        await fs.unlink(tmpFile).catch(() => { });
        return stdout.trim();
    } catch (err) {
        await fs.unlink(tmpFile).catch(() => { });
        throw err;
    }
}

/**
 * Execute an inline PowerShell command (no temp file).
 */
export async function runPowerShellInline(command: string, timeout = 10000): Promise<string> {
    if (!IS_WIN) throw new Error("runPowerShellInline is only available on Windows.");

    const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-Command", command,
    ], { timeout });
    return stdout.trim();
}

// ── Cross-Platform Screenshot ─────────────────

/**
 * Capture a screenshot to the given output path.
 * macOS: uses screencapture
 * Windows: uses PowerShell + System.Drawing
 */
export async function captureScreenshot(outputPath: string): Promise<void> {
    if (IS_MAC) {
        await execFileAsync("screencapture", ["-x", outputPath], { timeout: 10000 });
    } else if (IS_WIN) {
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
    } else {
        // Linux fallback: try scrot or gnome-screenshot
        try {
            await execFileAsync("scrot", [outputPath], { timeout: 10000 });
        } catch {
            await execFileAsync("gnome-screenshot", ["-f", outputPath], { timeout: 10000 });
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
            const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e",
                'ObjC.import("AppKit"); var f = $.NSScreen.mainScreen.frame; `${f.size.width},${f.size.height}`'
            ], { timeout: 3000 });
            const [w, h] = stdout.trim().split(",").map(Number);
            if (w > 0 && h > 0) return { width: w, height: h };
        } catch { /* fallback */ }
        return { width: 1440, height: 900 };
    } else if (IS_WIN) {
        try {
            const result = await runPowerShellInline(
                `$s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; "$($s.Width),$($s.Height)"`,
                3000
            );
            const [w, h] = result.trim().split(",").map(Number);
            if (w > 0 && h > 0) return { width: w, height: h };
        } catch { /* fallback */ }
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
        } catch { /* not X11 or xdpyinfo not available */ }

        try {
            // Wayland / fallback: try xrandr
            const { stdout } = await execFileAsync("xrandr", ["--current"], { timeout: 3000 });
            const match = stdout.match(/current\s+(\d+)\s*x\s*(\d+)/);
            if (match) {
                const w = parseInt(match[1]);
                const h = parseInt(match[2]);
                if (w > 0 && h > 0) return { width: w, height: h };
            }
        } catch { /* fallback */ }

        try {
            // Wayland: try wlr-randr or swaymsg
            const { stdout } = await execFileAsync("bash", ["-c",
                `swaymsg -t get_outputs 2>/dev/null | grep -o '"current_mode":{[^}]*}' | head -1 | grep -o '"width":[0-9]*,"height":[0-9]*'`
            ], { timeout: 3000 });
            const wMatch = stdout.match(/"width":(\d+)/);
            const hMatch = stdout.match(/"height":(\d+)/);
            if (wMatch && hMatch) {
                const w = parseInt(wMatch[1]);
                const h = parseInt(hMatch[1]);
                if (w > 0 && h > 0) return { width: w, height: h };
            }
        } catch { /* fallback */ }
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
            const { stdout } = await execFileAsync("osascript", ["-e",
                'tell application "System Events" to get name of first process whose frontmost is true'
            ], { timeout: 2000 });
            return stdout.trim();
        } catch { return "unknown"; }
    } else if (IS_WIN) {
        try {
            const result = await runPowerShellInline(
                `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class WinAPI { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId); }'; $hwnd = [WinAPI]::GetForegroundWindow(); $pid = 0; [WinAPI]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null; (Get-Process -Id $pid).ProcessName`,
                3000
            );
            return result.trim() || "unknown";
        } catch { return "unknown"; }
    }

    // Linux
    if (IS_LINUX) {
        try {
            const { stdout } = await execFileAsync("xdotool", [
                "getactivewindow", "getwindowname"
            ], { timeout: 2000 });
            return stdout.trim() || "unknown";
        } catch {
            // Wayland fallback
            try {
                const { stdout } = await execFileAsync("bash", ["-c",
                    `swaymsg -t get_tree 2>/dev/null | grep -o '"focused":true' -A 5 | grep -o '"name":"[^"]*"' | head -1 | sed 's/"name":"\\(.*\\)"/\\1/'`
                ], { timeout: 2000 });
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
 * Open a file, URL, or app using the system's default handler.
 * macOS: open
 * Windows: start / Start-Process
 */
export async function nativeOpen(target: string, app?: string): Promise<void> {
    if (IS_MAC) {
        const args = app ? ["-a", app, target] : [target];
        await execFileAsync("open", args, { timeout: 5000 });
    } else if (IS_WIN) {
        if (app) {
            await execFileAsync("cmd.exe", ["/c", "start", "", app, target], { timeout: 5000 });
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
        return await runPowerShellInline("Get-Clipboard", 3000);
    }
    // Linux
    const { stdout } = await execFileAsync("xclip", ["-selection", "clipboard", "-o"], { timeout: 3000 });
    return stdout;
}

export async function clipboardWrite(text: string): Promise<void> {
    if (IS_MAC) {
        const tmpFile = join(tmpdir(), `atlas_clip_${Date.now()}.txt`);
        await fs.writeFile(tmpFile, text, "utf-8");
        await execFileAsync("bash", ["-c", `cat "${tmpFile}" | pbcopy`], { timeout: 3000 });
        await fs.unlink(tmpFile).catch(() => { });
    } else if (IS_WIN) {
        const escaped = text.replace(/'/g, "''");
        await runPowerShellInline(`Set-Clipboard -Value '${escaped}'`, 3000);
    } else {
        const tmpFile = join(tmpdir(), `atlas_clip_${Date.now()}.txt`);
        await fs.writeFile(tmpFile, text, "utf-8");
        await execFileAsync("bash", ["-c", `cat "${tmpFile}" | xclip -selection clipboard`], { timeout: 3000 });
        await fs.unlink(tmpFile).catch(() => { });
    }
}
