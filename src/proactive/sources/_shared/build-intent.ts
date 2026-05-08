// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import {
    makeIntentId,
    type ProactiveIntent,
    type IntentSource,
    type ProactiveMode,
    type Urgency,
    type Channel,
    type Evidence,
    type SuggestedAction,
} from "../../intent.js";
import { embedText } from "../../../memory/embeddings.js";

export type BuildIntentInput = {
    source: IntentSource;
    mode: ProactiveMode;
    urgency: Urgency;
    channelPreference: Channel | "any";
    payloadKind: string;
    topic: string;
    evidence: Evidence[];
    payload: { kind: string; [k: string]: unknown };
    scheduledFor?: number;
    expiresAtMs?: number;
    suggestedAction?: SuggestedAction;
};

const DEFAULT_LIFETIME_MS = 6 * 60 * 60_000;

export async function buildIntent(input: BuildIntentInput): Promise<ProactiveIntent> {
    const now = Date.now();
    let embedding: number[];
    try {
        const raw = await embedText(input.topic, "query");
        const arr: number[] = Array.isArray(raw) ? raw : Array.from(raw);
        embedding = arr.length === 384 ? arr : new Array(384).fill(0);
    } catch {
        embedding = new Array(384).fill(0);
    }

    const intent: ProactiveIntent = {
        id: makeIntentId(input.source),
        source: input.source,
        mode: input.mode,
        urgency: input.urgency,
        channelPreference: input.channelPreference,
        topic: input.topic,
        topicEmbedding: embedding,
        evidence: input.evidence,
        payload: input.payload,
        payloadKind: input.payloadKind,
        createdAt: now,
        expiresAt: input.expiresAtMs ?? now + DEFAULT_LIFETIME_MS,
    };
    if (input.scheduledFor !== undefined) intent.scheduledFor = input.scheduledFor;
    if (input.suggestedAction !== undefined) intent.suggestedAction = input.suggestedAction;
    return intent;
}
