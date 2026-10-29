// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { getCreditCost } from "./credit_cost";
import { isGrokModel, toGrokRequest } from "./grok";

describe("grok passthrough (unhinged mode)", () => {
    it("only the xai/grok id goes to Grok; billing and fallback are Sonnet's", () => {
        expect(isGrokModel("xai/grok-4.7")).toBe(true);
        expect(isGrokModel("anthropic/claude-haiku-4.5")).toBe(false);
        expect(getCreditCost("xai/grok-4.7")).toBe(1);
    });

    it("keeps messages and tools, drops Claude-only fields, leaves room for reasoning", () => {
        const body = { model: "xai/grok-4.7", max_tokens: 512, reasoning: { effort: "none" }, tools: [{ type: "function", function: { name: "request_tools" } }] };
        const msgs = [
            { role: "system", content: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }] },
            { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "x", arguments: "{}" } }] },
            { role: "tool", tool_call_id: "1", content: "ok" },
        ];
        const r = toGrokRequest(body, msgs, "grok-4.7") as any;
        expect(r).toMatchObject({ model: "grok-4.7", reasoning_effort: "low", tools: body.tools });
        expect(r.max_tokens).toBe(4000);
        expect(r.reasoning).toBeUndefined();
        expect(r.messages[0].content).toEqual([{ type: "text", text: "sys" }]);
        expect(r.messages[1].tool_calls).toHaveLength(1);
        expect(r.messages[2].tool_call_id).toBe("1");
    });
});
