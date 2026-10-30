// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// After 3 GPS timeouts in a row, background refreshes skip GPS for an hour; a refresh the
// owner asks for still tries it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

process.env.ATLAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gps-backoff-"));
Object.defineProperty(process, "platform", { value: "darwin" });

const { gps } = vi.hoisted(() => ({ gps: { calls: 0 } }));
const fix = (source: string) => ({ latitude: 18.5, longitude: 73.8, accuracy: 5000, source, timestamp: Date.now() });
vi.mock("../location/providers/corelocation.js", () => ({
    CoreLocationProvider: class {
        name = "gps";
        isAvailable = async () => true;
        getLocation = async () => {
            gps.calls++;
            throw new Error("CoreLocation: timeout");
        };
    },
}));
vi.mock("../location/providers/wifi-geoloc.js", () => ({
    WiFiGeolocationProvider: class {
        name = "wifi";
        isAvailable = async () => false;
        getLocation = async () => fix("wifi");
    },
}));
vi.mock("../location/providers/ip-geoloc.js", () => ({
    IPGeolocationProvider: class {
        name = "ip";
        isAvailable = async () => true;
        getLocation = async () => fix("ip");
    },
}));

it("backs off GPS after 3 timeouts, retries hourly, and a forced refresh still tries it", async () => {
    const loc = await import("../location/index.js");
    await loc.initLocationService();
    await vi.waitFor(() => expect(gps.calls).toBe(1)); // boot refresh
    await loc.refreshLocation();
    await loc.refreshLocation();
    expect(gps.calls).toBe(3);

    const r = await loc.refreshLocation(); // backed off: straight to IP
    expect(gps.calls).toBe(3);
    expect(r?.source).toBe("ip");

    await loc.refreshLocation({ force: true });
    expect(gps.calls).toBe(4);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61 * 60_000);
    await loc.refreshLocation();
    expect(gps.calls).toBe(5);
    vi.useRealTimers();
});
