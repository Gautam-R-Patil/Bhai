// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { beforeEach, describe, expect, it } from "vitest";
import { _resetQuietForTests, isQuietNow } from "./proactive/kill-switches.js";
import { _resetSeriousMode, isSerious, noteOwnerMood } from "./serious-mode.js";

// Labelled owner messages: [text, isSerious].
const CORPUS: [string, boolean][] = [
    ["my dad passed away last night", true],
    ["My nani passed this morning", true],
    ["papa nahi rahe", true],
    ["the funeral is tomorrow", true],
    ["I got diagnosed with diabetes today", true],
    ["mom's in the hospital", true],
    ["he had a panic attack at work", true],
    ["I got scammed out of 2 lakh", true],
    ["I lost my job", true],
    ["I got laid off today", true],
    ["lost all my savings in that crypto thing", true],
    ["sometimes I want to die", true],
    ["thinking about self-harm again", true],
    // not about the person
    ["my build died again lol", false],
    ["my phone died, charging it", false],
    ["my brother passed the exam!", false],
    ["building a hospital management app", false],
    ["fix the stroke width on the logo", false],
    ["I'm fired up for the launch", false],
    ["kill the process on port 3000", false],
    ["battery nahi rahi", false],
];

describe("serious mode", () => {
    beforeEach(() => {
        _resetSeriousMode();
        _resetQuietForTests();
    });

    it.each(CORPUS)("%s → %s", (text, serious) => {
        noteOwnerMood(text, 0);
        expect(isSerious(1)).toBe(serious);
    });

    it("holds for a day and quiets proactive for that day", () => {
        noteOwnerMood("my dad passed away", 0);
        expect(isQuietNow(23 * 3_600_000)).toBe(true);
        expect(isSerious(23 * 3_600_000)).toBe(true);
        expect(isSerious(25 * 3_600_000)).toBe(false);
    });

    it("two light messages in a row clear it; one doesn't", () => {
        noteOwnerMood("my dad passed away", 0);
        noteOwnerMood("haha thanks bhai", 1);
        noteOwnerMood("ok", 2);
        noteOwnerMood("lol", 3);
        expect(isSerious(4)).toBe(true);
        noteOwnerMood("😂 true", 5);
        expect(isSerious(6)).toBe(false);
    });
});
