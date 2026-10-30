// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { IntentSourceModule, SourceCtx } from "./source.js";
import type { ProactiveIntent } from "../intent.js";
import type { LLMClient } from "../../llm.js";
import * as native from "../../../native/index.js";
import { fetchWeather } from "./_shared/weather-fetch.js";
import { buildIntent } from "./_shared/build-intent.js";
import { doneToday, markDoneToday } from "./_shared/daily-done.js";
import { debugProactive } from "../kill-switches.js";

const GATE_SEC = 3600;

export function makeWeatherMorningSource(deps: {
    llm: LLMClient | null;
    webSearch: (q: string) => Promise<string>;
}): IntentSourceModule {
    return {
        name: "weather_morning",
        async collectIntents(ctx: SourceCtx): Promise<ProactiveIntent[]> {
            if (doneToday("weather_morning", ctx.now)) return [];
            const gate = native.sourceGateCheck("weather_morning", GATE_SEC);
            if (!gate.mayRun) return [];

            let weather;
            try {
                weather = await fetchWeather({ llm: deps.llm, webSearch: deps.webSearch });
            } catch (err) {
                debugProactive("weather_morning_fetch_failed", { err: (err as Error).message });
                return [];
            }
            if (!weather) return [];
            markDoneToday("weather_morning", ctx.now); // checked today; nothing notable stays nothing to say

            const { summary, tempC, rainProb, hasOutdoorEvent, locationStr } = weather;
            const actionable = native.weatherActionable({ summary, tempC, rainProb, hasOutdoorEvent });
            if (!actionable && !hasOutdoorEvent) return [];

            const dateStr = new Date(ctx.now).toISOString().slice(0, 10);
            let headsUp = "";
            if (tempC > 35) headsUp = "very hot";
            else if (tempC < 5) headsUp = "very cold";
            else if (rainProb > 0.7) headsUp = "likely rain";
            else if (rainProb > 0.4) headsUp = "possible rain";
            else if (tempC > 28) headsUp = "warm";

            const intent = await buildIntent({
                source: "weather_morning",
                mode: "fyi",
                urgency: "ambient",
                channelPreference: "any",
                payloadKind: "weather_today",
                topic: `morning weather ${locationStr} ${dateStr}`,
                evidence: [
                    { label: "summary", value: summary },
                    { label: "temp_c", value: String(tempC) },
                    { label: "rain_prob", value: String(Math.round(rainProb * 100)) + "%" },
                ],
                payload: {
                    kind: "weather_today",
                    summary,
                    temp_c: tempC,
                    rain_prob: rainProb,
                    location: locationStr,
                    heads_up: headsUp,
                },
            });
            return [intent];
        },
    };
}
