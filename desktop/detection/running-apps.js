// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Cross-OS running-app snapshot. Three platforms, three implementations,
// one shape. Returns Promise<AppSnapshot>.
//
// AppSnapshot = { names: string[], platform: "darwin"|"win32"|"linux" }
//
// names is lowercased + de-duplicated. Empty array on detection failure
// (caller falls back to W1 static signals).
"use strict";

const { exec } = require("node:child_process");

const EXEC_TIMEOUT_MS = 2500;

function execAsync(cmd, opts) {
    return new Promise(function (resolve) {
        exec(cmd, Object.assign({ timeout: EXEC_TIMEOUT_MS, maxBuffer: 512 * 1024 }, opts || {}), function (err, stdout) {
            if (err) return resolve("");
            resolve(String(stdout || ""));
        });
    });
}

/* macOS: `osascript -e 'tell application "System Events" to get name of every application process where background only is false'`
   Returns a comma-separated string of foreground app names. */
async function darwinApps() {
    const script = 'tell application "System Events" to get name of every application process where background only is false';
    const stdout = await execAsync("osascript -e " + JSON.stringify(script));
    if (!stdout) return [];
    return stdout
        .split(",")
        .map(function (s) { return s.trim().toLowerCase(); })
        .filter(Boolean);
}

/* Windows: `tasklist /FO CSV /NH` outputs "Name","PID","Session","Session#","Mem". We take column 0. */
async function win32Apps() {
    const stdout = await execAsync('tasklist /FO CSV /NH');
    if (!stdout) return [];
    const names = [];
    const lines = stdout.split(/\r?\n/);
    for (const line of lines) {
        const m = line.match(/^"([^"]+)"/);
        if (m) {
            // tasklist returns process names like "Code.exe" — strip the extension
            // for parity with macOS app names.
            names.push(m[1].toLowerCase().replace(/\.exe$/, ""));
        }
    }
    return Array.from(new Set(names));
}

/* Linux: `wmctrl -l` lists windows. Fall back to empty if wmctrl isn't installed. */
async function linuxApps() {
    const stdout = await execAsync("wmctrl -l");
    if (!stdout) return [];
    const names = [];
    for (const line of stdout.split(/\r?\n/)) {
        const cols = line.split(/\s+/);
        if (cols.length >= 4) names.push(cols.slice(3).join(" ").toLowerCase());
    }
    return Array.from(new Set(names));
}

async function getRunningApps(platform) {
    const plat = platform || process.platform;
    try {
        let names = [];
        if (plat === "darwin") names = await darwinApps();
        else if (plat === "win32") names = await win32Apps();
        else if (plat === "linux") names = await linuxApps();
        return { names: Array.from(new Set(names)), platform: plat };
    } catch {
        return { names: [], platform: plat };
    }
}

module.exports = {
    getRunningApps,
    // exposed for tests
    _internals: { darwinApps, win32Apps, linuxApps, execAsync },
};
