// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { narrativeGuessesPronouns } from "../reflection.js";

describe("identity narrative pronouns", () => {
    it("a he/she guessed from a name is redone; stated pronouns or a name-only narrative stand", () => {
        const profile = '{"name":"Dheeraj"} prefers_professional_tone=true';
        expect(narrativeGuessesPronouns("Dheeraj is a founder in Bengaluru. He often works late.", profile)).toBe(true);
        expect(narrativeGuessesPronouns("Dheeraj is a founder in Bengaluru who often works late.", profile)).toBe(false);
        expect(narrativeGuessesPronouns("They often work late.", profile)).toBe(false);
        expect(narrativeGuessesPronouns("She often works late.", `${profile} pronouns=she/her`)).toBe(false);
        expect(narrativeGuessesPronouns("Theme: hero", profile)).toBe(false); // "he" inside a word
    });
});
