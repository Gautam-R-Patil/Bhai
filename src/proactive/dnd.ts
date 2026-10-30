// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Smart Do-Not-Disturb ──────────────────────
// Detects macOS Focus mode and gates proactive messages.
// Important messages (reminders, calendar, critical battery) always bypass DND.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IS_MAC, IS_WIN } from "../tools/platform.js";

const execFileAsync = promisify(execFile);

// ── DND Detection ─────────────────────────────

export async function isDNDActive(): Promise<boolean> {
    if (IS_MAC) {
        try {
            // Check macOS Focus/DND mode via defaults
            const { stdout } = await execFileAsync("defaults", [
                "read", "com.apple.controlcenter", "NSStatusItem Visible FocusModes",
            ], { timeout: 3000 });
            // Returns "1" when Focus is active/visible
            if (stdout.trim() === "1") {
                // Double-check with the actual assertion state
                const { stdout: assertStdout } = await execFileAsync("osascript", [
                    "-e", 'do shell script "defaults -currentHost read ~/Library/Preferences/ByHost/com.apple.notificationcenterui doNotDisturb 2>/dev/null || echo 0"',
                ], { timeout: 3000 });
                return assertStdout.trim() === "1";
            }
            return false;
        } catch {
            // Alternative: check for active Focus assertions
            try {
                const { stdout } = await execFileAsync("plutil", [
                    "-extract", "dnd_prefs", "raw",
                    "-o", "-",
                    `${process.env.HOME}/Library/DoNotDisturb/DB/Assertions.json`,
                ], { timeout: 3000 });
                return stdout.trim().length > 10; // Has active assertions
            } catch {
                return false; // Assume not in DND if detection fails
            }
        }
    }

    if (IS_WIN) {
        // Windows Focus Assist detection is not reliably scriptable.
        // The registry key for Focus Assist state is a binary blob that changes across Windows versions.
        // Return false (assume not in DND) as a safe default.
        try {
            const { stdout } = await execFileAsync("powershell.exe", [
                "-NoProfile", "-Command",
                `(Get-ItemProperty -Path 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings' -Name 'NOC_GLOBAL_SETTING_TOASTS_ENABLED' -ErrorAction SilentlyContinue).NOC_GLOBAL_SETTING_TOASTS_ENABLED`,
            ], { timeout: 3000 });
            // 0 = toasts disabled (DND on), 1 = toasts enabled (DND off)
            return stdout.trim() === "0";
        } catch {
            return false;
        }
    }

    // Linux or unsupported — assume not in DND
    return false;
}

// ── Important Message Classification ──────────

const IMPORTANT_PATTERNS = [
    // Reminders & scheduled tasks
    /🔔/,
    /\breminder\b/i,
    /\btask triggered\b/i,
    /\bscheduled\b/i,
    // Calendar alerts
    /📅/,
    /\bmeeting\b/i,
    /\bcalendar\b/i,
    /\bevent\b/i,
    /\bstarts? in\b/i,
    // Battery critical
    /🔋/,
    /\bbattery\b.*\bcritical\b/i,
    /\bbattery\b.*[0-9]%/i,
    // Emergency / urgent
    /\burgent\b/i,
    /\bemergency\b/i,
    /⚠️.*critical/i,
    // A research the owner asked for: its answer, not a nudge
    /^📚 Research ready/,
];

export function isImportantMessage(message: string): boolean {
    return IMPORTANT_PATTERNS.some(p => p.test(message));
}

// ── Gate Check ────────────────────────────────

/**
 * Returns true if the message should be suppressed (DND on + not important).
 * Returns false if the message should be delivered.
 */
export async function shouldSuppressMessage(message: string): Promise<boolean> {
    // Important messages ALWAYS get through
    if (isImportantMessage(message)) return false;

    // Check DND status
    const dndActive = await isDNDActive();
    return dndActive;
}
