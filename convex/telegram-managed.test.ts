// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { isBotUsername, managedBotLink } from "./telegramManaged";

describe("managed Telegram bots", () => {
    it("accepts only usernames Telegram would take for a bot", () => {
        expect(isBotUsername("bhai_x7k2q_bot")).toBe(true);
        expect(isBotUsername("BhaiBot")).toBe(true);
        expect(isBotUsername("bhai_x7k2q")).toBe(false);
        expect(isBotUsername("1bhai_bot")).toBe(false);
        expect(isBotUsername("bot")).toBe(false);
        expect(isBotUsername(`b${"a".repeat(29)}bot`)).toBe(false);
        expect(isBotUsername("bhai/../x_bot")).toBe(false);
        expect(isBotUsername(42)).toBe(false);
    });

    it("builds Telegram's documented newbot link", () => {
        expect(managedBotLink("BhaiSetupBot", "bhai_x7k2q_bot")).toBe("https://t.me/newbot/BhaiSetupBot/bhai_x7k2q_bot?name=Bhai");
    });
});
