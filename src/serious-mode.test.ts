// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { beforeEach, describe, expect, it } from "vitest";
import { clearQuiet, isQuietNow } from "./proactive/kill-switches.js";
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
    ["someone did fraud on my card and took 2 lakh", true],
    ["I got defrauded", true],
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
    ["research robotic surgery companies", false],
    ["the tumor classifier is done", false],
    ["check the chemo drug prices", false],
    ["is the funeral home stock up", false],
    ["the surgery scene in Grey's anatomy", false],
    ["in the hospital wing of the game", false],
    ["add fraud detection to the checkout", false],
    ["we're seeing a spike in fraud on our payments page, pull the logs", false],
    ["chargeback fraud with my Stripe account, check it", false],
    ["there was fraud on my credit card", true],
    ["my dad is in the hospital, send me the ward number", true],
    ["grandma's funeral is on sunday", true],
    ["mom starts chemo next week", true],
    ["dad's surgery went fine", true],
    ["he has a tumor", true],
];

describe("serious mode", () => {
    beforeEach(() => {
        _resetSeriousMode();
        clearQuiet();
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

    it("thanks isn't laughing again", () => {
        noteOwnerMood("my dad passed away last night", 0);
        noteOwnerMood("thanks bhai, means a lot", 1);
        noteOwnerMood("thanks", 2);
        expect(isSerious(3)).toBe(true);
    });
});
