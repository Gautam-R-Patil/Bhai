// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Alive UX System ──────────────────────────────
// Centralized personality, phrasing, and dynamic responses that make
// Bhai feel alive, human, and genuinely present — NOT like a
// pre-programmed system uttering canned responses.
//
// Key principles:
// 1. VARIETY — never use the same phrase twice in a row
// 2. CONTEXT-AWARENESS — adapt tone to time of day, user mood, task type
// 3. CONVERSATIONAL — like texting a smart friend, not a command line
// 4. GENUINE — acknowledge mistakes, delays, and feelings naturally

// ── Phrase History (prevents repetition) ──────────
import { getTimezone } from "./location/index.js";

const recentPhrases = new Map<string, string[]>(); // category → last N phrases
const MAX_HISTORY = 3;

export function pickPhrase(category: string, options: string[]): string {
    const history = recentPhrases.get(category) || [];

    // Filter out recently used phrases.
    const available = options.filter((opt) => !history.includes(opt));
    // When every option is in the history window (categories with ≤ MAX_HISTORY
    // phrases — most of them), still exclude the LAST one used, or the random
    // pick could land on it and repeat the phrase back-to-back — the exact thing
    // this function exists to prevent. Fall back to all options only when a
    // category has a single phrase.
    const last = history[history.length - 1];
    const pool =
        available.length > 0 ? available : options.filter((opt) => opt !== last).length > 0 ? options.filter((opt) => opt !== last) : options;

    // Random selection
    const chosen = pool[Math.floor(Math.random() * pool.length)];

    // Update history
    history.push(chosen);
    if (history.length > MAX_HISTORY) history.shift();
    recentPhrases.set(category, history);

    return chosen;
}

/** @internal test-only — clear the phrase-repetition history. */
export function _resetPhraseHistory(): void {
    recentPhrases.clear();
}

// ── Time-of-Day Awareness ──────────────────────────

export function getTimeContext(): { period: "night" | "earlyMorning" | "morning" | "afternoon" | "evening" | "lateNight"; hour: number } {
    const now = new Date();
    const hour = parseInt(now.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: getTimezone() }));

    if (hour >= 0 && hour < 5) return { period: "lateNight", hour };
    if (hour >= 5 && hour < 7) return { period: "earlyMorning", hour };
    if (hour >= 7 && hour < 12) return { period: "morning", hour };
    if (hour >= 12 && hour < 17) return { period: "afternoon", hour };
    if (hour >= 17 && hour < 21) return { period: "evening", hour };
    return { period: "night", hour };
}

// ── Thinking Indicators (varied, natural) ──────────

const THINKING_PHRASES = {
    default: [
        "hmm",
        "let me see",
        "one sec",
        "on it",
        "hang on",
        "checking",
        "looking into it",
        "gimme a sec",
        "alright",
        "sorting it",
        "got you",
        "let me check",
    ],
    complex: [
        "let me dig in",
        "needs a proper look",
        "bear with me",
        "thinking it through",
        "mapping it out",
        "finding another way",
    ],
    quick: [
        "sec",
        "easy",
        "got it",
        "yep",
        "on it",
    ]
};

export function getThinkingPhrase(complexity: "simple" | "complex" | "default" = "default"): string {
    const pool = complexity === "simple" ? THINKING_PHRASES.quick
               : complexity === "complex" ? THINKING_PHRASES.complex
               : THINKING_PHRASES.default;
    return pickPhrase("thinking", [...pool, ...THINKING_PHRASES.default.slice(0, 3)]);
}

// ── Progress Indicators (tool-specific, alive) ──────

interface ProgressConfig {
    emoji: string;
    phrases: string[];
    activeVerb: string;
}

const PROGRESS_CONFIGS: Record<string, ProgressConfig> = {
    search: {
        emoji: "🔍",
        phrases: ["looking for", "searching", "finding", "checking"],
        activeVerb: "searching",
    },
    browse: {
        emoji: "🌐",
        phrases: ["checking", "opening", "going to", "pulling up"],
        activeVerb: "browsing",
    },
    think: {
        emoji: "💭",
        phrases: ["thinking about", "considering", "working on"],
        activeVerb: "thinking",
    },
    code: {
        emoji: "⚡",
        phrases: ["running", "executing", "doing"],
        activeVerb: "running",
    },
    read: {
        emoji: "📄",
        phrases: ["reading", "checking", "looking at"],
        activeVerb: "reading",
    },
    write: {
        emoji: "📝",
        phrases: ["writing", "creating", "saving"],
        activeVerb: "writing",
    },
    screenshot: {
        emoji: "👀",
        phrases: ["looking at your screen", "checking what you see", "seeing this"],
        activeVerb: "looking",
    },
    download: {
        emoji: "⬇️",
        phrases: ["downloading", "grabbing", "getting"],
        activeVerb: "downloading",
    },
    upload: {
        emoji: "📤",
        phrases: ["sending", "uploading", "sharing"],
        activeVerb: "sending",
    },
    memory: {
        emoji: "🧠",
        phrases: ["remembering this", "noting", "got it"],
        activeVerb: "remembering",
    },
    analyze: {
        emoji: "🔎",
        phrases: ["looking into", "checking", "analyzing"],
        activeVerb: "analyzing",
    },
    wait: {
        emoji: "⏳",
        phrases: ["waiting", "hold on", "one sec"],
        activeVerb: "waiting",
    },
};

export function getProgressMessage(type: keyof typeof PROGRESS_CONFIGS, target?: string): string {
    const config = PROGRESS_CONFIGS[type] || PROGRESS_CONFIGS.think;
    const verb = pickPhrase(`progress_${type}`, config.phrases);

    if (target) {
        // Truncate long targets
        const shortTarget = target.length > 40 ? target.substring(0, 37) + "…" : target;
        return `${config.emoji} ${verb} ${shortTarget}…`;
    }
    return `${config.emoji} ${verb}…`;
}

// ── Error Messages (specific, actionable, human) ──────

interface ErrorConfig {
    message: string;
    suggestion?: string;
}

const ERROR_MESSAGES: Record<string, ErrorConfig> = {
    network_timeout: {
        message: "hmm connection timed out",
        suggestion: "wifi acting up? try again",
    },
    permission_denied: {
        message: "I can't do that — no permission",
        suggestion: "check System Settings",
    },
    rate_limited: {
        message: "too fast! slow down",
        suggestion: "wait a minute and try again",
    },
    out_of_credits: {
        message: "out of credits",
        suggestion: "need more credits from the XAGI Labs team",
    },
    file_not_found: {
        message: "can't find that file",
        suggestion: "check the path?",
    },
    api_error: {
        message: "backend hiccup",
        suggestion: "try again",
    },
    screenshot_failed: {
        message: "can't see your screen",
        suggestion: "System Settings → Privacy → Screen Recording",
    },
    audio_failed: {
        message: "trouble with that audio",
        suggestion: "try a shorter clip?",
    },
    browser_failed: {
        message: "browser didn't cooperate",
        suggestion: "page still loading? try again",
    },
    tool_timeout: {
        message: "took too long, gave up",
        suggestion: "might need to break this down",
    },
    unknown: {
        message: "something broke",
        suggestion: "let me know if it keeps happening",
    },
};

export function getErrorMessage(type: keyof typeof ERROR_MESSAGES, context?: string): string {
    const config = ERROR_MESSAGES[type] || ERROR_MESSAGES.unknown;
    let msg = config.message;
    if (context) msg += ` (${context})`;
    if (config.suggestion) msg += `. ${config.suggestion}`;
    return msg;
}

export function categorizeError(error: Error | string): keyof typeof ERROR_MESSAGES {
    const msg = typeof error === "string" ? error.toLowerCase() : error.message.toLowerCase();

    if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("etimedout")) return "network_timeout";
    if (msg.includes("permission") || msg.includes("eacces") || msg.includes("not permitted")) return "permission_denied";
    if (msg.includes("rate limit") || msg.includes("429") || msg.includes("too many")) return "rate_limited";
    if (msg.includes("credit") || msg.includes("quota")) return "out_of_credits";
    if (msg.includes("enoent") || msg.includes("no such file")) return "file_not_found";
    if (msg.includes("screenshot") || msg.includes("screen capture")) return "screenshot_failed";
    if (msg.includes("audio") || msg.includes("transcri")) return "audio_failed";
    if (msg.includes("browser") || msg.includes("playwright") || msg.includes("puppeteer")) return "browser_failed";
    if (msg.includes("api") || msg.includes("500") || msg.includes("502") || msg.includes("503")) return "api_error";

    return "unknown";
}

// ── Wait/Delay Acknowledgments ──────────────────────

const WAIT_PHRASES = {
    short: [  // < 10 seconds
        "sec",
        "moment",
        "almost",
        "nearly there",
    ],
    medium: [ // 10-30 seconds
        "still on it",
        "bit longer",
        "getting there",
        "hang tight",
    ],
    long: [   // > 30 seconds
        "taking a while, sorry",
        "still at it",
        "not giving up",
    ],
    timeout_warning: [
        "this is dragging — keep going?",
        "seems stuck — try another way?",
        "want me to try plan b?",
    ],
};

export function getWaitPhrase(elapsedMs: number): string {
    if (elapsedMs < 10000) {
        return pickPhrase("wait_short", WAIT_PHRASES.short);
    } else if (elapsedMs < 30000) {
        return pickPhrase("wait_medium", WAIT_PHRASES.medium);
    } else if (elapsedMs < 60000) {
        return pickPhrase("wait_long", WAIT_PHRASES.long);
    } else {
        return pickPhrase("wait_timeout", WAIT_PHRASES.timeout_warning);
    }
}

// ── Voice Feedback Stages ────────────────────────────

const VOICE_STAGES = {
    listening: ["🎤 listening", "🎤 go ahead", "🎤 hearing you"],
    processing: ["processing", "working on it", "analyzing"],
    transcribing: ["transcribing", "converting", "writing it down"],
    understanding: ["understanding", "getting it", "processing"],
    responding: ["got it", "okay", "on it"],
};

export function getVoiceStagePhrase(stage: keyof typeof VOICE_STAGES): string {
    return pickPhrase(`voice_${stage}`, VOICE_STAGES[stage]);
}

// ── Smart Message Chunking ───────────────────────────

/** Fenced block that a cut at `pos` would land inside, if any. */
function findFenceAround(
    text: string,
    pos: number,
): { start: number; openLine: string; openLineEnd: number; end: number } | null {
    let offset = 0;
    let open: { start: number; openLine: string; openLineEnd: number } | null = null;
    for (const line of text.split("\n")) {
        if (!open && offset >= pos) return null;
        const lineEnd = offset + line.length;
        // "```npm i foo``` then …" opens and closes on one line — an even count isn't a fence toggle
        if (line.trimStart().startsWith("```") && line.split("```").length % 2 === 0) {
            if (!open) {
                open = { start: offset, openLine: line.trim(), openLineEnd: lineEnd };
            } else {
                if (pos < lineEnd) return { ...open, end: lineEnd };
                open = null;
            }
        }
        offset = lineEnd + 1;
    }
    return open ? { ...open, end: -1 } : null;
}

/**
 * Splits a message into chunks that preserve code blocks and natural paragraph breaks.
 * Prefers cutting outside fenced code; when a block is too big to keep whole, the
 * fence is closed at the end of one chunk and reopened (same language) in the next.
 */
export function smartChunkMessage(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = text.trim();

    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            chunks.push(remaining);
            break;
        }

        // Find best split: double newline (paragraph) > single newline > sentence end > space
        let splitAt: number;
        const searchRange = remaining.substring(0, maxLength);
        const lastParaBreak = searchRange.lastIndexOf("\n\n");
        const lastLineBreak = searchRange.lastIndexOf("\n");
        const sentenceEnd = Math.max(
            searchRange.lastIndexOf(". "),
            searchRange.lastIndexOf("! "),
            searchRange.lastIndexOf("? "),
        );
        const lastSpace = searchRange.lastIndexOf(" ");
        if (lastParaBreak > maxLength * 0.3) splitAt = lastParaBreak;
        else if (lastLineBreak > maxLength * 0.5) splitAt = lastLineBreak;
        else if (sentenceEnd > maxLength * 0.5) splitAt = sentenceEnd + 1;
        else splitAt = lastSpace > maxLength * 0.3 ? lastSpace : maxLength;

        const fence = findFenceAround(remaining, splitAt);
        if (fence) {
            if (fence.end !== -1 && fence.end <= maxLength) {
                // Block closes within this chunk — cut right after it
                splitAt = fence.end;
            } else if (fence.start > maxLength * 0.3) {
                // Block starts well into the chunk — move it whole to the next one
                splitAt = fence.start;
            } else {
                // Block too big to keep whole: close it here, reopen in the next chunk
                const budget = maxLength - 4; // room for "\n```"
                if (budget > fence.openLineEnd + 1) {
                    let cut = remaining.lastIndexOf("\n", budget);
                    if (cut <= fence.openLineEnd) cut = budget;
                    chunks.push(`${remaining.substring(0, cut).trimEnd()}\n\`\`\``);
                    const rest = remaining.substring(cut).replace(/^\n/, "");
                    remaining = `${fence.openLine}\n${rest}`;
                    continue;
                }
            }
        }

        const chunk = remaining.substring(0, splitAt).trim();
        if (chunk) chunks.push(chunk);
        remaining = remaining.substring(splitAt).trim();
    }

    return chunks;
}
