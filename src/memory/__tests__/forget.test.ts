// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.ATLAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-forget-"));

let sqlite: typeof import("../sqlite.js");
let forget: typeof import("../forget.js");
let consent: typeof import("../../security/consent.js");
let raw: NonNullable<ReturnType<typeof sqlite.getRawDb>>;

const count = (sql: string) => (raw.prepare(sql).get() as { n: number }).n;

beforeAll(async () => {
    sqlite = await import("../sqlite.js");
    forget = await import("../forget.js");
    consent = await import("../../security/consent.js");
    const db = await sqlite.initMemoryDB();
    raw = sqlite.getRawDb() as typeof raw;
    (await import("../identity.js")).initIdentityDB(db);
    (await import("../traits.js")).initTraitsDB(db);
    const identity = await import("../identity.js");
    identity.updateIdentityProfile({ name: "Dheeraj", projects: ["a", "b", "surprise for Priya", "c"] });
    (await import("../traits.js")).upsertTrait("dates_priya", "true", 0.8);
    (await import("../task-learnings.js")).upsertLearning("app", "book a table for Priya", "Zomato", [], [], [], 1);

    const ins = raw.prepare("INSERT INTO memories (content, category) VALUES (?, ?)");
    ins.run("Owner is seeing Priya since June", "fact");
    ins.run("Session: planned dinner with Priya", "session_summary");
    ins.run("Owner likes chai", "preference");
    raw.prepare("INSERT INTO episodic_memory (id, type, description) VALUES ('e1', 'win', 'First date with Priya went well')").run();
    raw.prepare("INSERT INTO emotional_memory (id, emotion, context) VALUES ('m1', 'joy', 'happy about Priya')").run();
    const msgs = [
        { role: "user", content: "I'm seeing Priya" },
        { role: "assistant", content: "Nice!" },
        { role: "user", content: "remind me about chai" },
    ];
    raw.prepare("INSERT INTO conversations (session_id, messages_json, summary) VALUES ('s1', ?, 'Talked about Priya')").run(
        JSON.stringify(msgs),
    );
    raw.prepare("INSERT INTO conversation_embeddings (conversation_id, embedding) VALUES (1, x'00')").run();
    sqlite.indexConversationMessages(1, "s1", msgs);
    raw.prepare(
        "INSERT INTO sessions (session_id, started_at, last_activity, short_summary, recent_turns_json) VALUES ('s1', '2026-10-01', '2026-10-01', 'chatted', ?)",
    ).run(JSON.stringify([{ role: "user", content: "about Priya", ts: 1 }]));
});

describe("memory_forget across tiers", () => {
    it("previews matches in every tier and only deletes on the owner's later yes", () => {
        consent._resetConsent();
        const p = forget.previewForget("priya");
        const tiers = forget.findForgettable("priya").map((i) => i.tier);
        expect(new Set(tiers)).toEqual(
            new Set([
                "memory (fact)",
                "memory (session_summary)",
                "trait",
                "identity",
                "episode",
                "feeling",
                "task learning",
                "chat message",
                "chat log",
                "session",
            ]),
        );
        expect(p.count).toBe(tiers.length);
        expect(p.preview).toMatch(/^10 items: 1 memory \(fact\), .*\n1\. \[/);
        const token = p.token as string;

        // A quote the owner never sent, or one from before the preview, is refused.
        expect(forget.executeForget(token, "yes", "x")).toHaveProperty("error");
        consent.noteOwnerMessage("no wait");
        expect(forget.executeForget(token, "no wait", "x")).toHaveProperty("error");
        expect(count("SELECT COUNT(*) n FROM memories")).toBe(3);

        consent.noteOwnerMessage("yes forget it");
        const live = [{ role: "user", content: "forget that I'm seeing Priya" }, { role: "assistant", content: "ok" }];
        expect(forget.executeForget(token, "yes forget it", "private now", live)).toEqual({ forgotten: tiers.length });
        expect(forget.executeForget(token, "yes forget it", "again")).toHaveProperty("error"); // single use

        expect(forget.findForgettable("priya")).toEqual([]);
        expect(count("SELECT COUNT(*) n FROM memories")).toBe(1); // chai survives
        expect(count("SELECT COUNT(*) n FROM conversations_fts WHERE content MATCH 'priya'")).toBe(0);
        expect(count("SELECT COUNT(*) n FROM conversation_embeddings")).toBe(0);
        const conv = raw.prepare("SELECT messages_json, summary FROM conversations").get() as {
            messages_json: string;
            summary: string | null;
        };
        expect(JSON.parse(conv.messages_json).map((m: { content: string }) => m.content)).toEqual([
            "[forgotten]",
            "Nice!",
            "remind me about chai",
        ]);
        expect(conv.summary).toBeNull();
        expect(live[0].content).toBe("[forgotten]");
        expect(live[1].content).toBe("ok");

        // Identity: only the matching project went; the others kept their order.
        const profile = JSON.parse(
            (raw.prepare("SELECT profile_json FROM user_profiles").get() as { profile_json: string }).profile_json,
        );
        expect(profile.projects).toEqual(["a", "b", "c"]);
        expect(profile.name).toBe("Dheeraj");

        // The log keeps the count and the reason, never the content.
        const log = raw.prepare("SELECT * FROM memory_forget_log").all() as Array<Record<string, unknown>>;
        expect(log).toHaveLength(1);
        expect(log[0]).toMatchObject({ kind: "forget", original_id: `${tiers.length} items`, reason: "private now" });
        expect(JSON.stringify(log)).not.toMatch(/priya/i);
    });

    it("matches whole words in any script and reaches goals, the graph, insights, caches and logs", async () => {
        consent._resetConsent();
        const db = sqlite.getMemoryDB();
        (await import("../goals.js")).initGoals(db);
        (await import("../knowledge-graph.js")).initKnowledgeGraph(db);
        const ins = raw.prepare("INSERT INTO memories (content, category) VALUES (?, ?)");
        ins.run("Маша moved to Pune", "fact");
        ins.run("Same as before, sample sizes from Samsung", "fact");
        raw.prepare("INSERT INTO goals (description) VALUES ('Plan a trip with Маша')").run();
        raw.prepare("INSERT INTO entities (id, name) VALUES (1, 'Маша'), (2, 'Pune')").run();
        raw.prepare("INSERT INTO relationships (from_id, to_id, type) VALUES (1, 2, 'lives_in')").run();
        raw.prepare("INSERT INTO memory_insights (kind, title, body) VALUES ('most_discussed', 'People', 'You talk about Маша a lot')").run();
        const tools = await import("../../tools/tool-intelligence.js");
        tools.setCache("memory_search", { query: "маша" }, "Маша moved to Pune");
        fs.writeFileSync(path.join(process.env.ATLAS_DATA_DIR as string, "memory-gate.jsonl"), '{"content_preview":"x\\nМаша moved"}\n{"sha":"1"}\n');

        expect(forget.findForgettable("sam")).toEqual([]); // not "same", "sample" or "Samsung"
        const p = forget.previewForget("маша");
        expect(p.preview.split("\n")[0]).toBe("4 items: 1 memory (fact), 1 goal, 1 graph entity, 1 insight");
        consent.noteOwnerMessage("yes");
        expect(forget.executeForget(p.token as string, "yes", "")).toEqual({ forgotten: 4 });

        expect(raw.prepare("DELETE FROM memories WHERE content LIKE 'Same%'").run().changes).toBe(1);
        for (const t of ["goals", "entities WHERE id = 1", "relationships", "memory_insights"]) {
            expect(count(`SELECT COUNT(*) n FROM ${t}`)).toBe(0);
        }
        expect(tools.getCached("memory_search", { query: "маша" })).toBeNull();
        const gate = fs.readFileSync(path.join(process.env.ATLAS_DATA_DIR as string, "memory-gate.jsonl"), "utf8");
        expect(gate).not.toContain("Маша");
        expect(gate).toContain('"sha":"1"');
    });

    it("forgetMemoryById drops one memory without keeping its content", () => {
        const id = (raw.prepare("SELECT id FROM memories").get() as { id: number }).id;
        expect(forget.forgetMemoryById(id)).toBe(true);
        expect(forget.forgetMemoryById(id)).toBe(false);
        expect(count("SELECT COUNT(*) n FROM memories")).toBe(0);
        expect(count("SELECT COUNT(*) n FROM memory_forget_log WHERE content_snapshot IS NOT NULL")).toBe(0);
    });

    it("memory_forget refuses anyone but the owner in a live turn", async () => {
        const { memoryForget } = await import("../../tools/memory-tools.js");
        const { runWithCallerContext } = await import("../../tools/cron-tool.js");
        for (const ctx of [{ isOwner: false }, { isOwner: true, autonomous: true }]) {
            const out = JSON.parse(await runWithCallerContext(ctx, () => memoryForget.handler({ query: "zebra" })));
            expect(out.success).toBe(false);
        }
        const out = JSON.parse(
            await runWithCallerContext({ isOwner: true }, () => memoryForget.handler({ query: "zebra" })),
        );
        expect(out).toMatchObject({ success: true, count: 0 });
    });
});
