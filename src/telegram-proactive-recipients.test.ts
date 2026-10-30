// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Proactive messages carry the owner's calendar, tasks and mail: they go to the owners,
// not to every allowed Telegram user.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "tg-proactive-"));
process.env.ATLAS_DATA_DIR = dir;
process.env.OWNER_TELEGRAM_IDS = "111";
const { sendProactiveMessage } = await import("./telegram.js");
const config = { allowedUserIds: new Set([111, 222]) };
mkdirSync(join(dir, "research")); // Bhai's own files elsewhere in the data dir never leave
const report = join(dir, "research", "report.md");
writeFileSync(report, "# Report\n");

it("sends a plain proactive message to the owners only", async () => {
    const sentTo: number[] = [];
    const bot = {
        api: {
            sendMessage: async (chatId: number) => {
                sentTo.push(chatId);
                return { message_id: 1 };
            },
        },
    };
    await sendProactiveMessage(bot as never, config as never, "Morning: 3 meetings today, dentist at 5.");
    expect([...new Set(sentTo)]).toEqual([111]);
});

it("sends a proactive file to the owners only, its caption rendered like a reply", async () => {
    const sentTo: number[] = [];
    const opts: { caption?: string; parse_mode?: string }[] = [];
    const bot = {
        api: {
            sendDocument: async (chatId: number, _file: unknown, o: { caption?: string; parse_mode?: string }) => {
                sentTo.push(chatId);
                opts.push(o);
                return { message_id: 1 };
            },
        },
    };
    const msg = "📚 Research ready\n\n**bold** [1](https://x.y)";
    expect(await sendProactiveMessage(bot as never, config as never, msg, report)).toBe(true);
    expect(sentTo).toEqual([111]);
    expect(opts[0].parse_mode).toBe("HTML");
    expect(opts[0].caption).toContain("<b>bold</b>");
});

it("a caption Telegram can't parse goes again as plain text", async () => {
    const opts: { caption?: string; parse_mode?: string }[] = [];
    const bot = {
        api: {
            sendDocument: async (_chatId: number, _file: unknown, o: { caption?: string; parse_mode?: string }) => {
                opts.push(o);
                if (opts.length === 1) throw new Error("Bad Request: can't parse entities");
                return { message_id: 1 };
            },
        },
    };
    expect(await sendProactiveMessage(bot as never, config as never, "📚 **Research** ready", report)).toBe(true);
    expect(opts).toHaveLength(2);
    expect(opts[1].parse_mode).toBeUndefined();
    expect(opts[1].caption).toContain("Research ready");
});

it("still sends the text when every file upload fails", async () => {
    const texts: number[] = [];
    const bot = {
        api: {
            sendDocument: async () => {
                throw new Error("upload failed");
            },
            sendMessage: async (chatId: number) => {
                texts.push(chatId);
                return { message_id: 1 };
            },
        },
    };
    expect(await sendProactiveMessage(bot as never, config as never, "📚 Research ready — the answer", report)).toBe(true);
    expect(texts).toEqual([111]);
});
