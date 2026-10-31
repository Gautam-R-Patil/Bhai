// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// A proactive Discord message with a file (e.g. a research answer plus its report) must arrive
// whole, not cut to the first 2000-char chunk, and in the DM of the owner it was meant for.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const sent: { to: string; content: string; files?: unknown[] }[] = [];
vi.mock("discord.js", () => {
    class Client {
        users = { fetch: async (id: string) => ({ createDM: async () => ({ send: async (m: unknown) => {
            sent.push(typeof m === "string" ? { to: id, content: m } : { to: id, ...(m as { content: string }) });
        } }) }) };
        on() {}
        once() {}
        async login() {}
    }
    const stub = class {};
    return {
        Client,
        GatewayIntentBits: {},
        Events: {},
        ChannelType: {},
        Partials: {},
        SlashCommandBuilder: stub,
        REST: stub,
        Routes: {},
        EmbedBuilder: stub,
        AttachmentBuilder: class {
            constructor(public buf: unknown) {}
        },
    };
});

const dir = mkdtempSync(join(tmpdir(), "discord-proactive-"));
process.env.BHAI_DATA_DIR = dir;
process.env.DISCORD_BOT_TOKEN = "t";
process.env.OWNER_DISCORD_IDS = "A,B";
const { initDiscord, sendDiscordProactiveMessage } = await import("./discord.js");
await initDiscord({} as never);
mkdirSync(join(dir, "research")); // Bhai's own files elsewhere in the data dir never leave
const report = join(dir, "research", "report.md");
writeFileSync(report, "# Report\n");

it("sends every chunk of a long message with a file, to the owner asked for", async () => {
    const answer = "word ".repeat(1000); // ~5000 chars: three Discord messages
    expect(await sendDiscordProactiveMessage(answer, report, "B")).toBe(true);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent[0].files).toHaveLength(1);
    expect(sent.every((m) => m.to === "B")).toBe(true);
    expect(sent.map((m) => m.content).join("").replace(/\s/g, "")).toBe(answer.replace(/\s/g, ""));
});

it("never sends to a non-owner id", async () => {
    sent.length = 0;
    await sendDiscordProactiveMessage("hi", undefined, "stranger");
    expect(sent.map((m) => m.to)).toEqual(["A"]);
});
