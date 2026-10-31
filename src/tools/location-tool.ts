// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Location tool — exposes device location to the agent.

import { getLocation, getLocationString, getTimezone, refreshLocation } from "../location/index.js";
import type { ToolDefinition } from "./get-current-time.js";

export const locationTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "get_location",
            description:
                "Get the user's current geographic location, timezone, and location source. Returns GPS coordinates, city/region/country, accuracy, and how the location was determined (GPS, Wi-Fi, or IP).",
            parameters: {
                type: "object",
                properties: {
                    refresh: {
                        type: "boolean",
                        description:
                            "If true, force a fresh location detection instead of using cached data. Default: false.",
                    },
                },
                required: [],
            },
        },
    },

    async handler(input) {
        try {
            if (input.refresh) {
                await refreshLocation({ force: true });
            }

            const loc = getLocation();
            if (!loc) {
                return JSON.stringify({
                    success: false,
                    error: "Location unavailable — all providers failed. The user may need to enable Location Services in system settings.",
                });
            }

            return JSON.stringify({
                success: true,
                location: getLocationString(),
                latitude: loc.latitude,
                longitude: loc.longitude,
                accuracy_meters: loc.accuracy,
                altitude_meters: loc.altitude ?? null,
                city: loc.city ?? null,
                region: loc.region ?? null,
                country: loc.country ?? null,
                country_name: loc.countryName ?? null,
                timezone: getTimezone(),
                source: loc.source,
                stale: loc.stale ?? false,
                detected_at: new Date(loc.timestamp).toISOString(),
            });
        } catch (err) {
            return JSON.stringify({
                success: false,
                error: (err as Error).message,
            });
        }
    },
};
