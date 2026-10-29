// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Network Watcher — detects Wi-Fi SSID changes and triggers location refresh.
// Reuses the same platform commands from system-controls.ts for SSID detection.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { refreshLocation } from "./index.js";

const execFileAsync = promisify(execFile);

// ── Constants ────────────────────────────────

const POLL_INTERVAL_MS = 60_000;

// ── State ────────────────────────────────────

let _lastSSID: string | null = null;
let _pollTimer: NodeJS.Timeout | null = null;

// ── SSID Detection (per-platform) ────────────

async function getCurrentSSID(): Promise<string | null> {
    try {
        if (process.platform === "darwin") {
            const { stdout } = await execFileAsync(
                "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport",
                ["-I"],
                { timeout: 3000 },
            );
            const match = stdout.match(/\s+SSID:\s+(.+)/);
            return match?.[1]?.trim() || null;
        }

        if (process.platform === "win32") {
            const { stdout } = await execFileAsync("netsh", ["wlan", "show", "interfaces"], { timeout: 3000 });
            const match = stdout.match(/^\s+SSID\s+:\s+(.+)$/m);
            return match?.[1]?.trim() || null;
        }

        if (process.platform === "linux") {
            const { stdout } = await execFileAsync("nmcli", ["-t", "-f", "active,ssid", "dev", "wifi"], {
                timeout: 3000,
            });
            const active = stdout.split("\n").find((l) => l.startsWith("yes:"));
            if (active) {
                return active.split(":")[1] || null;
            }
            return null;
        }

        return null;
    } catch {
        return null;
    }
}

// ── Poll Loop ────────────────────────────────

async function checkForSSIDChange(): Promise<void> {
    const currentSSID = await getCurrentSSID();

    if (!currentSSID) return;

    if (_lastSSID === null) {
        _lastSSID = currentSSID;
        return;
    }

    if (currentSSID !== _lastSSID) {
        console.log(`[LOCATION] Wi-Fi changed: "${_lastSSID}" → "${currentSSID}" — refreshing location`);
        _lastSSID = currentSSID;

        refreshLocation().catch((err) => {
            console.warn("[LOCATION] Refresh after network change failed:", (err as Error).message);
        });
    }
}

// ── Public API ───────────────────────────────

export function startNetworkWatcher(): void {
    if (_pollTimer) return;
    if (process.env.LOCATION_ENABLED === "false") return;

    checkForSSIDChange().catch(() => {
        /* non-fatal */
    });

    _pollTimer = setInterval(() => {
        checkForSSIDChange().catch(() => {
            /* non-fatal */
        });
    }, POLL_INTERVAL_MS);

    if (_pollTimer.unref) _pollTimer.unref();
    console.log("[LOCATION] Network watcher started (SSID poll every 60s)");
}

export function stopNetworkWatcher(): void {
    if (_pollTimer) {
        clearInterval(_pollTimer);
        _pollTimer = null;
    }
    _lastSSID = null;
}
