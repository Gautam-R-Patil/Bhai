// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// macOS CoreLocation provider — uses a compiled Swift helper binary.
// The helper is compiled at build time (npm run build:location) and embeds an
// Info.plist so macOS can show the location permission dialog on first run.
// Falls through to Wi-Fi/IP if the helper is missing or permission is denied.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocationData, LocationProvider } from "../index.js";

const execFileAsync = promisify(execFile);

// Resolve path to the compiled Swift helper binary
function getHelperPath(): string {
	const scriptDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts");
	return join(scriptDir, "get_location_bin");
}

export class CoreLocationProvider implements LocationProvider {
	name = "gps";

	async isAvailable(): Promise<boolean> {
		if (process.platform !== "darwin") return false;
		// Check if the compiled Swift helper exists
		const helperPath = getHelperPath();
		if (!existsSync(helperPath)) {
			console.warn("[LOCATION] CoreLocation helper not found — run 'npm run build:location' to compile it");
			return false;
		}
		return true;
	}

	async getLocation(): Promise<LocationData> {
		const helperPath = getHelperPath();
		const { stdout } = await execFileAsync(helperPath, [], {
			timeout: 12000,
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
