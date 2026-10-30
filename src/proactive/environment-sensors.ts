// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Environment Sensors — Rich signal sources for proactive intelligence.
// Filesystem changes, calendar proximity, email, system resources.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { IS_MAC, IS_WIN } from "../tools/platform.js";
import { getLocation, type LocationData } from "../location/index.js";
import { isOnline } from "../network-health.js";
import { listUpcomingEvents } from "./monitors.js";
const execFileAsync = promisify(execFile);

export interface EnvironmentSnapshot {
    fsChanges: string[];
    upcomingCalendar: string[];
    systemLoad: { cpuPercent: number; memPercent: number; diskFreeGB: number };
    networkStatus: boolean;
    location: LocationData | null;
}

export async function getEnvironmentSnapshot(): Promise<EnvironmentSnapshot> {
    const [fsChanges, calendar, sysLoad] = await Promise.all([
        getRecentFSChanges(),
        getUpcomingCalendarEvents(),
        getSystemLoad(),
    ]);
    // The network monitor's status: no extra request.
    return { fsChanges, upcomingCalendar: calendar, systemLoad: sysLoad, networkStatus: isOnline(), location: getLocation() };
}

const FS_MARKER_PATH = `${tmpdir()}/.atlas-fs-marker`;

async function getRecentFSChanges(): Promise<string[]> {
    try {
        const home = process.env.HOME || process.env.USERPROFILE || "";

        if (IS_MAC) {
            const { stdout } = await execFileAsync("find", [
                `${home}/Desktop`, `${home}/Downloads`, "-maxdepth", "1", "-newer", FS_MARKER_PATH,
                "-type", "f", "-name", "*.pdf", "-o", "-name", "*.docx", "-o", "-name", "*.xlsx",
            ], { timeout: 3000 });
            // Touch marker for next check
            try { fs.writeFileSync(FS_MARKER_PATH, ""); } catch { /* */ }
            return stdout.trim().split("\n").filter(Boolean).slice(0, 5);
        }

        if (IS_WIN) {
            try {
                const desktopPath = `${home}\\Desktop`;
                const downloadsPath = `${home}\\Downloads`;
                const { stdout } = await execFileAsync("powershell.exe", [
                    "-NoProfile", "-Command",
                    `Get-ChildItem -Path "${desktopPath}","${downloadsPath}" -File -Include "*.pdf","*.docx","*.xlsx" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 5 -ExpandProperty FullName`,
                ], { timeout: 5000 });
                // Touch marker for next check
                try { fs.writeFileSync(FS_MARKER_PATH, ""); } catch { /* */ }
                return stdout.trim().split("\n").filter(Boolean).slice(0, 5);
            } catch {
                return [];
            }
        }

        // Linux fallback using find
        try {
            const { stdout } = await execFileAsync("find", [
                `${home}/Desktop`, `${home}/Downloads`, "-maxdepth", "1", "-newer", FS_MARKER_PATH,
                "-type", "f", "-name", "*.pdf", "-o", "-name", "*.docx", "-o", "-name", "*.xlsx",
            ], { timeout: 3000 });
            try { fs.writeFileSync(FS_MARKER_PATH, ""); } catch { /* */ }
            return stdout.trim().split("\n").filter(Boolean).slice(0, 5);
        } catch {
            return [];
        }
    } catch { return []; }
}

async function getUpcomingCalendarEvents(): Promise<string[]> {
    // Calendar integration via osascript is macOS only (the monitors' shared read).
    try {
        const events = await listUpcomingEvents();
        return events.slice(0, 5).map((e) => `${e.title} at ${new Date(e.startTime).toLocaleTimeString()}`);
    } catch { return []; }
}

async function getSystemLoad(): Promise<{ cpuPercent: number; memPercent: number; diskFreeGB: number }> {
    if (IS_MAC) {
        try {
            const [cpuOut, _memOut, diskOut] = await Promise.all([
                execFileAsync("ps", ["-A", "-o", "%cpu"], { timeout: 3000 }).then(r => r.stdout),
                execFileAsync("vm_stat", [], { timeout: 3000 }).then(r => r.stdout),
                execFileAsync("df", ["-g", "/"], { timeout: 3000 }).then(r => r.stdout),
            ]);
            const cpuLines = cpuOut.trim().split("\n").slice(1);
            const cpuPercent = cpuLines.reduce((sum, l) => sum + parseFloat(l.trim()) || 0, 0);
            const diskMatch = diskOut.match(/\s+(\d+)\s+\d+%/);
            const diskFreeGB = diskMatch ? parseInt(diskMatch[1]) : 0;
            return { cpuPercent: Math.min(100, cpuPercent), memPercent: 0, diskFreeGB };
        } catch { return { cpuPercent: 0, memPercent: 0, diskFreeGB: 0 }; }
    }

    if (IS_WIN) {
        try {
            const { stdout } = await execFileAsync("powershell.exe", [
                "-NoProfile", "-Command",
                `$os = Get-CimInstance Win32_OperatingSystem; $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" | Select-Object -ExpandProperty FreeSpace; @{cpu=[math]::Round($cpu,1);mem=[math]::Round((($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize) * 100, 1);diskGB=[math]::Round($disk / 1GB, 1)} | ConvertTo-Json`,
            ], { timeout: 5000 });
            const data = JSON.parse(stdout.trim() || "{}");
            return {
                cpuPercent: data.cpu ?? 0,
                memPercent: data.mem ?? 0,
                diskFreeGB: data.diskGB ?? 0,
            };
        } catch { return { cpuPercent: 0, memPercent: 0, diskFreeGB: 0 }; }
    }

    // Linux fallback
    return { cpuPercent: 0, memPercent: 0, diskFreeGB: 0 };
}
