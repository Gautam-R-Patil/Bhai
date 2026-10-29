// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it, vi } from "vitest";

vi.mock("./account-guard.js", async (orig) => ({
    ...(await orig<typeof import("./account-guard.js")>()),
    checkAccountStatus: async () => ({ allowed: true }),
}));

import { getConversationHistory, runAgent, setConversationHistory } from "./agent.js";
import type { ChatCompletionMessageParam, LLMClient } from "./llm.js";

const llm = {
    chat: async () => ({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }),
} as unknown as LLMClient;

describe("background prune vs. hard cap", () => {
    it("a turn that ends above the 200-message cap still gets pruned next turn", async () => {
        const big: ChatCompletionMessageParam[] = [];
        for (let i = 0; i < 105; i++) big.push({ role: "user", content: `q${i}` }, { role: "assistant", content: `a${i}` });
        setConversationHistory(big); // 210 messages
        await runAgent(llm, "first"); // ends > 200, schedules the prune
        await runAgent(llm, "second"); // must apply it, not cap and drop it
        const h = getConversationHistory();
        expect(h.length).toBeLessThan(60);
        expect(String(h[0].content)).toContain("[Previous conversation summary]");
    }, 60_000);
});
