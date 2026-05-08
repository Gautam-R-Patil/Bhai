// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { IntentSourceModule, SourceCtx } from "./source.js";
import type { ProactiveIntent } from "../intent.js";
import * as native from "../../../native/index.js";
import { getActiveGoals } from "../../goal-engine.js";
import { buildIntent } from "./_shared/build-intent.js";
import { debugProactive } from "../kill-switches.js";

const GATE_SEC = 3600;

export const GOALS_MORNING: IntentSourceModule = {
    name: "goals_morning",
    async collectIntents(ctx: SourceCtx): Promise<ProactiveIntent[]> {
        const gate = native.sourceGateCheck("goals_morning", GATE_SEC);
        if (!gate.mayRun) return [];

        let goals;
        try {
            goals = getActiveGoals().slice(0, 3);
        } catch (err) {
            debugProactive("goals_morning_fetch_failed", { err: (err as Error).message });
            return [];
        }
        if (goals.length === 0) return [];

        const dateStr = new Date(ctx.now).toISOString().slice(0, 10);
        const intent = await buildIntent({
            source: "goals_morning",
            mode: "fyi",
            urgency: "ambient",
            channelPreference: "any",
            payloadKind: "goals_status",
            topic: `morning goals ${dateStr}`,
            evidence: goals.map(g => ({ label: "goal", value: g.title })),
            payload: {
                kind: "goals_status",
                goals: goals.map(g => ({ title: g.title, progress: g.progress, status: g.status })),
            },
        });
        return [intent];
    },
};
