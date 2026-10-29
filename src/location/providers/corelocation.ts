// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
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

// Resolve path to the compiled Swift helper across dev + packaged layouts.
// Dev (tsx or compiled dist): scripts/ sits three levels above this file
// after bundling into desktop/ it lands at Contents/Resources/bot/scripts/.
function getHelperPath(): string | null {
	const here = dirname(fileURLToPath(import.meta.url));
	const cwd = process.cwd();
	const candidates = [
		join(here, "..", "..", "..", "scripts", "get_location_bin"), // src/location/providers → repo root
		join(here, "scripts", "get_location_bin"),                    // bundled next to mjs
		join(cwd, "scripts", "get_location_bin"),                     // cwd-relative (Electron bot/)
	];
	return candidates.find(existsSync) ?? null;
}

export class CoreLocationProvider implements LocationProvider {
	name = "gps";

	async isAvailable(): Promise<boolean> {
		if (process.platform !== "darwin") return false;
		const helperPath = getHelperPath();
		if (helperPath === null) {
			console.warn("[LOCATION] CoreLocation helper not found — run 'npm run build:location' to compile it");
			return false;
		}
		return true;
	}

	async getLocation(): Promise<LocationData> {
		const helperPath = getHelperPath();
		if (helperPath === null) {
			throw new Error("CoreLocation helper missing");
		}
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
