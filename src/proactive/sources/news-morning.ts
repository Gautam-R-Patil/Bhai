// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { IntentSourceModule, SourceCtx } from "./source.js";
import type { ProactiveIntent } from "../intent.js";
import type { LLMClient } from "../../llm.js";
import * as native from "../../../native/index.js";
import { fetchNews } from "./_shared/news-fetch.js";
import { buildIntent } from "./_shared/build-intent.js";
import { debugProactive } from "../kill-switches.js";

const GATE_SEC = 3600;

export function makeNewsMorningSource(deps: {
    llm: LLMClient | null;
    webSearch: (q: string) => Promise<string>;
}): IntentSourceModule {
    return {
        name: "news_morning",
        async collectIntents(ctx: SourceCtx): Promise<ProactiveIntent[]> {
            const gate = native.sourceGateCheck("news_morning", GATE_SEC);
            if (!gate.mayRun) return [];

            let newsResult;
            try {
                newsResult = await fetchNews({ llm: deps.llm, webSearch: deps.webSearch });
            } catch (err) {
                debugProactive("news_morning_fetch_failed", { err: (err as Error).message });
                return [];
            }
            const { headlines } = newsResult;
            if (headlines.length === 0) return [];

            const dateStr = new Date(ctx.now).toISOString().slice(0, 10);
            const intent = await buildIntent({
                source: "news_morning",
                mode: "fyi",
                urgency: "ambient",
                channelPreference: "any",
                payloadKind: "news_today",
                topic: `morning news ${dateStr}`,
                evidence: headlines.map((h, i) => ({ label: `headline_${i + 1}`, value: h.title })),
                payload: {
                    kind: "news_today",
                    headlines,
                },
            });
            return [intent];
        },
    };
}
