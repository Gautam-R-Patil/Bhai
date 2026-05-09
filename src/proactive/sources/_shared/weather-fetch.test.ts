// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../location/index.js", () => ({
    getLocation: vi.fn(() => ({ city: "Bangalore", region: "Karnataka", country: "IN" })),
}));

vi.mock("./calendar-fetch.js", () => ({
    fetchCalendarToday: vi.fn(async () => []),
}));

import { fetchWeather, _resetWeatherCache, type WeatherFetchDeps } from "./weather-fetch.js";
import { getLocation } from "../../../location/index.js";
import { fetchCalendarToday } from "./calendar-fetch.js";

function makeMockLlm(parsedJson: object) {
    return {
        chat: vi.fn(async () => ({
            choices: [{ message: { content: JSON.stringify(parsedJson) } }],
        })),
        config: {},
    } as any;
}

describe("weather-fetch", () => {
    beforeEach(() => {
        _resetWeatherCache();
        vi.mocked(getLocation).mockReturnValue({ city: "Bangalore", region: "Karnataka", country: "IN" } as any);
        vi.mocked(fetchCalendarToday).mockResolvedValue([]);
    });

    it("returns null when location is unavailable", async () => {
        vi.mocked(getLocation).mockReturnValueOnce(null);
        const result = await fetchWeather({
            llm: makeMockLlm({ summary: "sunny", temp_c: 28, rain_prob: 0.1 }),
            webSearch: vi.fn(async () => "sunny 28°C"),
        });
        expect(result).toBeNull();
    });

    it("returns null when llm is null", async () => {
        const result = await fetchWeather({
            llm: null,
            webSearch: vi.fn(async () => "sunny"),
        });
        expect(result).toBeNull();
    });

    it("returns null when webSearch throws", async () => {
        const result = await fetchWeather({
            llm: makeMockLlm({ summary: "sunny", temp_c: 28, rain_prob: 0.1 }),
            webSearch: vi.fn(async () => { throw new Error("network"); }),
        });
        expect(result).toBeNull();
    });

    it("parses LLM JSON into structured weather result", async () => {
        const deps: WeatherFetchDeps = {
            llm: makeMockLlm({ summary: "Partly cloudy", temp_c: 26, rain_prob: 0.3 }),
            webSearch: vi.fn(async () => "weather search result text"),
        };
        const result = await fetchWeather(deps);
        expect(result).not.toBeNull();
        expect(result!.summary).toBe("Partly cloudy");
        expect(result!.tempC).toBe(26);
        expect(result!.rainProb).toBe(0.3);
        expect(result!.locationStr).toBe("Bangalore, Karnataka");
    });

    it("caches by location — only one LLM call for same location", async () => {
        const llm = makeMockLlm({ summary: "Sunny", temp_c: 30, rain_prob: 0 });
        const deps: WeatherFetchDeps = {
            llm,
            webSearch: vi.fn(async () => "search result"),
        };
        await fetchWeather(deps);
        await fetchWeather(deps);
        expect(llm.chat).toHaveBeenCalledTimes(1);
    });

    it("detects outdoor event in calendar", async () => {
        vi.mocked(fetchCalendarToday).mockResolvedValueOnce([
            { id: "e1", title: "Morning run in the park", startMs: 0, endMs: 0, hasAttendees: false, isAllDay: false },
        ] as any);
        const deps: WeatherFetchDeps = {
            llm: makeMockLlm({ summary: "Clear", temp_c: 22, rain_prob: 0.05 }),
            webSearch: vi.fn(async () => "weather data"),
        };
        const result = await fetchWeather(deps);
        expect(result!.hasOutdoorEvent).toBe(true);
    });

    it("hasOutdoorEvent is false with no outdoor events", async () => {
        vi.mocked(fetchCalendarToday).mockResolvedValueOnce([
            { id: "e2", title: "Team standup", startMs: 0, endMs: 0, hasAttendees: true, isAllDay: false },
        ] as any);
        const deps: WeatherFetchDeps = {
            llm: makeMockLlm({ summary: "Clear", temp_c: 22, rain_prob: 0 }),
            webSearch: vi.fn(async () => "weather data"),
        };
        const result = await fetchWeather(deps);
        expect(result!.hasOutdoorEvent).toBe(false);
    });

    it("ATLAS_PROACTIVE_WEATHER_LOCATION overrides getLocation and uses env value in search query", async () => {
        vi.mocked(getLocation).mockClear();
        process.env.ATLAS_PROACTIVE_WEATHER_LOCATION = "Mumbai, India";
        try {
            const webSearch = vi.fn(async () => "Mumbai weather data");
            const deps: WeatherFetchDeps = {
                llm: makeMockLlm({ summary: "Hot", temp_c: 35, rain_prob: 0.2 }),
                webSearch,
            };
            const result = await fetchWeather(deps);
            expect(result).not.toBeNull();
            expect(result!.locationStr).toBe("Mumbai, India");
            const calls = (webSearch.mock.calls as unknown as Array<[string]>).map(c => c[0]);
            expect(calls[0]).toContain("Mumbai, India");
            expect(getLocation).not.toHaveBeenCalled();
        } finally {
            delete process.env.ATLAS_PROACTIVE_WEATHER_LOCATION;
        }
    });
});
