// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The owner's language survives a restart (proactive sends after a reboot stay in it),
// but only once a second message confirms it: a one-off paste isn't saved.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let prefs: Record<string, unknown> = {};
vi.mock("./memory/identity.js", () => ({
    getIdentityProfile: () => ({ user_id: "default", version: 1, preferences: prefs }),
    updateIdentityProfile: (f: { preferences?: Record<string, unknown> }) => {
        prefs = { ...prefs, ...f.preferences };
    },
}));
const { getCurrentLanguage, getLanguageInstruction, resetLanguage, updateSessionLanguage } = await import(
    "./language.js"
);

describe("language persistence", () => {
    beforeEach(() => {
        prefs = {};
        resetLanguage();
        vi.useFakeTimers();
        vi.spyOn(console, "log").mockImplementation(() => undefined);
    });
    afterEach(() => vi.useRealTimers());

    it("a switch confirmed by a second message is saved and read back after a restart", () => {
        updateSessionLanguage("bhai kya scene hai aaj, kuch plan hai kya");
        expect(prefs.language).toBeUndefined();
        vi.advanceTimersByTime(31_000);
        updateSessionLanguage("haan yaar kal milte hai phir, theek hai na");
        expect(prefs.language).toBe("Hindi (Romanized)");
        resetLanguage(); // what a restart leaves: module state back to English
        expect(getLanguageInstruction()).toMatch(/Hinglish/);
        expect(getCurrentLanguage()).toBe("Hindi (Romanized)");
    });

    it("a one-off foreign paste switches this session only", () => {
        updateSessionLanguage("translate this: Привет, как дела? Увидимся завтра на встрече");
        expect(getCurrentLanguage()).toBe("Russian");
        vi.advanceTimersByTime(31_000);
        updateSessionLanguage("thanks, that is what I needed for the email");
        expect(getCurrentLanguage()).toBe("English");
        resetLanguage();
        expect(prefs.language).toBeUndefined();
        expect(getCurrentLanguage()).toBe("English");
    });
});
