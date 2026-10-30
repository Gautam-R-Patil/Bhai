// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { getCreditCost } from "./credit_cost";
import { azureDeployment, azureTimeoutMs, isAzureModel, isGrokModel, toGrokRequest } from "./grok";

describe("grok passthrough (unhinged mode)", () => {
    it("only the xai/grok id goes to Grok; billing and fallback are Sonnet's", () => {
        expect(isGrokModel("xai/grok-4.7")).toBe(true);
        expect(isGrokModel("anthropic/claude-haiku-4.5")).toBe(false);
        expect(getCreditCost("xai/grok-4.7")).toBe(1);
    });

    it("keeps messages and tools, drops Claude-only fields, leaves room for reasoning", () => {
        const body = {
            model: "xai/grok-4.7",
            max_tokens: 512,
            reasoning: { effort: "none" },
            tools: [{ type: "function", function: { name: "request_tools" } }],
        };
        const msgs = [
            { role: "system", content: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }] },
            {
                role: "assistant",
                content: "",
                tool_calls: [{ id: "1", type: "function", function: { name: "x", arguments: "{}" } }],
            },
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

    it("sends azure/<deployment> to Azure with GPT's token field and no sampling knobs", () => {
        expect(isAzureModel("azure/gpt-6-luna")).toBe(true);
        expect(isAzureModel("openai/gpt-5-mini")).toBe(false);
        expect(azureDeployment("azure/gpt-6-luna")).toBe("gpt-6-luna");
        expect(getCreditCost("azure/gpt-6-luna")).toBe(1);
        const r = toGrokRequest(
            { model: "azure/gpt-6-luna", temperature: 0.2, max_tokens: 300 },
            [],
            "gpt-6-luna",
        ) as any;
        expect(r).toMatchObject({ model: "gpt-6-luna", max_completion_tokens: 4000, reasoning_effort: "low" });
        expect(r.max_tokens).toBeUndefined();
        expect(r.temperature).toBeUndefined();
        expect((toGrokRequest({}, [], "gpt-4.1") as any).reasoning_effort).toBeUndefined();
    });

    it("asks for the client's reasoning effort, in each family's own terms", () => {
        const tools = [{ type: "function", function: { name: "x" } }];
        const effort = (model: string, body: any) => (toGrokRequest(body, [], model) as any).reasoning_effort;
        // GPT-6 takes function tools on chat completions only with reasoning off.
        expect(effort("gpt-6.1-terra", { reasoning: { effort: "medium" }, tools })).toBe("none");
        expect(effort("gpt-6.1-terra", { reasoning: { effort: "medium" } })).toBe("medium");
        expect(effort("gpt-5-mini", { reasoning: { effort: "none" }, tools })).toBe("minimal");
        expect(effort("gpt-5-mini", { reasoning: { effort: "max" } })).toBe("high");
        expect(effort("grok-4.7", { reasoning: { effort: "high" } })).toBe("low");
    });

    it("leaves room for the Claude fallback inside the client's attempt", () => {
        expect(azureTimeoutMs({ attemptTimeoutMs: 25_000 })).toBeLessThan(12_500);
        expect(azureTimeoutMs({ reasoning: { effort: "medium" } })).toBeLessThan(30_000); // no deadline sent: sized by effort
        expect(azureTimeoutMs({ attemptTimeoutMs: 8_000 })).toBe(5_000); // never below 5s
    });

    it("moves screenshots out of tool results (Azure takes images only from the user)", () => {
        const img = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
        const msgs = [
            { role: "assistant", content: "", tool_calls: [{ id: "1" }, { id: "2" }] },
            { role: "tool", tool_call_id: "1", content: [{ type: "text", text: "clicked" }, img] },
            { role: "tool", tool_call_id: "2", content: "ok" },
            { role: "assistant", content: "done" },
        ];
        const out = (toGrokRequest({}, msgs, "gpt-4.1-nano") as any).messages;
        expect(out.map((m: any) => m.role)).toEqual(["assistant", "tool", "tool", "user", "assistant"]);
        expect(out[1].content).toEqual([{ type: "text", text: "clicked" }]);
        expect(out[3].content[1]).toEqual(img);
    });

    it("keeps the output cap inside a small deployment's limit", () => {
        expect((toGrokRequest({ max_tokens: 32_768 }, [], "gpt-4o-mini") as any).max_completion_tokens).toBe(16_384);
    });

    it("the router's cheap Azure arms bill like Haiku, GPT-6 like Sonnet", () => {
        for (const m of ["azure/gpt-4.1-nano", "azure/gpt-4o-mini", "azure/gpt-5-mini"]) expect(getCreditCost(m)).toBe(0.25);
        expect(getCreditCost("azure/gpt-6.1-terra")).toBe(1);
    });
});
