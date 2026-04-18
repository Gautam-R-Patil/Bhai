# Location Service for ATLAS

**Date:** 2026-04-16
**Status:** Approved
**Scope:** New `src/location/` module + integration with 8 existing subsystems

## Summary

Give ATLAS automatic device-level location awareness using a multi-tier fallback chain: native GPS -> Wi-Fi geolocation -> IP geolocation. Location data feeds into weather, identity, timezone, proactive suggestions, and agent context. Refresh is event-driven (triggered by Wi-Fi network changes), not polling-based.

## Requirements

1. Detect the user's geographic location automatically on macOS, Windows, and Linux
2. Fallback gracefully when GPS hardware is absent, permissions denied, or the device is a VM/server
3. Refresh location when the Wi-Fi network changes (SSID switch)
4. Auto-update identity profile, fix hardcoded IST timezone, enable location-aware proactive features
5. All dependencies auto-install via `npm install` — no manual setup steps
6. Fail-open: if all location providers fail, ATLAS continues without location data

## Non-Goals

- Real-time GPS tracking (this is a laptop agent, not a mobile app)
- Indoor positioning or floor-level accuracy
- Location history or trajectory tracking
- Geofencing with configurable zones (future scope)

## Dependencies

All dependencies are either already in the project or are zero-install (using built-in Node.js APIs and OS-level CLI tools):

- **No new npm packages required.** All platform-native calls use `child_process.execFile` (already used extensively throughout the codebase for `osascript`, `powershell.exe`, `nmcli`, etc.)
- **ip-api.com** — Free HTTP API, no API key, called via `fetch()` (built into Node.js 20+)
- **Platform CLI tools** (already present on target OSes):
  - macOS: `osascript` (for CoreLocation via JXA), `airport` (for Wi-Fi scan)
  - Windows: `powershell.exe` (for Windows.Devices.Geolocation and `netsh`)
  - Linux: `gdbus` (for GeoClue2, optional), `nmcli` (for Wi-Fi scan)

All of these are the same tools already used in `src/tools/system-controls.ts` and `src/proactive/environment-sensors.ts`.

## Module Structure

```
src/location/
├── index.ts              — LocationService singleton, public API, EventEmitter
├── providers/
│   ├── corelocation.ts   — macOS: CoreLocation via osascript/JXA
│   ├── win-geoloc.ts     — Windows: Windows.Devices.Geolocation via PowerShell
│   ├── geoclue.ts        — Linux: GeoClue2 via gdbus D-Bus call
│   ├── wifi-geoloc.ts    — Cross-platform: Wi-Fi BSSID scan → free geolocation API
│   └── ip-geoloc.ts      — Cross-platform: ip-api.com (free, city-level)
└── network-watcher.ts    — SSID change detection, triggers location refresh
```

## Data Shape

```typescript
export interface LocationData {
    latitude: number;
    longitude: number;
    accuracy: number;          // meters — GPS ~10m, Wi-Fi ~100m, IP ~10km
    altitude?: number;         // meters, only from native GPS
    city?: string;             // reverse-geocoded city name
    region?: string;           // state/province
    country?: string;          // ISO country code
    countryName?: string;      // full country name
    timezone?: string;         // IANA timezone (e.g., "America/New_York")
    source: LocationSource;    // which provider resolved this
    timestamp: number;         // Date.now() when acquired
    stale?: boolean;           // true if this is cached past TTL
}

export type LocationSource = "gps" | "wifi" | "ip" | "manual";

export interface LocationProvider {
    name: string;
    isAvailable(): Promise<boolean>;
    getLocation(): Promise<LocationData>;
}
```

## LocationService API

```typescript
class LocationService extends EventEmitter {
    // Initialization (called at boot)
    static async init(): Promise<LocationService>;

    // Cached last-known location (synchronous, returns null if never detected)
    getLocation(): LocationData | null;

    // Force re-detect through the fallback chain
    refreshLocation(): Promise<LocationData | null>;

    // Derived timezone from coordinates (falls back to system timezone)
    getTimezone(): string;

    // Human-readable location string (e.g., "Mumbai, Maharashtra, India")
    getLocationString(): string;

    // Event: 'locationChanged' — fires when location changes meaningfully (>1km)
    on(event: 'locationChanged', listener: (data: LocationData) => void): this;

    // Cleanup
    destroy(): void;
}
```

Singleton pattern matches `network-health.ts` — module-level functions exported for easy import:
```typescript
export function initLocationService(): Promise<void>;
export function getLocation(): LocationData | null;
export function getTimezone(): string;
export function getLocationString(): string;
export function onLocationChange(listener: (data: LocationData) => void): void;
export function refreshLocation(): Promise<LocationData | null>;
```

## Fallback Chain

Executes top-down, stopping at the first successful provider. Each provider has a 5-second timeout. Total chain budget: 15 seconds.

### Tier 1: Native GPS

**macOS — CoreLocation via JXA (`corelocation.ts`)**

Uses `osascript -l JavaScript` to invoke CoreLocation:
```javascript
// Spawns: osascript -l JavaScript -e '<JXA script>'
// The JXA script creates a CLLocationManager, requests a single location update,
// waits up to 5s, and prints "lat|lon|altitude|accuracy" to stdout.
// If Location Services disabled or permission denied, prints "error|<reason>".
```

Permission: macOS prompts the user on first use. If denied, provider returns failure and chain continues.

**Windows — Windows.Devices.Geolocation via PowerShell (`win-geoloc.ts`)**

```powershell
# Spawns: powershell.exe -NoProfile -Command '<script>'
# Creates a Windows.Devices.Geolocation.Geolocator instance,
# calls GetGeopositionAsync, returns lat|lon|altitude|accuracy.
# Falls through if location services disabled or user denies prompt.
```

**Linux — GeoClue2 via D-Bus (`geoclue.ts`)**

```bash
# Spawns: gdbus call --system --dest org.freedesktop.GeoClue2 ...
# Calls GetClient → Start → gets Location object with lat/lon/accuracy.
# Falls through if GeoClue2 is not installed (common on servers/minimal installs).
```

### Tier 2: Wi-Fi Geolocation (`wifi-geoloc.ts`)

1. Scan for nearby Wi-Fi access points (BSSIDs + signal strength):
   - macOS: `/System/Library/PrivateFrameworks/Apple80211.framework/.../airport -s`
   - Windows: `netsh wlan show networks mode=bssid`
   - Linux: `nmcli -t -f bssid,signal dev wifi list`
2. Use the scanned BSSID data with a free geolocation approach. Two options depending on what's available:
   - **Primary:** Apple's locationd (macOS) and Windows Location API already use Wi-Fi internally in Tier 1 — so on those platforms, if Tier 1 failed, Wi-Fi geolocation likely won't add value. On Linux, GeoClue2 already uses Wi-Fi when available.
   - **Fallback approach:** If none of the native APIs worked but we got BSSIDs, use the `wigle.net` free API (limited to 5 queries/day without key) or skip to IP tier.
3. Receives lat/lon with ~100-200m accuracy when it works

Practically, this tier adds the most value on Linux systems where GeoClue2 is not installed but Wi-Fi hardware exists. On macOS/Windows, the native GPS tier already uses Wi-Fi signals internally.

Fallback: If no Wi-Fi adapter, scan returns empty, or API fails → chain continues to IP tier.

### Tier 3: IP Geolocation (`ip-geoloc.ts`)

```
GET http://ip-api.com/json/?fields=status,lat,lon,city,regionName,countryCode,country,timezone
```

- Free tier: 45 requests/minute (more than sufficient for our refresh pattern)
- No API key required
- City-level accuracy (~5-50km)
- Works on any device with internet access
- Always the final fallback — if this fails too, we have no location

## Network Watcher (`network-watcher.ts`)

Polls the current Wi-Fi SSID every 60 seconds using the same commands already in `system-controls.ts`:
- macOS: `airport -I` → parse ` SSID:` line
- Windows: `netsh wlan show interfaces` → parse `SSID` line
- Linux: `nmcli -t -f active,ssid dev wifi` → find `yes:` line

When SSID changes from the last known value:
1. Emit a `'networkChanged'` event
2. Call `LocationService.refreshLocation()`
3. If location changed meaningfully (>1km haversine distance), emit `'locationChanged'`

Also hooks into the existing `onNetworkStatusChange` from `network-health.ts` — when network transitions from offline → online, trigger a refresh (the network may have changed while offline).

## Caching & Staleness

- Location cached in memory with 30-minute TTL
- Network change events bypass TTL and force refresh
- If cache is stale and all providers fail, last-known location is returned with `stale: true`
- On clean boot with no cached data and all providers failing, `getLocation()` returns `null`
- Consumers must handle `null` gracefully (this is consistent with the fail-open pattern)

## Integration Points

### A. Boot Sequence (`src/index.ts`)

Add to the Phase 2 `Promise.all` block (non-blocking, fail-open):

```typescript
import { initLocationService } from "./location/index.js";
// ...
initLocationService().catch(e => console.warn("[BOOT] Location:", (e as Error).message)),
```

After Phase 2, start the network watcher and register the network-health hook:

```typescript
import { startNetworkWatcher } from "./location/network-watcher.js";
import { onLocationChange } from "./location/index.js";

startNetworkWatcher();
onNetworkStatusChange((event) => {
    if (event.next === "online" && event.prev === "offline") {
        refreshLocation(); // Network changed while offline — re-detect
    }
});
```

### B. Weather Tool (`src/tools/weather.ts`)

Modify the `location: "auto"` behavior in `resolveLocation()`:

```typescript
import { getLocation } from "../location/index.js";

function resolveLocation(location: string): string {
    if (location === "auto" || location === "") {
        const loc = getLocation();
        if (loc) return `${loc.latitude},${loc.longitude}`;
        return ""; // Fall back to wttr.in's IP-based detection
    }
    return encodeURIComponent(location);
}
```

Also fix the Open-Meteo fallback to use real coordinates instead of `0,0`:

```typescript
async function fetchOpenMeteoFallback(): Promise<Record<string, unknown>> {
    const loc = getLocation();
    const lat = loc?.latitude ?? 0;
    const lon = loc?.longitude ?? 0;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;
    // ... rest unchanged
}
```

### C. Identity Profile (`src/memory/identity.ts`)

Subscribe to location changes and auto-update the identity profile:

```typescript
onLocationChange((data) => {
    const locationStr = [data.city, data.region, data.country].filter(Boolean).join(", ");
    const currentProfile = getIdentityProfile();
    // Only update if meaningfully different (not just coordinate drift)
    if (currentProfile.location !== locationStr && locationStr) {
        updateIdentityProfile({ location: locationStr });
    }
});
```

This replaces manual location entry — the agent always knows where the user is.

### D. Timezone Fix (replace hardcoded "Asia/Kolkata")

Create a shared timezone utility:

```typescript
// In src/location/index.ts
export function getTimezone(): string {
    const loc = getLocation();
    if (loc?.timezone) return loc.timezone;
    // System timezone as fallback (works even without GPS)
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
```

Files to update — replace all `"Asia/Kolkata"` with `getTimezone()`:

| File | Line(s) | Current | Change |
|------|---------|---------|--------|
| `src/agent.ts` | ~744-747 | `"Asia/Kolkata"` literal | `getTimezone()` |
| `src/proactive/heartbeat.ts` | ~77, 318-319 | `"Asia/Kolkata"` literal | `getTimezone()` |
| `src/alive-ux.ts` | ~42 | `"Asia/Kolkata"` literal | `getTimezone()` |
| `src/tools/google-api.ts` | ~478-479, 548-549 | `"Asia/Kolkata"` literal | `getTimezone()` |
| `src/memory/user-model.ts` | ~72, 90 | `"Asia/Kolkata"` default | `getTimezone()` |
| `src/voice/live/memory-bridge.ts` | ~34, 37, 40, 156 | `"Asia/Kolkata"` literal | `getTimezone()` |
| `src/proactive/dreaming.ts` | ~68, 82 | `"Asia/Kolkata"` literal | `getTimezone()` |

### E. Environment Sensors (`src/proactive/environment-sensors.ts`)

Extend `EnvironmentSnapshot` to include location:

```typescript
export interface EnvironmentSnapshot {
    fsChanges: string[];
    upcomingCalendar: string[];
    systemLoad: { cpuPercent: number; memPercent: number; diskFreeGB: number };
    networkStatus: boolean;
    location: LocationData | null;  // NEW
}
```

In `getEnvironmentSnapshot()`, add `getLocation()` to the snapshot.

### F. Agent Context Injection (`src/agent.ts`)

Add a location snippet to the memory injection at iteration 1 (alongside identity, traits, etc.):

```
📍 CURRENT LOCATION: Mumbai, Maharashtra, India (19.076°N, 72.877°E)
   Timezone: Asia/Kolkata | Source: GPS | Updated: 5 min ago
```

Budget: ~100 tokens. Only injected when location is available.

### G. Proactive Features (`src/proactive/`)

With location available, the proactive system gains:
- **Location-aware greetings:** "Good morning from Mumbai — 28°C and sunny"
- **Weather alerts:** Proactive notification when conditions change significantly
- **Travel detection:** "Looks like you've moved to Delhi — timezone adjusted"
- **Context for recommendations:** Nearby events, local time awareness

These are enabled by the existing heartbeat/proactive infrastructure reading `getLocation()` — no new proactive subsystem needed.

### H. `get_location` Tool (for agent)

Register a new tool so the agent can explicitly check/report location:

```typescript
{
    name: "get_location",
    description: "Get the user's current geographic location, timezone, and location source.",
    parameters: { type: "object", properties: {}, required: [] }
}
```

Handler returns the current `LocationData` as JSON. Registered as cross-platform in `src/tools/index.ts`.

## Privacy & Permissions

- **Local only:** Location data stays in-memory and local SQLite. Never sent to the Convex backend.
- **Kill switch:** `LOCATION_ENABLED=false` in `.env` disables the entire location system.
- **OS permissions:** macOS and Windows will prompt the user for location permission on first use. If denied, the chain gracefully falls through to Wi-Fi/IP.
- **IP exposure:** The ip-api.com call reveals the user's IP address, which any web request already does. No additional privacy exposure.
- **No tracking:** No location history is stored. Only the current location is cached.

## Error Handling

Consistent with ATLAS's fail-open architecture:

- Each provider wrapped in try/catch with 5-second timeouts
- Provider failure → log warning, try next provider
- All providers fail → `getLocation()` returns `null`, consumers handle gracefully
- Network watcher failure → location still works on-demand, just no auto-refresh
- Import failure → ATLAS boots without location (same pattern as counterfactual memory, world model, etc.)

## Configuration

New `.env` variables:

```bash
LOCATION_ENABLED=true         # Master kill switch (default: true)
```

No other configuration needed. Free ip-api.com, no API keys.

## File Change Summary

| Action | File |
|--------|------|
| **Create** | `src/location/index.ts` — LocationService singleton |
| **Create** | `src/location/providers/corelocation.ts` — macOS GPS |
| **Create** | `src/location/providers/win-geoloc.ts` — Windows GPS |
| **Create** | `src/location/providers/geoclue.ts` — Linux GPS |
| **Create** | `src/location/providers/wifi-geoloc.ts` — Wi-Fi geolocation |
| **Create** | `src/location/providers/ip-geoloc.ts` — IP geolocation |
| **Create** | `src/location/network-watcher.ts` — SSID change detection |
| **Modify** | `src/index.ts` — Add location init to boot |
| **Modify** | `src/tools/weather.ts` — Use real coordinates for auto |
| **Modify** | `src/tools/index.ts` — Register `get_location` tool |
| **Modify** | `src/memory/identity.ts` — Auto-update location on change |
| **Modify** | `src/proactive/environment-sensors.ts` — Add location to snapshot |
| **Modify** | `src/agent.ts` — Add location context injection + fix timezone |
| **Modify** | `src/proactive/heartbeat.ts` — Fix timezone |
| **Modify** | `src/alive-ux.ts` — Fix timezone |
| **Modify** | `src/tools/google-api.ts` — Fix timezone |
| **Modify** | `src/memory/user-model.ts` — Fix timezone |
| **Modify** | `src/voice/live/memory-bridge.ts` — Fix timezone |
| **Modify** | `src/proactive/dreaming.ts` — Fix timezone |
| **Modify** | `.env.example` — Add `LOCATION_ENABLED` |
| **Create** | `src/tools/location-tool.ts` — get_location tool definition |

8 new files, 12 modified files.
