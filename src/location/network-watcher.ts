// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Network Watcher — detects network changes (Wi-Fi switch, new IP) and triggers location refresh.

import os from "node:os";
import { refreshLocation } from "./index.js";

// ── Constants ────────────────────────────────

const POLL_INTERVAL_MS = 60_000;

// ── State ────────────────────────────────────

let _lastNet: string | null = null;
let _pollTimer: NodeJS.Timeout | null = null;

// ── Network signature ────────────────────────
// The machine's external IPv4 addresses. No spawn, works on every OS (macOS
// dropped the `airport` tool the SSID read used). IPv6 is left out: its
// privacy addresses rotate on their own. A DHCP renew to a new IP on the
// same Wi-Fi also counts as a change; that just refreshes location once.

export function networkSignature(ifaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces()): string {
    return Object.values(ifaces)
        .flat()
        .filter((a) => a && !a.internal && a.family === "IPv4")
        .map((a) => a?.address)
        .sort()
        .join(",");
}

// ── Poll Loop ────────────────────────────────

function checkForNetworkChange(): void {
    const current = networkSignature();

    if (!current) return;

    if (_lastNet === null) {
        _lastNet = current;
        return;
    }

    if (current !== _lastNet) {
        console.log("[LOCATION] Network changed — refreshing location");
        _lastNet = current;

        refreshLocation().catch((err) => {
            console.warn("[LOCATION] Refresh after network change failed:", (err as Error).message);
        });
    }
}

// ── Public API ───────────────────────────────

export function startNetworkWatcher(): void {
    if (_pollTimer) return;
    if (process.env.LOCATION_ENABLED === "false") return;

    checkForNetworkChange();
    _pollTimer = setInterval(checkForNetworkChange, POLL_INTERVAL_MS);

    if (_pollTimer.unref) _pollTimer.unref();
    console.log("[LOCATION] Network watcher started (polls every 60s)");
}

export function stopNetworkWatcher(): void {
    if (_pollTimer) {
        clearInterval(_pollTimer);
        _pollTimer = null;
    }
    _lastNet = null;
}
