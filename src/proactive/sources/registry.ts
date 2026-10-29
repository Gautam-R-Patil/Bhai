// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ProactiveIntent } from "../intent.js";
import type { IntentSourceModule, SourceCtx } from "./source.js";
import { isSourceDisabled, debugProactive } from "../kill-switches.js";
import { inWindow } from "../config.js";

const MORNING = { start: "05:00", end: "12:00" };

export class SourceRegistry {
    private sources: IntentSourceModule[] = [];

    register(src: IntentSourceModule): void {
        this.sources.push(src);
    }

    list(): string[] {
        return this.sources.map((s) => s.name);
    }

    async collectAll(ctx: SourceCtx): Promise<ProactiveIntent[]> {
        const out: ProactiveIntent[] = [];
        const results = await Promise.allSettled(
            this.sources.map(async (s) => {
                if (isSourceDisabled(s.name)) {
                    debugProactive("source_skipped_disabled", { source: s.name });
                    return [] as ProactiveIntent[];
                }
                // Morning briefings only in the morning: they used to fetch news,
                // search the web and call the LLM around the clock, then queue up.
                if (s.name.endsWith("_morning") && !inWindow(MORNING, new Date(ctx.now))) {
                    return [] as ProactiveIntent[];
                }
                try {
                    return await s.collectIntents(ctx);
                } catch (err) {
                    debugProactive("source_failed", {
                        source: s.name,
                        err: (err as Error).message,
                    });
                    return [] as ProactiveIntent[];
                }
            }),
        );
        for (const r of results) {
            if (r.status === "fulfilled") out.push(...r.value);
        }
        return out;
    }
}
