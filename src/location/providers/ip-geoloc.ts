// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// IP-based geolocation provider — final fallback in the location chain.
// Uses ip-api.com (free, no API key, 45 req/min, city-level accuracy).

import type { LocationData, LocationProvider } from "../index.js";

export class IPGeolocationProvider implements LocationProvider {
    name = "ip";

    async isAvailable(): Promise<boolean> {
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
            { signal: AbortSignal.timeout(5000) },
        );
        if (!res.ok) throw new Error(`ip-api.com returned ${res.status}`);

        const data = (await res.json()) as {
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
            accuracy: 10000,
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
