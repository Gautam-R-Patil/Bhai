// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// "Should I take an umbrella?" needs today's rain chance, not just this minute's conditions.
import { afterEach, expect, it, vi } from "vitest";
import { dayLabel, weatherTool } from "../weather.js";

afterEach(() => vi.unstubAllGlobals());

it("current weather includes today's high, low and rain chance", async () => {
    const hour = (chanceofrain: string) => ({ time: "0", tempC: "20", tempF: "68", chanceofrain, chanceofsnow: "0", weatherDesc: [{ value: "Sunny" }] });
    const wttr = {
        current_condition: [{ temp_C: "19", temp_F: "66", FeelsLikeC: "21", FeelsLikeF: "70", weatherDesc: [{ value: "Haze" }], humidity: "80",
            windspeedKmph: "4", windspeedMiles: "2", winddir16Point: "WSW", winddirDegree: "253", uvIndex: "0", visibility: "5", visibilityMiles: "3", pressure: "1015", pressureInches: "30" }],
        weather: [{ date: "2026-10-31", maxtempC: "30", maxtempF: "86", mintempC: "19", mintempF: "66", uvIndex: "10",
            astronomy: [{ sunrise: "06:13 AM", sunset: "05:54 PM" }], hourly: [hour("5"), hour("15"), hour("0"), hour("0"), hour("0")] }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(wttr), { status: 200 })));
    const r = JSON.parse(String(await weatherTool.handler({ action: "current", location: "Bengaluru" })));
    expect(r.current.temperature).toBe("19°C");
    expect(r.today).toMatchObject({ max_temp: "30°C", min_temp: "19°C", precipitation_chance: "15%" });
});

it("forecast days say today, tomorrow or the weekday", () => {
    expect(dayLabel("2026-10-31", "2026-10-31")).toBe("today");
    expect(dayLabel("2026-11-01", "2026-10-31")).toBe("tomorrow");
    expect(dayLabel("2026-11-02", "2026-10-31")).toBe("Monday");
});
