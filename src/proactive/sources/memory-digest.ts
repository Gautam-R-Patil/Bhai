// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../../config/paths.js";
import { digestPruneAction } from "../../memory/forget.js";
import { looksSensitive } from "../../memory/playbooks.js";
import { getRawDb } from "../../memory/sqlite.js";
import { getChannelSender } from "../../tools/channel-send.js";
import { makeIntentId, type ProactiveIntent } from "../intent.js";
import type { IntentSourceModule } from "./source.js";

const WEEK_MS = 7 * 86_400_000;
const RETRY_MS = 60 * 60_000; // each intent lives this long; one never sent is collected again after
const MIN_ITEMS = 3;
const MAX_ITEMS = 10;

// ranAt: the last weekly run, sent or skipped. sentAt/ids: the digest the owner got, for "forget #N".
type DigestState = { ranAt: number; sentAt?: number; ids?: number[] };
const statePath = () => join(getDataDir(), "memory-digest.json");

function readState(): DigestState {
    try {
        return JSON.parse(readFileSync(statePath(), "utf8")) as DigestState;
    } catch {
        return { ranAt: 0 };
    }
}

function writeState(s: DigestState): void {
    try {
        writeFileSync(statePath(), JSON.stringify(s));
    } catch {
        /* next run tries again */
    }
}

/** The memory id behind "#n" of the digest the owner got in the last 7 days. */
export function digestItemId(n: number, now = Date.now()): number | undefined {
    const s = readState();
    return s.sentAt && now - s.sentAt <= WEEK_MS ? s.ids?.[n - 1] : undefined;
}

/**
 * What the owner told Bhai themselves (memory_store or pin on their own turn) since `sinceMs`,
 * newest first. stated_at is never set on inferred rows; secrets and contacts stay out of a chat.
 */
export function ownerStatedSince(sinceMs: number): Array<{ id: number; content: string }> {
    const rows = (getRawDb()
        ?.prepare(
            `SELECT id, content FROM memories
             WHERE stated_at >= datetime(?, 'unixepoch') AND consolidated_into IS NULL
               AND category NOT IN ('bhai_did', 'session_summary', 'commitment_done')
             ORDER BY stated_at DESC, id DESC`,
        )
        .all(Math.floor(sinceMs / 1000)) ?? []) as Array<{ id: number; content: string }>;
    return rows.filter((r) => !looksSensitive(r.content)).slice(0, MAX_ITEMS);
}

let queuedAt = 0;

/** Once a week, the facts the owner stated, each with a prune button (Telegram) or "forget #N". */
export const MEMORY_DIGEST: IntentSourceModule = {
    name: "memory_digest",
    async collectIntents(ctx) {
        const state = readState();
        if (ctx.now - state.ranAt < WEEK_MS || ctx.now <= queuedAt + RETRY_MS) return [];
        const items = ownerStatedSince(ctx.now - WEEK_MS);
        if (items.length < MIN_ITEMS) {
            writeState({ ...state, ranAt: ctx.now });
            return [];
        }
        queuedAt = ctx.now;
        const intent: ProactiveIntent = {
            id: makeIntentId("memory_digest"),
            source: "memory_digest",
            mode: "fyi",
            urgency: "normal", // held by quiet hours and posture like any nudge
            // Owner memories go only to a private surface: Telegram (owners only, with buttons) or the overlay.
            channelPreference: getChannelSender("telegram") ? "telegram" : "overlay",
            topic: "what I picked up about you this week",
            topicEmbedding: new Array(384).fill(0),
            evidence: [{ label: "items", value: String(items.length) }],
            payload: {
                kind: "memory_digest",
                ownerOnly: true,
                items,
                buttons: items.map((it, i) => ({ text: `Forget #${i + 1}`, data: digestPruneAction(it.id, ctx.now) })),
            },
            createdAt: ctx.now,
            expiresAt: ctx.now + RETRY_MS,
        };
        return [intent];
    },
    onDispatched(intent) {
        const now = Date.now();
        const ids = (intent.payload.items as Array<{ id: number }>).map((it) => it.id);
        writeState({ ranAt: now, sentAt: now, ids });
    },
};
