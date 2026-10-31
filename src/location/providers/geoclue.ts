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
        try {
            await execFileAsync(
                "gdbus",
                [
                    "introspect",
                    "--system",
                    "--dest",
                    "org.freedesktop.GeoClue2",
                    "--object-path",
                    "/org/freedesktop/GeoClue2/Manager",
                ],
                { timeout: 3000 },
            );
            return true;
        } catch {
            return false;
        }
    }

    async getLocation(): Promise<LocationData> {
        const { stdout: clientPath } = await execFileAsync(
            "gdbus",
            [
                "call",
                "--system",
                "--dest",
                "org.freedesktop.GeoClue2",
                "--object-path",
                "/org/freedesktop/GeoClue2/Manager",
                "--method",
                "org.freedesktop.GeoClue2.Manager.GetClient",
            ],
            { timeout: 5000 },
        );

        const pathMatch = clientPath.match(/'([^']+)'/);
        if (!pathMatch) throw new Error("GeoClue2: failed to get client path");
        const client = pathMatch[1];

        await execFileAsync(
            "gdbus",
            [
                "call",
                "--system",
                "--dest",
                "org.freedesktop.GeoClue2",
                "--object-path",
                client,
                "--method",
                "org.freedesktop.DBus.Properties.Set",
                "org.freedesktop.GeoClue2.Client",
                "DesktopId",
                "<string 'bhai-agent'>",
            ],
            { timeout: 3000 },
        );

        await execFileAsync(
            "gdbus",
            [
                "call",
                "--system",
                "--dest",
                "org.freedesktop.GeoClue2",
                "--object-path",
                client,
                "--method",
                "org.freedesktop.GeoClue2.Client.Start",
            ],
            { timeout: 3000 },
        );

        let latitude = NaN;
        let longitude = NaN;
        let accuracy = NaN;

        for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 500));
            try {
                const { stdout: locOut } = await execFileAsync(
                    "gdbus",
                    [
                        "call",
                        "--system",
                        "--dest",
                        "org.freedesktop.GeoClue2",
                        "--object-path",
                        client,
                        "--method",
                        "org.freedesktop.DBus.Properties.GetAll",
                        "org.freedesktop.GeoClue2.Location",
                    ],
                    { timeout: 3000 },
                );

                const latMatch = locOut.match(/Latitude.*?(-?\d+\.?\d*)/);
                const lonMatch = locOut.match(/Longitude.*?(-?\d+\.?\d*)/);
                const accMatch = locOut.match(/Accuracy.*?(-?\d+\.?\d*)/);

                if (latMatch && lonMatch) {
                    latitude = parseFloat(latMatch[1]);
                    longitude = parseFloat(lonMatch[1]);
                    accuracy = accMatch ? parseFloat(accMatch[1]) : 1000;
                    break;
                }
            } catch {
                /* location not ready yet */
            }
        }

        try {
            await execFileAsync(
                "gdbus",
                [
                    "call",
                    "--system",
                    "--dest",
                    "org.freedesktop.GeoClue2",
                    "--object-path",
                    client,
                    "--method",
                    "org.freedesktop.GeoClue2.Client.Stop",
                ],
                { timeout: 3000 },
            );
        } catch {
            /* best-effort cleanup */
        }

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
