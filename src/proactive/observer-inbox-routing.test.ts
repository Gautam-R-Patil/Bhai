// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Task 4.2 — Observer routing: review-mode intents go to the InboxManager,
// NOT to the chat channel. fyi/question intents continue to dispatch.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProactiveIntent, ProactiveMode } from "./intent.js";

// ── Module mocks — must be hoisted above imports of the observer ──

// Mock Composer so the test doesn't need an LLM. Returns the intent text verbatim.
vi.mock("./composer.js", () => ({
    compose: vi.fn(
        async (intent: ProactiveIntent): Promise<{ text: string; modeTag: ProactiveMode } | null> => ({
            text: `composed: ${intent.topic}`,
            modeTag: intent.mode,
        }),
    ),
    composeMorningBatch: vi.fn(async () => ({ text: "morning (mock)", modeTag: "fyi" })),
}));

// Mock dispatch so we can assert whether the chat channel was invoked.
// Typed as (channel, text, mode) so `.mock.calls[n][i]` indexes correctly.
const dispatchSpy = vi.fn(async (_channel: string, _text: string, _mode: string) => {});
vi.mock("./dispatch.js", () => ({
    dispatchProactiveMessage: (channel: string, text: string, mode: string) =>
        dispatchSpy(channel, text, mode),
}));

// Mock native Rust scheduler: enqueue always accepts, schedulerReleaseGrouped returns
// whatever the current test stages on `releaseByChannel[<channel>]` as singles.
// Consumed-once per channel.
const releaseByChannel: Record<string, string[]> = {};
vi.mock("../../native/index.js", () => ({
    schedulerConfigure: vi.fn(),
    schedulerEnqueue: vi.fn().mockReturnValue("enqueued"),
    schedulerMarkBoundary: vi.fn(),
    schedulerSetDnd: vi.fn(),
    schedulerReleaseGrouped: vi.fn((channel: string) => {
        const bucket = releaseByChannel[channel];
        if (!bucket || bucket.length === 0) {
            return { morningBatch: [], singles: [], dropped: [] };
        }
        const singles = bucket.splice(0, bucket.length);
        return { morningBatch: [], singles, dropped: [] };
    }),
    schedulerDrainScheduled: vi.fn().mockReturnValue([]),
    schedulerDebugState: vi.fn().mockReturnValue(""),
}));

import { Observer } from "./observer.js";
import { InboxStore } from "./inbox/store.js";
import { InboxManager, setInboxManager, globalInboxBus } from "./inbox/manager.js";
import BetterSqlite3 from "better-sqlite3";
import { wrapDatabase, initProactiveSchema } from "../memory/sqlite.js";

// ── Fixtures ──

function buildInboxManager(): InboxManager {
    const raw = new BetterSqlite3(":memory:");
    initProactiveSchema(wrapDatabase(raw));
    const store = new InboxStore(raw);
    return new InboxManager({ store });
}

function makeReviewIntent(id = "rev-1"): ProactiveIntent {
    return {
        id,
        source: "meeting_followup",
        mode: "review",
        urgency: "normal",
        channelPreference: "telegram",
        topic: "follow up on standup",
        topicEmbedding: new Array(384).fill(0),
        evidence: [],
        payload: { kind: "meeting_followup" },
        suggestedAction: { toolCalls: [], summary: "draft recap" },
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
    };
}

function makeFyiIntent(id = "fyi-1"): ProactiveIntent {
    return {
        id,
        source: "memory_anticipation",
        mode: "fyi",
        urgency: "normal",
        channelPreference: "telegram",
        topic: "fyi topic",
        topicEmbedding: new Array(384).fill(0),
        evidence: [],
        payload: { kind: "memory_anticipation", hint: "hi" },
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
    };
}

// ── Tests ──

describe("Observer → inbox routing (Task 4.2)", () => {
    let dir: string;
    let configPath: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "bhai-inbox-route-"));
        configPath = join(dir, "proactive-config.json");
        dispatchSpy.mockReset();
        for (const k of Object.keys(releaseByChannel)) delete releaseByChannel[k];
        setInboxManager(null);
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
        setInboxManager(null);
    });

    it("review-mode intent is routed to inbox when manager is set; dispatch NOT invoked", async () => {
        const inbox = buildInboxManager();
        setInboxManager(inbox);

        const addEvents: Array<{ id: string }> = [];
        const unsub = globalInboxBus.subscribe((ev) => {
            if (ev.kind === "added") addEvents.push({ id: ev.item.intent.id });
        });

        const obs = new Observer({ llm: null as never, configPath });
        const intent = makeReviewIntent("rev-route-1");
        expect(obs.enqueue(intent)).toBe(true);

        // Stage release on the channel the intent was enqueued on
        releaseByChannel[intent.channelPreference as string] = [intent.id];
        await obs.tickAll();

        expect(addEvents.length).toBe(1);
        expect(addEvents[0].id).toBe(intent.id);
        expect(inbox.listPending().length).toBe(1);
        expect(dispatchSpy).not.toHaveBeenCalled();

        unsub();
        obs.stop();
    });

    it("review-mode falls through to dispatch when no inbox manager is registered", async () => {
        // Explicit: no inbox manager
        setInboxManager(null);

        const obs = new Observer({ llm: null as never, configPath });
        const intent = makeReviewIntent("rev-fallthrough");
        expect(obs.enqueue(intent)).toBe(true);

        releaseByChannel[intent.channelPreference as string] = [intent.id];
        await obs.tickAll();

        // Since inbox is absent, dispatch MUST have been called for the review intent.
        expect(dispatchSpy).toHaveBeenCalledTimes(1);
        const call = dispatchSpy.mock.calls[0];
        expect(call[0]).toBe(intent.channelPreference);
        expect(call[2]).toBe("review");

        obs.stop();
    });

    it("fyi-mode intent goes to dispatch, never the inbox", async () => {
        const inbox = buildInboxManager();
        setInboxManager(inbox);

        const addEvents: number[] = [];
        const unsub = globalInboxBus.subscribe((ev) => {
            if (ev.kind === "added") addEvents.push(1);
        });

        const obs = new Observer({ llm: null as never, configPath });
        const intent = makeFyiIntent("fyi-route-1");
        expect(obs.enqueue(intent)).toBe(true);

        releaseByChannel[intent.channelPreference as string] = [intent.id];
        await obs.tickAll();

        // fyi never hits the inbox
        expect(addEvents.length).toBe(0);
        expect(inbox.listPending().length).toBe(0);
        // and dispatch WAS called
        expect(dispatchSpy).toHaveBeenCalledTimes(1);
        const call = dispatchSpy.mock.calls[0];
        expect(call[2]).toBe("fyi");

        unsub();
        obs.stop();
    });
});
