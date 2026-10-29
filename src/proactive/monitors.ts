// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Proactive Monitors ────────────────────────
// Lightweight, token-free OS monitors that fire events when specific conditions are met.
// Each monitor uses cheap OS queries (no LLM calls).
// The heartbeat integrates these and ONLY invokes the LLM when something fires.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IS_MAC, IS_WIN } from "../tools/platform.js";

const execFileAsync = promisify(execFile);

// ═══════════════════════════════════════════════
// 1. BATTERY MONITOR
// ═══════════════════════════════════════════════

interface BatteryState {
    percent: number;
    isCharging: boolean;
    minutesRemaining: number;
}

let lastBatteryAlert = 0; // Timestamp of last battery alert
const BATTERY_ALERT_COOLDOWN = 30 * 60 * 1000; // 30 minutes between alerts

export async function checkBattery(): Promise<{ alert: string | null; state: BatteryState }> {
    try {
        let isCharging = true;
        let percent = 100;
        let minutesRemaining = -1;

        if (IS_MAC) {
            const { stdout } = await execFileAsync("pmset", ["-g", "batt"], { timeout: 3000 });
            // Parse: "Now drawing from 'Battery Power'" / "'AC Power'"
            isCharging = stdout.includes("AC Power") || stdout.includes("charging");
            const percentMatch = stdout.match(/(\d+)%/);
            percent = percentMatch ? parseInt(percentMatch[1]) : 100;
            const timeMatch = stdout.match(/(\d+):(\d+) remaining/);
            minutesRemaining = timeMatch ? parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2]) : -1;
        } else if (IS_WIN) {
            try {
                const { stdout } = await execFileAsync("powershell.exe", [
                    "-NoProfile", "-Command",
                    "Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json",
                ], { timeout: 5000 });
                const data = JSON.parse(stdout.trim() || "{}");
                percent = data.EstimatedChargeRemaining ?? 100;
                // BatteryStatus: 1=discharging, 2=AC power, 3+ = charging variants
                isCharging = (data.BatteryStatus ?? 2) !== 1;
            } catch {
                // No battery or WMI unavailable — assume desktop on AC
                return { alert: null, state: { percent: 100, isCharging: true, minutesRemaining: -1 } };
            }
        } else {
            // Linux or unsupported — skip battery monitoring
            return { alert: null, state: { percent: 100, isCharging: true, minutesRemaining: -1 } };
        }

        const state: BatteryState = { percent, isCharging, minutesRemaining };

        // Only alert if not charging and below thresholds
        if (!isCharging && Date.now() - lastBatteryAlert > BATTERY_ALERT_COOLDOWN) {
            if (percent <= 10) {
                lastBatteryAlert = Date.now();
                return { alert: `battery_critical:${percent}`, state };
            }
            if (percent <= 20) {
                lastBatteryAlert = Date.now();
                return { alert: `battery_low:${percent}`, state };
            }
        }

        return { alert: null, state };
    } catch {
        return { alert: null, state: { percent: 100, isCharging: true, minutesRemaining: -1 } };
    }
}

// ═══════════════════════════════════════════════
// 2. CALENDAR MONITOR (Apple Calendar via osascript)
// ═══════════════════════════════════════════════

interface CalendarEvent {
    title: string;
    startTime: string;
    endTime: string;
    location: string;
    notes: string;
    minutesUntil: number;
}

let lastCalendarAlert: Record<string, number> = {}; // event title → last alert timestamp

export async function checkUpcomingEvents(): Promise<{ alert: CalendarEvent | null; events: CalendarEvent[] }> {
    // Calendar integration via osascript is macOS only.
    // Windows has no easy scriptable calendar API — return empty.
    if (!IS_MAC) {
        return { alert: null, events: [] };
    }

    try {
        // Get events in the next 30 minutes using JXA
        const script = `
const app = Application("Calendar");
const now = new Date();
const soon = new Date(now.getTime() + 30 * 60 * 1000);
const results = [];

try {
    const calendars = app.calendars();
    for (const cal of calendars) {
        try {
            const events = cal.events.whose({
                _and: [
                    { startDate: { _greaterThan: now } },
                    { startDate: { _lessThan: soon } }
                ]
            })();
            for (const ev of events) {
                results.push({
                    title: ev.summary(),
                    startTime: ev.startDate().toISOString(),
                    endTime: ev.endDate().toISOString(),
                    location: ev.location() || "",
                    notes: (ev.description() || "").substring(0, 100),
                });
            }
        } catch(e) { /* skip calendar */ }
    }
} catch(e) { /* Calendar not accessible */ }

JSON.stringify(results);`;

        const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script], { timeout: 10000 });
        const rawEvents: Array<{ title: string; startTime: string; endTime: string; location: string; notes: string }> = JSON.parse(stdout.trim() || "[]");

        const now = Date.now();
        const events: CalendarEvent[] = rawEvents.map(ev => ({
            ...ev,
            minutesUntil: Math.round((new Date(ev.startTime).getTime() - now) / 60000),
        }));

        // Find first event within 15 minutes that we haven't alerted about
        const upcoming = events.find(ev => {
            if (ev.minutesUntil > 15 || ev.minutesUntil < 0) return false;
            const lastAlert = lastCalendarAlert[ev.title] || 0;
            // Don't re-alert within 20 minutes for same event
            if (now - lastAlert < 20 * 60 * 1000) return false;
            return true;
        });

        if (upcoming) {
            lastCalendarAlert[upcoming.title] = now;
            // Clean up old entries
            for (const [title, ts] of Object.entries(lastCalendarAlert)) {
                if (now - ts > 60 * 60 * 1000) delete lastCalendarAlert[title];
            }
            return { alert: upcoming, events };
        }

        return { alert: null, events };
    } catch {
        return { alert: null, events: [] };
    }
}

// ═══════════════════════════════════════════════
// 3. DISK SPACE MONITOR
// ═══════════════════════════════════════════════

let lastDiskAlert = 0;
const DISK_ALERT_COOLDOWN = 6 * 60 * 60 * 1000; // 6 hours

export async function checkDiskSpace(): Promise<{ alert: string | null; freeGB: number }> {
    try {
        let freeGB = -1;

        if (IS_MAC) {
            const { stdout } = await execFileAsync("df", ["-g", "/"], { timeout: 3000 });
            const lines = stdout.trim().split("\n");
            if (lines.length < 2) return { alert: null, freeGB: -1 };
            const parts = lines[1].split(/\s+/);
            freeGB = parseInt(parts[3] || "0");
        } else if (IS_WIN) {
            try {
                const { stdout } = await execFileAsync("powershell.exe", [
                    "-NoProfile", "-Command",
                    `[math]::Round((Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" | Select-Object -ExpandProperty FreeSpace) / 1GB, 1)`,
                ], { timeout: 5000 });
                freeGB = parseFloat(stdout.trim()) || -1;
            } catch {
                return { alert: null, freeGB: -1 };
            }
        } else {
            // Linux: df -BG /
            const { stdout } = await execFileAsync("df", ["-BG", "/"], { timeout: 3000 });
            const lines = stdout.trim().split("\n");
            if (lines.length < 2) return { alert: null, freeGB: -1 };
            const parts = lines[1].split(/\s+/);
            freeGB = parseInt(parts[3] || "0");
        }

        if (freeGB >= 0 && freeGB < 10 && Date.now() - lastDiskAlert > DISK_ALERT_COOLDOWN) {
            lastDiskAlert = Date.now();
            return { alert: `disk_low:${freeGB}`, freeGB };
        }

        return { alert: null, freeGB };
    } catch {
        return { alert: null, freeGB: -1 };
    }
}

// ═══════════════════════════════════════════════
// 4. APP CHANGE DETECTOR
// ═══════════════════════════════════════════════

let lastFrontmostApp = "";

export function detectAppChange(currentApp: string): { changed: boolean; from: string; to: string } {
    const prev = lastFrontmostApp;
    lastFrontmostApp = currentApp;

    if (!prev || prev === currentApp) {
        return { changed: false, from: prev, to: currentApp };
    }

    return { changed: true, from: prev, to: currentApp };
}

// ═══════════════════════════════════════════════
// 5. CLIPBOARD URL DETECTOR
// ═══════════════════════════════════════════════

let lastClipboard = "";
let lastClipboardCheck = 0;
const CLIPBOARD_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

export async function checkClipboardForUrl(): Promise<{ url: string | null }> {
    const now = Date.now();
    if (now - lastClipboardCheck < CLIPBOARD_CHECK_INTERVAL) return { url: null };
    lastClipboardCheck = now;

    try {
        let text = "";
        if (IS_MAC) {
            const { stdout } = await execFileAsync("pbpaste", [], { timeout: 2000 });
            text = stdout.trim();
        } else if (IS_WIN) {
            try {
                const { stdout } = await execFileAsync("powershell.exe", [
                    "-NoProfile", "-Command", "Get-Clipboard",
                ], { timeout: 3000 });
                text = stdout.trim();
            } catch {
                return { url: null };
            }
        } else {
            // Linux: try xclip or xsel
            try {
                const { stdout } = await execFileAsync("xclip", ["-selection", "clipboard", "-o"], { timeout: 2000 });
                text = stdout.trim();
            } catch {
                return { url: null };
            }
        }

        if (text === lastClipboard) return { url: null };
        lastClipboard = text;

        // Check if it looks like a URL
        if (/^https?:\/\/\S+/.test(text) && text.length > 10 && text.length < 500) {
            return { url: text };
        }

        return { url: null };
    } catch {
        return { url: null };
    }
}

// ═══════════════════════════════════════════════
// COMBINED: Run all lightweight monitors
// ═══════════════════════════════════════════════

export interface MonitorResults {
    batteryAlert: string | null;
    calendarAlert: CalendarEvent | null;
    diskAlert: string | null;
    appChanged: { from: string; to: string } | null;
    clipboardUrl: string | null;
}

/**
 * Run all monitors in parallel. Total cost: ~50ms, 0 LLM tokens.
 * Only call the LLM if at least one alert fires.
 */
export async function runAllMonitors(frontmostApp: string): Promise<MonitorResults> {
    const [battery, calendar, disk, clipboard] = await Promise.all([
        checkBattery(),
        checkUpcomingEvents(),
        checkDiskSpace(),
        checkClipboardForUrl(),
    ]);

    const appChange = detectAppChange(frontmostApp);

    return {
        batteryAlert: battery.alert,
        calendarAlert: calendar.alert,
        diskAlert: disk.alert,
        appChanged: appChange.changed ? { from: appChange.from, to: appChange.to } : null,
        clipboardUrl: clipboard.url,
    };
}

/**
 * Build a proactive message from monitor results WITHOUT using LLM.
 * Returns null if no alerts fired.
 */
export function buildAlertMessage(results: MonitorResults): string | null {
    const parts: string[] = [];

    // Battery alerts (direct message, no LLM needed)
    if (results.batteryAlert) {
        const percent = results.batteryAlert.split(":")[1];
        if (results.batteryAlert.startsWith("battery_critical")) {
            parts.push(`🔋 hey your battery's at ${percent}% — might wanna plug in soon before it dies`);
        } else {
            parts.push(`🔋 heads up — battery's down to ${percent}%. might wanna find a charger`);
        }
    }

    // Calendar alerts (direct message)
    if (results.calendarAlert) {
        const ev = results.calendarAlert;
        const mins = ev.minutesUntil;
        let msg = `📅 "${ev.title}" starts in ${mins} min`;
        if (ev.location) msg += ` (${ev.location})`;
        parts.push(msg);
    }

    // Disk alerts
    if (results.diskAlert) {
        const gb = results.diskAlert.split(":")[1];
        parts.push(`💾 disk space is getting low — only ${gb}GB free. want me to check what's using space?`);
    }

    if (parts.length === 0) return null;
    return parts.join("\n\n");
}
