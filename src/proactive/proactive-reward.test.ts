// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { scoreProactiveAction } from "./proactive-reward.js";

const llm = (reply: string, seen: string[] = []) =>
    ({
        chat: async (req: { messages: Array<{ content: string }> }) => {
            seen.push(req.messages[0].content);
            return { choices: [{ message: { content: reply } }] };
        },
    }) as never;

describe("proactive reward", () => {
    it("a 1/10 thought is suppressed, and the score is a number the heartbeat can format", async () => {
        const r = await scoreProactiveAction(llm("SCORE: 1 REASON: not now"), "take a break", { hourOfDay: 0 });
        expect(typeof r.acceptanceProbability).toBe("number");
        expect(r.acceptanceProbability.toFixed(2)).toMatch(/^0\.\d\d$/);
        expect(r.recommendation).toBe("suppress");
    });

    it("midnight is midnight, not noon", async () => {
        const seen: string[] = [];
        await scoreProactiveAction(llm("SCORE: 5", seen), "x", { hourOfDay: 0 });
        expect(seen[0]).toContain("Time: 0:00");
    });
});
