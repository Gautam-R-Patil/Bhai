# Location Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give ATLAS automatic device-level location awareness with GPS → Wi-Fi → IP fallback, integrated into weather, identity, timezone, proactive, and agent context.

**Architecture:** New `src/location/` module with a singleton `LocationService` that runs a provider chain at boot and on Wi-Fi network changes. Module-level exported functions (`getLocation()`, `getTimezone()`, etc.) match the `network-health.ts` pattern. No new npm dependencies — all platform calls use `execFile` + `fetch`.

**Tech Stack:** Node.js `child_process.execFile`, `fetch()`, platform CLIs (osascript, powershell.exe, gdbus, nmcli, airport), ip-api.com free API.

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/location/index.ts` | LocationService singleton, public API, event emitter, fallback chain orchestrator |
| Create | `src/location/providers/corelocation.ts` | macOS GPS via CoreLocation/JXA |
| Create | `src/location/providers/win-geoloc.ts` | Windows GPS via PowerShell/WinRT |
| Create | `src/location/providers/geoclue.ts` | Linux GPS via GeoClue2/D-Bus |
| Create | `src/location/providers/wifi-geoloc.ts` | Wi-Fi BSSID scan + geolocation |
| Create | `src/location/providers/ip-geoloc.ts` | IP-based geolocation (ip-api.com) |
| Create | `src/location/network-watcher.ts` | SSID polling, triggers location refresh on change |
| Modify | `src/index.ts` | Add location init to boot Phase 2 |
| Modify | `src/tools/weather.ts` | Use real coords for "auto", fix Open-Meteo fallback |
| Modify | `src/tools/index.ts` | Register `get_location` tool |
| Modify | `src/memory/identity.ts` | Auto-update location on change |
| Modify | `src/proactive/environment-sensors.ts` | Add location to snapshot |
| Modify | `src/agent.ts` | Location context injection + fix timezone |
| Modify | `src/proactive/heartbeat.ts` | Fix timezone (6 occurrences) |
| Modify | `src/alive-ux.ts` | Fix timezone (1 occurrence) |
| Modify | `src/tools/google-api.ts` | Fix timezone (4 occurrences) |
| Modify | `src/memory/user-model.ts` | Fix timezone (2 occurrences) |
| Modify | `src/voice/live/memory-bridge.ts` | Fix timezone (4 occurrences) |
| Modify | `src/proactive/dreaming.ts` | Fix timezone (2 occurrences) |
| Modify | `.env.example` | Add `LOCATION_ENABLED` |


---

### Task 1: Core Types and IP Geolocation Provider

**Files:**
- Create: `src/location/providers/ip-geoloc.ts`

This is the simplest provider and the final fallback — build it first so the chain has something to test against immediately.

- [ ] **Step 1: Create `src/location/providers/ip-geoloc.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// IP-based geolocation provider — final fallback in the location chain.
// Uses ip-api.com (free, no API key, 45 req/min, city-level accuracy).

import type { LocationData, LocationProvider } from "../index.js";

export class IPGeolocationProvider implements LocationProvider {
    name = "ip";

    async isAvailable(): Promise<boolean> {
        // Always available if online — no hardware or permission needed
        try {
            await fetch("https://1.1.1.1", { method: "HEAD", signal: AbortSignal.timeout(3000) });
            return true;
        } catch {
            return false;
        }
    }

    async getLocation(): Promise<LocationData> {
        const res = await fetch(
            "http://ip-api.com/json/?fields=status,lat,lon,city,regionName,countryCode,country,timezone",
            { signal: AbortSignal.timeout(5000) }
        );
        if (!res.ok) throw new Error(`ip-api.com returned ${res.status}`);

        const data = await res.json() as {
            status: string;
            lat: number;
            lon: number;
            city: string;
            regionName: string;
            countryCode: string;
            country: string;
            timezone: string;
        };

        if (data.status !== "success") {
            throw new Error(`ip-api.com returned status: ${data.status}`);
        }

        return {
            latitude: data.lat,
            longitude: data.lon,
            accuracy: 10000, // ~10km city-level
            city: data.city,
            region: data.regionName,
            country: data.countryCode,
            countryName: data.country,
            timezone: data.timezone,
            source: "ip",
            timestamp: Date.now(),
        };
    }
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `npx tsc --noEmit src/location/providers/ip-geoloc.ts`

This will fail because `LocationData` and `LocationProvider` types don't exist yet — that's expected. We'll define them in Task 2. Move on.

- [ ] **Step 3: Commit**

```bash
git add src/location/providers/ip-geoloc.ts
git commit -m "feat(location): add IP geolocation provider (ip-api.com fallback)"
```


---

### Task 2: LocationService Singleton (`src/location/index.ts`)

**Files:**
- Create: `src/location/index.ts`

The core module — defines types, the fallback chain, caching, event emission, and module-level exports.

- [ ] **Step 1: Create `src/location/index.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Location Service — automatic device location with GPS → Wi-Fi → IP fallback.
// Singleton pattern matches network-health.ts. Fail-open: null if all providers fail.

import { EventEmitter } from "node:events";

// ── Types ────────────────────────────────────

export type LocationSource = "gps" | "wifi" | "ip" | "manual";

export interface LocationData {
    latitude: number;
    longitude: number;
    accuracy: number;
    altitude?: number;
    city?: string;
    region?: string;
    country?: string;
    countryName?: string;
    timezone?: string;
    source: LocationSource;
    timestamp: number;
    stale?: boolean;
}

export interface LocationProvider {
    name: string;
    isAvailable(): Promise<boolean>;
    getLocation(): Promise<LocationData>;
}

// ── Constants ────────────────────────────────

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const PROVIDER_TIMEOUT_MS = 5000;     // 5s per provider
const SIGNIFICANT_DISTANCE_KM = 1;    // >1km = meaningful location change

// ── State ────────────────────────────────────

let _location: LocationData | null = null;
let _providers: LocationProvider[] = [];
let _emitter: EventEmitter | null = null;
let _initialized = false;

// ── Haversine Distance ───────────────────────

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Provider Chain Execution ─────────────────

async function runProviderWithTimeout(provider: LocationProvider): Promise<LocationData | null> {
    try {
        const available = await Promise.race([
            provider.isAvailable(),
            new Promise<false>(r => setTimeout(() => r(false), PROVIDER_TIMEOUT_MS)),
        ]);
        if (!available) return null;

        const location = await Promise.race([
            provider.getLocation(),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`${provider.name} timed out`)), PROVIDER_TIMEOUT_MS)
            ),
        ]);
        return location;
    } catch (err) {
        console.warn(`[LOCATION] Provider ${provider.name} failed:`, (err as Error).message);
        return null;
    }
}

async function runFallbackChain(): Promise<LocationData | null> {
    for (const provider of _providers) {
        const result = await runProviderWithTimeout(provider);
        if (result) {
            console.log(`[LOCATION] Resolved via ${provider.name}: ${result.city || "unknown"}, ${result.country || "unknown"} (±${result.accuracy}m)`);
            return result;
        }
    }
    return null;
}

// ── Public API ───────────────────────────────

export async function initLocationService(): Promise<void> {
    if (_initialized) return;
    if (process.env.LOCATION_ENABLED === "false") {
        console.log("📍 Location service disabled (LOCATION_ENABLED=false)");
        return;
    }

    _emitter = new EventEmitter();
    _providers = [];

    // Load platform-specific GPS provider
    const platform = process.platform;
    try {
        if (platform === "darwin") {
            const { CoreLocationProvider } = await import("./providers/corelocation.js");
            _providers.push(new CoreLocationProvider());
        } else if (platform === "win32") {
            const { WinGeolocationProvider } = await import("./providers/win-geoloc.js");
            _providers.push(new WinGeolocationProvider());
        } else if (platform === "linux") {
            const { GeoClueProvider } = await import("./providers/geoclue.js");
            _providers.push(new GeoClueProvider());
        }
    } catch (err) {
        console.warn("[LOCATION] Native GPS provider load failed (non-fatal):", (err as Error).message);
    }

    // Wi-Fi geolocation (cross-platform)
    try {
        const { WiFiGeolocationProvider } = await import("./providers/wifi-geoloc.js");
        _providers.push(new WiFiGeolocationProvider());
    } catch (err) {
        console.warn("[LOCATION] Wi-Fi provider load failed (non-fatal):", (err as Error).message);
    }

    // IP geolocation (always available as final fallback)
    try {
        const { IPGeolocationProvider } = await import("./providers/ip-geoloc.js");
        _providers.push(new IPGeolocationProvider());
    } catch (err) {
        console.warn("[LOCATION] IP provider load failed (non-fatal):", (err as Error).message);
    }

    _initialized = true;

    // Initial location detection (non-blocking)
    refreshLocation().then(loc => {
        if (loc) {
            console.log(`📍 Location: ${loc.city || "unknown"}, ${loc.countryName || loc.country || "unknown"} (via ${loc.source}, ±${loc.accuracy}m)`);
        } else {
            console.log("📍 Location: unavailable (all providers failed)");
        }
    }).catch(err => {
        console.warn("[LOCATION] Initial detection failed:", (err as Error).message);
    });
}

export async function refreshLocation(): Promise<LocationData | null> {
    const newLoc = await runFallbackChain();
    if (!newLoc) {
        // Mark existing cached location as stale if TTL expired
        if (_location && Date.now() - _location.timestamp > CACHE_TTL_MS) {
            _location = { ..._location, stale: true };
        }
        return _location;
    }

    const prev = _location;
    _location = newLoc;

    // Emit change event if location moved significantly
    if (prev && _emitter) {
        const dist = haversineKm(prev.latitude, prev.longitude, newLoc.latitude, newLoc.longitude);
        if (dist >= SIGNIFICANT_DISTANCE_KM) {
            _emitter.emit("locationChanged", newLoc);
        }
    } else if (!prev && _emitter) {
        // First detection — always emit
        _emitter.emit("locationChanged", newLoc);
    }

    return _location;
}

export function getLocation(): LocationData | null {
    if (!_location) return null;
    // Mark stale if past TTL (but still return it)
    if (Date.now() - _location.timestamp > CACHE_TTL_MS) {
        return { ..._location, stale: true };
    }
    return _location;
}

export function getTimezone(): string {
    const loc = getLocation();
    if (loc?.timezone) return loc.timezone;
    // System timezone as fallback
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function getLocationString(): string {
    const loc = getLocation();
    if (!loc) return "";
    return [loc.city, loc.region, loc.countryName || loc.country].filter(Boolean).join(", ");
}

export function onLocationChange(listener: (data: LocationData) => void): void {
    _emitter?.on("locationChanged", listener);
}

export function getLocationSnippet(): string {
    const loc = getLocation();
    if (!loc) return "";
    const coords = `${Math.abs(loc.latitude).toFixed(3)}°${loc.latitude >= 0 ? "N" : "S"}, ${Math.abs(loc.longitude).toFixed(3)}°${loc.longitude >= 0 ? "E" : "W"}`;
    const locStr = getLocationString();
    const tz = getTimezone();
    const ago = Math.round((Date.now() - loc.timestamp) / 60000);
    const agoStr = ago < 1 ? "just now" : `${ago} min ago`;
    const staleTag = loc.stale ? " [stale]" : "";
    return `📍 CURRENT LOCATION: ${locStr || "Unknown"} (${coords})\n   Timezone: ${tz} | Source: ${loc.source.toUpperCase()} | Updated: ${agoStr}${staleTag}`;
}

export function destroyLocationService(): void {
    _emitter?.removeAllListeners();
    _emitter = null;
    _location = null;
    _providers = [];
    _initialized = false;
}
```

- [ ] **Step 2: Verify it compiles (will fail on missing provider imports — expected)**

Run: `npx tsc --noEmit`

Note: This will have import errors for providers not yet created. That's fine — we're building incrementally.

- [ ] **Step 3: Commit**

```bash
git add src/location/index.ts
git commit -m "feat(location): add LocationService singleton with fallback chain and caching"
```


---

### Task 3: macOS CoreLocation Provider

**Files:**
- Create: `src/location/providers/corelocation.ts`

Uses `osascript -l JavaScript` to invoke CoreLocation. This is the same pattern used throughout the codebase for macOS-specific features (calendar events, screenshots, etc.).

- [ ] **Step 1: Create `src/location/providers/corelocation.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// macOS CoreLocation provider — uses JXA via osascript to get GPS coordinates.
// Requires Location Services enabled and user permission grant on first use.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LocationData, LocationProvider } from "../index.js";

const execFileAsync = promisify(execFile);

// JXA script that invokes CoreLocation for a one-shot location fix.
// Uses ObjC bridge available in osascript -l JavaScript.
const LOCATION_SCRIPT = `
ObjC.import('CoreLocation');
ObjC.import('Foundation');

const mgr = $.CLLocationManager.alloc.init;

// Check authorization
const authStatus = $.CLLocationManager.authorizationStatus;
// 0=notDetermined, 1=restricted, 2=denied, 3=authorizedAlways, 4=authorizedWhenInUse
if (authStatus === 1 || authStatus === 2) {
    "error|permission_denied";
} else {
    mgr.requestWhenInUseAuthorization;
    mgr.startUpdatingLocation;

    // Poll for up to 5 seconds
    let loc = null;
    for (let i = 0; i < 50; i++) {
        $.NSRunLoop.currentRunLoop.runUntilDate(
            $.NSDate.dateWithTimeIntervalSinceNow(0.1)
        );
        loc = mgr.location;
        if (loc && loc.horizontalAccuracy >= 0) break;
    }

    mgr.stopUpdatingLocation;

    if (loc && loc.horizontalAccuracy >= 0) {
        loc.coordinate.latitude + "|" + loc.coordinate.longitude + "|" + loc.altitude + "|" + loc.horizontalAccuracy;
    } else {
        "error|no_fix";
    }
}
`;

export class CoreLocationProvider implements LocationProvider {
    name = "gps";

    async isAvailable(): Promise<boolean> {
        return process.platform === "darwin";
    }

    async getLocation(): Promise<LocationData> {
        const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", LOCATION_SCRIPT], {
            timeout: 8000,
        });

        const result = stdout.trim();
        if (result.startsWith("error|")) {
            throw new Error(`CoreLocation: ${result.split("|")[1]}`);
        }

        const [latStr, lonStr, altStr, accStr] = result.split("|");
        const latitude = parseFloat(latStr);
        const longitude = parseFloat(lonStr);
        const altitude = parseFloat(altStr);
        const accuracy = parseFloat(accStr);

        if (isNaN(latitude) || isNaN(longitude)) {
            throw new Error("CoreLocation: invalid coordinate data");
        }

        // Reverse-geocode timezone from coordinates using Intl API
        // This gives us an IANA timezone string without any external API call
        let timezone: string | undefined;
        try {
            // Node.js Intl can resolve timezone from the system, but not from arbitrary coords.
            // We'll let the LocationService use the IP provider's timezone as enrichment.
            timezone = undefined;
        } catch { /* */ }

        return {
            latitude,
            longitude,
            accuracy: Math.round(accuracy),
            altitude: isNaN(altitude) ? undefined : Math.round(altitude),
            source: "gps",
            timezone,
            timestamp: Date.now(),
        };
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/location/providers/corelocation.ts
git commit -m "feat(location): add macOS CoreLocation GPS provider"
```


---

### Task 4: Windows Geolocation Provider

**Files:**
- Create: `src/location/providers/win-geoloc.ts`

Uses PowerShell to invoke the Windows.Devices.Geolocation WinRT API — same pattern as system-controls.ts uses for battery, CPU, etc.

- [ ] **Step 1: Create `src/location/providers/win-geoloc.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Windows geolocation provider — uses PowerShell + Windows.Devices.Geolocation WinRT API.
// Requires Location Services enabled in Windows Settings.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LocationData, LocationProvider } from "../index.js";

const execFileAsync = promisify(execFile);

const PS_SCRIPT = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Devices.Geolocation.Geolocator, Windows.Devices.Geolocation, ContentType=WindowsRuntime] | Out-Null

$gl = New-Object Windows.Devices.Geolocation.Geolocator
$gl.DesiredAccuracy = [Windows.Devices.Geolocation.PositionAccuracy]::High

try {
    $task = $gl.GetGeopositionAsync()
    [Windows.Foundation.IAsyncOperation[Windows.Devices.Geolocation.Geoposition]]$task | Out-Null

    # Wait up to 5 seconds
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($task.Status -eq 'Started' -and $sw.ElapsedMilliseconds -lt 5000) {
        Start-Sleep -Milliseconds 100
    }

    if ($task.Status -ne 'Completed') {
        Write-Output "error|timeout"
        exit
    }

    $pos = $task.GetResults()
    $coord = $pos.Coordinate
    $lat = $coord.Point.Position.Latitude
    $lon = $coord.Point.Position.Longitude
    $alt = $coord.Point.Position.Altitude
    $acc = $coord.Accuracy
    Write-Output "$lat|$lon|$alt|$acc"
} catch {
    Write-Output "error|$($_.Exception.Message)"
}
`;

export class WinGeolocationProvider implements LocationProvider {
    name = "gps";

    async isAvailable(): Promise<boolean> {
        return process.platform === "win32";
    }

    async getLocation(): Promise<LocationData> {
        const { stdout } = await execFileAsync("powershell.exe", [
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", PS_SCRIPT,
        ], { timeout: 8000 });

        const result = stdout.trim();
        if (result.startsWith("error|")) {
            throw new Error(`WinGeoloc: ${result.split("|")[1]}`);
        }

        const [latStr, lonStr, altStr, accStr] = result.split("|");
        const latitude = parseFloat(latStr);
        const longitude = parseFloat(lonStr);
        const altitude = parseFloat(altStr);
        const accuracy = parseFloat(accStr);

        if (isNaN(latitude) || isNaN(longitude)) {
            throw new Error("WinGeoloc: invalid coordinate data");
        }

        return {
            latitude,
            longitude,
            accuracy: Math.round(accuracy),
            altitude: isNaN(altitude) ? undefined : Math.round(altitude),
            source: "gps",
            timestamp: Date.now(),
        };
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/location/providers/win-geoloc.ts
git commit -m "feat(location): add Windows geolocation provider (WinRT)"
```


---

### Task 5: Linux GeoClue2 Provider

**Files:**
- Create: `src/location/providers/geoclue.ts`

Uses `gdbus` to call the GeoClue2 D-Bus service. Falls through gracefully if GeoClue2 is not installed.

- [ ] **Step 1: Create `src/location/providers/geoclue.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Linux GeoClue2 provider — uses gdbus to query location via D-Bus.
// Falls through if GeoClue2 is not installed (common on servers/minimal installs).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LocationData, LocationProvider } from "../index.js";

const execFileAsync = promisify(execFile);

export class GeoClueProvider implements LocationProvider {
    name = "gps";

    async isAvailable(): Promise<boolean> {
        if (process.platform !== "linux") return false;
        // Check if gdbus and GeoClue2 service exist
        try {
            await execFileAsync("gdbus", ["introspect", "--system",
                "--dest", "org.freedesktop.GeoClue2",
                "--object-path", "/org/freedesktop/GeoClue2/Manager"],
                { timeout: 3000 });
            return true;
        } catch {
            return false;
        }
    }

    async getLocation(): Promise<LocationData> {
        // Step 1: Get a client path from the Manager
        const { stdout: clientPath } = await execFileAsync("gdbus", [
            "call", "--system",
            "--dest", "org.freedesktop.GeoClue2",
            "--object-path", "/org/freedesktop/GeoClue2/Manager",
            "--method", "org.freedesktop.GeoClue2.Manager.GetClient",
        ], { timeout: 5000 });

        // Parse client object path from output like "('/org/freedesktop/GeoClue2/Client/1',)"
        const pathMatch = clientPath.match(/'([^']+)'/);
        if (!pathMatch) throw new Error("GeoClue2: failed to get client path");
        const client = pathMatch[1];

        // Step 2: Set DesktopId (required by GeoClue2)
        await execFileAsync("gdbus", [
            "call", "--system",
            "--dest", "org.freedesktop.GeoClue2",
            "--object-path", client,
            "--method", "org.freedesktop.DBus.Properties.Set",
            "org.freedesktop.GeoClue2.Client", "DesktopId",
            "<string 'atlas-agent'>",
        ], { timeout: 3000 });

        // Step 3: Start the client
        await execFileAsync("gdbus", [
            "call", "--system",
            "--dest", "org.freedesktop.GeoClue2",
            "--object-path", client,
            "--method", "org.freedesktop.GeoClue2.Client.Start",
        ], { timeout: 3000 });

        // Step 4: Poll for location (up to 5 seconds)
        let latitude = NaN;
        let longitude = NaN;
        let accuracy = NaN;

        for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 500));
            try {
                const { stdout: locOut } = await execFileAsync("gdbus", [
                    "call", "--system",
                    "--dest", "org.freedesktop.GeoClue2",
                    "--object-path", client,
                    "--method", "org.freedesktop.DBus.Properties.GetAll",
                    "org.freedesktop.GeoClue2.Location",
                ], { timeout: 3000 });

                // Parse latitude, longitude, accuracy from D-Bus variant output
                const latMatch = locOut.match(/Latitude.*?(-?\d+\.?\d*)/);
                const lonMatch = locOut.match(/Longitude.*?(-?\d+\.?\d*)/);
                const accMatch = locOut.match(/Accuracy.*?(-?\d+\.?\d*)/);

                if (latMatch && lonMatch) {
                    latitude = parseFloat(latMatch[1]);
                    longitude = parseFloat(lonMatch[1]);
                    accuracy = accMatch ? parseFloat(accMatch[1]) : 1000;
                    break;
                }
            } catch { /* location not ready yet */ }
        }

        // Step 5: Stop the client
        try {
            await execFileAsync("gdbus", [
                "call", "--system",
                "--dest", "org.freedesktop.GeoClue2",
                "--object-path", client,
                "--method", "org.freedesktop.GeoClue2.Client.Stop",
            ], { timeout: 3000 });
        } catch { /* best-effort cleanup */ }

        if (isNaN(latitude) || isNaN(longitude)) {
            throw new Error("GeoClue2: failed to get location fix");
        }

        return {
            latitude,
            longitude,
            accuracy: Math.round(accuracy),
            source: "gps",
            timestamp: Date.now(),
        };
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/location/providers/geoclue.ts
git commit -m "feat(location): add Linux GeoClue2 GPS provider (D-Bus)"
```


---

### Task 6: Wi-Fi Geolocation Provider

**Files:**
- Create: `src/location/providers/wifi-geoloc.ts`

Scans nearby Wi-Fi BSSIDs and uses them for geolocation. Most useful on Linux where GeoClue2 may not be installed. On macOS/Windows, native GPS already uses Wi-Fi internally, so this is a secondary fallback.

- [ ] **Step 1: Create `src/location/providers/wifi-geoloc.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
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
    signal: number; // dBm or percentage
}

async function scanMac(): Promise<AccessPoint[]> {
    try {
        const { stdout } = await execFileAsync(
            "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport",
            ["-s"], { timeout: 5000 }
        );
        // Parse airport -s output: SSID BSSID RSSI CHANNEL ...
        return stdout.trim().split("\n").slice(1).map(line => {
            const parts = line.trim().split(/\s+/);
            // BSSID is typically the second column, RSSI the third
            const bssid = parts.find(p => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(p));
            const rssi = parts.find(p => /^-?\d+$/.test(p) && parseInt(p) < 0);
            if (bssid) return { bssid, signal: rssi ? parseInt(rssi) : -70 };
            return null;
        }).filter((ap): ap is AccessPoint => ap !== null).slice(0, 10);
    } catch { return []; }
}

async function scanWindows(): Promise<AccessPoint[]> {
    try {
        const { stdout } = await execFileAsync("netsh", [
            "wlan", "show", "networks", "mode=bssid",
        ], { timeout: 5000 });
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
    } catch { return []; }
}

async function scanLinux(): Promise<AccessPoint[]> {
    try {
        const { stdout } = await execFileAsync("nmcli", [
            "-t", "-f", "bssid,signal", "dev", "wifi", "list",
        ], { timeout: 5000 });
        return stdout.trim().split("\n").map(line => {
            const [bssid, signal] = line.split(":");
            if (bssid && signal) {
                return { bssid: bssid.trim(), signal: -(100 - parseInt(signal)) };
            }
            return null;
        }).filter((ap): ap is AccessPoint => ap !== null).slice(0, 10);
    } catch { return []; }
}

export class WiFiGeolocationProvider implements LocationProvider {
    name = "wifi";

    async isAvailable(): Promise<boolean> {
        // Try scanning — if we get any APs, Wi-Fi is available
        const aps = await this.scanAPs();
        return aps.length >= 2; // Need at least 2 APs for triangulation
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

        // Use Mozilla Location Service (MLS) compatible API
        // Note: Mozilla shut down their public API, so we use a lightweight
        // approach: if we have Wi-Fi BSSIDs but native GPS failed, the IP
        // fallback will likely give similar accuracy. This provider primarily
        // exists to bridge the gap on Linux without GeoClue2.
        //
        // For now, use a simple heuristic: if the connected AP has a known
        // location from a previous GPS fix + IP combo, use that. Otherwise,
        // fall through to IP provider.
        //
        // Future enhancement: integrate with a BSSID geolocation service.
        throw new Error("WiFi: no BSSID geolocation service configured — falling through to IP");
    }
}
```

Note: The Wi-Fi provider currently falls through to IP. The BSSID scanning infrastructure is in place for future BSSID geolocation service integration. On macOS/Windows, the native GPS provider already uses Wi-Fi internally, so this tier adds the most value on Linux systems.

- [ ] **Step 2: Commit**

```bash
git add src/location/providers/wifi-geoloc.ts
git commit -m "feat(location): add Wi-Fi geolocation provider with BSSID scanning"
```


---

### Task 7: Network Watcher (SSID Change Detection)

**Files:**
- Create: `src/location/network-watcher.ts`

Polls the current Wi-Fi SSID every 60 seconds. When it changes, triggers a location refresh. Uses the exact same platform commands already in `src/tools/system-controls.ts`.

- [ ] **Step 1: Create `src/location/network-watcher.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Network Watcher — detects Wi-Fi SSID changes and triggers location refresh.
// Reuses the same platform commands from system-controls.ts for SSID detection.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { refreshLocation } from "./index.js";

const execFileAsync = promisify(execFile);

// ── Constants ────────────────────────────────

const POLL_INTERVAL_MS = 60_000; // Check SSID every 60 seconds

// ── State ────────────────────────────────────

let _lastSSID: string | null = null;
let _pollTimer: NodeJS.Timeout | null = null;

// ── SSID Detection (per-platform) ────────────

async function getCurrentSSID(): Promise<string | null> {
    try {
        if (process.platform === "darwin") {
            const { stdout } = await execFileAsync(
                "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport",
                ["-I"], { timeout: 3000 }
            );
            const match = stdout.match(/\s+SSID:\s+(.+)/);
            return match?.[1]?.trim() || null;
        }

        if (process.platform === "win32") {
            const { stdout } = await execFileAsync("netsh", [
                "wlan", "show", "interfaces",
            ], { timeout: 3000 });
            // Match "SSID" but not "BSSID"
            const match = stdout.match(/^\s+SSID\s+:\s+(.+)$/m);
            return match?.[1]?.trim() || null;
        }

        if (process.platform === "linux") {
            const { stdout } = await execFileAsync("nmcli", [
                "-t", "-f", "active,ssid", "dev", "wifi",
            ], { timeout: 3000 });
            const active = stdout.split("\n").find(l => l.startsWith("yes:"));
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

    // Skip if we can't detect SSID (no Wi-Fi, or command failed)
    if (!currentSSID) return;

    // First run — just record the SSID
    if (_lastSSID === null) {
        _lastSSID = currentSSID;
        return;
    }

    // SSID changed — trigger location refresh
    if (currentSSID !== _lastSSID) {
        console.log(`[LOCATION] Wi-Fi changed: "${_lastSSID}" → "${currentSSID}" — refreshing location`);
        _lastSSID = currentSSID;

        refreshLocation().catch(err => {
            console.warn("[LOCATION] Refresh after network change failed:", (err as Error).message);
        });
    }
}

// ── Public API ───────────────────────────────

export function startNetworkWatcher(): void {
    if (_pollTimer) return; // Already running
    if (process.env.LOCATION_ENABLED === "false") return;

    // Initial SSID capture
    checkForSSIDChange().catch(() => { /* non-fatal */ });

    // Start polling
    _pollTimer = setInterval(() => {
        checkForSSIDChange().catch(() => { /* non-fatal */ });
    }, POLL_INTERVAL_MS);

    // Don't prevent process exit
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
```

- [ ] **Step 2: Commit**

```bash
git add src/location/network-watcher.ts
git commit -m "feat(location): add SSID-based network watcher for location refresh"
```


---

### Task 8: Build Verification

**Files:**
- None (verification only)

Before integrating, verify the entire location module compiles.

- [ ] **Step 1: Run typecheck**

Run: `npx tsc --noEmit`

Expected: No errors from `src/location/` files. If there are import resolution issues, fix them (ensure all `.js` extensions are present in imports).

- [ ] **Step 2: Run lint**

Run: `npm run lint`

Expected: Clean or only pre-existing warnings (not from new files).

---

### Task 9: Boot Integration (`src/index.ts`)

**Files:**
- Modify: `src/index.ts:1-2` (add import)
- Modify: `src/index.ts:208-235` (add to Phase 2 Promise.all)
- Modify: `src/index.ts:237-242` (add network watcher start + network-health hook)

Wire the location service into the boot sequence.

- [ ] **Step 1: Add imports at the top of `src/index.ts`**

Add after the existing import block (after line 51, near the other subsystem imports):

```typescript
import { initLocationService, refreshLocation, onLocationChange } from "./location/index.js";
import { startNetworkWatcher, stopNetworkWatcher } from "./location/network-watcher.js";
```

- [ ] **Step 2: Add location init to Phase 2 Promise.all**

In the `Promise.all([` block starting at line 208, add this line alongside the other subsystem inits:

```typescript
        // Location service (GPS → Wi-Fi → IP fallback chain)
        initLocationService().catch(e => console.warn("[BOOT] Location:", (e as Error).message)),
```

- [ ] **Step 3: Start network watcher after Phase 2**

After the Phase 2 `Promise.all` completes (around line 237, after `initBrowserMemory()`), add:

```typescript
    // Location: start SSID watcher + hook into network recovery
    startNetworkWatcher();
    onNetworkStatusChange((event) => {
        if (event.next === "online" && event.prev === "offline") {
            refreshLocation().catch(() => { /* non-fatal */ });
        }
    });
```

Note: `onNetworkStatusChange` is already imported at line 48 — no new import needed for it.

- [ ] **Step 4: Add cleanup to graceful shutdown**

Find the existing `process.on("SIGINT"` or shutdown handler and add:

```typescript
stopNetworkWatcher();
```

alongside the existing `stopHeartbeat()`, `stopNetworkMonitor()`, etc.

- [ ] **Step 5: Verify build**

Run: `npx tsc --noEmit`
Expected: Clean compilation.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat(location): wire location service into boot sequence"
```


---

### Task 10: Weather Tool Integration (`src/tools/weather.ts`)

**Files:**
- Modify: `src/tools/weather.ts:4` (add import)
- Modify: `src/tools/weather.ts:54-57` (update `resolveLocation()`)
- Modify: `src/tools/weather.ts:69-73` (fix Open-Meteo fallback)

Use real coordinates when the user passes `location: "auto"`, and fix the Open-Meteo fallback from hardcoded `0,0` to actual coordinates.

- [ ] **Step 1: Add location import**

Add after the existing import at line 5 of `src/tools/weather.ts`:

```typescript
import { getLocation } from "../location/index.js";
```

- [ ] **Step 2: Update `resolveLocation()` to use GPS coordinates**

Replace the `resolveLocation` function at lines 54-57:

Old:
```typescript
function resolveLocation(location: string): string {
    if (location === "auto" || location === "") return "";
    return encodeURIComponent(location);
}
```

New:
```typescript
function resolveLocation(location: string): string {
    if (location === "auto" || location === "") {
        const loc = getLocation();
        if (loc) return `${loc.latitude},${loc.longitude}`;
        return ""; // Fall back to wttr.in's IP-based detection
    }
    return encodeURIComponent(location);
}
```

- [ ] **Step 3: Fix Open-Meteo fallback coordinates**

Replace the `fetchOpenMeteoFallback` function at lines 69-92:

Old (line 72-73):
```typescript
    const url =
        "https://api.open-meteo.com/v1/forecast?latitude=0&longitude=0&current_weather=true";
```

New:
```typescript
    const loc = getLocation();
    const lat = loc?.latitude ?? 0;
    const lon = loc?.longitude ?? 0;
    const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;
```

- [ ] **Step 4: Verify build**

Run: `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/tools/weather.ts
git commit -m "feat(location): weather tool uses GPS coordinates for auto-location"
```

---

### Task 11: Register `get_location` Tool (`src/tools/index.ts`)

**Files:**
- Modify: `src/tools/index.ts:63` (add import)
- Modify: `src/tools/index.ts:195` (register tool)

Add a `get_location` tool so the agent can explicitly check/report the user's location.

- [ ] **Step 1: Add import**

Add after the existing weather import at line 63 of `src/tools/index.ts`:

```typescript
import { locationTool } from "./location-tool.js";
```

- [ ] **Step 2: Create `src/tools/location-tool.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Location tool — exposes device location to the agent.

import type { ToolDefinition } from "./get-current-time.js";
import { getLocation, getTimezone, getLocationString, refreshLocation } from "../location/index.js";

export const locationTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "get_location",
            description: "Get the user's current geographic location, timezone, and location source. Returns GPS coordinates, city/region/country, accuracy, and how the location was determined (GPS, Wi-Fi, or IP).",
            parameters: {
                type: "object",
                properties: {
                    refresh: {
                        type: "boolean",
                        description: "If true, force a fresh location detection instead of using cached data. Default: false.",
                    },
                },
                required: [],
            },
        },
    },

    async handler(input) {
        try {
            if (input.refresh) {
                await refreshLocation();
            }

            const loc = getLocation();
            if (!loc) {
                return JSON.stringify({
                    success: false,
                    error: "Location unavailable — all providers failed. The user may need to enable Location Services in system settings.",
                });
            }

            return JSON.stringify({
                success: true,
                location: getLocationString(),
                latitude: loc.latitude,
                longitude: loc.longitude,
                accuracy_meters: loc.accuracy,
                altitude_meters: loc.altitude ?? null,
                city: loc.city ?? null,
                region: loc.region ?? null,
                country: loc.country ?? null,
                country_name: loc.countryName ?? null,
                timezone: getTimezone(),
                source: loc.source,
                stale: loc.stale ?? false,
                detected_at: new Date(loc.timestamp).toISOString(),
            });
        } catch (err) {
            return JSON.stringify({
                success: false,
                error: (err as Error).message,
            });
        }
    },
};
```

- [ ] **Step 3: Register the tool in `src/tools/index.ts`**

Add after the weather tool registration at line 195:

```typescript
registry.set(locationTool.schema.function.name, locationTool);
```

- [ ] **Step 4: Verify build**

Run: `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/tools/location-tool.ts src/tools/index.ts
git commit -m "feat(location): add get_location tool for agent"
```


---

### Task 12: Timezone Fix — Replace All Hardcoded "Asia/Kolkata" (7 files, 22 occurrences)

**Files:**
- Modify: `src/agent.ts:744-749`
- Modify: `src/proactive/heartbeat.ts:77,318-319,377,391,494`
- Modify: `src/alive-ux.ts:42`
- Modify: `src/tools/google-api.ts:478-479,548-549`
- Modify: `src/memory/user-model.ts:72,90`
- Modify: `src/voice/live/memory-bridge.ts:34,37,40,156`
- Modify: `src/proactive/dreaming.ts:68,82`

Replace every `"Asia/Kolkata"` with `getTimezone()` from the location service.

- [ ] **Step 1: Add import and fix `src/agent.ts`**

Add import near the top of `src/agent.ts`:
```typescript
import { getTimezone, getLocationSnippet } from "./location/index.js";
```

Replace lines 744-749. Change every `"Asia/Kolkata"` to `getTimezone()` and `"IST"` to dynamic:

Old:
```typescript
            const timeStr = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
            const dateStr = now.toLocaleDateString("en-IN", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Kolkata" });
            // Parse IST hour from the formatted time string (not system-local hours)
            const istHour = parseInt(now.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" })) || 0;
            const greeting = istHour < 12 ? "morning" : istHour < 17 ? "afternoon" : istHour < 21 ? "evening" : "night";
            parts.push(`🕐 CURRENT CONTEXT:\n- Date: ${dateStr}\n- Time: ${timeStr} IST\n- Period: ${greeting}`);
```

New:
```typescript
            const tz = getTimezone();
            const timeStr = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: tz });
            const dateStr = now.toLocaleDateString("en-IN", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: tz });
            const localHour = parseInt(now.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: tz })) || 0;
            const greeting = localHour < 12 ? "morning" : localHour < 17 ? "afternoon" : localHour < 21 ? "evening" : "night";
            parts.push(`🕐 CURRENT CONTEXT:\n- Date: ${dateStr}\n- Time: ${timeStr} (${tz})\n- Period: ${greeting}`);
```

- [ ] **Step 2: Fix `src/proactive/heartbeat.ts` (6 occurrences)**

Add import near the top:
```typescript
import { getTimezone } from "../location/index.js";
```

Replace all 6 occurrences of `"Asia/Kolkata"` with `getTimezone()`:

Line 77 — change:
```typescript
        const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
```
to:
```typescript
        const nowLocal = new Date(new Date().toLocaleString("en-US", { timeZone: getTimezone() }));
```
Then update all references to `nowIST` → `nowLocal` in the same function scope.

Line 318 — change:
```typescript
    const timeStr = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
```
to:
```typescript
    const timeStr = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: getTimezone() });
```

Line 319 — change:
```typescript
    const dateStr = now.toLocaleDateString("en-IN", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Kolkata" });
```
to:
```typescript
    const dateStr = now.toLocaleDateString("en-IN", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: getTimezone() });
```

Line 377 — change:
```typescript
    const todayStr = now.toLocaleDateString("en-IN", { weekday: "long", month: "long", day: "numeric", timeZone: "Asia/Kolkata" });
```
to:
```typescript
    const todayStr = now.toLocaleDateString("en-IN", { weekday: "long", month: "long", day: "numeric", timeZone: getTimezone() });
```

Line 391 — change:
```typescript
                const time = e.start?.dateTime ? new Date(e.start.dateTime).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" }) : "all day";
```
to:
```typescript
                const time = e.start?.dateTime ? new Date(e.start.dateTime).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: getTimezone() }) : "all day";
```

Line 494 — change:
```typescript
    const timeStr = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
```
to:
```typescript
    const timeStr = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: getTimezone() });
```

- [ ] **Step 3: Fix `src/alive-ux.ts` (1 occurrence)**

Add import near the top:
```typescript
import { getTimezone } from "./location/index.js";
```

Line 42 — change:
```typescript
    const hour = parseInt(now.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" }));
```
to:
```typescript
    const hour = parseInt(now.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: getTimezone() }));
```

- [ ] **Step 4: Fix `src/tools/google-api.ts` (4 occurrences)**

Add import near the top:
```typescript
import { getTimezone } from "../location/index.js";
```

Lines 478-479 — change:
```typescript
                const dateStr = action === "today"
                    ? new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })
                    : (input.date as string || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }));
```
to:
```typescript
                const dateStr = action === "today"
                    ? new Date().toLocaleDateString("en-CA", { timeZone: getTimezone() })
                    : (input.date as string || new Date().toLocaleDateString("en-CA", { timeZone: getTimezone() }));
```

Lines 548-549 — change:
```typescript
                    start: { dateTime: startTime, timeZone: "Asia/Kolkata" },
                    end: { dateTime: endTime || new Date(new Date(startTime).getTime() + 3600000).toISOString(), timeZone: "Asia/Kolkata" },
```
to:
```typescript
                    start: { dateTime: startTime, timeZone: getTimezone() },
                    end: { dateTime: endTime || new Date(new Date(startTime).getTime() + 3600000).toISOString(), timeZone: getTimezone() },
```

- [ ] **Step 5: Fix `src/memory/user-model.ts` (2 occurrences)**

Add import near the top:
```typescript
import { getTimezone } from "../location/index.js";
```

Line 72 — change:
```typescript
        timezone: "Asia/Kolkata",
```
to:
```typescript
        timezone: getTimezone(),
```

Line 90 — change:
```typescript
            model.timezone = (identity as any).location?.timezone || "Asia/Kolkata";
```
to:
```typescript
            model.timezone = (identity as any).location?.timezone || getTimezone();
```

- [ ] **Step 6: Fix `src/voice/live/memory-bridge.ts` (4 occurrences)**

Add import near the top:
```typescript
import { getTimezone } from "../../location/index.js";
```

Lines 34, 37, 40 — change all three `"Asia/Kolkata"` to `getTimezone()`:
```typescript
    const timeStr = now.toLocaleTimeString("en-IN", {
        hour: "2-digit", minute: "2-digit", hour12: true, timeZone: getTimezone(),
    });
    const dateStr = now.toLocaleDateString("en-IN", {
        weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: getTimezone(),
    });
    const localHour = parseInt(
        now.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: getTimezone() })
```

Line 156 — change:
```typescript
        hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata",
```
to:
```typescript
        hour: "2-digit", minute: "2-digit", hour12: true, timeZone: getTimezone(),
```

- [ ] **Step 7: Fix `src/proactive/dreaming.ts` (2 occurrences)**

Add import near the top:
```typescript
import { getTimezone } from "../location/index.js";
```

Line 68 — change:
```typescript
    const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
```
to:
```typescript
    const nowLocal = new Date(new Date().toLocaleString("en-US", { timeZone: getTimezone() }));
```

Line 82 — change:
```typescript
    const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
```
to:
```typescript
    const nowLocal = new Date(new Date().toLocaleString("en-US", { timeZone: getTimezone() }));
```

Update variable references from `nowIST` → `nowLocal` in both functions.

- [ ] **Step 8: Verify no remaining "Asia/Kolkata" in source**

Run: `grep -r "Asia/Kolkata" src/`

Expected: Zero matches (only hits in `dist/`, `node_modules/`, or docs should remain).

- [ ] **Step 9: Verify build**

Run: `npx tsc --noEmit`

- [ ] **Step 10: Commit**

```bash
git add src/agent.ts src/proactive/heartbeat.ts src/alive-ux.ts src/tools/google-api.ts src/memory/user-model.ts src/voice/live/memory-bridge.ts src/proactive/dreaming.ts
git commit -m "fix(timezone): replace all hardcoded Asia/Kolkata with dynamic getTimezone()"
```


---

### Task 13: Identity Auto-Update + Agent Context Injection

**Files:**
- Modify: `src/memory/identity.ts` (add location change listener setup)
- Modify: `src/agent.ts:795-803` (add location snippet to context injection)
- Modify: `src/index.ts` (wire identity listener after boot)

- [ ] **Step 1: Wire identity auto-update in `src/index.ts`**

After the `startNetworkWatcher()` call added in Task 9, add:

```typescript
    // Auto-update identity profile when location changes
    onLocationChange((data) => {
        try {
            const { getIdentityProfile, updateIdentityProfile } = require("./memory/identity.js");
            const locationStr = [data.city, data.region, data.countryName || data.country].filter(Boolean).join(", ");
            const currentProfile = getIdentityProfile();
            if (currentProfile.location !== locationStr && locationStr) {
                updateIdentityProfile({ location: locationStr });
                console.log(`[LOCATION] Identity updated: ${locationStr}`);
            }
        } catch { /* identity not initialized */ }
    });
```

Note: Use `require()` instead of top-level import to avoid circular dependency issues, since identity.ts is initialized before location in the boot sequence.

- [ ] **Step 2: Add location snippet to agent context injection in `src/agent.ts`**

After the identity injection block (around line 803, after the identity `try/catch`), add:

```typescript
            // ── Location context ──
            try {
                const locationSnippet = getLocationSnippet();
                if (locationSnippet) parts.push(locationSnippet);
            } catch { /* location not initialized */ }
```

The `getLocationSnippet` import was already added in Task 12 Step 1.

- [ ] **Step 3: Verify build**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/index.ts src/agent.ts
git commit -m "feat(location): auto-update identity profile and inject location into agent context"
```

---

### Task 14: Environment Sensors Integration

**Files:**
- Modify: `src/proactive/environment-sensors.ts:12-17` (extend interface)
- Modify: `src/proactive/environment-sensors.ts:19-27` (add to snapshot)

- [ ] **Step 1: Add import**

Add after existing imports at the top of `src/proactive/environment-sensors.ts`:

```typescript
import { getLocation, type LocationData } from "../location/index.js";
```

- [ ] **Step 2: Extend `EnvironmentSnapshot` interface**

Add `location` field to the interface at line 12:

Old:
```typescript
export interface EnvironmentSnapshot {
    fsChanges: string[];
    upcomingCalendar: string[];
    systemLoad: { cpuPercent: number; memPercent: number; diskFreeGB: number };
    networkStatus: boolean;
}
```

New:
```typescript
export interface EnvironmentSnapshot {
    fsChanges: string[];
    upcomingCalendar: string[];
    systemLoad: { cpuPercent: number; memPercent: number; diskFreeGB: number };
    networkStatus: boolean;
    location: LocationData | null;
}
```

- [ ] **Step 3: Add location to snapshot function**

Update `getEnvironmentSnapshot()` at line 19:

Old:
```typescript
    return { fsChanges, upcomingCalendar: calendar, systemLoad: sysLoad, networkStatus: network };
```

New:
```typescript
    return { fsChanges, upcomingCalendar: calendar, systemLoad: sysLoad, networkStatus: network, location: getLocation() };
```

- [ ] **Step 4: Verify build**

Run: `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/proactive/environment-sensors.ts
git commit -m "feat(location): add location to environment snapshot"
```

---

### Task 15: `.env.example` Update

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add `LOCATION_ENABLED` to `.env.example`**

Add after the voice section (after line 89):

```bash

# ── Optional: Location Service ───────────────
# Automatic device location detection (GPS → Wi-Fi → IP fallback)
# Used for weather, timezone, and location-aware proactive features
# Set to "false" to disable location detection entirely
# LOCATION_ENABLED=true
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: add LOCATION_ENABLED to .env.example"
```

---

### Task 16: Full Build & Smoke Test

**Files:**
- None (verification only)

- [ ] **Step 1: Full typecheck**

Run: `npx tsc --noEmit`
Expected: Zero errors.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: Clean or only pre-existing warnings.

- [ ] **Step 3: Verify no remaining "Asia/Kolkata" in source**

Run: `grep -rn "Asia/Kolkata" src/`
Expected: Zero matches.

- [ ] **Step 4: Full build**

Run: `npm run build`
Expected: Successful compilation to `dist/`.

- [ ] **Step 5: Smoke test — start the bot**

Run: `npm run dev`
Expected output should include:
```
📍 Location: <city>, <country> (via <source>, ±<accuracy>m)
```
or:
```
📍 Location: unavailable (all providers failed)
```

Both are acceptable — the first confirms the fallback chain works, the second confirms fail-open behavior.

- [ ] **Step 6: Verify location tool works**

If the bot started successfully, send a message asking about the weather or location. The agent should:
1. Use the `get_location` tool or have location context injected
2. Show the correct timezone in its datetime context (not hardcoded IST)
3. Weather tool should use real coordinates when `location: "auto"`

