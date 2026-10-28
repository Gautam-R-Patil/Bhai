// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Emotion Detector ─────────────────────────────
 * Detects user emotional state from linguistic cues.
 * Uses heuristic analysis (zero API cost) with optional local model upgrade.
 * Feeds into tone calibrator and proactive behavior gating.
 */

// ── Types ─────────────────────────────────────

export interface EmotionAnalysis {
    primary: string;             // "happy" | "frustrated" | "neutral" | "excited" | "stressed" | "confused" | "grateful" | "angry"
    confidence: number;          // 0-1
    valence: number;             // -1 (negative) to 1 (positive)
    arousal: number;             // 0 (calm) to 1 (excited/agitated)
    signals: string[];           // What triggered this detection
}

// ── Emotion Lexicons ──────────────────────────

const EMOTION_SIGNALS: Record<string, { words: string[]; valence: number; arousal: number }> = {
    frustrated: {
        words: ["ugh", "annoying", "doesn't work", "broken", "stuck", "wtf", "why won't", "hate", "terrible", "nightmare", "impossible", "give up", "frustrating", "frustrated", "not working", "keeps failing"],
        valence: -0.7, arousal: 0.6,
    },
    angry: {
        words: ["angry", "furious", "ridiculous", "unacceptable", "bullshit", "stupid", "waste of time", "horrible"],
        valence: -0.9, arousal: 0.9,
    },
    stressed: {
        words: ["deadline", "urgent", "asap", "running out of time", "pressure", "overwhelmed", "too much", "behind"],
        valence: -0.5, arousal: 0.7,
    },
    confused: {
        words: ["confused", "don't understand", "what do you mean", "makes no sense", "lost", "unclear", "huh", "wait what"],
        valence: -0.3, arousal: 0.3,
    },
    excited: {
        words: ["awesome", "amazing", "perfect", "incredible", "love it", "brilliant", "fantastic", "woah", "wow", "let's go"],
        valence: 0.8, arousal: 0.8,
    },
    happy: {
        words: ["thanks", "great", "nice", "good", "cool", "sweet", "appreciate", "helpful", "exactly"],
        valence: 0.6, arousal: 0.3,
    },
    grateful: {
        words: ["thank you so much", "really appreciate", "you're the best", "lifesaver", "couldn't have done", "saved me"],
        valence: 0.9, arousal: 0.4,
    },
};

// Whole words only: substring matching read "bullet points" as angry ("bull")
// and "whatever" as frustrated ("hate"), which injected sympathy into replies.
const WORD_RE = new Map(
    Object.values(EMOTION_SIGNALS)
        .flatMap((d) => d.words)
        .map((w) => [w, new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`)] as const),
);

// ── Detection ─────────────────────────────────

/**
 * Detect emotion from user message text.
 * Zero API cost — uses linguistic cue analysis.
 */
export function detectEmotion(text: string): EmotionAnalysis {
    const lower = text.toLowerCase();
    const signals: string[] = [];

    let bestEmotion = "neutral";
    let bestScore = 0;
    let totalValence = 0;
    let totalArousal = 0;
    let emotionCount = 0;

    for (const [emotion, data] of Object.entries(EMOTION_SIGNALS)) {
        let matchCount = 0;
        for (const word of data.words) {
            if (WORD_RE.get(word)?.test(lower)) {
                matchCount++;
                signals.push(`"${word}" → ${emotion}`);
            }
        }

        if (matchCount > 0) {
            const score = matchCount / data.words.length;
            totalValence += data.valence * matchCount;
            totalArousal += data.arousal * matchCount;
            emotionCount += matchCount;

            if (score > bestScore) {
                bestScore = score;
                bestEmotion = emotion;
            }
        }
    }

    // Punctuation signals
    const exclamations = (text.match(/!/g) || []).length;
    const questionMarks = (text.match(/\?/g) || []).length;
    const capsRatio = (text.match(/[A-Z]/g) || []).length / Math.max(text.length, 1);

    if (exclamations > 2) { totalArousal += 0.3; signals.push("Multiple exclamation marks"); }
    if (capsRatio > 0.5 && text.length > 5) { totalArousal += 0.4; totalValence -= 0.2; signals.push("Excessive caps"); }
    if (questionMarks > 2) { signals.push("Multiple questions → possible confusion"); }

    // Normalize
    const valence = emotionCount > 0 ? (totalValence / emotionCount) : 0;
    const arousal = emotionCount > 0 ? (totalArousal / emotionCount) : 0;
    const confidence = Math.min(1, bestScore * 2 + (signals.length > 0 ? 0.2 : 0));

    return {
        primary: bestEmotion,
        confidence,
        valence: Math.max(-1, Math.min(1, valence)),
        arousal: Math.max(0, Math.min(1, arousal)),
        signals,
    };
}

/**
 * Generate a tone calibration directive based on detected emotion.
 */
export function getToneDirective(emotion: EmotionAnalysis): string {
    switch (emotion.primary) {
        case "frustrated":
            return "User is frustrated — be patient, acknowledge the difficulty, offer a clear path forward.";
        case "angry":
            return "User is upset — stay calm, validate their concern, apologize if appropriate, focus on resolution.";
        case "stressed":
            return "User is under pressure — be efficient, prioritize the most urgent items, offer to take things off their plate.";
        case "confused":
            return "User is confused — explain step by step, use simpler language, check understanding.";
        case "excited":
            return "User is excited — match their energy, encourage their enthusiasm, build on their ideas.";
        case "grateful":
            return "User is grateful — acknowledge warmly, continue being helpful.";
        case "happy":
            return "User is in a good mood — keep the positive tone, be friendly.";
        default:
            return "";
    }
}
