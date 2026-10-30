// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Location Service — automatic device location with GPS → Wi-Fi → IP fallback.
// Singleton pattern matches network-health.ts. Fail-open: null if all providers fail.

import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../config/paths.js";

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
    /** GPS only: the location permission as a short token, null when it can't be read. */
    permissionStatus?(): Promise<string | null>;
}

// ── Constants ────────────────────────────────

const CACHE_TTL_MS = 30 * 60 * 1000;
const GPS_TIMEOUT_MS = 12000;
const PROVIDER_TIMEOUT_MS = 5000;
const SIGNIFICANT_DISTANCE_KM = 1;

// ── State ────────────────────────────────────

let _location: LocationData | null = null;
let _providers: LocationProvider[] = [];
let _emitter: EventEmitter | null = null;
let _initialized = false;

// ── GPS back-off ─────────────────────────────
// The GPS helper can time out on every try (no fix, or a permission prompt that never shows):
// 60-70 times a day here, each holding location back ~12 s. After 3 timeouts in a row a
// background refresh skips GPS (Wi-Fi/IP answer at once) and tries it again once an hour, or
// as soon as the location permission changes; a refresh the owner asks for (get_location
// refresh) always tries it. On disk, because the bot
// restarts often and every boot refreshes.

const GPS_BACKOFF_AFTER = 3;
const GPS_RETRY_MS = 60 * 60_000;
type GpsBackoff = { timeouts: number; retryAt: number; status?: string | null };
const gpsBackoffFile = () => join(getDataDir(), "location-gps-backoff.json");

function readGpsBackoff(): GpsBackoff {
    try {
        return JSON.parse(readFileSync(gpsBackoffFile(), "utf8")) as GpsBackoff;
    } catch {
        return { timeouts: 0, retryAt: 0 };
    }
}

async function noteGpsResult(provider: LocationProvider, timedOut: boolean): Promise<void> {
    const prev = readGpsBackoff();
    const timeouts = timedOut ? prev.timeouts + 1 : 0;
    const status = timedOut ? ((await provider.permissionStatus?.().catch(() => null)) ?? null) : null;
    const next = { timeouts, retryAt: timeouts >= GPS_BACKOFF_AFTER ? Date.now() + GPS_RETRY_MS : 0, status };
    if (next.timeouts === prev.timeouts && next.retryAt === prev.retryAt && status === (prev.status ?? null)) return;
    try {
        writeFileSync(gpsBackoffFile(), JSON.stringify(next));
    } catch {
        /* back-off is an optimisation: without the file GPS is just tried every time */
    }
}

async function gpsBackedOff(provider: LocationProvider): Promise<boolean> {
    const b = readGpsBackoff();
    if (b.timeouts < GPS_BACKOFF_AFTER || Date.now() >= b.retryAt) return false;
    if (!b.status || !provider.permissionStatus) return true;
    // The permission changed since GPS last timed out (e.g. the owner just allowed it): try now.
    const now = await provider.permissionStatus().catch(() => null);
    return now === null || now === b.status;
}

// ── Haversine Distance ───────────────────────

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Provider Chain Execution ─────────────────

async function runProviderWithTimeout(provider: LocationProvider): Promise<LocationData | null> {
    try {
        // GPS providers get a longer timeout (Swift helper needs up to 10s for permission dialog)
        const timeout = provider.name === "gps" ? GPS_TIMEOUT_MS : PROVIDER_TIMEOUT_MS;

        const available = await Promise.race([
            provider.isAvailable(),
            new Promise<false>((r) => setTimeout(() => r(false), PROVIDER_TIMEOUT_MS)),
        ]);
        if (!available) return null;

        const location = await Promise.race([
            provider.getLocation(),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`${provider.name} timed out`)), timeout),
            ),
        ]);
        if (provider.name === "gps") await noteGpsResult(provider, false);
        return location;
    } catch (err) {
        const message = (err as Error).message;
        console.warn(`[LOCATION] Provider ${provider.name} failed:`, message);
        if (provider.name === "gps") await noteGpsResult(provider, /timed out|timeout/i.test(message));
        return null;
    }
}

async function runFallbackChain(force = false): Promise<LocationData | null> {
    for (const provider of _providers) {
        if (provider.name === "gps" && !force && (await gpsBackedOff(provider))) continue;
        const result = await runProviderWithTimeout(provider);
        if (result) {
            console.log(
                `[LOCATION] Resolved via ${provider.name}: ${result.city || "unknown"}, ${result.country || "unknown"} (±${result.accuracy}m)`,
            );
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

    try {
        const { WiFiGeolocationProvider } = await import("./providers/wifi-geoloc.js");
        _providers.push(new WiFiGeolocationProvider());
    } catch (err) {
        console.warn("[LOCATION] Wi-Fi provider load failed (non-fatal):", (err as Error).message);
    }

    try {
        const { IPGeolocationProvider } = await import("./providers/ip-geoloc.js");
        _providers.push(new IPGeolocationProvider());
    } catch (err) {
        console.warn("[LOCATION] IP provider load failed (non-fatal):", (err as Error).message);
    }

    _initialized = true;

    refreshLocation()
        .then((loc) => {
            if (loc) {
                console.log(
                    `📍 Location: ${loc.city || "unknown"}, ${loc.countryName || loc.country || "unknown"} (via ${loc.source}, ±${loc.accuracy}m)`,
                );
            } else {
                console.log("📍 Location: unavailable (all providers failed)");
            }
        })
        .catch((err) => {
            console.warn("[LOCATION] Initial detection failed:", (err as Error).message);
        });
}

/** `force`: the owner asked for a fresh location, so GPS is tried even while backed off. */
export async function refreshLocation(opts: { force?: boolean } = {}): Promise<LocationData | null> {
    const newLoc = await runFallbackChain(opts.force);
    if (!newLoc) {
        if (_location && Date.now() - _location.timestamp > CACHE_TTL_MS) {
            _location = { ..._location, stale: true };
        }
        return _location;
    }

    const prev = _location;
    _location = newLoc;

    if (prev && _emitter) {
        const dist = haversineKm(prev.latitude, prev.longitude, newLoc.latitude, newLoc.longitude);
        if (dist >= SIGNIFICANT_DISTANCE_KM) {
            _emitter.emit("locationChanged", newLoc);
        }
    } else if (!prev && _emitter) {
        _emitter.emit("locationChanged", newLoc);
    }

    return _location;
}

export function getLocation(): LocationData | null {
    if (!_location) return null;
    if (Date.now() - _location.timestamp > CACHE_TTL_MS) {
        return { ..._location, stale: true };
    }
    return _location;
}

export function getTimezone(): string {
    const loc = getLocation();
    if (loc?.timezone) return loc.timezone;
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
