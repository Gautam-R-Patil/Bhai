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
        const { stdout } = await execFileAsync(
            "powershell.exe",
            ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", PS_SCRIPT],
            { timeout: 8000 },
        );

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
