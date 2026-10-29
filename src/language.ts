// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Adaptive Language Matching ───────────────
// Detects the user's language from message text using Unicode script analysis
// and keyword heuristics. Injects language hints into LLM context so the
// agent naturally responds in the user's language.

// ── Script-Based Detection ───────────────────
// Uses Unicode character ranges to identify writing systems.

interface LanguageMatch {
    language: string;
    confidence: number;
    script: string;
}

// Script ranges mapped to languages
const SCRIPT_RANGES: [RegExp, string, string][] = [
    // [pattern, language name, script name]
    [/[\u0900-\u097F]/,   "Hindi",       "Devanagari"],
    [/[\u0980-\u09FF]/,   "Bengali",     "Bengali"],
    [/[\u0A00-\u0A7F]/,   "Punjabi",     "Gurmukhi"],
    [/[\u0A80-\u0AFF]/,   "Gujarati",    "Gujarati"],
    [/[\u0B00-\u0B7F]/,   "Odia",        "Odia"],
    [/[\u0B80-\u0BFF]/,   "Tamil",       "Tamil"],
    [/[\u0C00-\u0C7F]/,   "Telugu",      "Telugu"],
    [/[\u0C80-\u0CFF]/,   "Kannada",     "Kannada"],
    [/[\u0D00-\u0D7F]/,   "Malayalam",   "Malayalam"],
    [/[\u0E00-\u0E7F]/,   "Thai",        "Thai"],
    [/[\u3040-\u309F]/,   "Japanese",    "Hiragana"],
    [/[\u30A0-\u30FF]/,   "Japanese",    "Katakana"],
    [/[\u4E00-\u9FFF]/,   "Chinese",     "CJK"],
    [/[\uAC00-\uD7AF]/,   "Korean",      "Hangul"],
    [/[\u0600-\u06FF]/,   "Arabic",      "Arabic"],
    [/[\u0590-\u05FF]/,   "Hebrew",      "Hebrew"],
    [/[\u0400-\u04FF]/,   "Russian",     "Cyrillic"],
    [/[\u10A0-\u10FF]/,   "Georgian",    "Georgian"],
    [/[\u0530-\u058F]/,   "Armenian",    "Armenian"],
    [/[\u1000-\u109F]/,   "Burmese",     "Myanmar"],
];

// Latin-script language detection via common words
const RAW_LATIN_KEYWORDS: [RegExp, string][] = [
    // Spanish
    [/\b(hola|gracias|por favor|buenos días|buenas|cómo estás|qué|también|puede|hacer|tengo|quiero|necesito|dónde|cuándo)\b/i, "Spanish"],
    // French
    [/\b(bonjour|merci|s'il vous plaît|comment|pourquoi|oui|non|aussi|faire|avoir|être|avec|dans|cette|votre|très)\b/i, "French"],
    // German
    [/\b(danke|bitte|guten tag|hallo|wie geht|warum|nicht|auch|haben|können|diese|werden|machen|sehr)\b/i, "German"],
    // Portuguese
    [/\b(obrigado|obrigada|por favor|bom dia|como vai|também|fazer|ter|pode|preciso|onde|quando|muito)\b/i, "Portuguese"],
    // Italian
    [/\b(ciao|grazie|per favore|buongiorno|come stai|perché|anche|fare|avere|questa|molto|sono|voglio)\b/i, "Italian"],
    // Dutch
    [/\b(hallo|dank|alsjeblieft|goedemorgen|hoe gaat het|waarom|niet|ook|hebben|kunnen|deze|worden|maken)\b/i, "Dutch"],
    // Turkish
    [/\b(merhaba|teşekkür|lütfen|nasılsın|neden|değil|yapma|gelmek|olmak|çok|bir|için|burada)\b/i, "Turkish"],
    // Indonesian/Malay
    [/\b(terima kasih|tolong|selamat|apa kabar|mengapa|tidak|juga|bisa|harus|sudah|dengan|untuk|saya)\b/i, "Indonesian"],
    // Vietnamese (Latin with diacritics)
    [/[ắằẳẵặâấầẩẫậêếềểễệôốồổỗộơớờởỡợưứừửữự]/i, "Vietnamese"],
    // Polish
    [/\b(dzień dobry|dziękuję|proszę|jak się masz|dlaczego|również|robić|mieć|bardzo|jest|nie)\b/i, "Polish"],
    // Swedish
    [/\b(hej|tack|snälla|god morgon|hur mår du|varför|inte|också|göra|har|mycket|är)\b/i, "Swedish"],
];

// \b is ASCII-only: next to é, ç, ä… it never matches, so keywords starting or ending in one
// (qué, être, çok, är) could never count. Swap it for a Unicode letter boundary.
const LATIN_LANGUAGE_KEYWORDS: [RegExp, string][] = RAW_LATIN_KEYWORDS.map(([p, language]) => [
    new RegExp(p.source.replace(/^\\b/, "(?<!\\p{L})").replace(/\\b$/, "(?!\\p{L})"), "giu"),
    language,
]);

// Romanized Hindi/Hinglish detection. Words that are also common English or French
// ("do", "the", "main", "to", "le", "de", "sun", "band") are left out on purpose.
const HINGLISH_KEYWORDS =
    /\b(kya|kaise|hai|hain|nahi|nahin|nhi|mujhe|aap|tum|yeh|woh|karo|kar|karna|karke|karta|karti|kardo|bhai|yaar|accha|acha|achha|theek|thik|bahut|lekin|aur|kyun|kyunki|kab|kahan|kaisa|kaun|kitna|kitne|batao|bata|bolo|bol|dekho|dekh|chalo|chal|ruk|samajh|pata|chahiye|kuch|sab|abhi|raha|rahi|rahe|tha|thi|kal|aaj|baje|bas|haan|gaya|gayi|hua|hoga|mera|meri|mere|tera|teri|apna|apni|sahi|matlab|phir|jaldi|thoda|zyada|bilkul|sirf|wala|wali|wale|bhej|bhejo|bhejna|dena|lena|ho|hoon|hun|ji|arre|arey|yahan|wahan|subah|shaam|raat|ek)\b/i;

// Plain English: function words a Hinglish or other-language message rarely carries this many of.
const ENGLISH_MARKERS =
    /\b(the|is|are|was|and|to|for|my|me|you|your|can|could|please|what|how|it|this|that|with|of|on|at|i|do|does|will|would|should|have|has|an)\b/gi;

// ── Session State ────────────────────────────

let currentLanguage = "English";
let lastDetectionTime = 0;
const DETECTION_COOLDOWN_MS = 30000; // Don't re-detect within 30s

// ── Public API ───────────────────────────────

/**
 * Detect the language of a message using script analysis + keyword heuristics.
 * Returns the language name or "English" as default.
 */
export function detectLanguage(text: string): LanguageMatch {
    // Strip code blocks, URLs, and technical content that might confuse detection
    const cleanText = text
        .replace(/```[\s\S]*?```/g, "")
        .replace(/`[^`]+`/g, "")
        .replace(/https?:\/\/\S+/g, "")
        .replace(/\b[A-Z_]{2,}\b/g, "") // Constants like UPPERCASE_VAR
        .trim();

    if (cleanText.length < 10) {
        return { language: currentLanguage, confidence: 0, script: "inherited" };
    }

    // 1. Check non-Latin scripts first (highest confidence)
    for (const [pattern, language, script] of SCRIPT_RANGES) {
        const matches = cleanText.match(new RegExp(pattern.source, "g"));
        if (matches && matches.length >= 5) {
            const ratio = matches.length / cleanText.replace(/\s/g, "").length;
            if (ratio > 0.40) {
                return { language, confidence: Math.min(0.95, 0.5 + ratio), script };
            }
        }
    }

    // 2. Check Romanized Hindi/Hinglish
    const hinglishMatches = cleanText.match(new RegExp(HINGLISH_KEYWORDS.source, "gi"));
    if (hinglishMatches && hinglishMatches.length >= 2) {
        const words = cleanText.split(/\s+/).length;
        const ratio = hinglishMatches.length / words;
        if (ratio > 0.2) {
            // ≥2 Hindi words at >20% density is already a clear signal: clear the 0.80 switch bar.
            return {
                language: "Hindi (Romanized)",
                confidence: Math.min(0.95, 0.8 + ratio * 0.15),
                script: "Latin-Hinglish",
            };
        }
    }

    // 2b. Plain English, confidently: without this, English came back at 0.5 — under the 0.80
    // switch bar — so a session that went Hinglish (or Spanish…) never switched back.
    const words = cleanText.split(/\s+/).length;
    const hinglishHits = hinglishMatches?.length ?? 0;
    const englishHits = cleanText.match(ENGLISH_MARKERS)?.length ?? 0;
    // Two hits, like the checks below: "comment", "come", "non" are English words too.
    const latinHit = LATIN_LANGUAGE_KEYWORDS.some(([p]) => (cleanText.match(p)?.length ?? 0) >= 2);
    if (
        words >= 4 &&
        !latinHit &&
        ((hinglishHits === 0 && englishHits >= 1) || (hinglishHits <= 1 && englishHits >= 2))
    ) {
        return { language: "English", confidence: 0.85, script: "Latin" };
    }

    // 3. Check Latin-script languages via keywords
    for (const [pattern, language] of LATIN_LANGUAGE_KEYWORDS) {
        const matches = cleanText.match(pattern);
        if (matches && matches.length >= 2) {
            const words = cleanText.split(/\s+/).length;
            const ratio = matches.length / words;
            if (ratio > 0.15) {
                return { language, confidence: 0.6 + ratio * 0.3, script: "Latin" };
            }
        }
    }

    // 4. Default to English
    return { language: "English", confidence: 0.5, script: "Latin" };
}

/**
 * Update session language based on user message.
 * Returns the detected language. Uses cooldown to avoid thrashing.
 */
export function updateSessionLanguage(userMessage: string): string {
    const now = Date.now();

    // Don't re-detect too frequently
    if (now - lastDetectionTime < DETECTION_COOLDOWN_MS) {
        return currentLanguage;
    }

    const detection = detectLanguage(userMessage);

    // Only switch if confidence is high (avoid false positives from stray CJK chars)
    if (detection.confidence >= 0.80 && detection.language !== currentLanguage) {
        console.log(`[LANG] Language switch: ${currentLanguage} → ${detection.language} (confidence: ${detection.confidence.toFixed(2)}, script: ${detection.script})`);
        currentLanguage = detection.language;
        lastDetectionTime = now;
    } else if (detection.confidence > 0 && detection.language === currentLanguage) {
        // Only a REAL same-language detection refreshes the cooldown. A message
        // too short to detect returns the inherited language at confidence 0 —
        // if that armed the 30s window, a quick "ok" before a long foreign
        // message would block its detection and keep replies in the old language.
        lastDetectionTime = now;
    }

    return currentLanguage;
}

/**
 * Get a language instruction to inject into the LLM system prompt.
 * Returns empty string if English (no instruction needed).
 */
export function getLanguageInstruction(): string {
    if (currentLanguage === "English") return "";

    if (currentLanguage === "Hindi (Romanized)") {
        return `[LANGUAGE] The user is writing in Hinglish (Hindi written in Latin script). Respond naturally in Hinglish — use a mix of Hindi and English in Roman script, matching the user's style. Do NOT use Devanagari script unless the user does.`;
    }

    return `[LANGUAGE] The user is writing in ${currentLanguage}. Respond in ${currentLanguage}. Match the user's language and writing style naturally.`;
}

/**
 * Get the current session language.
 */
export function getCurrentLanguage(): string {
    return currentLanguage;
}

/**
 * Reset language to English (e.g., on new session).
 */
export function resetLanguage(): void {
    currentLanguage = "English";
    lastDetectionTime = 0;
}
