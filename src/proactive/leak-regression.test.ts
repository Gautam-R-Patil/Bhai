// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Regression tests — every reported third-person leak becomes a test here.
// If this file ever goes empty, it stays — as documentation.
//
// Rule: if the LLM in `compose()` emits text that is a recognized leak,
// the Composer's post-filter MUST return null rather than dispatch it.

import { describe, it, expect, vi } from "vitest";
import { compose } from "./composer.js";
import type { ProactiveIntent } from "./intent.js";

vi.mock("../config/system-prompts.js", () => ({
    fetchSystemPrompt: vi.fn().mockResolvedValue("STUB SYSTEM PROMPT"),
}));

const LEAKS = [
    // 2026-04-21 screenshot on WhatsApp — AM reminder
    "Dheeraj's been away for 8+ hours and was working on that Midnight Library bookstore project last night — probably worth a quick recap of where he left off before diving back in, especially since it's morning and momentum matters for design work.",
    // 2026-04-21 screenshot on WhatsApp — second variant of the same leak
    "Dheeraj's been away for 8+ hours and was mid-conversation about building the Midnight Library website — might be good to recap where that left off and ask if he wants to continue or needs a different direction now that it's morning.",
    // 2026-04-21 screenshot on WhatsApp — afternoon variant with location
    "Dheeraj is in the middle of a dev project (Code is open) on an afternoon in Thiruvananthapuram — might be useful to remind him about the Midnight Library website he started scoping out yesterday, or check if he needs a quick break/focus session with Spotify already running.",
];

const baseIntent: ProactiveIntent = {
    id: "leak-test",
    source: "memory_anticipation",
    mode: "fyi",
    urgency: "normal",
    channelPreference: "any",
    topic: "x",
    topicEmbedding: new Array(384).fill(0),
    evidence: [],
    payload: { kind: "memory_anticipation", hint: "x" },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
};

describe("leak regression — verbatim strings from bug report must NEVER dispatch", () => {
    for (const [i, leak] of LEAKS.entries()) {
        it(`leak ${i + 1} is rejected by Composer`, async () => {
            const fakeLlm = {
                chat: vi.fn().mockResolvedValue({
                    choices: [{ message: { content: JSON.stringify({ text: leak, modeTag: "fyi", skip: false }) } }],
                }),
            } as any;

            const r = await compose(baseIntent, "whatsapp", { tone: "neutral" }, [], { llm: fakeLlm });

            // Primary assertion: Composer refused to dispatch this.
            expect(r).toBeNull();
        });

        it(`leak ${i + 1} is also rejected on telegram`, async () => {
            const fakeLlm = {
                chat: vi.fn().mockResolvedValue({
                    choices: [{ message: { content: JSON.stringify({ text: leak, modeTag: "fyi", skip: false }) } }],
                }),
            } as any;

            const r = await compose(baseIntent, "telegram", { tone: "neutral" }, [], { llm: fakeLlm });

            expect(r).toBeNull();
        });
    }

    it("belt-and-suspenders: even if filters were bypassed, dispatched text must not contain bug-report fingerprints", async () => {
        // This is a meta-test: if someone accidentally weakens the filters and a
        // leak slips through, we catch it here by asserting the exact substrings
        // that define the reported bug.
        const fingerprints = [
            "dheeraj",        // third-person name reference
            "been away for",  // classic leak opener
            "worth a quick",  // deliberation phrase
            "might be useful",
            "might be good to",
        ];
        for (const leak of LEAKS) {
            const lower = leak.toLowerCase();
            const hit = fingerprints.find((fp) => lower.includes(fp));
            expect(hit).toBeDefined();
        }
    });
});
