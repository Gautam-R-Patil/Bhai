// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The owner's language survives a restart (proactive sends after a reboot stay in it).
import { describe, expect, it, vi } from "vitest";

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
    it("a switch is saved and read back after the in-memory state is gone", () => {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        updateSessionLanguage("bhai kya scene hai aaj, kuch plan hai kya");
        expect(prefs.language).toBe("Hindi (Romanized)");
        resetLanguage(); // what a restart leaves: module state back to English
        expect(getLanguageInstruction()).toMatch(/Hinglish/);
        expect(getCurrentLanguage()).toBe("Hindi (Romanized)");
    });
});
