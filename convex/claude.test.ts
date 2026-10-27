import { describe, expect, it } from "vitest";
import { toClaudeModel, toClaudeRequest, toOpenAIResponse } from "./claude";

describe("toClaudeModel", () => {
  it("keeps the client's tiering", () => {
    expect(toClaudeModel("anthropic/claude-opus-4.6")).toBe("claude-opus-5-5");
    expect(toClaudeModel("openai/gpt-5-nano")).toBe("claude-haiku-5-5");
    expect(toClaudeModel("google/gemini-2.5-flash")).toBe("claude-haiku-5-5");
    expect(toClaudeModel("anthropic/claude-sonnet-4.6")).toBe("claude-sonnet-5-5");
    expect(toClaudeModel("deepseek/deepseek-v4-pro")).toBe("claude-sonnet-5-5");
  });
});

describe("toClaudeRequest", () => {
  const chat = [
    { role: "system", content: "SERVER PROMPT" },
    { role: "system", content: "clock: 10:00" },
    {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "t1", type: "function", function: { name: "a", arguments: '{"x":1}' } },
        { id: "t2", type: "function", function: { name: "b", arguments: "not json" } },
      ],
    },
    { role: "tool", tool_call_id: "t1", content: "r1" },
    { role: "tool", tool_call_id: "t2", content: "" },
  ];
  const body = {
    model: "anthropic/claude-sonnet-4.6",
    max_tokens: 200,
    reasoning: { effort: "low" },
    tools: [{ type: "function", function: { name: "a", description: "A", parameters: { type: "object" } } }],
  };
  const req = toClaudeRequest(body, chat) as any;

  it("hoists system messages and caches the stable server prompt", () => {
    expect(req.system).toEqual([
      { type: "text", text: "SERVER PROMPT", cache_control: { type: "ephemeral" } },
      { type: "text", text: "clock: 10:00" },
    ]);
  });

  it("converts images, tool calls and merges parallel tool results", () => {
    expect(req.messages[0].content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
    expect(req.messages[1].content).toEqual([
      { type: "tool_use", id: "t1", name: "a", input: { x: 1 } },
      { type: "tool_use", id: "t2", name: "b", input: {} },
    ]);
    expect(req.messages).toHaveLength(3);
    expect(req.messages[2].content.map((b: any) => b.tool_use_id)).toEqual(["t1", "t2"]);
    expect(req.messages[2].content[1].content).toBe("(empty)");
  });

  it("maps tools, effort, max_tokens and fallbacks", () => {
    expect(req.model).toBe("claude-sonnet-5-5");
    expect(req.tools).toEqual([{ name: "a", description: "A", input_schema: { type: "object" } }]);
    expect(req.output_config).toEqual({ effort: "low" });
    expect(req.max_tokens).toBe(8192);
    expect(req.fallbacks).toBe("default");
    expect(toClaudeRequest({ model: "openai/gpt-5-nano" }, chat).fallbacks).toBeUndefined();
  });
});

describe("toOpenAIResponse", () => {
  it("returns the OpenAI chat-completion shape", () => {
    const out = toOpenAIResponse({
      id: "msg_1",
      model: "claude-sonnet-5-5",
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "", signature: "s" },
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "t1", name: "a", input: { x: 1 } },
      ],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 },
    } as any);
    expect(out.choices[0]).toEqual({
      index: 0,
      message: {
        role: "assistant",
        content: "Let me check.",
        tool_calls: [{ id: "t1", type: "function", function: { name: "a", arguments: '{"x":1}' } }],
      },
      finish_reason: "tool_calls",
    });
    expect(out.usage).toMatchObject({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 90 } });
  });
});
