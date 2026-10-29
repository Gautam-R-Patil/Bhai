// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { ProactiveIntent } from "../../proactive/intent.js";
import type { CronCallerContext } from "../../tools/cron-tool.js";

process.env.ATLAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-digest-"));

let sqlite: typeof import("../sqlite.js");
let forget: typeof import("../forget.js");
let tools: typeof import("../../tools/memory-tools.js");
let cron: typeof import("../../tools/cron-tool.js");
let src: typeof import("../../proactive/sources/memory-digest.js");
let composer: typeof import("../../proactive/composer.js");
let raw: NonNullable<ReturnType<typeof sqlite.getRawDb>>;

beforeAll(async () => {
    sqlite = await import("../sqlite.js");
    forget = await import("../forget.js");
    tools = await import("../../tools/memory-tools.js");
    cron = await import("../../tools/cron-tool.js");
    src = await import("../../proactive/sources/memory-digest.js");
    composer = await import("../../proactive/composer.js");
    await sqlite.initMemoryDB();
    raw = sqlite.getRawDb() as typeof raw;
});

const WEEK = 7 * 86_400_000;
const stated = (content: string, ago: string | null = "-1 day", category = "general") =>
    Number(
        raw
            .prepare("INSERT INTO memories (content, category, stated_at) VALUES (?, ?, datetime('now', ?))")
            .run(content, category, ago).lastInsertRowid,
    );
const exists = (id: number) => !!raw.prepare("SELECT 1 FROM memories WHERE id = ?").get(id);
const collect = (now: number) => src.MEMORY_DIGEST.collectIntents({ now } as never);
const writeState = (s: object) =>
    fs.writeFileSync(path.join(process.env.ATLAS_DATA_DIR as string, "memory-digest.json"), JSON.stringify(s));
const forgetItem = async (ctx: CronCallerContext, n: number) =>
    JSON.parse(await cron.runWithCallerContext(ctx, () => tools.memoryForget.handler({ digest_item: n })));

let digest: ProactiveIntent;

describe("weekly digest", () => {
    it("skips the week with fewer than 3 owner-stated facts", async () => {
        stated("I'm vegetarian");
        stated("My sister Riya lives in Pune", "-2 hours");
        expect(await collect(Date.now())).toEqual([]);
        stated("I prefer short replies", "-1 hour");
        expect(await collect(Date.now() + 2 * 60 * 60_000)).toEqual([]); // still the skipped week
    });

    it("lists only what the owner stated this week, newest first, with a prune button each", async () => {
        stated("Old fact from last month", "-8 days");
        sqlite.getRawDb()?.prepare("INSERT INTO memories (content) VALUES ('Inferred: seems stressed')").run();
        stated("On 12 Oct Bhai sent an email", "-1 hour", "bhai_did");
        stated("My email is me@example.com", "-1 hour");
        const retired = stated("I live in Mumbai", "-3 hours");
        raw.prepare("UPDATE memories SET consolidated_into = 1 WHERE id = ?").run(retired);

        writeState({ ranAt: Date.now() - WEEK - 1 });
        const now = Date.now();
        const out = await collect(now);
        expect(out).toHaveLength(1);
        digest = out[0];
        const items = digest.payload.items as Array<{ id: number; content: string }>;
        expect(items.map((i) => i.content)).toEqual([
            "I prefer short replies",
            "My sister Riya lives in Pune",
            "I'm vegetarian",
        ]);
        expect(digest.payload.buttons).toEqual(
            items.map((it, i) => ({ text: `Forget #${i + 1}`, data: forget.digestPruneAction(it.id, now) })),
        );
        expect(await collect(now + 1000)).toEqual([]); // one in flight
    });

    it("words it per channel, quoting memories verbatim", async () => {
        const tg = await composer.compose(digest, "telegram", { tone: "warm" } as never, [], { llm: null });
        expect(tg?.text).toBe(
            "what I picked up about you this week:\n1. I prefer short replies\n2. My sister Riya lives in Pune\n3. I'm vegetarian\ntap one to drop it.",
        );
        const third = { ...digest, payload: { ...digest.payload, items: [{ id: 1, content: "The user is vegetarian" }] } };
        const ov = await composer.compose(third, "overlay", { tone: "warm" } as never, [], { llm: null });
        expect(ov?.text).toContain('1. The user is vegetarian\nanything off? say "forget #2"');
    });

    it("once sent, stays quiet for a week and resolves 'forget #N' only on the owner's own ask", async () => {
        src.MEMORY_DIGEST.onDispatched?.(digest);
        expect(await collect(Date.now() + 2 * 60 * 60_000)).toEqual([]);
        const ids = (digest.payload.items as Array<{ id: number }>).map((i) => i.id);
        expect(src.digestItemId(2)).toBe(ids[1]);
        expect(src.digestItemId(2, Date.now() + WEEK + 1000)).toBeUndefined();

        expect(await forgetItem({ isOwner: false, message: "forget #2" }, 2)).toMatchObject({ success: false });
        expect(await forgetItem({ isOwner: true, message: "#2 is right" }, 2)).toMatchObject({ success: false });
        expect(await forgetItem({ isOwner: true, message: "forget #12" }, 2)).toMatchObject({ success: false });
        // The cue word in the quoted digest is not the owner's.
        const reply = '[Replying to Bhai\'s message: "tap one to drop it."]\n\n#2 is right';
        expect(await forgetItem({ isOwner: true, message: reply }, 2)).toMatchObject({ success: false });
        // A pending forget preview owns "#N": "yes delete #2" confirms it, not the digest.
        const { token } = forget.previewForget("Riya");
        expect(token).toBeTruthy();
        expect(await forgetItem({ isOwner: true, message: "yes delete #2" }, 2)).toMatchObject({ success: false });
        forget._resetForget();
        expect(exists(ids[1])).toBe(true);
        expect(await forgetItem({ isOwner: true, message: "forget #2 please" }, 2)).toEqual({
            success: true,
            forgotten: "My sister Riya lives in Pune",
            hint: expect.any(String),
        });
        expect(exists(ids[1])).toBe(false);
        expect(await forgetItem({ isOwner: true, message: "forget #2" }, 2)).toMatchObject({ error: "Already gone." });
    });

    it("prune buttons delete that exact id for 7 days", () => {
        const id = (digest.payload.items as Array<{ id: number }>)[0].id;
        const now = Date.now();
        expect(forget.pruneDigestTap(forget.digestPruneAction(id, now - WEEK - 1000), now)).toMatch(/Too late/);
        expect(exists(id)).toBe(true);
        expect(forget.pruneDigestTap(forget.digestPruneAction(id, now - WEEK + 60_000), now)).toBe("Forgotten.");
        expect(exists(id)).toBe(false);
        expect(forget.pruneDigestTap(forget.digestPruneAction(id, now), now)).toBe("Already gone.");
        expect(forget.pruneDigestTap("mem:forget:1:1", now)).toBeUndefined();
    });
});

describe("stated_at", () => {
    const store = async (ctx: CronCallerContext, content: string) => {
        const out = JSON.parse(
            await cron.runWithCallerContext(ctx, () =>
                cron.runAsMainLoopTool("memory_store", () => tools.memoryStore.handler({ content })),
            ),
        );
        return raw.prepare("SELECT stated_at FROM memories WHERE id = ?").get(out.id) as { stated_at: string | null };
    };

    it("is set by the owner's own memory_store, never a contact's or an autonomous run's", async () => {
        expect((await store({ isOwner: true, message: "I run every morning" }, "Runs every morning")).stated_at).not.toBe(
            null,
        );
        expect((await store({ isOwner: false, message: "I'm Ravi" }, "Contact Ravi likes cricket")).stated_at).toBe(null);
        expect(
            (await store({ isOwner: true, autonomous: true, message: "" }, "Owner seems busy this week")).stated_at,
        ).toBe(null);
    });
});
