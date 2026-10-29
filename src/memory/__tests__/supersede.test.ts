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
const store = async (ctx: CronCallerContext, input: Record<string, unknown>) =>
    JSON.parse(await cron.runWithCallerContext(ctx, () => tools.memoryStore.handler(input)));
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
        const out = await store({ isOwner: true, message: "Actually I moved to Pune last month" }, {
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
            { isOwner: true, message: "My car is a Creta" },
            { isOwner: false, message: "Actually his car is a Creta" },
            { isOwner: true, autonomous: true, message: "Actually it changed" },
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
        const ctx: CronCallerContext = { isOwner: true, message: "standup moved, now it's at 11" };
        const out = await store(ctx, { content: "Owner's standup is at 11", supersedes: c });
        expect(live(c)).toBe(false);
        expect(ctx.storedMemory?.id).toBe(out.id);
        expect(undoMemoryTap(memoryUndoAction(ctx.storedMemory as { id: number; at: number }))).toBe("Forgotten.");
        expect(live(c)).toBe(true);
        expect(await visible("standup")).toEqual(["Owner's standup is at 10"]);
    });
});
