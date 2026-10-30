// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Proactive messages carry the owner's calendar, tasks and mail: they go to the owners,
// not to every allowed Telegram user.
import { expect, it } from "vitest";

process.env.OWNER_TELEGRAM_IDS = "111";
const { sendProactiveMessage } = await import("./telegram.js");

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
    const config = { allowedUserIds: new Set([111, 222]) };
    await sendProactiveMessage(bot as never, config as never, "Morning: 3 meetings today, dentist at 5.");
    expect([...new Set(sentTo)]).toEqual([111]);
});
