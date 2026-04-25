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

# Check access status first
$accessTask = [Windows.Devices.Geolocation.Geolocator]::RequestAccessAsync()
$sw = [System.Diagnostics.Stopwatch]::StartNew()
while ($accessTask.Status -eq 'Started' -and $sw.ElapsedMilliseconds -lt 5000) {
    Start-Sleep -Milliseconds 100
}
$accessStatus = $accessTask.GetResults()
if ($accessStatus -ne 'Allowed') {
    Write-Output "error|location_access_denied|Enable Location in Windows Settings > Privacy & Security > Location"
    exit
}

$gl = New-Object Windows.Devices.Geolocation.Geolocator
$gl.DesiredAccuracy = [Windows.Devices.Geolocation.PositionAccuracy]::High

try {
    $task = $gl.GetGeopositionAsync()
    $sw2 = [System.Diagnostics.Stopwatch]::StartNew()
    while ($task.Status -eq 'Started' -and $sw2.ElapsedMilliseconds -lt 8000) {
        Start-Sleep -Milliseconds 100
    }
    if ($task.Status -ne 'Completed') {
        Write-Output "error|timeout|Location request timed out"
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
            const parts = result.split("|");
            const code = parts[1];
            const hint = parts[2] || "";
            if (code === "location_access_denied") {
                throw new Error(`Windows location access denied. ${hint}`);
            }
            throw new Error(`WinGeoloc: ${code}${hint ? ` — ${hint}` : ""}`);
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
