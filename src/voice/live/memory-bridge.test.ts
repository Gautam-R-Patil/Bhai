// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { detectMemoryVerb } from "./memory-bridge.js";

describe("detectMemoryVerb — voice shortcut to sqlite memory", () => {
    it("matches 'remember that X' and captures X", () => {
        const got = detectMemoryVerb("remember that I prefer dark mode");
        expect(got?.content).toBe("I prefer dark mode");
        expect(got?.verb).toBe("remember");
    });

    it("matches 'Remember, my birthday is March fifth'", () => {
        const got = detectMemoryVerb("Remember, my birthday is March fifth");
        expect(got?.content).toBe("my birthday is March fifth");
    });

    it("matches 'don't forget to buy milk'", () => {
        const got = detectMemoryVerb("don't forget to buy milk");
        expect(got?.content).toBe("to buy milk");
        // "don't forget" matches as the verb
        expect(got?.verb).toMatch(/forget/i);
    });

    it("matches 'note that the meeting moved to Friday'", () => {
        const got = detectMemoryVerb("note that the meeting moved to Friday");
        expect(got?.content).toBe("the meeting moved to Friday");
    });

    it("matches 'for future reference, use the dev API key'", () => {
        const got = detectMemoryVerb("for future reference, use the dev API key");
        expect(got?.content).toBe("use the dev API key");
    });

    it("matches 'keep in mind my deadline is tomorrow'", () => {
        const got = detectMemoryVerb("keep in mind my deadline is tomorrow");
        expect(got?.content).toBe("my deadline is tomorrow");
    });

    it("matches 'save this: the stage IP is 10 dot 0 dot 1 dot 5'", () => {
        const got = detectMemoryVerb("save this: the stage IP is 10 dot 0 dot 1 dot 5");
        expect(got?.content).toBe("the stage IP is 10 dot 0 dot 1 dot 5");
    });

    it("strips leading filler: 'hey bhai remember I like dark mode'", () => {
        const got = detectMemoryVerb("hey bhai remember I like dark mode");
        expect(got?.content).toBe("I like dark mode");
    });

    it("does NOT match casual 'I'll remember that'", () => {
        // Not imperative. Capital-I "I'll" doesn't match the pattern.
        expect(detectMemoryVerb("I'll remember that for next time")).toBeNull();
    });

    it("does NOT match 'I noted your name'", () => {
        expect(detectMemoryVerb("I noted your name earlier")).toBeNull();
    });

    it("does NOT match pure tail 'remember' with no content", () => {
        // "remember this" with nothing after → content would be empty → null
        expect(detectMemoryVerb("remember.")).toBeNull();
    });

    it("does NOT match 'can you remember this for me?' (question not imperative verb at start)", () => {
        // This one starts with "can" — our pattern requires the verb at start
        // (after optional filler). Conservative: question forms handled by LLM.
        expect(detectMemoryVerb("can you remember this for me?")).toBeNull();
    });

    it("returns null for empty string", () => {
        expect(detectMemoryVerb("")).toBeNull();
    });

    it("trims trailing punctuation from content", () => {
        const got = detectMemoryVerb("remember that I hate cilantro.");
        expect(got?.content).toBe("I hate cilantro");
    });

    it("rejects content shorter than 4 chars (noise)", () => {
        expect(detectMemoryVerb("remember x")).toBeNull();
    });
});
