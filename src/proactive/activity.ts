// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Activity Detector ─────────────────────────
// Detects whether the user is actively using their laptop via macOS APIs.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IS_MAC, IS_WIN } from "../tools/platform.js";
import { globalBoundaryBus } from "./boundary-events.js";

const execFileAsync = promisify(execFile);

// ── Types ─────────────────────────────────────

export interface UserPresence {
    isActive: boolean;             // idle < 5 min
    idleMinutes: number;           // minutes since last input
    activeApps: string[];          // visible (non-background) apps
    frontmostApp: string;          // currently focused app
    isJustServerProcesses: boolean; // only Terminal/Finder/system = bot's own servers
    appTransitionHistory: string[];     // recent app transitions (latest first)
    activeAppDurationMinutes: Map<string, number>; // estimated time per app
}

// Apps that are always running and don't indicate real user activity
const SERVER_ONLY_APPS = new Set([
    "Terminal",
    "Finder",
    "Electron",           // Bhai UI or similar
    "loginwindow",
    "SystemUIServer",
    "Dock",
    "WindowManager",
    "Control Center",
    "Notification Center",
]);

// ── Idle Time ─────────────────────────────────

async function getUserIdleSeconds(): Promise<number> {
    if (IS_MAC) {
        try {
            const { stdout } = await execFileAsync("ioreg", [
                "-c", "IOHIDSystem",
            ], { timeout: 5000 });

            const match = stdout.match(/"HIDIdleTime"\s*=\s*(\d+)/);
            if (!match) return 0;

            // HIDIdleTime is in nanoseconds
            return Math.floor(Number(match[1]) / 1_000_000_000);
        } catch {
            return 0;
        }
    }

    if (IS_WIN) {
        try {
            // Query idle time via user32.dll GetLastInputInfo through PowerShell
            const { stdout } = await execFileAsync("powershell.exe", [
                "-NoProfile", "-Command",
                `Add-Type @'
using System;
using System.Runtime.InteropServices;
public class IdleTime {
    [StructLayout(LayoutKind.Sequential)]
    struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    public static int GetIdleSeconds() {
        LASTINPUTINFO lii = new LASTINPUTINFO();
        lii.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        if (!GetLastInputInfo(ref lii)) return 0;
        return (int)((Environment.TickCount - lii.dwTime) / 1000);
    }
}
'@
[IdleTime]::GetIdleSeconds()`,
            ], { timeout: 5000 });
            const seconds = parseInt(stdout.trim());
            return isNaN(seconds) ? 0 : seconds;
        } catch {
            return 0;
        }
    }

    // Unsupported platform — assume active
    return 0;
}

/** The owner touched the keyboard or mouse in the last 5 minutes (getUserPresence's isActive). */
export async function isUserActive(): Promise<boolean> {
    return (await getUserIdleSeconds()) < 5 * 60;
}

// ── Active Apps ───────────────────────────────

async function getActiveApps(): Promise<{ apps: string[]; frontmost: string }> {
    if (IS_MAC) {
        try {
            const [appsResult, frontmostResult] = await Promise.all([
                execFileAsync("osascript", [
                    "-e",
                    'tell application "System Events" to get name of every process whose background only is false',
                ], { timeout: 5000 }),
                execFileAsync("osascript", [
                    "-e",
                    'tell application "System Events" to get name of first process whose frontmost is true',
                ], { timeout: 5000 }),
            ]);

            const apps = appsResult.stdout.trim().split(", ").filter(Boolean);
            const frontmost = frontmostResult.stdout.trim();
            return { apps, frontmost };
        } catch {
            return { apps: [], frontmost: "unknown" };
        }
    }

    if (IS_WIN) {
        try {
            const { stdout } = await execFileAsync("powershell.exe", [
                "-NoProfile", "-Command",
                `Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -First 10 ProcessName, MainWindowTitle | ConvertTo-Json -Compress`,
            ], { timeout: 5000 });
            const raw = JSON.parse(stdout.trim() || "[]");
            const procs = Array.isArray(raw) ? raw : [raw];
            const apps = procs.map((p: { ProcessName: string }) => p.ProcessName).filter(Boolean);
            const frontmost = apps[0] || "unknown";
            return { apps, frontmost };
        } catch {
            return { apps: [], frontmost: "unknown" };
        }
    }

    return { apps: [], frontmost: "unknown" };
}

// ── App Transition Tracking ──────────────────

let lastFrontmostApp = "";
let lastAppChangeTime = Date.now();
const appTransitions: string[] = []; // "From → To" history
const appDurations = new Map<string, number>(); // app → cumulative minutes
const MAX_TRANSITION_HISTORY = 20;
let lastIsActive: boolean | null = null;

/**
 * Get the last app transition (if any occurred since the previous check).
 * Returns { from, to } or null.
 */
export function getLastAppTransition(): { from: string; to: string } | null {
    if (appTransitions.length === 0) return null;
    const last = appTransitions[appTransitions.length - 1];
    const [from, to] = last.split(" → ");
    return from && to ? { from, to } : null;
}

// ── Main: Get User Presence ───────────────────

export async function getUserPresence(): Promise<UserPresence> {
    const [idleSeconds, { apps, frontmost }] = await Promise.all([
        getUserIdleSeconds(),
        getActiveApps(),
    ]);

    const idleMinutes = Math.floor(idleSeconds / 60);
    const isActive = idleMinutes < 5;

    // Check if only server/system processes are running
    const userApps = apps.filter(app => !SERVER_ONLY_APPS.has(app));
    const isJustServerProcesses = userApps.length === 0;

    // Track app transitions
    if (frontmost && frontmost !== lastFrontmostApp && lastFrontmostApp) {
        const now = Date.now();
        const durationMinutes = (now - lastAppChangeTime) / 60_000;

        appTransitions.push(`${lastFrontmostApp} → ${frontmost}`);
        while (appTransitions.length > MAX_TRANSITION_HISTORY) appTransitions.shift();
        globalBoundaryBus.emit({
            kind: "app_switch",
            ts: Date.now(),
            meta: { from: lastFrontmostApp, to: frontmost },
        });

        // Accumulate duration for the previous app
        appDurations.set(
            lastFrontmostApp,
            (appDurations.get(lastFrontmostApp) || 0) + durationMinutes
        );

        lastAppChangeTime = now;
    }
    if (frontmost) lastFrontmostApp = frontmost;

    // Fire idle transitions on the bus. First call establishes baseline.
    if (lastIsActive !== null) {
        if (lastIsActive && !isActive) {
            globalBoundaryBus.emit({ kind: "idle_start", ts: Date.now() });
        } else if (!lastIsActive && isActive) {
            globalBoundaryBus.emit({ kind: "idle_end", ts: Date.now() });
        }
    }
    lastIsActive = isActive;

    return {
        isActive,
        idleMinutes,
        activeApps: userApps,
        frontmostApp: frontmost,
        isJustServerProcesses,
        appTransitionHistory: [...appTransitions].reverse(),
        activeAppDurationMinutes: new Map(appDurations),
    };
}

// ── Human-readable summary for LLM ───────────

export function describePresence(p: UserPresence): string {
    const parts: string[] = [];

    if (!p.isActive) {
        parts.push(`User has been away from laptop for ${p.idleMinutes} minutes.`);
    } else if (p.isJustServerProcesses) {
        parts.push("Laptop is on but only server/system processes are running — user is likely not at the computer.");
    } else {
        parts.push(`User is currently active on their laptop.`);
        if (p.frontmostApp && p.frontmostApp !== "unknown") {
            parts.push(`They're currently in ${p.frontmostApp}.`);
        }
        if (p.activeApps.length > 0) {
            parts.push(`Open apps: ${p.activeApps.join(", ")}.`);
        }
    }

    return parts.join(" ");
}
