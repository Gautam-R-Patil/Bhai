// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { CronCallerContext } from "../../tools/cron-tool.js";

process.env.BHAI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bhai-commit-"));

let sqlite: typeof import("../sqlite.js");
let tools: typeof import("../../tools/memory-tools.js");
let cron: typeof import("../../tools/cron-tool.js");
let src: typeof import("../../proactive/sources/commitment-due.js");
let raw: NonNullable<ReturnType<typeof sqlite.getRawDb>>;

beforeAll(async () => {
    sqlite = await import("../sqlite.js");
    tools = await import("../../tools/memory-tools.js");
    cron = await import("../../tools/cron-tool.js");
    src = await import("../../proactive/sources/commitment-due.js");
    await sqlite.initMemoryDB();
    raw = sqlite.getRawDb() as typeof raw;
});

const NOW = Date.parse("2026-10-30T10:00:00Z");
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const store = async (ctx: CronCallerContext, input: Record<string, unknown>) =>
    JSON.parse(
        await cron.runWithCallerContext(ctx, () =>
            cron.runAsMainLoopTool("memory_store", () => tools.memoryStore.handler(input)),
        ),
    );
const rowOf = (id: number) =>
    raw.prepare("SELECT category, due_at, fired_at FROM memories WHERE id = ?").get(id) as {
        category: string;
        due_at: string | null;
        fired_at: string | null;
    };
const commitment = (content: string, dueIso: string, firedAt: string | null = null) =>
    Number(
        raw
            .prepare("INSERT INTO memories (content, category, due_at, fired_at) VALUES (?, 'commitment', ?, ?)")
            .run(content, dueIso, firedAt).lastInsertRowid,
    );

describe("commitmentDue gate", () => {
    const due = "2026-11-06T18:00:00Z";
    it("takes the owner's own first-person promise with a time", () => {
        for (const msg of [
            "I'll send Riya the deck by Friday",
            "I need to file taxes tomorrow",
            "I promised Arjun I'd call him at 5pm",
            "main kal tak deck bhej dunga",
            "mujhe parso report bhejna hai",
            "मैं कल रिपोर्ट भेजूँगा",
        ]) {
            expect(tools.commitmentDue(msg, due, NOW), msg).toEqual({ dueAt: "2026-11-06T18:00:00.000Z" });
        }
    });

    it("refuses inferred, timeless, remind-me and unparseable ones", () => {
        const refused = (msg: string, d: unknown = due) => "error" in tools.commitmentDue(msg, d, NOW);
        expect(refused("Riya needs the deck by Friday")).toBe(true); // not the owner's promise
        expect(refused("I'll send Riya the deck")).toBe(true); // no time
        expect(refused("Remind me to send Riya the deck tomorrow, I'll forget")).toBe(true); // cron's job
        expect(refused("I'll send it tomorrow", "next friday")).toBe(true);
        expect(refused("I'll send it tomorrow", "2026-10-29T10:00:00Z")).toBe(true); // past
        expect(refused("I'll send it tomorrow", null)).toBe(true);
    });

    it("hasDoneCue reads done and dropped", () => {
        expect(tools.hasDoneCue("sent it to Riya, done")).toBe(true);
        expect(tools.hasDoneCue("bhej diya")).toBe(true);
        expect(tools.hasDoneCue("what's on my plate?")).toBe(false);
        expect(tools.hasDoneCue("did Riya reply? check my inbox")).toBe(false);
    });
});

describe("commitments in memory_store", () => {
    it("stores the owner's commitment with due_at; contacts and autonomous runs can't", async () => {
        const due = inDays(3);
        const out = await store(
            { isOwner: true, message: "I'll send Riya the deck by Monday" },
            { content: "Send Riya the deck by Monday", category: "commitment", due_at: due },
        );
        expect(out).toMatchObject({ success: true, due_at: due });
        expect(rowOf(out.id)).toEqual({ category: "commitment", due_at: due, fired_at: null });

        for (const ctx of [
            { isOwner: false, message: "I'll send Riya the deck by Monday" },
            { isOwner: true, autonomous: true, message: "I'll send Riya the deck by Monday" },
        ] as CronCallerContext[]) {
            expect(await store(ctx, { content: "Contact promise", category: "commitment", due_at: due })).toMatchObject({
                success: false,
            });
        }
        expect(
            await store(
                { isOwner: true, message: "Riya wants the deck Monday" },
                { content: "Send Riya the deck", category: "commitment", due_at: due },
            ),
        ).toMatchObject({ success: false });
    });

    it("done_id takes a shown commitment off the card on the owner's word", async () => {
        const id = commitment("Call the bank about the card", inDays(1));
        const shown = (message: string): CronCallerContext => ({ isOwner: true, message, shownMemories: new Set([id]) });
        expect(await store(shown("what's next?"), { content: "x", done_id: id })).toMatchObject({ success: false });
        expect(await store({ isOwner: false, message: "done" }, { content: "x", done_id: id })).toMatchObject({
            success: false,
        });
        expect(await store(shown("called them, done"), { content: "x", done_id: id })).toMatchObject({
            success: true,
            done: true,
        });
        expect(rowOf(id).category).toBe("commitment_done");

        // One per turn: text riding the owner's "done" can't retire every commitment on the card.
        const a = commitment("Book flights", inDays(1));
        const b = commitment("Renew insurance", inDays(1));
        const ctx: CronCallerContext = { isOwner: true, message: "done", shownMemories: new Set([a, b]) };
        const both = await cron.runWithCallerContext(ctx, () =>
            cron.runAsMainLoopTool("memory_store", async () => [
                JSON.parse(await tools.memoryStore.handler({ content: "x", done_id: a })),
                JSON.parse(await tools.memoryStore.handler({ content: "x", done_id: b })),
            ]),
        );
        expect(both.map((o) => o.success)).toEqual([true, false]);
        expect(rowOf(b).category).toBe("commitment");

        const { buildMemoryCards } = await import("../cards.js");
        const rec = { id, content: "Call the bank about the card", tags: "", importance: 5, access_count: 0 };
        const created_at = "2026-10-30 09:00:00";
        expect(buildMemoryCards("bank", [{ ...rec, category: "commitment_done", created_at }]).cards).not.toContain(
            "COMMITMENTS",
        );
        expect(buildMemoryCards("bank", [{ ...rec, category: "commitment", created_at }]).cards).toContain("COMMITMENTS");
    });
});

describe("commitment_due source", () => {
    it("fires each commitment once near due, never a fired, done, far-off or long-past one", async () => {
        const now = Date.now();
        const soon = commitment("Send Riya the deck", new Date(now + 10 * 60_000).toISOString());
        commitment("Pay rent", new Date(now + 10 * 60_000).toISOString(), "2026-10-30 09:00:00"); // fired before a restart
        commitment("Renew passport", new Date(now + 5 * 86_400_000).toISOString());
        commitment("Old thing", new Date(now - 2 * 86_400_000).toISOString());

        const first = await src.COMMITMENT_DUE.collectIntents({ now });
        expect(first.map((i) => i.payload.memoryId)).toEqual([soon]);
        expect(first[0]).toMatchObject({ source: "commitment_due", urgency: "normal", mode: "question" });
        expect(first[0].expiresAt).toBeGreaterThan(now);
        expect(await src.COMMITMENT_DUE.collectIntents({ now })).toEqual([]);
        // Never sent (held, suppressed, failed): it has expired by the retry, which collects it again.
        expect(first[0].expiresAt).toBe(now + 60 * 60_000);
        const retry = await src.COMMITMENT_DUE.collectIntents({ now: now + 61 * 60_000 });
        expect(retry.map((i) => i.payload.memoryId)).toEqual([soon]);

        const { SourceRegistry } = await import("../../proactive/sources/registry.js");
        const reg = new SourceRegistry();
        reg.register(src.COMMITMENT_DUE);
        reg.dispatched(first[0]);
        expect(rowOf(soon).fired_at).not.toBeNull();

        const { tryTemplate } = await import("../../proactive/composer-templates.js");
        expect(tryTemplate(first[0], "discord")).toContain("Send Riya the deck");
        // It quotes the owner's memory: a private surface, owners only, never a phone number.
        expect(first[0]).toMatchObject({ channelPreference: "overlay", payload: { ownerOnly: true } });
        const call = commitment("Call Riya on +91 98765 43210", new Date(now + 10 * 60_000).toISOString());
        const [nudge] = (await src.COMMITMENT_DUE.collectIntents({ now })).filter((i) => i.payload.memoryId === call);
        expect(tryTemplate(nudge, "telegram")).toContain(`commitment #${call}`);
        expect(JSON.stringify(nudge)).not.toContain("98765");
    });
});
