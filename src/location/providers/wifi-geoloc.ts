// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Wi-Fi BSSID-based geolocation provider.
// Scans nearby access points and uses their BSSIDs for location estimation.
// Most useful on Linux systems without GeoClue2; on macOS/Windows the native
// GPS tier already uses Wi-Fi signals internally.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LocationData, LocationProvider } from "../index.js";

const execFileAsync = promisify(execFile);

interface AccessPoint {
    bssid: string;
    signal: number;
}

async function scanMac(): Promise<AccessPoint[]> {
    try {
        const { stdout } = await execFileAsync(
            "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport",
            ["-s"],
            { timeout: 5000 },
        );
        return stdout
            .trim()
            .split("\n")
            .slice(1)
            .map((line) => {
                const parts = line.trim().split(/\s+/);
                const bssid = parts.find((p) => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(p));
                const rssi = parts.find((p) => /^-?\d+$/.test(p) && parseInt(p) < 0);
                if (bssid) return { bssid, signal: rssi ? parseInt(rssi) : -70 };
                return null;
            })
            .filter((ap): ap is AccessPoint => ap !== null)
            .slice(0, 10);
    } catch {
        return [];
    }
}

async function scanWindows(): Promise<AccessPoint[]> {
    try {
        const { stdout } = await execFileAsync("netsh", ["wlan", "show", "networks", "mode=bssid"], { timeout: 5000 });
        const aps: AccessPoint[] = [];
        const blocks = stdout.split(/SSID \d+/);
        for (const block of blocks) {
            const bssidMatch = block.match(/BSSID\s*\d*\s*:\s*([0-9a-f:]+)/i);
            const signalMatch = block.match(/Signal\s*:\s*(\d+)%/);
            if (bssidMatch) {
                aps.push({
                    bssid: bssidMatch[1],
                    signal: signalMatch ? -(100 - parseInt(signalMatch[1])) : -70,
                });
            }
        }
        return aps.slice(0, 10);
    } catch {
        return [];
    }
}

async function scanLinux(): Promise<AccessPoint[]> {
    try {
        const { stdout } = await execFileAsync("nmcli", ["-t", "-f", "bssid,signal", "dev", "wifi", "list"], {
            timeout: 5000,
        });
        return stdout
            .trim()
            .split("\n")
            .map((line) => {
                const [bssid, signal] = line.split(":");
                if (bssid && signal) {
                    return { bssid: bssid.trim(), signal: -(100 - parseInt(signal)) };
                }
                return null;
            })
            .filter((ap): ap is AccessPoint => ap !== null)
            .slice(0, 10);
    } catch {
        return [];
    }
}

export class WiFiGeolocationProvider implements LocationProvider {
    name = "wifi";

    async isAvailable(): Promise<boolean> {
        const aps = await this.scanAPs();
        return aps.length >= 2;
    }

    private async scanAPs(): Promise<AccessPoint[]> {
        if (process.platform === "darwin") return scanMac();
        if (process.platform === "win32") return scanWindows();
        if (process.platform === "linux") return scanLinux();
        return [];
    }

    async getLocation(): Promise<LocationData> {
        const aps = await this.scanAPs();
        if (aps.length < 2) {
            throw new Error("WiFi: insufficient access points for geolocation");
        }

        // Wi-Fi BSSID scanning infrastructure is in place for future BSSID geolocation
        // service integration. On macOS/Windows, the native GPS provider already uses
        // Wi-Fi internally, so this tier falls through to IP for now.
        throw new Error("WiFi: no BSSID geolocation service configured — falling through to IP");
    }
}
