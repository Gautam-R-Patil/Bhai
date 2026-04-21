// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { wrapDatabase, initProactiveSchema } from "../memory/sqlite.js";
import { MonitorStore, type MonitorRuleInput } from "./monitors/monitor-store.js";
import type { ParseResult } from "./monitors/monitor-parser.js";
import { tryProactiveCommand, type ProactiveCommandOpts } from "./chat-commands.js";

function mkStore() {
    const raw = new BetterSqlite3(":memory:");
    const db = wrapDatabase(raw);
    initProactiveSchema(db);
    return { raw, store: new MonitorStore(raw) };
}

function mkInput(overrides: Partial<MonitorRuleInput> = {}): MonitorRuleInput {
    return {
        userPhrase: "ping me if anyone mentions X",
        topic: "mentions of X",
        topicEmbedding: new Array(384).fill(0).map((_, i) => Math.sin(i * 0.1)),
        scope: { channels: ["*"] as ["*"], excludeSelf: true },
        urgency: "normal",
        action: { defaultMode: "question" },
        threshold: 0.82,
        cooldownMinutes: 60,
        ...overrides,
    };
}

describe("tryProactiveCommand — posture controls", () => {
    let dir: string;
    let file: string;
    const original = { ...process.env };

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "atlas-cc-"));
        file = join(dir, "cfg.json");
        delete process.env.ATLAS_PROACTIVE_DISABLE;
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
        process.env = { ...original };
    });

    it("`shut up` sets global disable", async () => {
        const r = await tryProactiveCommand("shut up", { configPath: file });
        expect(r?.reply).toMatch(/quiet/i);
        expect(process.env.ATLAS_PROACTIVE_DISABLE).toBe("true");
    });

    it("`atlas, shut up` works too", async () => {
        const r = await tryProactiveCommand("atlas, shut up", { configPath: file });
        expect(r?.reply).toMatch(/quiet/i);
        expect(process.env.ATLAS_PROACTIVE_DISABLE).toBe("true");
    });

    it("`resume` clears the disable flag", async () => {
        process.env.ATLAS_PROACTIVE_DISABLE = "true";
        const r = await tryProactiveCommand("resume", { configPath: file });
        expect(r?.reply).toMatch(/resuming/i);
        expect(process.env.ATLAS_PROACTIVE_DISABLE).toBeUndefined();
    });

    it("`atlas resume` works too", async () => {
        process.env.ATLAS_PROACTIVE_DISABLE = "true";
        const r = await tryProactiveCommand("atlas resume", { configPath: file });
        expect(r?.reply).toMatch(/resuming/i);
    });

    it("`set whatsapp to ambient` persists posture", async () => {
        const r = await tryProactiveCommand("set whatsapp to ambient", { configPath: file });
        expect(r?.reply).toMatch(/whatsapp/i);
        expect(r?.reply).toMatch(/ambient/i);
        const r2 = await tryProactiveCommand("proactive status", { configPath: file });
        expect(r2?.reply).toMatch(/whatsapp: ambient/i);
    });

    it("`set telegram to active` works too", async () => {
        const r = await tryProactiveCommand("set telegram to active", { configPath: file });
        expect(r?.reply).toMatch(/telegram/i);
        expect(r?.reply).toMatch(/active/i);
    });

    it("rejects unknown channel", async () => {
        const r = await tryProactiveCommand("set xmpp to calm", { configPath: file });
        expect(r?.reply).toMatch(/unknown channel/i);
    });

    it("rejects unknown preset", async () => {
        const r = await tryProactiveCommand("set whatsapp to spammy", { configPath: file });
        expect(r?.reply).toMatch(/unknown preset/i);
    });

    it("`proactive status` shows current postures", async () => {
        const r = await tryProactiveCommand("proactive status", { configPath: file });
        expect(r?.reply).toMatch(/current postures/i);
        expect(r?.reply).toMatch(/whatsapp: calm/i);
        expect(r?.reply).toMatch(/telegram: active/i);
    });

    it("status reply reflects global disable", async () => {
        process.env.ATLAS_PROACTIVE_DISABLE = "true";
        const r = await tryProactiveCommand("proactive status", { configPath: file });
        expect(r?.reply).toMatch(/disabled/i);
    });

    it("returns null for non-command text", async () => {
        expect(await tryProactiveCommand("hello", { configPath: file })).toBeNull();
        expect(await tryProactiveCommand("what does that do?", { configPath: file })).toBeNull();
    });

    it("plain `stop` returns null (handled by stop-signal flow, not us)", async () => {
        expect(await tryProactiveCommand("stop", { configPath: file })).toBeNull();
    });
});

describe("tryProactiveCommand — monitor CRUD", () => {
    let dir: string;
    let file: string;
    let store: MonitorStore;
    let nativeUpsert: ReturnType<typeof vi.fn>;
    let nativeDelete: ReturnType<typeof vi.fn>;
    const original = { ...process.env };

    function makeOpts(): ProactiveCommandOpts {
        return {
            configPath: file,
            monitorStore: store,
            parseRule: async (phrase: string): Promise<ParseResult> => ({
                kind: "ok",
                input: mkInput({ userPhrase: phrase, topic: `topic: ${phrase}` }),
            }),
            nativeMonitor: {
                upsertRule: nativeUpsert,
                deleteRule: nativeDelete,
            },
        };
    }

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "atlas-cc-mon-"));
        file = join(dir, "cfg.json");
        store = mkStore().store;
        nativeUpsert = vi.fn();
        nativeDelete = vi.fn();
        delete process.env.ATLAS_PROACTIVE_DISABLE;
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
        process.env = { ...original };
    });

    it("`ping me if X` creates a monitor and replies with the topic", async () => {
        const r = await tryProactiveCommand(
            "ping me if anyone mentions project launch",
            makeOpts(),
        );
        expect(r).not.toBeNull();
        expect(r?.reply).toMatch(/monitor #1/i);
        expect(r?.reply).toMatch(/anyone mentions project launch/i);
        expect(store.list(true).length).toBe(1);
        expect(nativeUpsert).toHaveBeenCalledTimes(1);
    });

    it("`atlas, monitor me when X` also creates a monitor", async () => {
        const r = await tryProactiveCommand(
            "atlas, monitor me when Lambda is discussed",
            makeOpts(),
        );
        expect(r?.reply).toMatch(/monitor #1/i);
        expect(store.list(true).length).toBe(1);
    });

    it("`watch for X` also creates a monitor", async () => {
        const r = await tryProactiveCommand(
            "watch for new pricing announcements",
            makeOpts(),
        );
        expect(r?.reply).toMatch(/monitor #1/i);
    });

    it("parser clarify → reply with clarification, no rule inserted", async () => {
        const opts = makeOpts();
        opts.parseRule = async () => ({
            kind: "clarify",
            question: "Did you mean only direct messages or group chats too?",
        });
        const r = await tryProactiveCommand("ping me if X", opts);
        expect(r?.reply).toMatch(/direct messages or group chats/i);
        expect(store.list(true).length).toBe(0);
        expect(nativeUpsert).not.toHaveBeenCalled();
    });

    it("parser error → graceful reply, no rule inserted", async () => {
        const opts = makeOpts();
        opts.parseRule = async () => ({ kind: "error", error: "bad embedding" });
        const r = await tryProactiveCommand("ping me if X", opts);
        expect(r?.reply).toMatch(/bad embedding/i);
        expect(store.list(true).length).toBe(0);
    });

    it("`list monitors` on empty store gives a helpful prompt", async () => {
        const r = await tryProactiveCommand("list monitors", makeOpts());
        expect(r?.reply).toMatch(/no monitors/i);
    });

    it("`list monitors` shows numbered rules whose order matches `delete monitor N`", async () => {
        const opts = makeOpts();
        await tryProactiveCommand("ping me if first thing", opts);
        await tryProactiveCommand("ping me if second thing", opts);
        await tryProactiveCommand("ping me if third thing", opts);
        const r = await tryProactiveCommand("list monitors", opts);
        // All three rules must be present, each tagged [active]
        expect(r?.reply).toMatch(/first thing/);
        expect(r?.reply).toMatch(/second thing/);
        expect(r?.reply).toMatch(/third thing/);
        // Numbered 1-3
        expect(r?.reply).toMatch(/1\./);
        expect(r?.reply).toMatch(/2\./);
        expect(r?.reply).toMatch(/3\./);
        expect((r?.reply.match(/\[active\]/g) ?? []).length).toBe(3);
    });

    it("`delete monitor N` removes a specific rule (both soft-delete + native)", async () => {
        const opts = makeOpts();
        await tryProactiveCommand("ping me if first thing", opts);
        await tryProactiveCommand("ping me if second thing", opts);
        // Resolve whichever rule `list monitors` calls #1 — must match what handleList renders.
        const first = await tryProactiveCommand("list monitors", opts);
        const nameOfFirst = first?.reply.match(/1\. (topic: [^[]+?) \[/)?.[1].trim();
        if (!nameOfFirst) throw new Error("failed to parse monitor #1 from list output");
        const r = await tryProactiveCommand("delete monitor 1", opts);
        expect(r?.reply).toMatch(/deleted monitor/i);
        expect(r?.reply).toContain(nameOfFirst);
        expect(store.list(true).length).toBe(1);
        expect(nativeDelete).toHaveBeenCalled();
    });

    it("`stop monitor N` also deletes (alias)", async () => {
        const opts = makeOpts();
        await tryProactiveCommand("ping me if first thing", opts);
        const r = await tryProactiveCommand("stop monitor 1", opts);
        expect(r?.reply).toMatch(/deleted monitor/i);
    });

    it("`remove monitor N` also deletes (alias)", async () => {
        const opts = makeOpts();
        await tryProactiveCommand("ping me if first thing", opts);
        const r = await tryProactiveCommand("remove monitor 1", opts);
        expect(r?.reply).toMatch(/deleted monitor/i);
    });

    it("`delete monitor N` with invalid N → friendly error", async () => {
        const opts = makeOpts();
        await tryProactiveCommand("ping me if first thing", opts);
        const r = await tryProactiveCommand("delete monitor 99", opts);
        expect(r?.reply).toMatch(/no monitor found/i);
    });

    it("`delete monitor <uuid>` works via id", async () => {
        const opts = makeOpts();
        await tryProactiveCommand("ping me if X", opts);
        const [rule] = store.list(true);
        const r = await tryProactiveCommand(`delete monitor ${rule.id}`, opts);
        expect(r?.reply).toMatch(/deleted monitor/i);
        expect(store.list(true).length).toBe(0);
    });

    it("`pause monitor N` sets active=false and calls native deleteRule", async () => {
        const opts = makeOpts();
        await tryProactiveCommand("ping me if first thing", opts);
        nativeDelete.mockClear();
        const r = await tryProactiveCommand("pause monitor 1", opts);
        expect(r?.reply).toMatch(/paused monitor/i);
        expect(store.list(false)[0].active).toBe(false);
        expect(nativeDelete).toHaveBeenCalledTimes(1);
    });

    it("`resume monitor N` sets active=true and calls native upsertRule", async () => {
        const opts = makeOpts();
        await tryProactiveCommand("ping me if first thing", opts);
        await tryProactiveCommand("pause monitor 1", opts);
        nativeUpsert.mockClear();
        const r = await tryProactiveCommand("resume monitor 1", opts);
        expect(r?.reply).toMatch(/resumed monitor/i);
        expect(store.list(false)[0].active).toBe(true);
        expect(nativeUpsert).toHaveBeenCalledTimes(1);
    });

    it("`resume` (no monitor arg) still clears the global disable — not caught by monitor resume", async () => {
        process.env.ATLAS_PROACTIVE_DISABLE = "true";
        const r = await tryProactiveCommand("resume", makeOpts());
        expect(r?.reply).toMatch(/resuming proactive/i);
        expect(process.env.ATLAS_PROACTIVE_DISABLE).toBeUndefined();
    });

    it("monitor commands return null when deps are absent (caller falls through)", async () => {
        // Only configPath provided — no monitor deps
        const r1 = await tryProactiveCommand("ping me if X", { configPath: file });
        expect(r1).toBeNull();
        const r2 = await tryProactiveCommand("list monitors", { configPath: file });
        expect(r2).toBeNull();
        const r3 = await tryProactiveCommand("delete monitor 1", { configPath: file });
        expect(r3).toBeNull();
        const r4 = await tryProactiveCommand("pause monitor 1", { configPath: file });
        expect(r4).toBeNull();
    });
});
