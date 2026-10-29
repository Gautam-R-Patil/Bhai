// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { CronCallerContext } from "../../tools/cron-tool.js";

process.env.ATLAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-pin-"));

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

const row = (content: string, importance = 5) =>
    Number(
        raw.prepare("INSERT INTO memories (content, category, importance) VALUES (?, 'fact', ?)").run(content, importance)
            .lastInsertRowid,
    );
const store = async (ctx: CronCallerContext, input: Record<string, unknown>) =>
    JSON.parse(
        await cron.runWithCallerContext(ctx, () =>
            cron.runAsMainLoopTool("memory_store", () => tools.memoryStore.handler(input)),
        ),
    );
const pinned = (id: number) =>
    (raw.prepare("SELECT COALESCE(pinned, 0) p FROM memories WHERE id = ?").get(id) as { p: number } | undefined)?.p === 1;
const owner = (ids: number[] = []): CronCallerContext => ({ isOwner: true, message: "x", shownMemories: new Set(ids) });

describe("pinned memories", () => {
    it("memory_store pin:true pins for the owner only; a dup of a pinned row stays pinned", async () => {
        const out = await store(owner(), { content: "Owner's daughter's birthday is 3 March", pin: true, importance: 8 });
        expect(out).toMatchObject({ success: true, message: "Memory stored and pinned." });
        expect(pinned(out.id)).toBe(true);
        const again = await store(owner(), { content: "Owner's daughter's birthday is 3 March" });
        expect(again.id).toBe(out.id);
        expect(pinned(out.id)).toBe(true);

        for (const ctx of [
            { isOwner: false, message: "x" },
            { isOwner: true, autonomous: true, message: "x" },
        ] as CronCallerContext[]) {
            const c = await store(ctx, { content: `Contact note ${ctx.isOwner}`, pin: true });
            expect(pinned(c.id)).toBe(false);
        }
    });

    it("pin_id pins/unpins a shown memory, never an unshown one or for a contact", async () => {
        const a = row("Owner's passport expires in 2031");
        expect((await store(owner(), { content: "x", pin_id: a, pin: true })).success).toBe(false);
        expect((await store({ isOwner: false, message: "x", shownMemories: new Set([a]) }, { content: "x", pin_id: a })).success).toBe(false);
        expect(pinned(a)).toBe(false);
        expect(await store(owner([a]), { content: "x", pin_id: `#${a}`, pin: true })).toMatchObject({ success: true, pinned: true });
        expect(pinned(a)).toBe(true);
        expect(await store(owner([a]), { content: "x", pin_id: a, pin: false })).toMatchObject({ success: true, pinned: false });
        expect(pinned(a)).toBe(false);
    });

    it("core memory keeps pinned slots (capped, newest first) ahead of busier rows", () => {
        for (let i = 0; i < 12; i++) row(`Busy fact ${i}`, 10);
        const low = row("Owner's blood group is O+", 1);
        raw.prepare("UPDATE memories SET decay_score = 0.1 WHERE id = ?").run(low);
        expect(sqlite.getCoreMemory(5).some((m) => m.id === low)).toBe(false);
        expect(sqlite.setMemoryPinned(low, true)).toBe(true);
        const core = sqlite.getCoreMemory(5);
        expect(core[0]).toMatchObject({ id: low, pinned: true });
        expect(core.filter((m) => !m.pinned)).toHaveLength(5);

        const extra = Array.from({ length: sqlite.PINNED_CORE_CAP + 2 }, (_, i) => row(`Pinned ${i}`));
        for (const id of extra) sqlite.setMemoryPinned(id, true);
        const capped = sqlite.getCoreMemory(20).filter((m) => m.pinned);
        expect(capped).toHaveLength(sqlite.PINNED_CORE_CAP);
        expect(capped[0].id).toBe(extra[extra.length - 1]);
        for (const id of extra) sqlite.setMemoryPinned(id, false);
    });

    it("a correction carries the pin; forget still removes a pinned row", async () => {
        const b = row("Owner's allergy is peanuts");
        sqlite.setMemoryPinned(b, true);
        const out = await store(
            { isOwner: true, message: "actually it's cashews, not peanuts", shownMemories: new Set([b]) },
            { content: "Owner's allergy is cashews", supersedes: b },
        );
        expect(out.superseded).toBe(b);
        expect(pinned(out.id)).toBe(true);

        const { findForgettable, forgetMemoryById } = await import("../forget.js");
        expect(findForgettable("cashews").length).toBeGreaterThan(0);
        expect(forgetMemoryById(out.id)).toBe(true);
        expect(raw.prepare("SELECT 1 FROM memories WHERE id = ?").get(out.id)).toBeUndefined();
    });
});
