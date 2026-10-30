// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// A GPS helper that timed out isn't waited on again for every "where am I?".
import { expect, it, vi } from "vitest";

const gps = vi.hoisted(() => ({ calls: 0 }));
const fakeGps = {
    name: "gps",
    isAvailable: async () => true,
    getLocation: async () => {
        gps.calls++;
        throw new Error("CoreLocation: timeout");
    },
};
const ip = {
    name: "ip",
    isAvailable: async () => true,
    getLocation: async () => ({ latitude: 12.97, longitude: 77.59, accuracy: 10000, source: "ip", timestamp: Date.now() }),
};
for (const m of ["corelocation", "win-geoloc", "geoclue"]) {
    vi.doMock(`../location/providers/${m}.js`, () => ({
        CoreLocationProvider: function () {
            return fakeGps;
        },
        WinGeolocationProvider: function () {
            return fakeGps;
        },
        GeoClueProvider: function () {
            return fakeGps;
        },
    }));
}
vi.doMock("../location/providers/wifi-geoloc.js", () => ({
    WiFiGeolocationProvider: function () {
        return { ...ip, name: "wifi", isAvailable: async () => false };
    },
}));
vi.doMock("../location/providers/ip-geoloc.js", () => ({
    IPGeolocationProvider: function () {
        return ip;
    },
}));

it("after a GPS timeout the next refreshes go straight to the fallback", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const loc = await import("../location/index.js");
    await loc.initLocationService();
    expect((await loc.refreshLocation())?.source).toBe("ip");
    const after = gps.calls;
    expect(after).toBeGreaterThanOrEqual(1);
    expect((await loc.refreshLocation())?.source).toBe("ip");
    expect(gps.calls).toBe(after);
    loc.destroyLocationService();
});
