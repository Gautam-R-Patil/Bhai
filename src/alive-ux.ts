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

function pickPhrase(category: string, options: string[]): string {
    const history = recentPhrases.get(category) || [];

    // Filter out recently used phrases
    const available = options.filter(opt => !history.includes(opt));
    const pool = available.length > 0 ? available : options;

    // Random selection
    const chosen = pool[Math.floor(Math.random() * pool.length)];

    // Update history
    history.push(chosen);
    if (history.length > MAX_HISTORY) history.shift();
    recentPhrases.set(category, history);

    return chosen;
}

// ── Time-of-Day Awareness ──────────────────────────

export function getTimeContext(): { period: "night" | "earlyMorning" | "morning" | "afternoon" | "evening" | "lateNight"; hour: number; greeting: string } {
    const now = new Date();
    const hour = parseInt(now.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: getTimezone() }));

    if (hour >= 0 && hour < 5) {
        return { period: "lateNight", hour, greeting: pickPhrase("greeting", ["hey night owl", "still up?", "burning the midnight oil", "you're up late", "late night vibes"]) };
    } else if (hour >= 5 && hour < 7) {
        return { period: "earlyMorning", hour, greeting: pickPhrase("greeting", ["early bird!", "you're up early", "morning sunshine", "rise and shine", "early start today"]) };
    } else if (hour >= 7 && hour < 12) {
        return { period: "morning", hour, greeting: pickPhrase("greeting", ["morning!", "hey there", "good morning", "what's up", "yo"]) };
    } else if (hour >= 12 && hour < 17) {
        return { period: "afternoon", hour, greeting: pickPhrase("greeting", ["hey", "what's good", "afternoon", "sup", "hey there"]) };
    } else if (hour >= 17 && hour < 21) {
        return { period: "evening", hour, greeting: pickPhrase("greeting", ["evening!", "hey", "winding down?", "how's the evening", "what's up"]) };
    } else {
        return { period: "night", hour, greeting: pickPhrase("greeting", ["hey", "night mode", "still at it?", "evening", "what's up"]) };
    }
}

// ── Thinking Indicators (varied, natural) ──────────

const THINKING_PHRASES = {
    default: [
        "hmm",
        "let me think",
        "one sec",
        "hold on",
        "okay",
        "working on it",
        "hang on",
        "gimme a sec",
        "checking",
        "looking",
        "alright",
        "mmm",
    ],
    complex: [
        "okay this is interesting",
        "ooh let me dig into this",
        "hmm this needs some thought",
        "alright bear with me",
        "okay give me a minute",
        "this is a good one",
        "let me think through this",
    ],
    quick: [
        "sec",
        "easy",
        "got it",
        "yep",
        "sure",
        "k",
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
        suggestion: "need to top up",
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

    if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("ETIMEDOUT")) return "network_timeout";
    if (msg.includes("permission") || msg.includes("EACCES") || msg.includes("not permitted")) return "permission_denied";
    if (msg.includes("rate limit") || msg.includes("429") || msg.includes("too many")) return "rate_limited";
    if (msg.includes("credit") || msg.includes("quota") || msg.includes("exceeded")) return "out_of_credits";
    if (msg.includes("ENOENT") || msg.includes("not found") || msg.includes("no such file")) return "file_not_found";
    if (msg.includes("screenshot") || msg.includes("screen capture")) return "screenshot_failed";
    if (msg.includes("audio") || msg.includes("transcri")) return "audio_failed";
    if (msg.includes("browser") || msg.includes("playwright") || msg.includes("puppeteer")) return "browser_failed";
    if (msg.includes("api") || msg.includes("500") || msg.includes("502") || msg.includes("503")) return "api_error";

    return "unknown";
}

// ── Acknowledgment Phrases (task received) ──────────

const TASK_ACKS = {
    search: ["looking", "searching", "finding that", "on it"],
    browse: ["opening", "going there", "checking it out", "pulling up"],
    code: ["running", "on it", "doing that", "executing"],
    file: ["checking", "opening", "looking", "got it"],
    research: ["diving in", "researching", "looking into it", "exploring"],
    creative: ["working on it", "creating", "making that", "on it"],
    general: ["on it", "got it", "doing that", "sec"],
};

export function getTaskAck(taskType: keyof typeof TASK_ACKS = "general"): string {
    const pool = TASK_ACKS[taskType] || TASK_ACKS.general;
    return pickPhrase(`ack_${taskType}`, pool);
}

// ── Wait/Delay Acknowledgments ──────────────────────

const WAIT_PHRASES = {
    short: [  // < 10 seconds
        "sec",
        "almost",
        "moment",
    ],
    medium: [ // 10-30 seconds
        "still working",
        "bit longer",
        "hang on",
        "getting there",
    ],
    long: [   // > 30 seconds
        "taking a while, sorry",
        "still at it",
        "bear with me",
        "almost done",
    ],
    timeout_warning: [
        "this is taking forever — keep trying?",
        "seems stuck — try differently?",
        "want me to stop and try another way?",
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

// ── Response Time Acknowledgments ──────────────────

export function getResponseTimeAck(durationMs: number, hadToolCalls: boolean): string | null {
    // Don't acknowledge fast responses or pure text (no tool) responses
    if (durationMs < 15000 || !hadToolCalls) return null;

    if (durationMs < 30000) {
        return pickPhrase("response_time", [
            "took a sec — ",
            "sorry for the wait — ",
            "okay — ",
        ]);
    } else if (durationMs < 60000) {
        return pickPhrase("response_time", [
            "that took a while — ",
            "finally — ",
            "sorry that was slow — ",
        ]);
    } else {
        return pickPhrase("response_time", [
            "took forever, sorry — ",
            "finally! — ",
            "phew — ",
        ]);
    }
}

// ── Casual Phrases (human filler) ────────────────────

const CASUAL_INTROS = [
    "so",
    "okay",
    "alright",
    "well",
    "here's the thing",
    "",  // sometimes no intro is more natural
    "",
];

const CASUAL_OUTROS = [
    "anything else?",
    "need more?",
    "that help?",
    "all good?",
    "",  // sometimes ending without a question is more natural
    "",
];

export function getCasualIntro(): string {
    return pickPhrase("casual_intro", CASUAL_INTROS);
}

export function getCasualOutro(): string {
    return pickPhrase("casual_outro", CASUAL_OUTROS);
}

// ── Voice Feedback Stages ────────────────────────────

export const VOICE_STAGES = {
    listening: ["🎤 listening", "🎤 go ahead", "🎤 hearing you"],
    processing: ["processing", "working on it", "analyzing"],
    transcribing: ["transcribing", "converting", "writing it down"],
    understanding: ["understanding", "getting it", "processing"],
    responding: ["got it", "okay", "on it"],
};

export function getVoiceStagePhrase(stage: keyof typeof VOICE_STAGES): string {
    return pickPhrase(`voice_${stage}`, VOICE_STAGES[stage]);
}

// ── Proactive Message Personality ────────────────────

export function getProactivePrefix(type: "reminder" | "checkIn" | "suggestion" | "alert"): string {
    const prefixes = {
        reminder: ["hey", "btw", "don't forget", "quick —"],
        checkIn: ["hey", "yo", "sup"],
        suggestion: ["random thought —", "btw", "might help —", "idea —"],
        alert: ["heads up", "yo", "quick"],
    };
    return pickPhrase(`proactive_${type}`, prefixes[type]);
}

// ── Session/Context Warnings ─────────────────────────

export function getSessionWarning(minutesRemaining: number): string {
    if (minutesRemaining <= 5) {
        return pickPhrase("session_warn", [
            "btw context resets soon — say something to keep it",
            "heads up, about to lose our thread — reply to keep it",
            "chat memory refreshing soon, reply to save context",
        ]);
    }
    return pickPhrase("session_warn", [
        "fyi we lose context if you step away for a bit",
        "context times out after inactivity btw",
    ]);
}

// ── Memory Transparency ──────────────────────────────

export function getMemoryAck(action: "stored" | "recalled" | "forgot"): string {
    const phrases = {
        stored: ["noted", "got it", "remembered", "saved"],
        recalled: ["you mentioned", "from before —", "I remember —"],
        forgot: ["cleared", "forgot that", "removed"],
    };
    return pickPhrase(`memory_${action}`, phrases[action]);
}

// ── Smart Message Chunking ───────────────────────────

/**
 * Splits a message into chunks that preserve code blocks and natural paragraph breaks.
 * Never cuts in the middle of a code block or mid-sentence.
 */
export function smartChunkMessage(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = text.trim();

    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            chunks.push(remaining);
            break;
        }

        // Find the best split point
        let splitAt = -1;
        let inCodeBlock = false;
        let codeBlockStart = -1;

        // Track code blocks — scan the ENTIRE remaining text to find matching pairs
        {
            let scanPos = 0;
            while (scanPos < remaining.length) {
                const idx = remaining.indexOf("```", scanPos);
                if (idx === -1) break;
                if (!inCodeBlock) {
                    inCodeBlock = true;
                    codeBlockStart = idx;
                } else {
                    inCodeBlock = false;
                    codeBlockStart = -1;
                }
                scanPos = idx + 3;
            }
        }

        // If a code block spans across the maxLength boundary, split BEFORE it opens
        if (inCodeBlock && codeBlockStart >= 0 && codeBlockStart < maxLength) {
            splitAt = codeBlockStart > 0 ? codeBlockStart : maxLength;
        } else {
            // Find best split: double newline (paragraph) > single newline > sentence end > space
            const searchRange = remaining.substring(0, maxLength);

            // Prefer paragraph breaks
            const lastParaBreak = searchRange.lastIndexOf("\n\n");
            if (lastParaBreak > maxLength * 0.3) {
                splitAt = lastParaBreak;
            } else {
                // Try line break
                const lastLineBreak = searchRange.lastIndexOf("\n");
                if (lastLineBreak > maxLength * 0.5) {
                    splitAt = lastLineBreak;
                } else {
                    // Try sentence end
                    const sentenceEnd = Math.max(
                        searchRange.lastIndexOf(". "),
                        searchRange.lastIndexOf("! "),
                        searchRange.lastIndexOf("? ")
                    );
                    if (sentenceEnd > maxLength * 0.5) {
                        splitAt = sentenceEnd + 1;
                    } else {
                        // Fall back to word break
                        const lastSpace = searchRange.lastIndexOf(" ");
                        splitAt = lastSpace > maxLength * 0.3 ? lastSpace : maxLength;
                    }
                }
            }
        }

        const chunk = remaining.substring(0, splitAt).trim();
        if (chunk) chunks.push(chunk);
        remaining = remaining.substring(splitAt).trim();
    }

    return chunks;
}

// ── Reset/Clear (for testing or conversation reset) ──

export function resetPhraseHistory(): void {
    recentPhrases.clear();
}
