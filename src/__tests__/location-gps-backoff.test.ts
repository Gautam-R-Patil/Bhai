// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// After a GPS timeout, background refreshes skip GPS for an hour or until the
// location permission changes; a refresh the owner asks for still tries it, and so
// does the first refresh after a restart.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

process.env.BHAI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gps-backoff-"));
Object.defineProperty(process, "platform", { value: "darwin" });

const { gps } = vi.hoisted(() => ({ gps: { calls: 0, status: "0" } }));
const fix = (source: string) => ({ latitude: 18.5, longitude: 73.8, accuracy: 5000, source, timestamp: Date.now() });
vi.mock("../location/providers/corelocation.js", () => ({
    CoreLocationProvider: class {
        name = "gps";
        isAvailable = async () => true;
        getLocation = async () => {
            gps.calls++;
            throw new Error("CoreLocation: timeout");
        };
        permissionStatus = async () => gps.status;
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

it("backs off GPS after a timeout, retries hourly, and a forced refresh still tries it", async () => {
    const loc = await import("../location/index.js");
    await loc.initLocationService();
    await vi.waitFor(() => expect(gps.calls).toBe(1)); // boot refresh timed out

    const r = await loc.refreshLocation(); // backed off: straight to IP
    expect(gps.calls).toBe(1);
    expect(r?.source).toBe("ip");

    await loc.refreshLocation({ force: true });
    expect(gps.calls).toBe(2);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61 * 60_000);
    await loc.refreshLocation();
    expect(gps.calls).toBe(3);
    vi.useRealTimers();
});

it("tries GPS again at once when the location permission changes while backed off", async () => {
    const loc = await import("../location/index.js");
    const before = gps.calls;
    await loc.refreshLocation();
    expect(gps.calls).toBe(before); // still backed off, permission unchanged
    gps.status = "3"; // the owner granted location access
    await loc.refreshLocation();
    expect(gps.calls).toBe(before + 1);
    await loc.refreshLocation(); // timed out again under the new permission: backed off again
    expect(gps.calls).toBe(before + 1);
});

it("a restart tries GPS at boot again, even within the hour after a timeout", async () => {
    const loc = await import("../location/index.js");
    const before = gps.calls;
    await loc.refreshLocation();
    expect(gps.calls).toBe(before); // backed off in this run
    vi.resetModules(); // the bot restarts
    const fresh = await import("../location/index.js");
    await fresh.initLocationService();
    await vi.waitFor(() => expect(gps.calls).toBe(before + 1));
});
