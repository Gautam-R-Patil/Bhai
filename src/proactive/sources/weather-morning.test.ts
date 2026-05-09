import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./_shared/weather-fetch.js", () => ({
    fetchWeather: vi.fn(async () => ({
        summary: "Sunny with clouds",
        tempC: 32,
        rainProb: 0.1,
        hasOutdoorEvent: false,
        locationStr: "Bangalore, Karnataka",
    })),
}));

vi.mock("../../../native/index.js", () => ({
    sourceGateCheck: vi.fn((_name: string, _gap: number) => ({ mayRun: true, nextEligibleMs: 0 })),
    weatherActionable: vi.fn((_w: unknown) => true),
}));

vi.mock("../../memory/embeddings.js", () => ({
    embedText: vi.fn(async () => new Float32Array(384).fill(0)),
}));

import { makeWeatherMorningSource } from "./weather-morning.js";

const mockLlm = {} as any;
const mockWebSearch = vi.fn(async () => "weather result text");

describe("weather-morning source", () => {
    const source = makeWeatherMorningSource({ llm: mockLlm, webSearch: mockWebSearch });

    beforeEach(() => vi.clearAllMocks());

    it("emits weather_today intent when actionable", async () => {
        const intents = await source.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(1);
        expect(intents[0].payload.kind).toBe("weather_today");
        expect(intents[0].source).toBe("weather_morning");
        expect(intents[0].urgency).toBe("ambient");
        expect(intents[0].payload.temp_c).toBe(32);
    });

    it("returns empty when gate blocks", async () => {
        const native = await import("../../../native/index.js");
        (native.sourceGateCheck as any).mockReturnValueOnce({ mayRun: false, nextEligibleMs: 0 });
        const intents = await source.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(0);
    });

    it("returns empty when weather not actionable and no outdoor event", async () => {
        const native = await import("../../../native/index.js");
        (native.weatherActionable as any).mockReturnValueOnce(false);
        const fetchMod = await import("./_shared/weather-fetch.js");
        (fetchMod.fetchWeather as any).mockResolvedValueOnce({
            summary: "Mild", tempC: 22, rainProb: 0.1, hasOutdoorEvent: false, locationStr: "London",
        });
        const intents = await source.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(0);
    });

    it("returns empty when fetchWeather returns null", async () => {
        const fetchMod = await import("./_shared/weather-fetch.js");
        (fetchMod.fetchWeather as any).mockResolvedValueOnce(null);
        const intents = await source.collectIntents({ now: Date.now() });
        expect(intents).toHaveLength(0);
    });
});
