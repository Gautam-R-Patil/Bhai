import { describe, expect, it } from "vitest";
import { toClaudeModel, toClaudeRequest, toOpenAIResponse } from "./claude";

describe("toClaudeModel", () => {
  it("keeps the client's tiering", () => {
    expect(toClaudeModel("anthropic/claude-opus-4.6")).toBe("claude-opus-5-5");
    expect(toClaudeModel("openai/gpt-5-nano")).toBe("claude-haiku-5-5");
    expect(toClaudeModel("google/gemini-2.5-flash")).toBe("claude-haiku-5-5");
    expect(toClaudeModel("anthropic/claude-sonnet-4.6")).toBe("claude-sonnet-5-5");
    expect(toClaudeModel("deepseek/deepseek-v4-pro")).toBe("claude-sonnet-5-5");
    // "gemini" contains "mini" — must not be mistaken for a small model
    expect(toClaudeModel("google/gemini-3.1-pro-preview-customtools")).toBe("claude-sonnet-5-5");
    expect(toClaudeModel("google/gemini-3.1-flash-lite-preview")).toBe("claude-haiku-5-5");
    expect(toClaudeModel("openai/gpt-5-mini")).toBe("claude-haiku-5-5");
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

  it("caches only the stable server prompt and sends per-request context with the latest turn", () => {
    expect(req.system).toEqual([{ type: "text", text: "SERVER PROMPT", cache_control: { type: "ephemeral" } }]);
    const last = req.messages[req.messages.length - 1];
    expect(last.content[last.content.length - 1].text).toContain("clock: 10:00");
    expect(req.messages[0].content.some((b: any) => b.text?.includes("clock"))).toBe(false);
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
    expect(req.messages[2].content.filter((b: any) => b.type === "tool_result").map((b: any) => b.tool_use_id)).toEqual(["t1", "t2"]);
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

describe("toClaudeRequest — mid-conversation system messages and tool images", () => {
  const chat = [
    { role: "system", content: "SERVER PROMPT" },
    { role: "user", content: "take a screenshot" },
    { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "shot", arguments: "{}" } }] },
    { role: "system", content: "nudge: be brief" },
    {
      role: "tool",
      tool_call_id: "t1",
      content: [
        { type: "text", text: "captured" },
        { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
      ],
    },
    { role: "system", content: "plan hint" },
  ];
  const req = toClaudeRequest({ model: "anthropic/claude-sonnet-4.6", reasoning: { effort: "minimal" } }, chat) as any;

  it("keeps only leading system messages in the cached system prompt", () => {
    expect(req.system.map((b: any) => b.text)).toEqual(["SERVER PROMPT"]);
  });

  it("delivers later system messages as reminders after the tool results", () => {
    const last = req.messages[req.messages.length - 1];
    expect(last.role).toBe("user");
    expect(last.content[0].type).toBe("tool_result");
    const reminders = last.content.slice(1).map((b: any) => b.text).join("\n");
    expect(reminders).toContain("nudge: be brief");
    expect(reminders).toContain("plan hint");
  });

  it("passes screenshots inside tool results to Claude", () => {
    const result = req.messages[2].content[0];
    expect(result.content).toEqual([
      { type: "text", text: "captured" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "BBBB" } },
    ]);
  });

  it("maps minimal effort to low", () => {
    expect(req.output_config).toEqual({ effort: "low" });
  });
});

describe("toClaudeRequest — thinking off", () => {
  const chat = [{ role: "user", content: "hi" }];
  const off = (model: string) => toClaudeRequest({ model, reasoning: { effort: "none" } }, chat) as any;
  it("disables thinking on Haiku, between_tools on Sonnet, and only lowers effort on Opus", () => {
    expect(off("openai/gpt-4.1-nano").thinking).toEqual({ type: "disabled" });
    expect(off("anthropic/claude-sonnet-4.6").thinking).toEqual({ type: "between_tools" });
    expect(off("anthropic/claude-opus-4.6").thinking).toBeUndefined();
    for (const m of ["openai/gpt-4.1-nano", "anthropic/claude-sonnet-4.6", "anthropic/claude-opus-4.6"]) {
      expect(off(m).output_config).toEqual({ effort: "low" });
    }
  });
  it("leaves thinking on for a normal effort", () => {
    expect((toClaudeRequest({ model: "openai/gpt-4.1-nano", reasoning: { effort: "low" } }, chat) as any).thinking).toBeUndefined();
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

  const usage = { input_tokens: 1, output_tokens: 1 };

  it("drops tool calls made before a server-side fallback", () => {
    const out = toOpenAIResponse({
      id: "msg_2",
      model: "claude-sonnet-5-5",
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "Let me " },
        { type: "tool_use", id: "t1", name: "shell_exec", input: {} },
        { type: "fallback" },
        { type: "text", text: "check that." },
        { type: "tool_use", id: "t2", name: "read_file", input: {} },
      ],
      usage,
    } as any);
    const msg = out.choices[0].message as any;
    expect(msg.tool_calls.map((c: any) => c.id)).toEqual(["t2"]);
    expect(msg.content).toBe("Let me check that.");
  });

  it("returns no tool calls on a refusal", () => {
    const out = toOpenAIResponse({
      id: "msg_3",
      model: "claude-sonnet-5-5",
      stop_reason: "refusal",
      content: [
        { type: "text", text: "I can't" },
        { type: "tool_use", id: "t1", name: "a", input: {} },
      ],
      usage,
    } as any);
    const msg = out.choices[0].message as any;
    expect(msg.tool_calls ?? []).toEqual([]);
    expect(out.choices[0].finish_reason).toBe("content_filter");
  });
});
