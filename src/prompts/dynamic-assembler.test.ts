// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { detectTaskType } from "./dynamic-assembler.js";

describe("detectTaskType", () => {
    it("doesn't read everyday words as coding/browsing (word boundaries)", () => {
        // Substring .includes("error")/("open") mislabelled plain chat and
        // injected coding/browsing tool rules into personal-advice replies.
        expect(detectTaskType("I made an error in judgment, how should I apologize?")).toBe("chat");
        expect(detectTaskType("I'm open to new ideas")).toBe("chat");
    });

    it("still detects genuine task intents", () => {
        expect(detectTaskType("please fix this bug")).toBe("coding");
        expect(detectTaskType("open the website and click login")).toBe("browsing");
        expect(detectTaskType("research the paper on transformers")).toBe("research");
    });
});
