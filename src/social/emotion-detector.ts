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
        words: ["urgent", "asap", "running out of time", "pressure", "overwhelmed"],
        valence: -0.5, arousal: 0.7,
    },
    confused: {
        words: ["confused", "don't understand", "what do you mean", "makes no sense", "unclear", "huh", "wait what"],
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
// A negator just before a cue flips its meaning ("not amazing"), so we drop
// that cue rather than scoring the praise as positive.
const NEGATOR_RE = /\b(?:not|no|never|without|hardly|barely)\b|n['’]t\b/;

export function detectEmotion(text: string): EmotionAnalysis {
    const lower = text.toLowerCase();
    const signals: string[] = [];

    // Collect every cue hit with its span so overlapping phrases can be
    // de-duplicated and a preceding negator can be checked.
    type Hit = { emotion: string; word: string; valence: number; arousal: number; start: number; end: number };
    const hits: Hit[] = [];
    for (const [emotion, data] of Object.entries(EMOTION_SIGNALS)) {
        for (const word of data.words) {
            const m = WORD_RE.get(word)?.exec(lower);
            if (m) hits.push({ emotion, word, valence: data.valence, arousal: data.arousal, start: m.index, end: m.index + word.length });
        }
    }

    // Drop a hit whose span sits inside a longer hit's span ("appreciate" ⊂
    // "really appreciate") so overlapping cues count once, not twice.
    hits.sort((a, b) => (b.end - b.start) - (a.end - a.start));
    const kept: Hit[] = [];
    for (const h of hits) {
        if (kept.some((k) => k.start <= h.start && k.end >= h.end)) continue;
        kept.push(h);
    }

    // Score by raw cue count per emotion (NOT count/lexiconSize — that
    // penalised the largest lexicon, "frustrated", so one frustrated cue lost
    // to one cue from any smaller lexicon). Tie-break follows EMOTION_SIGNALS
    // order via the strict `>`.
    const counts = new Map<string, number>();
    let totalValence = 0;
    let totalArousal = 0;
    let emotionCount = 0;
    for (const h of kept) {
        // Look back only within the current clause: a negator in a previous clause
        // ("not a fan, this is terrible") must not flip this cue to neutral.
        let before = lower.slice(Math.max(0, h.start - 20), h.start);
        const bound = Math.max(before.lastIndexOf(","), before.lastIndexOf("."), before.lastIndexOf(";"),
            before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf("\n"));
        if (bound >= 0) before = before.slice(bound + 1);
        if (NEGATOR_RE.test(before)) continue; // negated cue — ignore
        signals.push(`"${h.word}" → ${h.emotion}`);
        totalValence += h.valence;
        totalArousal += h.arousal;
        emotionCount++;
        counts.set(h.emotion, (counts.get(h.emotion) || 0) + 1);
    }

    let bestEmotion = "neutral";
    let bestCount = 0;
    for (const emotion of Object.keys(EMOTION_SIGNALS)) {
        const c = counts.get(emotion) || 0;
        if (c > bestCount) { bestCount = c; bestEmotion = emotion; }
    }

    // Punctuation signals — kept separate so they survive even when no cue
    // matched (an all-caps shout with no lexicon word is still agitated).
    const exclamations = (text.match(/!/g) || []).length;
    const questionMarks = (text.match(/\?/g) || []).length;
    const capsRatio = (text.match(/[A-Z]/g) || []).length / Math.max(text.length, 1);

    let punctValence = 0;
    let punctArousal = 0;
    if (exclamations > 2) { punctArousal += 0.3; signals.push("Multiple exclamation marks"); }
    if (capsRatio > 0.5 && text.length > 5) { punctArousal += 0.4; punctValence -= 0.2; signals.push("Excessive caps"); }
    if (questionMarks > 2) { signals.push("Multiple questions → possible confusion"); }

    // Average the cue contributions, THEN add punctuation flat — so emphasis
    // isn't diluted by cue count and isn't discarded when emotionCount === 0.
    const valence = (emotionCount > 0 ? totalValence / emotionCount : 0) + punctValence;
    const arousal = (emotionCount > 0 ? totalArousal / emotionCount : 0) + punctArousal;
    const confidence = Math.min(1, bestCount * 0.3 + (signals.length > 0 ? 0.2 : 0));

    return {
        primary: bestEmotion,
        confidence,
        valence: Math.max(-1, Math.min(1, valence)),
        arousal: Math.max(0, Math.min(1, arousal)),
        signals,
    };
}
