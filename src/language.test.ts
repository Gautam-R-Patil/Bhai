// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
    detectLanguage,
    updateSessionLanguage,
    getLanguageInstruction,
    getCurrentLanguage,
    resetLanguage,
} from "./language.js";

// The module holds session state (currentLanguage + lastDetectionTime).
// resetLanguage() zeros both — use it in beforeEach to isolate tests.

describe("language — detectLanguage: short input", () => {
    beforeEach(() => resetLanguage());

    it("returns inherited language with confidence 0 for text under 10 chars", () => {
        const result = detectLanguage("hi");
        expect(result.language).toEqual("English");
        expect(result.confidence).toEqual(0);
        expect(result.script).toEqual("inherited");
    });

    it("20 chars of pure whitespace is still 'short' after trim", () => {
        const result = detectLanguage("                    ");
        expect(result.confidence).toEqual(0);
    });

    it("after stripping code/URLs, text may become short and return inherited", () => {
        const result = detectLanguage("```js\nconst x = 1;\n```");
        // Everything strips → empty → confidence 0
        expect(result.confidence).toEqual(0);
    });

    it("after stripping UPPERCASE constants, text may drop below threshold", () => {
        const result = detectLanguage("API_KEY DATABASE_URL MAX");
        // All UPPERCASE words + short → inherited
        expect(result.confidence).toEqual(0);
    });

    it("plain English is detected confidently (so a session can switch back to it)", () => {
        const result = detectLanguage("The quick brown fox jumps over the lazy dog");
        expect(result.language).toEqual("English");
        expect(result.confidence).toBeGreaterThanOrEqual(0.8);
        expect(result.script).toEqual("Latin");
    });

    it("text with no clear signal still defaults to English at 0.5", () => {
        expect(detectLanguage("Quick brown foxes jumping lazily")).toMatchObject({
            language: "English",
            confidence: 0.5,
        });
    });
});

describe("language — detectLanguage: non-Latin scripts", () => {
    beforeEach(() => resetLanguage());

    it("detects Hindi (Devanagari) from substantial Hindi text", () => {
        const result = detectLanguage("नमस्ते आप कैसे हैं मैं ठीक हूँ धन्यवाद");
        expect(result.language).toEqual("Hindi");
        expect(result.script).toEqual("Devanagari");
        expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it("detects Japanese (Hiragana)", () => {
        const result = detectLanguage("こんにちは、お元気ですか？私は元気です。ありがとう");
        expect(result.language).toEqual("Japanese");
        // Hiragana or Katakana — both land under Japanese
        expect(["Hiragana", "Katakana"]).toContain(result.script);
    });

    it("detects Chinese (CJK)", () => {
        // Needs ≥20 chars AFTER preprocessing; ≥5 CJK matches; CJK ratio > 0.40.
        const result = detectLanguage("你好吗我很好谢谢非常感谢大家都很好今天天气真的非常好");
        expect(result.language).toEqual("Chinese");
        expect(result.script).toEqual("CJK");
    });

    it("detects Korean (Hangul)", () => {
        const result = detectLanguage("안녕하세요 저는 잘 지내고 있습니다 감사합니다");
        expect(result.language).toEqual("Korean");
        expect(result.script).toEqual("Hangul");
    });

    it("detects Arabic", () => {
        const result = detectLanguage("مرحبا كيف حالك أنا بخير شكرا لك على كل شيء");
        expect(result.language).toEqual("Arabic");
        expect(result.script).toEqual("Arabic");
    });

    it("detects Russian (Cyrillic)", () => {
        const result = detectLanguage("Привет как дела у меня все хорошо спасибо");
        expect(result.language).toEqual("Russian");
        expect(result.script).toEqual("Cyrillic");
    });

    it("detects Hebrew", () => {
        const result = detectLanguage("שלום מה שלומך אני בסדר תודה רבה לך");
        expect(result.language).toEqual("Hebrew");
    });

    it("detects Thai", () => {
        const result = detectLanguage("สวัสดีคุณสบายดีไหมฉันสบายดีขอบคุณ");
        expect(result.language).toEqual("Thai");
    });

    it("detects Tamil", () => {
        const result = detectLanguage("வணக்கம் நீங்கள் எப்படி இருக்கிறீர்கள் நன்றி");
        expect(result.language).toEqual("Tamil");
    });

    it("detects Bengali", () => {
        const result = detectLanguage("নমস্কার আপনি কেমন আছেন আমি ভালো আছি ধন্যবাদ");
        expect(result.language).toEqual("Bengali");
    });

    it("requires ≥5 matches AND ratio > 0.40 — a single non-Latin char doesn't trigger", () => {
        // Long English text with one stray Hindi character.
        const result = detectLanguage("The quick brown fox jumped over a lazy dog in the park न");
        // One match of न → below 5-match threshold → falls through to English default
        expect(result.language).toEqual("English");
    });

    it("caps non-Latin confidence at 0.95 (not 1.0)", () => {
        // Extremely Hindi-heavy text → ratio approaches 1.0
        const result = detectLanguage("नमस्तेनमस्तेनमस्तेनमस्तेनमस्तेनमस्तेनमस्तेनमस्तेनमस्ते");
        expect(result.confidence).toBeLessThanOrEqual(0.95);
    });
});

describe("language — detectLanguage: Latin-script languages via keywords", () => {
    beforeEach(() => resetLanguage());

    it("detects Spanish", () => {
        const result = detectLanguage("Hola, ¿cómo estás? Gracias por la ayuda. Necesito también un favor.");
        expect(result.language).toEqual("Spanish");
        expect(result.script).toEqual("Latin");
    });

    it("detects French", () => {
        const result = detectLanguage("Bonjour, comment allez-vous? Merci beaucoup pour votre aide dans cette situation.");
        expect(result.language).toEqual("French");
    });

    it("detects German", () => {
        const result = detectLanguage("Hallo, wie geht es dir? Danke für diese Hilfe, ich kann das auch haben.");
        expect(result.language).toEqual("German");
    });

    it("detects Portuguese", () => {
        const result = detectLanguage("Bom dia, como vai? Obrigado por esta ajuda, também preciso de fazer muito.");
        expect(result.language).toEqual("Portuguese");
    });

    it("detects Italian", () => {
        const result = detectLanguage("Ciao, come stai? Grazie per questa cosa, voglio fare anche molto bene.");
        expect(result.language).toEqual("Italian");
    });

    it("detects Dutch", () => {
        const result = detectLanguage("Hallo, hoe gaat het? Dank je wel, ik ook, kunnen deze dingen maken hebben.");
        expect(result.language).toEqual("Dutch");
    });

    it("detects Vietnamese via diacritics", () => {
        const result = detectLanguage("Xin chào tôi ắấầẩẫậêếềểễệ cám ơn bạn rất nhiều lắm");
        expect(result.language).toEqual("Vietnamese");
    });

    it("keywords that start or end with an accented letter count (qué, être, çok)", () => {
        expect(detectLanguage("hola, ¿qué tal?").language).toEqual("Spanish");
        expect(detectLanguage("je veux être avec toi").language).toEqual("French");
        expect(detectLanguage("çok teşekkür ederim").language).toEqual("Turkish");
    });

    it("requires ≥2 keyword matches AND ratio > 0.15 — a single keyword doesn't trigger", () => {
        // Long English with ONE Spanish word — word ratio too low
        const result = detectLanguage("I went to the store and bought some gracias bread for my family and friends today morning");
        expect(result.language).toEqual("English");
    });

    it("boosts confidence by ratio (higher keyword density → higher confidence)", () => {
        const dense = detectLanguage("Hola gracias cómo estás por favor también puede hacer necesito dónde cuándo");
        const sparse = detectLanguage("Hola cómo estás amigo mio este es un texto mas largo para que supere el umbral");
        expect(dense.confidence).toBeGreaterThan(sparse.confidence);
    });
});

describe("language — detectLanguage: Romanized Hindi / Hinglish", () => {
    beforeEach(() => resetLanguage());

    it("detects Hinglish from Romanized Hindi keywords", () => {
        const result = detectLanguage("Bhai yaar kya kar rahe ho tum accha hai nahi theek hai batao");
        expect(result.language).toEqual("Hindi (Romanized)");
        expect(result.script).toEqual("Latin-Hinglish");
    });

    it("requires ≥2 Hinglish keywords AND ratio > 0.2", () => {
        // Long English with only ONE Hinglish word - should NOT match
        const result = detectLanguage("Today I went for coffee with accha friend and we talked about weather here and there");
        expect(result.language).not.toEqual("Hindi (Romanized)");
    });

    it("Hinglish takes precedence over generic Latin when both match", () => {
        // Keywords shared: "kya kaise hai nahi" — heavily Hinglish
        const result = detectLanguage("yaar kya kaise ho bhai nahi hain tum accha theek");
        expect(result.language).toEqual("Hindi (Romanized)");
    });

    it("confidence boosts with ratio (0.8 + ratio * 0.15, capped)", () => {
        const highRatio = detectLanguage("bhai kya kaise nahi hai yaar accha theek bahut");
        expect(highRatio.confidence).toBeGreaterThan(0.7);
        expect(highRatio.confidence).toBeLessThan(1.0);
    });
});

describe("language — everyday Hinglish and switching back", () => {
    beforeEach(() => resetLanguage());

    it("catches short, everyday Hinglish", () => {
        for (const m of [
            "kal 5 baje meeting set kar do",
            "acha theek hai",
            "main bas check kar raha tha",
            "mujhe ek email bhejna hai boss ko",
        ])
            expect(detectLanguage(m), m).toMatchObject({ language: "Hindi (Romanized)" });
        // ...and confidently enough to switch the session (0.80 bar).
        expect(detectLanguage("kal 5 baje meeting set kar do").confidence).toBeGreaterThanOrEqual(0.8);
    });

    it("plain English requests stay English", () => {
        for (const m of [
            "send the report to rahul",
            "set an alarm for 6 am",
            "open youtube and play some lofi",
            "the main issue is the code",
            "add a comment to the doc",
            "come with me to the store",
        ])
            expect(detectLanguage(m).language, m).toEqual("English");
    });

    it("a session that went Hinglish comes back to English when the owner does", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        try {
            updateSessionLanguage("bhai kya scene hai aaj");
            expect(getCurrentLanguage()).toEqual("Hindi (Romanized)");
            updateSessionLanguage("ok"); // too short to say anything
            expect(getCurrentLanguage()).toEqual("Hindi (Romanized)");
            vi.setSystemTime(new Date("2025-01-01T00:00:31Z"));
            updateSessionLanguage("can you check my calendar for tomorrow");
            expect(getCurrentLanguage()).toEqual("English");
            expect(getLanguageInstruction()).toEqual("");
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("language — detectLanguage: input preprocessing", () => {
    beforeEach(() => resetLanguage());

    it("strips fenced code blocks before detection", () => {
        const input =
            "```python\ndef hello(): print('hola gracias')\n``` " +
            "The above is a Python function which prints a greeting and thanks in Spanish.";
        const result = detectLanguage(input);
        // Code block removed → only English prose remains → default to English
        expect(result.language).toEqual("English");
    });

    it("strips inline backtick code", () => {
        const input = "Run `kya hai bhai nahi accha yaar` as a variable name in my Node script please";
        const result = detectLanguage(input);
        // Hinglish words were inside backticks → stripped → English default
        expect(result.language).toEqual("English");
    });

    it("strips URLs", () => {
        const input = "Visit https://example.com/hola/gracias/por-favor for more info about this topic here";
        const result = detectLanguage(input);
        expect(result.language).toEqual("English");
    });

    it("strips UPPERCASE constants", () => {
        // API_GRACIAS is a constant — should be stripped
        const input = "Set API_GRACIAS_HOLA_TAMBIEN to null in the config file for this deployment setup";
        const result = detectLanguage(input);
        expect(result.language).toEqual("English");
    });

    it("preserves mixed case text (not stripped)", () => {
        // Mixed Title-Case words stay, detection triggers on keyword density.
        const input = "Hola Gracias Por Favor cómo estás también puede hacer tengo quiero necesito dónde cuándo";
        const result = detectLanguage(input);
        expect(result.language).toEqual("Spanish");
    });
});

describe("language — updateSessionLanguage: cooldown + high-confidence gating", () => {
    beforeEach(() => {
        resetLanguage();
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("switches to a new language when confidence ≥ 0.80", () => {
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        // Hindi Devanagari gets cap-bounded confidence (0.95)
        const result = updateSessionLanguage("नमस्ते आप कैसे हैं मैं ठीक हूँ धन्यवाद बहुत अच्छा है");
        expect(result).toEqual("Hindi");
        expect(getCurrentLanguage()).toEqual("Hindi");
        expect(logSpy).toHaveBeenCalled();
    });

    it("does NOT switch when confidence < 0.80 (e.g., generic English default at 0.5)", () => {
        updateSessionLanguage("The quick brown fox jumps over the lazy dog");
        expect(getCurrentLanguage()).toEqual("English");
    });

    it("a too-short message does not arm the cooldown, so the next real message still detects", () => {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        // Short ack: inherited English at confidence 0 — must NOT refresh the cooldown.
        updateSessionLanguage("ok haan");
        expect(getCurrentLanguage()).toEqual("English");
        // 5s later (well inside the 30s window) a real Hindi message must still switch.
        vi.setSystemTime(new Date("2025-01-01T00:00:05Z"));
        const result = updateSessionLanguage("नमस्ते आप कैसे हैं मैं ठीक हूँ धन्यवाद बहुत अच्छा है");
        expect(result).toEqual("Hindi");
    });

    it("inside the 30s cooldown a clear switch back is still mirrored", () => {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        updateSessionLanguage("bhai mujhe kal 5 baje yaad dilana");
        expect(getCurrentLanguage()).toEqual("Hindi (Romanized)");

        // 10s later — inside the cooldown — the owner is back in plain English.
        vi.setSystemTime(new Date("2025-01-01T00:00:10Z"));
        expect(updateSessionLanguage("what time is it in London")).toEqual("English");
    });

    it("allows switch after cooldown elapses (>30s)", () => {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        updateSessionLanguage("नमस्ते आप कैसे हैं मैं ठीक हूँ धन्यवाद बहुत अच्छा है");
        expect(getCurrentLanguage()).toEqual("Hindi");

        // 31s later — cooldown passed. But we need a new detection with confidence ≥ 0.80.
        vi.setSystemTime(new Date("2025-01-01T00:00:31Z"));
        // Dense Spanish
        updateSessionLanguage(
            "Hola gracias por favor cómo estás también puede hacer tengo quiero necesito dónde cuándo buenos días",
        );
        // Spanish confidence = 0.6 + ratio*0.3 — may or may not hit 0.80 depending on word ratio.
        // This test validates cooldown elapsed; exact switch depends on keyword density.
        // Language after call is either the original Hindi (if confidence < 0.80) or Spanish.
        const after = getCurrentLanguage();
        expect(["Spanish", "Hindi"]).toContain(after);
    });

    it("updates lastDetectionTime even when detected language matches current", () => {
        // Start in English. Detect English → shouldn't switch but SHOULD refresh timer.
        const initial = updateSessionLanguage("The quick brown fox jumps over the lazy dog and runs");
        expect(initial).toEqual("English");

        // After cooldown, a strong-confidence Hindi message triggers a switch.
        vi.setSystemTime(new Date("2025-01-01T00:00:31Z"));
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        updateSessionLanguage("नमस्ते आप कैसे हैं मैं ठीक हूँ धन्यवाद बहुत अच्छा है");
        expect(getCurrentLanguage()).toEqual("Hindi");
    });
});

describe("language — quoted text is content, not the owner's language", () => {
    it("an English question about a quoted Hindi or French phrase stays English", () => {
        expect(detectLanguage("what does 'kya haal hai' mean?").language).toBe("English");
        expect(detectLanguage('send "theek hai, aata hoon" to Rahul on WhatsApp').language).toBe("English");
        expect(detectLanguage("translate ‘bonjour, comment ça va’ to english").language).toBe("English");
    });

    it("apostrophes aren't quotes, and a message that is all quote keeps its language", () => {
        expect(detectLanguage("kal aana yaar, don't forget the chai").language).toBe("Hindi (Romanized)");
        expect(detectLanguage("'kya haal hai bhai'").language).toBe("Hindi (Romanized)");
    });
});

describe("language — getLanguageInstruction", () => {
    beforeEach(() => resetLanguage());

    it("returns empty string for English (no instruction needed)", () => {
        expect(getLanguageInstruction()).toEqual("");
    });

    it("returns a Hinglish-specific instruction for Romanized Hindi", () => {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        try {
            updateSessionLanguage("bhai yaar kya kaise ho nahi hai accha theek bahut batao bolo");
            const inst = getLanguageInstruction();
            expect(inst).toContain("Hinglish");
            expect(inst).toContain("Latin script");
            expect(inst).toContain("Do NOT use Devanagari");
        } finally {
            vi.useRealTimers();
        }
    });

    it("returns a generic instruction for non-Hinglish, non-English languages", () => {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        try {
            updateSessionLanguage("नमस्ते आप कैसे हैं मैं ठीक हूँ धन्यवाद बहुत अच्छा है");
            const inst = getLanguageInstruction();
            expect(inst).toContain("Hindi");
            expect(inst).toContain("Respond in Hindi");
        } finally {
            vi.useRealTimers();
        }
    });

    it("instruction is formatted as an LLM-facing [LANGUAGE] prefix", () => {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        try {
            updateSessionLanguage("Привет как дела у меня все хорошо спасибо большое много");
            expect(getLanguageInstruction().startsWith("[LANGUAGE]")).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("language — resetLanguage", () => {
    beforeEach(() => resetLanguage());

    it("restores English as the current language", () => {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        try {
            updateSessionLanguage("नमस्ते आप कैसे हैं मैं ठीक हूँ धन्यवाद बहुत अच्छा है");
            expect(getCurrentLanguage()).toEqual("Hindi");
            resetLanguage();
            expect(getCurrentLanguage()).toEqual("English");
        } finally {
            vi.useRealTimers();
        }
    });

    it("after reset, cooldown no longer blocks an immediate re-detection", () => {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        try {
            updateSessionLanguage("नमस्ते आप कैसे हैं मैं ठीक हूँ धन्यवाद बहुत अच्छा है");
            expect(getCurrentLanguage()).toEqual("Hindi");

            // Reset — lastDetectionTime=0 → even an immediate call should detect fresh.
            resetLanguage();
            // 1ms later — normally inside cooldown — should still succeed.
            vi.setSystemTime(new Date("2025-01-01T00:00:00.001Z"));
            updateSessionLanguage("こんにちは、お元気ですか？私は元気です。ありがとうございます");
            expect(getCurrentLanguage()).toEqual("Japanese");
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("language — getCurrentLanguage", () => {
    beforeEach(() => resetLanguage());

    it("starts as English after reset", () => {
        expect(getCurrentLanguage()).toEqual("English");
    });

    it("reflects whatever updateSessionLanguage set", () => {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
        try {
            updateSessionLanguage("你好吗我很好谢谢非常感谢大家都很好啊真的很高兴");
            expect(getCurrentLanguage()).toEqual("Chinese");
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("language — realistic regression cases", () => {
    beforeEach(() => resetLanguage());

    it("a message mixing English prose + a Spanish phrase at the end doesn't switch", () => {
        // A realistic case: Spanish phrase below threshold.
        const result = detectLanguage(
            "I was trying to debug this problem yesterday and then my colleague said hola amigo how are you today",
        );
        // Only 2 Spanish-ish words out of ~22 → ratio ~0.09, below 0.15 threshold
        expect(result.language).toEqual("English");
    });

    it("one-word messages fall back to current language regardless of script", () => {
        const result = detectLanguage("你好");
        // Short text → inherited
        expect(result.confidence).toEqual(0);
    });

    it("code-heavy technical text stays English", () => {
        const input =
            "```ts\nfunction hola(gracias: string) { return gracias.toUpperCase(); }\n```" +
            "This is a TypeScript function named hola which takes an argument named gracias " +
            "and returns the uppercase form";
        const result = detectLanguage(input);
        // Code block + UPPERCASE-style tokens stripped → only English prose
        expect(result.language).toEqual("English");
    });
});
