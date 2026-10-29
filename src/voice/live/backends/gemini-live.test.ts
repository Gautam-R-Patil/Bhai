// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { filterNoiseTranscript } from "./gemini-live.js";

describe("filterNoiseTranscript — drop obvious noise transcriptions", () => {
    it("drops empty / whitespace-only", () => {
        expect(filterNoiseTranscript("")).toBeNull();
        expect(filterNoiseTranscript("   ")).toBeNull();
    });

    it("drops single-character noise", () => {
        // Content length < 2 → noise.
        expect(filterNoiseTranscript("a")).toBeNull();
    });

    it("keeps 2-char Latin affirmations ('Hi', 'No', 'Ok')", () => {
        // Content length ≥ 2 and not in the filler set → pass.
        expect(filterNoiseTranscript("Hi")).toBe("Hi");
        expect(filterNoiseTranscript("No")).toBe("No");
        expect(filterNoiseTranscript("Ok")).toBe("Ok");
    });

    it("keeps 'Yes' and 'No' with punctuation", () => {
        expect(filterNoiseTranscript("Yes!")).toBe("Yes!");
        expect(filterNoiseTranscript("No.")).toBe("No.");
    });

    it("keeps '너도' (Korean 'you too') and 'はい' (Japanese 'yes')", () => {
        // Round 3 regression fix — these are common legitimate replies.
        expect(filterNoiseTranscript("너도")).toBe("너도");
        expect(filterNoiseTranscript("너도.")).toBe("너도.");
        expect(filterNoiseTranscript("はい")).toBe("はい");
        expect(filterNoiseTranscript("はい。")).toBe("はい。");
    });

    it("drops pure punctuation like '.'", () => {
        expect(filterNoiseTranscript(".")).toBeNull();
        expect(filterNoiseTranscript("...")).toBeNull();
        expect(filterNoiseTranscript("???!!!")).toBeNull();
    });

    it("drops a single CJK character with a period", () => {
        expect(filterNoiseTranscript("늘.")).toBeNull();
    });

    it("drops the short-CJK noise exemplar '늘어났구나.'", () => {
        // Matched via the KNOWN_NOISE_EXACT set.
        expect(filterNoiseTranscript("늘어났구나.")).toBeNull();
    });

    it("drops short Latin filler-starts like 'Sagen, ey.'", () => {
        expect(filterNoiseTranscript("Sagen, ey.")).toBeNull();
    });

    it("drops 'ey.' / 'uh.' short filler bursts", () => {
        expect(filterNoiseTranscript("ey.")).toBeNull();
        expect(filterNoiseTranscript("uh hm")).toBeNull();
    });

    it("keeps a plausible English utterance", () => {
        expect(filterNoiseTranscript("Hey, what's up?")).toBe("Hey, what's up?");
    });

    it("keeps a plausible Hindi utterance", () => {
        expect(filterNoiseTranscript("क्या हाल है")).toBe("क्या हाल है");
    });

    it("keeps a plausible full-sentence Korean utterance above the threshold", () => {
        expect(filterNoiseTranscript("안녕하세요 저는 잘 지내요")).toBe("안녕하세요 저는 잘 지내요");
    });

    it("keeps 'Hey' even though it's short — Latin without filler pattern", () => {
        // 'Hey' is only 3 chars of content. The filler-pattern regex requires
        // "sagen|ey|eh|uh|ah|mm|hm|um" as an isolated word — 'Hey' starts with 'h'
        // but "hey" is not in the filler list, so it should pass.
        expect(filterNoiseTranscript("Hey there")).toBe("Hey there");
    });

    // Short single-word CJK/Devanagari greetings must pass — they are legitimate
    // user utterances. This is the C1-new regression caught in Round 2.
    it("keeps a single-word Korean greeting '안녕하세요'", () => {
        expect(filterNoiseTranscript("안녕하세요")).toBe("안녕하세요");
    });
    it("keeps a short Korean 'hi' '안녕'", () => {
        expect(filterNoiseTranscript("안녕")).toBe("안녕");
    });
    it("keeps a Japanese 'thank you' 'ありがとう'", () => {
        expect(filterNoiseTranscript("ありがとう")).toBe("ありがとう");
    });
    it("keeps Chinese 'ni hao' '你好'", () => {
        expect(filterNoiseTranscript("你好")).toBe("你好");
    });
    it("keeps Hindi 'haan' 'हाँ' (with combining-mark nasalization)", () => {
        expect(filterNoiseTranscript("हाँ")).toBe("हाँ");
    });
    it("keeps 'namaste' 'नमस्ते'", () => {
        expect(filterNoiseTranscript("नमस्ते")).toBe("नमस्ते");
    });
});
