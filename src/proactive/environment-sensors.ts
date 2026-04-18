// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Environment Sensors — Rich signal sources for proactive intelligence.
// Filesystem changes, calendar proximity, email, system resources.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { IS_MAC, IS_WIN } from "../tools/platform.js";
import { getLocation, type LocationData } from "../location/index.js";
const execFileAsync = promisify(execFile);

export interface EnvironmentSnapshot {
    fsChanges: string[];
    upcomingCalendar: string[];
    systemLoad: { cpuPercent: number; memPercent: number; diskFreeGB: number };
    networkStatus: boolean;
    location: LocationData | null;
}

export async function getEnvironmentSnapshot(): Promise<EnvironmentSnapshot> {
    const [fsChanges, calendar, sysLoad, network] = await Promise.all([
        getRecentFSChanges(),
        getUpcomingCalendarEvents(),
        getSystemLoad(),
        checkNetwork(),
    ]);
    return { fsChanges, upcomingCalendar: calendar, systemLoad: sysLoad, networkStatus: network, location: getLocation() };
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
    // Calendar integration via osascript is macOS only.
    // Windows has no easy scriptable calendar API — return empty.
    if (!IS_MAC) return [];

    try {
        const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", `
            const app = Application("Calendar");
            const now = new Date();
            const soon = new Date(now.getTime() + 30*60*1000);
            const cals = app.calendars();
            const events = [];
            for (const cal of cals) {
                try {
                    const evts = cal.events.whose({startDate: {_greaterThan: now}, startDate: {_lessThan: soon}})();
                    for (const e of evts) events.push(e.summary() + " at " + e.startDate().toLocaleTimeString());
                } catch {}
            }
            events.slice(0, 5).join("\\n");
        `], { timeout: 5000 });
        return stdout.trim().split("\n").filter(Boolean);
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

async function checkNetwork(): Promise<boolean> {
    try {
        await fetch("https://1.1.1.1", { method: "HEAD", signal: AbortSignal.timeout(3000) });
        return true;
    } catch { return false; }
}
