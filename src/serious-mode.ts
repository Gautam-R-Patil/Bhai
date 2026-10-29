// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// identity.md takes the shades off for grief, health, lost money and crisis,
// but only as prose: the per-turn tone line still said UNHINGED, the turn still
// went to Grok, and proactive kept chatting. So spot the moment in the owner's
// own words and hold it for a day, or until they're laughing again.

import { setQuietUntil } from "./proactive/kill-switches.js";

export const SHADES_OFF_NOTE = "Serious moment: no catchphrases, jokes, emoji or cube lines; short, steady, present.";

const HOLD_MS = 24 * 3_600_000;

// ponytail: hand-written detector checked against the labelled corpus in
// serious-mode.test.ts; add a miss or false hit there before touching it.
// Aimed at the person ("my dad passed", "I got diagnosed"), not their build or app.
const SERIOUS_RE = new RegExp(
    [
        // grief
        String.raw`\bpassed away\b`,
        String.raw`\b(?:my|our) (?:\w+ )?(?:mom|mum|mother|dad|father|parents?|grand\w+|nani|nana|dadi|dada|brother|sister|wife|husband|son|daughter|uncle|aunt|friend|dog|cat) (?:just |has |had )?(?:died|passed(?! (?:the|his|her|their|an?|my|with)\b)|is no more)\b`,
        String.raw`\b(?:\w+'s|his|her|their|to the|at the) funeral\b|\bfuneral (?:is|was|today|tomorrow|tonight)\b`,
        String.raw`\bguzar gay[ei]\b`,
        String.raw`\bnahi rahe\b`,
        // health
        String.raw`\b(?:got|been|was|were|is|am|i'?m|just) diagnosed\b`,
        String.raw`(?:'s|\b(?:is|are|was|were|am|i'?m|been|got|rushed|admitted|taken|go|going|went|way|back|still)) (?:\w+ )?(?:in|to|at|into|from) (?:the )?(?:hospital|icu|emergency room)\b`,
        String.raw`(?:'s|\b(?:my|his|her|their|has|have|had|got|needs?|having|getting|starts?|started|starting)) (?:a |an )?(?:surgery|chemo|tumou?r)\b`,
        String.raw`\b(?:has|have|had|got) cancer\b`,
        String.raw`\b(?:had|having) (?:a )?(?:heart attack|stroke|panic attack|seizure)\b`,
        // money
        String.raw`\b(?:got|been|was|were) (?:scammed|defrauded)\b`,
        String.raw`\bfraud (?:on|against) me\b|\bfraud on my (?:\w+ )?(?:card|bank)\b`,
        String.raw`\b(?:lost|lose) my job\b`,
        String.raw`\b(?:got|been|was|were|i'?m) (?:laid off|fired)\b(?! up)`,
        String.raw`\blost (?:all )?(?:my|our) (?:money|savings)\b`,
        // crisis
        String.raw`\bsuicid`,
        String.raw`\bkill myself\b`,
        String.raw`\bwant to die\b`,
        String.raw`\bend (?:it all|my life)\b`,
        String.raw`\bself[- ]?harm`,
        String.raw`\bhurt(?:ing)? myself\b`,
    ].join("|"),
    "i",
);
const LIGHT_RE = /\b(?:lol|lmao|haha+|hehe+)\b|😂|🤣/i;

let seriousUntil = 0;
let lightInARow = 0;

/** Call with each message the owner sends. */
export function noteOwnerMood(text: string, now = Date.now()): void {
    if (SERIOUS_RE.test(text)) {
        seriousUntil = now + HOLD_MS;
        lightInARow = 0;
        setQuietUntil(seriousUntil); // proactive holds non-urgent sends
    } else if (now < seriousUntil && LIGHT_RE.test(text)) {
        if (++lightInARow >= 2) seriousUntil = 0; // laughing again; "thanks" isn't
    } else {
        lightInARow = 0;
    }
}

// ponytail: in-memory, so a restart clears it; persist it if that matters.
export function isSerious(now = Date.now()): boolean {
    return now < seriousUntil;
}

export function _resetSeriousMode(): void {
    seriousUntil = 0;
    lightInARow = 0;
}
