// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Centralized threat-pattern scanner ──────────────────────────
// Canonical home for prompt-injection / exfil / C2 / tool-coercion /
// invisible-unicode detection across ATLAS. Two narrow regex scanners
// predate this module — src/store/sideload.ts (8 injection regexes) and
// src/agents/defang-plan-injection.ts (identity-affirmation scrub). Both
// stay in place for now; new call sites should route here instead of
// growing their own pattern lists. If those modules are revisited, their
// injection regexes are superseded by `instruction_override` / `role_switch`
// / `exfil` below and should reference this module rather than duplicate it.
//
// Pure module — no I/O, no module-level mutable state, no LLM. Detection is
// regex `.exec` + a single O(n) Set-membership pass over codepoints, so every
// call is $0.00. TS-only; benched-out of Rust per CLAUDE.md small-input rule
// (memory writes cap at 2000 chars, context snippets ~1500 tokens — far below
// the multi-pattern-over-100KB threshold where the sanitizer's Rust port wins,
// and the napi FFI tax would dominate this work).

export type ThreatScope = "all" | "context" | "strict";

export type ThreatCategory =
    | "instruction_override"
    | "role_switch"
    | "exfil"
    | "c2"
    | "tool_coercion"
    | "invisible_unicode";

export interface ThreatMatch {
    name: string;
    category: ThreatCategory;
    sample: string;
}

export interface ThreatScanResult {
    detected: boolean;
    matches: ThreatMatch[];
    categories: ThreatCategory[];
}

interface ThreatPattern {
    name: string;
    category: ThreatCategory;
    scopes: ThreatScope[];
    regex: RegExp;
}

// Filler-resistant: bounded `[\s\S]{0,N}?` gaps (not `.*`) defeat word-stuffing
// without opening a ReDoS window, and `\b` anchors keep substrings like
// "ignores" from matching "ignore". Every regex carries `g` so `.exec` can be
// re-run statelessly after a `lastIndex` reset (mirrors secrets-sanitizer).
const PATTERNS: ThreatPattern[] = [
    {
        name: "override_instructions",
        category: "instruction_override",
        scopes: ["all", "context", "strict"],
        regex: /\b(?:ignore|disregard|forget|override|bypass)\b[\s\S]{0,40}?\b(?:all|any|the|your|previous|prior|above|earlier|system)\b[\s\S]{0,20}?\b(?:instruction|prompt|rule|directive|context|guardrail|constraint)s?\b/gi,
    },
    {
        name: "new_instructions_colon",
        category: "instruction_override",
        scopes: ["all", "strict"],
        regex: /\bnew\b[\s\S]{0,15}?\b(?:instruction|directive|system\s*prompt|rule)s?\b[\s\S]{0,20}?:/gi,
    },
    {
        name: "you_are_now",
        category: "role_switch",
        scopes: ["all", "context", "strict"],
        // Requires a jailbreak/elevation noun after "you are now" — a bare
        // article (a/an/the) is allowed only as the determiner immediately
        // preceding that noun, so benign "you are now ready to deploy the
        // service" does not trip.
        regex: /\byou\s+are\s+now\b[\s\S]{0,20}?\b(?:a|an|the)?\s*(?:DAN|developer\s*mode|jailbroken|unrestricted|unfiltered|uncensored|admin|root|sudo|god\s*mode)\b/gi,
    },
    {
        name: "act_as_unrestricted",
        category: "role_switch",
        scopes: ["all"],
        regex: /\b(?:act|behave|respond|pretend|roleplay)\s+as\b[\s\S]{0,30}?\b(?:if\s+)?(?:you\s+(?:are|were)|an?\s+)?(?:unrestricted|jailbroken|developer\s*mode|DAN|no\s*(?:rules|filter|restriction))/gi,
    },
    {
        name: "system_directive_must",
        category: "role_switch",
        scopes: ["all", "strict"],
        regex: /\b(?:system|assistant)\s*[:>]\s*you\s+(?:must|will|should)\b/gi,
    },
    {
        name: "exfil_secrets",
        category: "exfil",
        scopes: ["all", "strict"],
        regex: /\b(?:send|post|upload|exfiltrate|leak|transmit|forward|email|curl|wget|fetch)\b[\s\S]{0,40}?\b(?:credential|secret|api[\s_-]?key|password|token|private[\s_-]?key|\.env|env\s*var|memory|conversation|chat\s*history|system\s*prompt)s?\b/gi,
    },
    {
        name: "reveal_system_prompt",
        category: "exfil",
        scopes: ["all", "context", "strict"],
        regex: /\b(?:print|reveal|show|dump|output|repeat|echo)\b[\s\S]{0,30}?\b(?:your|the|all)\b[\s\S]{0,20}?\b(?:system\s*prompt|instruction|secret|api[\s_-]?key|credential|hidden\s*(?:prompt|rule))s?\b/gi,
    },
    {
        name: "encoded_network_payload",
        category: "c2",
        scopes: ["all", "context"],
        regex: /\b(?:base64|atob|fromCharCode|eval|exec)\b[\s\S]{0,40}?\b(?:http|fetch|curl|wget|request|payload)\b/gi,
    },
    {
        name: "beacon_interval",
        category: "c2",
        scopes: ["all", "context"],
        regex: /\b(?:poll|beacon|callback|check[\s-]?in)\b[\s\S]{0,30}?\b(?:every|each|interval|seconds?|minutes?|c2|server|endpoint|url)\b/gi,
    },
    {
        name: "command_url",
        category: "c2",
        scopes: ["all", "context"],
        regex: /\bhttps?:\/\/[^\s"'<>]+\?(?:[^\s]*(?:cmd|exec|payload|data|exfil)=)/gi,
    },
    {
        name: "covert_tool_call",
        category: "tool_coercion",
        scopes: ["all", "strict"],
        regex: /\b(?:always|must|secretly|silently|without\s+(?:telling|asking|notifying)|don'?t\s+(?:tell|ask|notify|warn))\b[\s\S]{0,40}?\b(?:call|invoke|run|execute|use)\b[\s\S]{0,20}?\b(?:tool|shell|exec|command|function|delete|rm\b|git\s+push)/gi,
    },
    {
        name: "bypass_approval",
        category: "tool_coercion",
        scopes: ["all", "strict"],
        regex: /\b(?:auto[\s-]?approve|skip\s+(?:confirmation|approval|the\s+check)|bypass\s+(?:approval|safety|guardrail))/gi,
    },
];

// Invisible / bidi control codepoints. Borrowed from the proven list in
// src/forge/critics.ts (BIDI_CONTROL_RE) and extended to 17. Detection is a
// single Set-membership sweep over the string's codepoints rather than a regex,
// so a payload that hides a `‮` mid-word is caught regardless of context.
export const INVISIBLE_CHARS: ReadonlySet<string> = new Set([
    "​", // ZWSP
    "‌", // ZWNJ
    "‍", // ZWJ
    "‎", // LRM
    "‏", // RLM
    "‪", // LRE
    "‫", // RLE
    "‬", // PDF
    "‭", // LRO
    "‮", // RLO
    "⁦", // LRI
    "⁧", // RLI
    "⁨", // FSI
    "⁩", // PDI
    "⁠", // word joiner
    "﻿", // BOM / ZWNBSP
    "᠎", // Mongolian vowel separator
]);

const INVISIBLE_UNICODE_SCOPES: ThreatScope[] = ["all", "context", "strict"];

function patternsForScope(scope: ThreatScope): ThreatPattern[] {
    return PATTERNS.filter((p) => p.scopes.includes(scope));
}

function firstInvisibleChar(input: string): string | null {
    for (const ch of input) {
        if (INVISIBLE_CHARS.has(ch)) return ch;
    }
    return null;
}

export function scanForThreats(input: string, scope: ThreatScope = "all"): ThreatScanResult {
    const matches: ThreatMatch[] = [];
    if (!input) return { detected: false, matches, categories: [] };

    for (const pattern of patternsForScope(scope)) {
        pattern.regex.lastIndex = 0;
        const hit = pattern.regex.exec(input);
        if (hit) {
            matches.push({
                name: pattern.name,
                category: pattern.category,
                sample: hit[0].slice(0, 60),
            });
        }
    }

    if (INVISIBLE_UNICODE_SCOPES.includes(scope)) {
        const invisible = firstInvisibleChar(input);
        if (invisible) {
            matches.push({
                name: "invisible_unicode",
                category: "invisible_unicode",
                sample: `U+${invisible.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`,
            });
        }
    }

    const categories = Array.from(new Set(matches.map((m) => m.category)));
    return { detected: matches.length > 0, matches, categories };
}

// Cheap probe: short-circuits on first hit without collecting match metadata.
export function containsThreat(input: string, scope: ThreatScope = "all"): boolean {
    if (!input) return false;

    for (const pattern of patternsForScope(scope)) {
        pattern.regex.lastIndex = 0;
        if (pattern.regex.test(input)) return true;
    }

    if (INVISIBLE_UNICODE_SCOPES.includes(scope) && firstInvisibleChar(input) !== null) {
        return true;
    }

    return false;
}
