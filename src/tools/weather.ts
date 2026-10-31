// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { getLocation } from "../location/index.js";
import type { ToolDefinition } from "./get-current-time.js";

// ── Types ─────────────────────────────────────

interface CurrentCondition {
    temp_C: string;
    temp_F: string;
    FeelsLikeC: string;
    FeelsLikeF: string;
    weatherDesc: { value: string }[];
    humidity: string;
    windspeedKmph: string;
    windspeedMiles: string;
    winddirDegree: string;
    winddir16Point: string;
    uvIndex: string;
    visibility: string;
    visibilityMiles: string;
    pressure: string;
    pressureInches: string;
}

interface WttrHourly {
    time: string;
    tempC: string;
    tempF: string;
    weatherDesc: { value: string }[];
    chanceofrain: string;
    chanceofsnow: string;
}

interface WttrDay {
    date: string;
    maxtempC: string;
    maxtempF: string;
    mintempC: string;
    mintempF: string;
    astronomy: { sunrise: string; sunset: string }[];
    hourly: WttrHourly[];
    uvIndex: string;
}

interface WttrResponse {
    current_condition: CurrentCondition[];
    weather: WttrDay[];
}

// ── Helpers ───────────────────────────────────

// wttr.in often hangs instead of failing. Three of these (wttr, geocode, Open-Meteo) must fit the 30s tool cap,
// or the cap kills the call before the fallback runs.
const FETCH_TIMEOUT_MS = 8_000;

function resolveLocation(location: string): string {
    if (location === "auto" || location === "") {
        const loc = getLocation();
        if (loc) return `${loc.latitude},${loc.longitude}`;
        return ""; // Fall back to wttr.in's IP-based detection
    }
    return encodeURIComponent(location);
}

async function fetchWttr(location: string): Promise<WttrResponse> {
    const loc = resolveLocation(location);
    const url = `https://wttr.in/${loc}?format=j1`;
    const res = await fetch(url, {
        headers: { "User-Agent": "bhai-agent/0.2.0" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`wttr.in returned ${res.status}`);
    return (await res.json()) as WttrResponse;
}

/** Coordinates for the place that was asked about, so the fallback never answers for somewhere else. */
async function fallbackCoords(location: string): Promise<{ lat: number; lon: number; name: string }> {
    if (location === "auto" || location === "") {
        const loc = getLocation();
        if (!loc) throw new Error("Weather service is unavailable and your location is unknown.");
        return { lat: loc.latitude, lon: loc.longitude, name: "auto" };
    }
    const m = location.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) return { lat: Number(m[1]), lon: Number(m[2]), name: location };
    const res = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`,
        { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) throw new Error(`Open-Meteo geocoding returned ${res.status}`);
    const place = ((await res.json()) as { results?: { latitude: number; longitude: number; name: string; country?: string }[] })
        .results?.[0];
    if (!place) throw new Error(`Couldn't find a place called "${location}".`);
    return {
        lat: place.latitude,
        lon: place.longitude,
        name: place.country ? `${place.name}, ${place.country}` : place.name,
    };
}

async function fetchOpenMeteoFallback(location: string): Promise<Record<string, unknown>> {
    const { lat, lon, name } = await fallbackCoords(location);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Open-Meteo returned ${res.status}`);
    const data = (await res.json()) as {
        current_weather: {
            temperature: number;
            windspeed: number;
            winddirection: number;
            weathercode: number;
        };
    };
    const cw = data.current_weather;
    return {
        location: name,
        temperature_c: cw.temperature,
        wind_speed_kmh: cw.windspeed,
        wind_direction_deg: cw.winddirection,
        weather_code: cw.weathercode,
        source: "open-meteo-fallback",
    };
}

function isMetric(units: string): boolean {
    return units !== "imperial";
}

function formatCurrent(c: CurrentCondition, metric: boolean) {
    return {
        temperature: metric ? `${c.temp_C}°C` : `${c.temp_F}°F`,
        feels_like: metric ? `${c.FeelsLikeC}°C` : `${c.FeelsLikeF}°F`,
        conditions: c.weatherDesc?.[0]?.value ?? "Unknown",
        humidity: `${c.humidity}%`,
        wind_speed: metric ? `${c.windspeedKmph} km/h` : `${c.windspeedMiles} mph`,
        wind_direction: `${c.winddir16Point} (${c.winddirDegree}°)`,
        uv_index: c.uvIndex,
        visibility: metric ? `${c.visibility} km` : `${c.visibilityMiles} mi`,
        pressure: metric ? `${c.pressure} hPa` : `${c.pressureInches} inHg`,
    };
}

/** "today", "tomorrow" or the weekday for a forecast date ("2026-10-31"), in the place's own calendar. */
export function dayLabel(date: string, todayDate: string): string {
    const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${todayDate}T00:00:00Z`)) / 86_400_000);
    if (days === 0) return "today";
    if (days === 1) return "tomorrow";
    return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}

function formatForecast(days: WttrDay[], metric: boolean, count: number) {
    // wttr.in's first day is the place's today. Bare dates got misread: Bhai called today's
    // forecast "kal (Sunday)" and tomorrow's "parso".
    const first = days[0]?.date ?? "";
    return days.slice(0, count).map((d) => ({
        date: d.date,
        day: dayLabel(d.date, first),
        max_temp: metric ? `${d.maxtempC}°C` : `${d.maxtempF}°F`,
        min_temp: metric ? `${d.mintempC}°C` : `${d.mintempF}°F`,
        conditions: d.hourly[4]?.weatherDesc?.[0]?.value ?? "Unknown",
        precipitation_chance: `${Math.max(...d.hourly.map((h) => parseInt(h.chanceofrain || "0", 10)))}%`,
        uv_index: d.uvIndex,
        sunrise: d.astronomy?.[0]?.sunrise ?? "N/A",
        sunset: d.astronomy?.[0]?.sunset ?? "N/A",
    }));
}

function formatHourly(day: WttrDay, metric: boolean) {
    return day.hourly.map((h) => {
        const hour = String(parseInt(h.time, 10) / 100).padStart(2, "0") + ":00";
        return {
            time: hour,
            temperature: metric ? `${h.tempC}°C` : `${h.tempF}°F`,
            conditions: h.weatherDesc?.[0]?.value ?? "Unknown",
            precipitation_chance: `${Math.max(
                parseInt(h.chanceofrain || "0", 10),
                parseInt(h.chanceofsnow || "0", 10),
            )}%`,
        };
    });
}

// ── Tool Definition ───────────────────────────

export const weatherTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "weather",
            description:
                "Get current weather, multi-day forecast, or hourly breakdown for any location. Uses wttr.in (free, no API key) with Open-Meteo fallback.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["current", "forecast", "hourly"],
                        description: "Type of weather data to retrieve.",
                    },
                    location: {
                        type: "string",
                        description:
                            'City name, coordinates (e.g. "48.8566,2.3522"), or "auto" for IP-based geolocation.',
                    },
                    units: {
                        type: "string",
                        enum: ["metric", "imperial"],
                        description: 'Unit system. Defaults to "metric".',
                    },
                    days: {
                        type: "number",
                        description: "Number of forecast days (1-7). Only used with action=forecast. Defaults to 3.",
                    },
                },
                required: ["action", "location"],
            },
        },
    },

    async handler(input) {
        try {
            const action = input.action as string;
            const location = input.location as string;
            const units = (input.units as string) || "metric";
            const days = Math.min(Math.max((input.days as number) || 3, 1), 7);
            const metric = isMetric(units);

            let data: WttrResponse;
            try {
                data = await fetchWttr(location);
            } catch {
                // Fallback to Open-Meteo for current weather only
                if (action === "current") {
                    const fallback = await fetchOpenMeteoFallback(location);
                    return JSON.stringify({ success: true, ...fallback });
                }
                throw new Error(
                    "Primary weather API (wttr.in) is unavailable and fallback does not support this action.",
                );
            }

            if (action === "current") {
                const c = data.current_condition?.[0];
                if (!c) return JSON.stringify({ error: "No current weather data available." });
                // "Should I take an umbrella?" is about today, not this minute: without the day's rain
                // chance Bhai said "take one" and "no sign of rain" in the same reply.
                const today = data.weather?.[0];
                return JSON.stringify({
                    success: true,
                    location,
                    units,
                    current: formatCurrent(c, metric),
                    ...(today?.hourly?.length ? { today: formatForecast([today], metric, 1)[0] } : {}),
                });
            }

            if (action === "forecast") {
                if (!data.weather?.length) return JSON.stringify({ error: "No forecast data available." });
                return JSON.stringify({
                    success: true,
                    location,
                    units,
                    days,
                    forecast: formatForecast(data.weather, metric, days),
                });
            }

            if (action === "hourly") {
                const today = data.weather?.[0];
                if (!today?.hourly?.length) return JSON.stringify({ error: "No hourly data available." });
                return JSON.stringify({
                    success: true,
                    location,
                    units,
                    date: today.date,
                    hourly: formatHourly(today, metric),
                });
            }

            return JSON.stringify({ error: `Unknown action: ${action}` });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return JSON.stringify({ error: message });
        }
    },
};
