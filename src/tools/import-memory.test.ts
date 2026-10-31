// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { runWithCallerContext } from "./cron-tool.js";
import { hasImportCue, importMemory, readImportFile } from "./import-memory.js";

describe("hasImportCue", () => {
    it("takes the owner's own asks and pasted exports", () => {
        for (const m of [
            "import my memory from chatgpt",
            "bring over what Claude knows about me",
            "here's my conversations.json",
            "ise yaad rakh lo",
            "import it",
            "import my memories",
            "haan import",
            "yes import",
            "[2025-01-02] - Works as a product designer at Acme",
            "```\n- [unknown] - Likes filter coffee\n```",
        ]) {
            expect(hasImportCue(m), m).toBe(true);
        }
    });

    it("refuses turns that never asked", () => {
        for (const m of ["", "what's the weather in Pune", "summarise this web page", "open Spotify"]) {
            expect(hasImportCue(m), m).toBe(false);
        }
    });
});

// A minimal zip writer: stored or deflated entries, and a declared size that can lie (a zip bomb's trick).
function zip(entries: { name: string; data: string | Buffer; store?: boolean; declared?: number }[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const e of entries) {
        const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
        const body = e.store ? raw : deflateRawSync(raw);
        const name = Buffer.from(e.name);
        const size = e.declared ?? raw.length;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(e.store ? 0 : 8, 8);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(size, 22);
        local.writeUInt16LE(name.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(e.store ? 0 : 8, 10);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(size, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, name, body);
        centrals.push(central, name);
        offset += 30 + name.length + body.length;
    }
    const cd = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bhai-import-zip-"));
const writeZip = (name: string, entries: Parameters<typeof zip>[0]) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, zip(entries));
    return p;
};

describe("readImportFile: data export zips", () => {
    it("joins every ChatGPT conversations shard, at any depth, stored or deflated", async () => {
        const p = writeZip("chatgpt.zip", [
            { name: "user.json", data: '{"email":"me@example.com"}' },
            { name: "conversations-000.json", data: JSON.stringify([{ title: "A", mapping: {} }]) },
            { name: "export/conversations-001.json", data: JSON.stringify([{ title: "B", mapping: {} }]), store: true },
            { name: "conversations.json", data: JSON.stringify([{ title: "C", mapping: {} }]) },
        ]);
        const r = await readImportFile(p);
        if ("error" in r) throw new Error(r.error);
        expect(r.filename).toBe("conversations.json");
        const titles = (JSON.parse(r.raw) as { title: string }[]).map((c) => c.title).sort();
        expect(titles).toEqual(["A", "B", "C"]);
        expect(r.raw).not.toContain("me@example.com");
    });

    it("Claude's export: memories.json first, projects by name only, then chats", async () => {
        const p = writeZip("claude.zip", [
            { name: "users.json", data: '[{"email_address":"me@example.com"}]' },
            { name: "conversations.json", data: JSON.stringify([{ uuid: "c", name: "Trip", chat_messages: [] }]) },
            { name: "projects.json", data: JSON.stringify([{ uuid: "p-1", name: "Bhai", docs: [{ content: "HUGE DOC" }] }]) },
            { name: "memories.json", data: JSON.stringify([{ conversations_memory: "Lives in Pune", project_memories: {} }]) },
        ]);
        const r = await readImportFile(p);
        if ("error" in r) throw new Error(r.error);
        const all = JSON.parse(r.raw) as Record<string, unknown>[];
        expect(all[0]).toMatchObject({ conversations_memory: "Lives in Pune" });
        expect(all[1]).toEqual({ uuid: "p-1", name: "Bhai" });
        expect(all[2]).toMatchObject({ name: "Trip" });
        expect(r.raw).not.toContain("HUGE DOC");
        expect(r.raw).not.toContain("me@example.com");
    });

    it("no conversations: the largest other text file, never users.json", async () => {
        const p = writeZip("pi.zip", [
            { name: "users.json", data: `{"pad":"${"u".repeat(5000)}"}` },
            { name: "pi-user-history.json", data: '{"messages":[{"role":"user","text":"I garden"}]}' },
        ]);
        const r = await readImportFile(p);
        expect(r).toMatchObject({ filename: "pi-user-history.json" });
    });

    it("refuses a zip bomb: a lying small header, and entries that add up past the budget", async () => {
        const zeros = Buffer.alloc(3 * 1024 * 1024);
        const liar = writeZip("bomb.zip", [{ name: "conversations.json", data: zeros, declared: 10 }]);
        expect(await readImportFile(liar, 1024 * 1024)).toHaveProperty("error");
        const many = writeZip("many.zip", [
            { name: "conversations-1.json", data: `["${"a".repeat(600_000)}"]` },
            { name: "conversations-2.json", data: `["${"b".repeat(600_000)}"]` },
        ]);
        expect(await readImportFile(many, 1024 * 1024)).toEqual({ error: "What's inside that .zip is over 200 MB." });
        expect(await readImportFile(many)).not.toHaveProperty("error");
    });

    it("accepts a picked file under ~/Downloads-like places; refuses other extensions", async () => {
        expect(await readImportFile(path.join(os.homedir(), "Downloads", "no-such-export.zip"))).toEqual({
            error: expect.stringMatching(/^File not found/),
        });
        expect(await readImportFile(path.join(dir, "x.pdf"))).toEqual({
            error: "Only .txt, .md, .json or .zip exports can be imported.",
        });
    });
});

describe("import_memory tool", () => {
    const run = (ctx: Parameters<typeof runWithCallerContext>[0], input: Record<string, unknown>) =>
        Promise.resolve(runWithCallerContext(ctx, () => importMemory.handler(input))).then((r) => JSON.parse(r as string));

    it("refuses anyone but the owner, and the owner outside a private chat", async () => {
        expect(await run({ isOwner: false, isPrivate: true }, { text: "[unknown] - x" })).toMatchObject({
            success: false,
            error: "Only the owner can import memories.",
        });
        expect(await run({ isOwner: true, isPrivate: false }, { text: "[unknown] - x" })).toMatchObject({
            success: false,
        });
    });

    it("no import cue in the owner's message: tells the model what reply to ask for", async () => {
        const r = await run(
            { isOwner: true, isPrivate: true, message: "what's the weather" },
            { text: "Lives in Pune" },
        );
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/"import it"/);
    });

    it("the prompt step adds paste-first guidance on Telegram and WhatsApp only", async () => {
        const tg = await run({ isOwner: true, isPrivate: true, conversationKey: "telegram:1" }, {});
        expect(tg.prompt).toMatch(/Do not summarize, group, or omit any entries/);
        expect(tg.channel_hint).toMatch(/20 MB/);
        const overlay = await run({ isOwner: true, isPrivate: true, conversationKey: "overlay:local" }, {});
        expect(overlay.channel_hint).toBeUndefined();
    });
});
