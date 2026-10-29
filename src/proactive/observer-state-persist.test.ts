// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Daily counts and sent topics survive a restart (every app update restarts the bot).
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const { restore, released } = vi.hoisted(() => ({ restore: vi.fn(), released: { ids: [] as string[] } }));
const SNAP = { channel: "telegram", sentToday: 2, dayBucket: 1, lastSentMs: 1, recentTs: [], recentEmbeddings: [] };
vi.mock("../../native/index.js", () => ({
    schedulerConfigure: vi.fn(),
    schedulerEnqueue: vi.fn().mockReturnValue("enqueued"),
    schedulerMarkBoundary: vi.fn(),
    schedulerSetDnd: vi.fn(),
    schedulerReleaseGrouped: vi.fn((ch: string) => {
        const singles = ch === "telegram" ? released.ids.splice(0) : [];
        return { morningBatch: [], singles, dropped: [] };
    }),
    schedulerDrainScheduled: vi.fn().mockReturnValue([]),
    schedulerDebugState: vi.fn().mockReturnValue(""),
    schedulerSnapshot: vi.fn((ch: string) => (ch === "telegram" ? SNAP : null)),
    schedulerRestore: restore,
}));
vi.mock("./composer.js", () => ({
    compose: vi.fn(async () => ({ text: "hi", modeTag: "fyi" })),
    composeMorningBatch: vi.fn(async () => null),
}));
vi.mock("./dispatch.js", () => ({ dispatchProactiveMessage: vi.fn(async () => {}) }));

import { Observer } from "./observer.js";

describe("scheduler state across restarts", () => {
    it("is saved after a release that sent something, and restored at startup", async () => {
        const dir = mkdtempSync(join(tmpdir(), "proactive-"));
        const configPath = join(dir, "proactive-config.json");
        const obs = new Observer({ llm: null as never, configPath });
        expect(restore).not.toHaveBeenCalled(); // nothing saved yet

        await obs.tickAll(); // nothing released: nothing written
        expect(existsSync(join(dir, "proactive-state.json"))).toBe(false);

        released.ids.push("x");
        await obs.tickAll();
        expect(existsSync(join(dir, "proactive-state.json"))).toBe(true);

        new Observer({ llm: null as never, configPath }); // the bot restarts
        expect(restore).toHaveBeenCalledWith(SNAP);
    });
});
