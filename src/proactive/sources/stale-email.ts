// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { IntentSourceModule, SourceCtx } from "./source.js";
import type { ProactiveIntent } from "../intent.js";
import * as native from "../../../native/index.js";
import { fetchStaleEmails } from "./_shared/gmail-stale-fetch.js";
import { buildIntent } from "./_shared/build-intent.js";
import { debugProactive } from "../kill-switches.js";

const GATE_SEC = 3600;
const MAX_CANDIDATES = 3;

export const STALE_EMAIL: IntentSourceModule = {
    name: "stale_email",
    async collectIntents(ctx: SourceCtx): Promise<ProactiveIntent[]> {
        const gate = native.sourceGateCheck("stale_email", GATE_SEC);
        if (!gate.mayRun) return [];

        let fetchResult;
        try {
            fetchResult = await fetchStaleEmails();
        } catch (err) {
            debugProactive("stale_email_fetch_failed", { err: (err as Error).message });
            return [];
        }

        const { stale, engaged_senders } = fetchResult;
        if (stale.length === 0) return [];

        const candidates = native.staleEmailScore(stale, engaged_senders, ctx.now);
        if (candidates.length === 0) return [];

        const intents: ProactiveIntent[] = [];
        for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
            const intent = await buildIntent({
                source: "stale_email",
                mode: "review",
                urgency: "normal",
                channelPreference: "any",
                payloadKind: "stale_email_draft",
                topic: `stale ${candidate.id}`,
                evidence: [
                    { label: "from", value: candidate.from },
                    { label: "subject", value: candidate.subject },
                    { label: "days_stale", value: String(candidate.daysStale) },
                ],
                payload: {
                    kind: "stale_email_draft",
                    emailId: candidate.id,
                    from: candidate.from,
                    subject: candidate.subject,
                    daysStale: candidate.daysStale,
                    score: candidate.score,
                },
                suggestedAction: {
                    toolCalls: [
                        {
                            toolName: "gmail",
                            args: { action: "reply", message_id: candidate.id },
                        },
                    ],
                    summary: `draft reply to ${candidate.from} about "${candidate.subject}"`,
                },
            });
            intents.push(intent);
        }
        return intents;
    },
};
