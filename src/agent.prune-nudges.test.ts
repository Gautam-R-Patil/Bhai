// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { applyPendingPrune, pushNudge, pushRetry, runWithTurnNudges, stripTurnNudges } from "./agent.js";
import type { ChatCompletionMessageParam } from "./llm.js";

const msg = (content: string): ChatCompletionMessageParam => ({ role: "user", content });

describe("applyPendingPrune", () => {
    const base = Array.from({ length: 70 }, (_, i) => msg(`m${i}`));
    const recent = base.slice(50);

    it("applies a summarized prune and keeps messages appended since", () => {
        const extra = msg("new");
        const summary: ChatCompletionMessageParam = { role: "system", content: "[Previous conversation summary]\nx" };
        const out = applyPendingPrune([...base, extra], {
            base,
            result: { messages: [summary, ...recent], pruned: 50, summary: "x" },
        });
        expect(out).toEqual([summary, ...recent, extra]);
    });

    it("ignores a summary-less truncation (summary call failed), but not forever", () => {
        const failed = { base, result: { messages: recent, pruned: 50 } };
        expect(applyPendingPrune([...base], failed)).toBeNull();
        expect(applyPendingPrune([...base], failed)).toBeNull();
        // Third straight failure: truncate anyway so history can't sit at the cap.
        expect(applyPendingPrune([...base], failed)).toEqual(recent);
        expect(applyPendingPrune([...base], failed)).toBeNull(); // counter reset
    });
});

describe("turn nudges", () => {
    it("a retry's draft reply and steering note don't outlive the turn, and don't pose as the owner", () => {
        const history: ChatCompletionMessageParam[] = [msg("remind me in 3 minutes")];
        const owned = new Set<object>();
        runWithTurnNudges(owned, () => pushRetry(history, "Set for 7:43.", "If it is done, give your final answer."));
        expect(history[2]).toMatchObject({
            role: "user",
            content: expect.stringMatching(/^\[Automatic check, not from the owner\]/),
        });
        history.push({ role: "assistant", content: "Done — 7:43." });
        stripTurnNudges(history, owned);
        expect(history.map((m) => m.content)).toEqual(["remind me in 3 minutes", "Done — 7:43."]);
    });

    it("a turn strips only its own nudges, not an overlapping turn's", () => {
        const history: ChatCompletionMessageParam[] = [msg("hi")];
        const a = new Set<object>();
        const b = new Set<object>();
        runWithTurnNudges(a, () => pushNudge(history, "A nudge"));
        runWithTurnNudges(b, () => pushNudge(history, "B nudge"));
        stripTurnNudges(history, a);
        expect(history.map((m) => m.content)).toEqual(["hi", "B nudge"]);
        stripTurnNudges(history, b);
        expect(history.map((m) => m.content)).toEqual(["hi"]);
    });

    it("keeps the scope across awaits", async () => {
        const history: ChatCompletionMessageParam[] = [];
        const owned = new Set<object>();
        await runWithTurnNudges(owned, async () => {
            await new Promise((r) => setTimeout(r, 1));
            pushNudge(history, "late");
        });
        expect(owned.size).toBe(1);
    });
});
