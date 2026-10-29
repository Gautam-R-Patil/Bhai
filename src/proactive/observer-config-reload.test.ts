// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// "set whatsapp to ambient" applies without a restart.
import { mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const { configure } = vi.hoisted(() => ({ configure: vi.fn() }));
vi.mock("../../native/index.js", () => ({
    schedulerConfigure: configure,
    schedulerEnqueue: vi.fn().mockReturnValue("enqueued"),
    schedulerMarkBoundary: vi.fn(),
    schedulerSetDnd: vi.fn(),
    schedulerReleaseGrouped: vi.fn(() => ({ morningBatch: [], singles: [], dropped: [] })),
    schedulerDrainScheduled: vi.fn().mockReturnValue([]),
    schedulerDebugState: vi.fn().mockReturnValue(""),
}));

import { tryProactiveCommand } from "./chat-commands.js";
import { POSTURE_PARAMS } from "./config.js";
import { Observer } from "./observer.js";

describe("proactive posture hot-reload", () => {
    it("a posture change reaches the scheduler on the next tick", async () => {
        const configPath = join(mkdtempSync(join(tmpdir(), "proactive-")), "proactive-config.json");
        const obs = new Observer({ llm: null as never, configPath });
        configure.mockClear();
        await obs.tickAll();
        expect(configure).not.toHaveBeenCalled(); // unchanged file: nothing re-applied

        await tryProactiveCommand("set whatsapp to ambient", { configPath } as never);
        utimesSync(configPath, new Date(), new Date(Date.now() + 5000)); // a distinct mtime
        await obs.tickAll();
        expect(configure).toHaveBeenCalledWith(
            expect.objectContaining({ channel: "whatsapp", maxPerDay: POSTURE_PARAMS.ambient.maxPerDay }),
        );
    });

    it("'shut up' still holds after a restart; 'resume' clears it", async () => {
        const configPath = join(mkdtempSync(join(tmpdir(), "proactive-")), "proactive-config.json");
        await tryProactiveCommand("shut up", { configPath } as never);
        delete process.env.ATLAS_PROACTIVE_DISABLE; // the process restarts
        new Observer({ llm: null as never, configPath });
        expect(process.env.ATLAS_PROACTIVE_DISABLE).toBe("true");
        await tryProactiveCommand("resume", { configPath } as never);
        expect(process.env.ATLAS_PROACTIVE_DISABLE).toBeUndefined();
        new Observer({ llm: null as never, configPath });
        expect(process.env.ATLAS_PROACTIVE_DISABLE).toBeUndefined();
    });
});

describe("scheduled alerts are queued once", () => {
    const prep = (id: string, fireAt: number) =>
        ({
            id,
            source: "calendar_prep",
            mode: "fyi",
            urgency: "urgent",
            channelPreference: "telegram",
            topic: "prep evt-42",
            topicEmbedding: new Array(384).fill(0),
            evidence: [],
            payload: { kind: "meeting_prep" },
            scheduledFor: fireAt,
            createdAt: Date.now(),
            expiresAt: fireAt + 25 * 60_000,
        }) as never;

    it("the same meeting re-emitted every 5 minutes (fresh ids) is queued once", () => {
        const configPath = join(mkdtempSync(join(tmpdir(), "proactive-")), "proactive-config.json");
        const obs = new Observer({ llm: null as never, configPath });
        const fireAt = Date.now() + 6 * 60 * 60_000; // 14:45 for a 15:00 meeting, seen from 09:00
        const accepted = [1, 2, 3, 4, 5].filter((n) => obs.enqueue(prep(`prep-${n}`, fireAt)));
        expect(accepted).toEqual([1]);
        // A different meeting (or the same one moved) still gets its alert.
        expect(obs.enqueue(prep("prep-moved", fireAt + 30 * 60_000))).toBe(true);
    });
});
