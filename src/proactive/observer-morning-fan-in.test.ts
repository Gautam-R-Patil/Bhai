// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Observer, setObserver } from "./observer.js";
import type { ProactiveIntent } from "./intent.js";
import * as native from "../../native/index.js";

function mkMorningIntent(kind: string, idSuffix: string): ProactiveIntent {
    const now = Date.now();
    return {
        id: `m-${kind}-${idSuffix}`,
        source: "memory_anticipation",
        mode: "fyi",
        urgency: "normal",
        channelPreference: "telegram",
        topic: `topic ${idSuffix} ${Math.random()}`,
        topicEmbedding: (() => { const v = new Array(384).fill(0); v[idSuffix.charCodeAt(0) % 384] = 1; return v; })(),
        evidence: [],
        payload: { kind, note: idSuffix },
        payloadKind: kind,
        createdAt: now,
        expiresAt: now + 3600_000,
    };
}

describe("Observer morning fan-in (stub)", () => {
    let observer: Observer;
    beforeEach(() => {
        observer = new Observer({ llm: null, configPath: "/tmp/nx.json" });
        setObserver(observer);
        native.schedulerMarkBoundary("telegram", 120_000);
    });

    it("rolls up 3 morning-kind intents into a single dispatch (no errors thrown)", async () => {
        observer.enqueue(mkMorningIntent("calendar_today_summary", "a"));
        observer.enqueue(mkMorningIntent("tasks_today", "b"));
        observer.enqueue(mkMorningIntent("goals_status", "c"));
        await expect(observer.tickAll()).resolves.toBeUndefined();
    });
});
