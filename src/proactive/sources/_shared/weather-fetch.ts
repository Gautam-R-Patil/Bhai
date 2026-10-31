// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { getLocation } from "../../../location/index.js";
import { fetchCalendarToday } from "./calendar-fetch.js";
import type { LLMClient } from "../../../llm.js";

const TTL_MS = 3 * 3600_000;

export type WeatherFetchResult = {
    summary: string;
    tempC: number;
    rainProb: number;
    hasOutdoorEvent: boolean;
    locationStr: string;
};

const cacheByLocation = new Map<string, { result: WeatherFetchResult; expires: number }>();

const OUTDOOR_KEYWORDS = ["park", "outdoor", "outside", "beach", "hike", "run", "walk", "garden", "trail", "field"];

function hasOutdoorEvent(events: Array<{ title?: string; location?: string }>): boolean {
    for (const e of events) {
        const hay = `${e.title ?? ""} ${e.location ?? ""}`.toLowerCase();
        if (OUTDOOR_KEYWORDS.some(k => hay.includes(k))) return true;
    }
    return false;
}

async function parseWeatherFromSearch(
    searchResult: string,
    llm: LLMClient,
): Promise<{ summary: string; tempC: number; rainProb: number }> {
    try {
        const resp = await llm.chat({
            messages: [
                {
                    role: "user" as const,
                    content: `Extract weather data from this search result. Return ONLY valid JSON: {"summary": "...", "temp_c": <number>, "rain_prob": <0-1 number>}\n\n${searchResult.slice(0, 4000)}`,
                },
            ],
            systemPrompt: "You extract structured weather data. Return only a JSON object with summary (string), temp_c (number), rain_prob (0-1 float). No commentary.",
            responseFormat: "json_object",
            modelOverride: "openai/gpt-4.1-nano",
        });
        const content = resp.choices[0]?.message?.content ?? "";
        const parsed = JSON.parse(content);
        return {
            summary: typeof parsed.summary === "string" ? parsed.summary : "unknown",
            tempC: typeof parsed.temp_c === "number" ? parsed.temp_c : 20,
            rainProb: typeof parsed.rain_prob === "number" ? Math.min(1, Math.max(0, parsed.rain_prob)) : 0,
        };
    } catch {
        return { summary: "unknown", tempC: 20, rainProb: 0 };
    }
}

export type WeatherFetchDeps = {
    llm: LLMClient | null;
    webSearch: (query: string) => Promise<string>;
};

export async function fetchWeather(deps: WeatherFetchDeps): Promise<WeatherFetchResult | null> {
    const override = process.env.BHAI_PROACTIVE_WEATHER_LOCATION;
    const locationStr = override ?? (() => {
        const loc = getLocation();
        return loc ? [loc.city, loc.region].filter(Boolean).join(", ") || "unknown" : null;
    })();
    if (!locationStr) return null;
    const hit = cacheByLocation.get(locationStr);
    if (hit && hit.expires > Date.now()) return hit.result;

    if (!deps.llm) return null;

    let searchText: string;
    try {
        searchText = await deps.webSearch(`weather today ${locationStr}`);
    } catch {
        return null;
    }

    const parsed = await parseWeatherFromSearch(searchText, deps.llm);
    const events = await fetchCalendarToday();
    const hasOutdoor = hasOutdoorEvent(events.map(e => ({ title: e.title, location: e.location })));

    const result: WeatherFetchResult = {
        summary: parsed.summary,
        tempC: parsed.tempC,
        rainProb: parsed.rainProb,
        hasOutdoorEvent: hasOutdoor,
        locationStr,
    };
    cacheByLocation.set(locationStr, { result, expires: Date.now() + TTL_MS });
    return result;
}

export function _resetWeatherCache(): void {
    cacheByLocation.clear();
}
