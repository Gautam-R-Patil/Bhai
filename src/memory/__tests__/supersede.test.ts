// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { CronCallerContext } from "../../tools/cron-tool.js";

process.env.ATLAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-supersede-"));

let sqlite: typeof import("../sqlite.js");
let tools: typeof import("../../tools/memory-tools.js");
let cron: typeof import("../../tools/cron-tool.js");
let raw: NonNullable<ReturnType<typeof sqlite.getRawDb>>;

beforeAll(async () => {
    sqlite = await import("../sqlite.js");
    tools = await import("../../tools/memory-tools.js");
    cron = await import("../../tools/cron-tool.js");
    await sqlite.initMemoryDB();
    raw = sqlite.getRawDb() as typeof raw;
});

const old = (content: string) =>
    Number(raw.prepare("INSERT INTO memories (content, category) VALUES (?, 'fact')").run(content).lastInsertRowid);
// As the owner's main loop runs it; `outer` is the main-loop tool a sub-agent would run under.
const store = async (ctx: CronCallerContext, input: Record<string, unknown>, outer = "memory_store") =>
    JSON.parse(
        await cron.runWithCallerContext(ctx, () => cron.runAsMainLoopTool(outer, () => tools.memoryStore.handler(input))),
    );
const shown = (...ids: number[]) => new Set(ids);
const live = (id: number) =>
    (raw.prepare("SELECT consolidated_into c FROM memories WHERE id = ?").get(id) as { c: number | null }).c === null;
const visible = async (q: string) => (await sqlite.recall(q, 10, undefined, undefined, undefined, null, { touch: false })).map((m) => m.content);

describe("memory_store supersedes", () => {
    it("spots corrections in English, Hinglish and Hindi, not plain statements", () => {
        for (const t of ["Actually it's Tuesday", "I moved to Pune", "no, the dentist is Dr Rao", "ab main chai nahi peeta", "अब मैं पुणे में रहता हूँ"]) {
            expect(tools.hasCorrectionCue(t), t).toBe(true);
        }
        for (const t of ["My dentist is Dr Rao", "I like chai", "", "Remember my gym is on 5th street"]) {
            expect(tools.hasCorrectionCue(t), t).toBe(false);
        }
    });

    it("retires the old memory on the owner's correction, everywhere it was shown", async () => {
        const a = old("Owner lives in Mumbai");
        const out = await store({ isOwner: true, message: "Actually I moved to Pune last month", shownMemories: shown(a) }, {
            content: "Owner lives in Pune",
            supersedes: `#${a}`,
        });
        expect(out).toMatchObject({ success: true, superseded: a });
        expect(live(a)).toBe(false);
        expect(await visible("Owner lives")).toEqual(["Owner lives in Pune"]);
        expect(sqlite.getCoreMemory(50).some((m) => m.id === a)).toBe(false);
        expect(sqlite.listMemories(undefined, 50).some((m) => m.id === a)).toBe(false);
    });

    it("ignores supersedes without a correction cue, from contacts, and on autonomous runs", async () => {
        const b = old("Owner's car is a Swift");
        const cases: CronCallerContext[] = [
            { isOwner: true, message: "My car is a Creta", shownMemories: shown(b) },
            { isOwner: false, message: "Actually his car is a Creta", shownMemories: shown(b) },
            { isOwner: true, autonomous: true, message: "Actually it changed", shownMemories: shown(b) },
            { isOwner: true, message: "Actually it changed" },
        ];
        for (const ctx of cases) {
            const out = await store(ctx, { content: `Car note ${cases.indexOf(ctx)}`, supersedes: b });
            expect(out.success).toBe(true);
            expect(out.message).toMatch(/supersede ignored/);
        }
        expect(live(b)).toBe(true);
    });

    it("the Forget that tap on a correction brings the old memory back", async () => {
        const { memoryUndoAction, undoMemoryTap } = await import("../forget.js");
        const c = old("Owner's standup is at 10");
        const ctx: CronCallerContext = { isOwner: true, message: "standup moved, now it's at 11", shownMemories: shown(c) };
        const out = await store(ctx, { content: "Owner's standup is at 11", supersedes: c });
        expect(live(c)).toBe(false);
        expect(ctx.storedMemory?.id).toBe(out.id);
        expect(undoMemoryTap(memoryUndoAction(ctx.storedMemory as { id: number; at: number }))).toBe("Forgotten.");
        expect(live(c)).toBe(true);
        expect(await visible("standup")).toEqual(["Owner's standup is at 10"]);
    });

    it("refuses sub-agents and a second supersede in the turn; memory_search in the main loop marks ids shown", async () => {
        const d = old("Owner's gym is Cult");
        const e = old("Owner's gym timing is 7am");
        const ctx: CronCallerContext = { isOwner: true, message: "research gyms instead of yoga" };
        // A sub-agent started by sub_agent searches and then tries to retire what it found.
        await cron.runWithCallerContext(ctx, () =>
            cron.runAsMainLoopTool("sub_agent", () => tools.memorySearch.handler({ query: "Owner's gym" })),
        );
        expect(ctx.shownMemories?.has(d) ?? false).toBe(false);
        ctx.shownMemories = shown(d, e);
        expect((await store(ctx, { content: "x", supersedes: d }, "sub_agent")).message).toMatch(/supersede ignored/);
        expect(live(d)).toBe(true);

        const turn: CronCallerContext = { isOwner: true, message: "actually I switched gyms" };
        await cron.runWithCallerContext(turn, () =>
            cron.runAsMainLoopTool("memory_search", () => tools.memorySearch.handler({ query: "Owner's gym" })),
        );
        expect(turn.shownMemories?.has(d) && turn.shownMemories.has(e)).toBe(true);
        expect(await store(turn, { content: "Owner's gym is Gold's", supersedes: d })).toMatchObject({ superseded: d });
        expect((await store(turn, { content: "Owner's gym timing is 8am", supersedes: e })).message).toMatch(/ignored/);
        expect(live(e)).toBe(true);
    });

    it("a later store in the turn doesn't take the correction's undo away", async () => {
        const { memoryUndoAction, undoMemoryTap } = await import("../forget.js");
        const f = old("Owner's sister lives in Mumbai");
        const ctx: CronCallerContext = { isOwner: true, message: "actually I moved to Pune, office in Baner", shownMemories: shown(f) };
        const out = await store(ctx, { content: "Owner lives in Pune", supersedes: f });
        await store(ctx, { content: "Owner's office is in Baner" });
        expect(ctx.storedMemory?.id).toBe(out.id);
        undoMemoryTap(memoryUndoAction(ctx.storedMemory as { id: number; at: number }));
        expect(live(f)).toBe(true);
    });

    it("a repeated memory_search through executeTool still marks its ids shown", async () => {
        const { executeTool } = await import("../../tools/index.js");
        const g = old("Owner's dentist is Dr Rao");
        for (let i = 0; i < 2; i++) {
            const turn: CronCallerContext = { isOwner: true, message: "my dentist changed" };
            await cron.runWithCallerContext(turn, () =>
                cron.runAsMainLoopTool("memory_search", () => executeTool("memory_search", { query: "Owner's dentist" })),
            );
            expect(turn.shownMemories?.has(g), `call ${i + 1}`).toBe(true);
        }
    });
});
