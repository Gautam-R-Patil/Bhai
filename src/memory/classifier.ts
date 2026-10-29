// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Query Classifier (SAC-DR) ─────────────────
// Lightweight rule-based classifier (no LLM call) that decides retrieval strategy.

import type { UserProfile } from "./identity.js";

// ── Types ─────────────────────────────────────

export type QueryMode = "llm_only" | "llm_with_traits" | "retrieve";

// ── Patterns ──────────────────────────────────

// Patterns that indicate the user is asking about past conversations / history
const RETRIEVAL_PATTERNS = [
    /what did (i|we) (say|discuss|talk about|mention|decide)/i,
    /last (time|week|month|session|conversation)/i,
    /\b(previously|earlier|before|ago)\b/i,
    /\bdo you remember\b/i,
    /\bwhat was\b.*\b(conclusion|decision|result)\b/i,
    /\b(three|two|four|five|six|seven|eight|nine|ten|\d+) (weeks?|months?|days?) ago\b/i,
    /\bhistory\b/i,
    /\brecall\b/i,
    /\bwhat (have|did) (i|we) (done|worked on|discussed)\b/i,
    /\byesterday\b/i,
    /\b(didn'?t I mention|didnt I mention)\b/i,
    /\b(earlier I told|earlier I said|earlier I mentioned)\b/i,
    /\b(remind me|what was that)\b/i,
];

// Action verbs that indicate a task, not a greeting — used as negative lookahead
const ACTION_VERB_RE = /\b(search|find|fix|create|open|run|download|send|set|build|write|read|check|show|delete|update|install|deploy|edit|make|start|help me|can you|could you|please)\b/i;

// Simple greetings / commands that don't need any memory injection.
// Tail word count is capped at {0,2} so that action queries starting with a
// greeting word ("yo what's the weather", "okay play closer song") are NOT
// caught here — they'll get proper tool selection via llm_with_traits.
const LLM_ONLY_PATTERNS = [
    /^(hi|hello|hey|yo|sup|good (morning|afternoon|evening)|gm)\b[\s!?.,]*(\S+[\s!?.,]*){0,2}$/i,
    /^(thanks|thank you|thx|ty)\b[\s!?.,]*(\S+[\s!?.,]*){0,2}$/i,
    /^(ok|okay|sure|got it|cool|nice|great|alright|no worries|np)\b[\s!?.,]*(\S+[\s!?.,]*){0,2}$/i,
    /^(how are you|how's it going|how have you been|what's up|wassup|whats up|how do you do)[\s!?.]*$/i,
    /^(good night|gn|bye|goodbye|see you|later|cya|ttyl|brb|gtg)[\s!?.,]*(\S+[\s!?.,]*){0,2}$/i,
    /^\/\w+/,  // Slash commands
    /^(stop|cancel)$/i,
    // Instant functional queries (Time, Date, Day) that don't need tools
    /^(what is the time|what's the time|whats the time|what time is it|time|current time|what is the date|what's the date|whats the date|what date is it|date|current date|what day is it|day)[\s!?.]*$/i,
];

// ── Classify ──────────────────────────────────

/**
 * Decides how much memory context to inject for a given query.
 *
 * - "llm_only": Simple greetings/commands — no memory needed
 * - "llm_with_traits": Normal queries — identity + traits injected
 * - "retrieve": User asking about past context — trigger semantic retrieval
 */
export function classifyQuery(userMessage: string, _profile?: UserProfile | null): QueryMode {
    // Normalize apostrophes for pattern matching
    const trimmed = userMessage.trim().replace(/[\u2018\u2019]/g, "'");

    // Only classify as "llm_only" for explicit greetings/acks that clearly need no memory.
    // Previously, short non-action messages like "this device" or "how much?" were classified
    // as llm_only, skipping ALL semantic recall — causing context loss on follow-up messages.
    // An action request that merely opens with a greeting/ack ("ok delete
    // everything", "sure send it") must NOT be treated as a no-memory greeting:
    // the {0,2} tail cap alone lets 2-token actions slip through, so guard the
    // match with the action-verb check. Guarding the match (not early-returning)
    // lets a history query that contains an action verb still fall through to the
    // RETRIEVAL loop below.
    for (const pattern of LLM_ONLY_PATTERNS) {
        if (pattern.test(trimmed) && !ACTION_VERB_RE.test(trimmed)) {
            return "llm_only";
        }
    }

    // Check for retrieval patterns (explicit history references)
    for (const pattern of RETRIEVAL_PATTERNS) {
        if (pattern.test(trimmed)) {
            return "retrieve";
        }
    }

    // Default — ALWAYS run memory retrieval (identity + traits + semantic recall).
    // Short ambiguous messages benefit most from context injection.
    return "llm_with_traits";
}
