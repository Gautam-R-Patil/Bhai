// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The session language is the owner's: guests, contacts and helper calls don't move it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentLanguage, resetLanguage } from "./language.js";
import { type ChatParams, createLanguageMiddleware } from "./llm-middleware.js";
import { runWithCallerContext } from "./tools/cron-tool.js";

const mw = createLanguageMiddleware();
const seen: Array<string | undefined> = [];
const call = (text: string, extra: Partial<ChatParams> = {}) =>
    mw({ messages: [{ role: "user", content: text }], ...extra } as ChatParams, async (p) => {
        seen.push((p as unknown as Record<string, string>)._languageInstruction);
        return {} as never;
    });
const HINGLISH = "bhai kya scene hai aaj, kuch plan hai kya";

describe("session language scope", () => {
    beforeEach(() => {
        resetLanguage();
        seen.length = 0;
        vi.spyOn(console, "log").mockImplementation(() => undefined);
    });

    it("the owner's own turn sets it", async () => {
        await runWithCallerContext({ isOwner: true }, () => call(HINGLISH));
        expect(getCurrentLanguage()).toBe("Hindi (Romanized)");
    });

    it("a contact writing Hinglish doesn't switch the owner's replies, nor get the owner's language", async () => {
        await runWithCallerContext({ isOwner: false }, () => call(HINGLISH));
        expect(getCurrentLanguage()).toBe("English");
        await runWithCallerContext({ isOwner: true }, () => call(HINGLISH));
        seen.length = 0;
        await runWithCallerContext({ isOwner: false }, () => call("hey can you tell me when he is free"));
        expect(seen).toEqual([undefined]); // no "respond in Hinglish" for the contact
        expect(getCurrentLanguage()).toBe("Hindi (Romanized)");
    });

    it("a helper call's English prompt inside the owner's turn doesn't flip it back", async () => {
        await runWithCallerContext({ isOwner: true }, () => call(HINGLISH));
        await runWithCallerContext({ isOwner: true }, () =>
            call("Classify the following message into one of the categories and return JSON", { _lean: true }),
        );
        expect(getCurrentLanguage()).toBe("Hindi (Romanized)");
    });

    it("background work (no turn) still speaks the owner's language but can't change it", async () => {
        await runWithCallerContext({ isOwner: true }, () => call(HINGLISH));
        seen.length = 0;
        await call("Write a short reminder for the owner about their 5pm meeting");
        expect(getCurrentLanguage()).toBe("Hindi (Romanized)");
        expect(seen[0]).toContain("Hinglish");
    });
});
