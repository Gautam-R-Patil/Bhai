// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Translates the client's OpenAI-format chat requests (previously forwarded to
// OpenRouter) into Claude Messages API calls, and Claude's reply back into the
// OpenAI chat-completion shape the client already parses.

import type * as Beta from "@anthropic-ai/sdk/resources/beta/messages/messages";

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";

// The client still routes by OpenRouter ids across vendors. Keep its tiering:
// heavy → Opus, light/cheap → Haiku, everything else → Sonnet.
export function toClaudeModel(id: unknown): string {
  const m = String(id ?? "").toLowerCase();
  if (m.includes("opus")) return OPUS;
  if (/haiku|nano|mini|micro|lite|flash/.test(m)) return HAIKU;
  return SONNET;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p: any) => (typeof p === "string" ? p : p?.type === "text" ? p.text ?? "" : ""))
    .join("");
}

function dataUrl(url: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return m ? { mediaType: m[1], data: m[2] } : null;
}

function toBlocks(content: any): Beta.BetaContentBlockParam[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: Beta.BetaContentBlockParam[] = [];
  for (const p of content) {
    if (typeof p === "string") {
      if (p) blocks.push({ type: "text", text: p });
    } else if (p?.type === "text") {
      if (p.text) blocks.push({ type: "text", text: p.text });
    } else if (p?.type === "image_url") {
      const url: string = typeof p.image_url === "string" ? p.image_url : p.image_url?.url ?? "";
      const d = dataUrl(url);
      if (d) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: d.mediaType as any, data: d.data },
        });
      } else if (url) {
        blocks.push({ type: "image", source: { type: "url", url } });
      }
    } else if (p?.type === "file") {
      const d = dataUrl(p.file?.file_data ?? "");
      if (d?.mediaType === "application/pdf") {
        blocks.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: d.data },
        });
      }
    }
  }
  return blocks;
}

function parseArgs(args: unknown): Record<string, unknown> {
  if (args && typeof args === "object") return args as Record<string, unknown>;
  try {
    const v = JSON.parse(String(args ?? "{}"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// `chat` is the OpenAI-format conversation after the server has injected its
// system prompt as the first message.
export function toClaudeRequest(body: any, chat: any[]): Beta.MessageCreateParamsNonStreaming {
  const model = toClaudeModel(body.model);
  const system: Beta.BetaTextBlockParam[] = [];
  const messages: Beta.BetaMessageParam[] = [];

  for (const msg of chat) {
    if (msg?.role === "system" || msg?.role === "developer") {
      const t = textOf(msg.content);
      if (t) system.push({ type: "text", text: t });
    } else if (msg?.role === "assistant") {
      const content: Beta.BetaContentBlockParam[] = toBlocks(msg.content);
      for (const tc of msg.tool_calls ?? []) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function?.name,
          input: parseArgs(tc.function?.arguments),
        });
      }
      if (content.length) messages.push({ role: "assistant", content });
    } else if (msg?.role === "tool") {
      const result: Beta.BetaToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: textOf(msg.content) || "(empty)",
      };
      // All results for one assistant turn go back in a single user message.
      const last = messages[messages.length - 1];
      if (
        last?.role === "user" &&
        Array.isArray(last.content) &&
        last.content.every((b) => b.type === "tool_result")
      ) {
        last.content.push(result);
      } else {
        messages.push({ role: "user", content: [result] });
      }
    } else {
      const content = toBlocks(msg?.content);
      if (content.length) messages.push({ role: "user", content });
    }
  }

  const tools: Beta.BetaTool[] | undefined = Array.isArray(body.tools)
    ? body.tools
        .filter((t: any) => t?.type === "function" && t.function?.name)
        .map((t: any) => ({
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters ?? { type: "object", properties: {} },
        }))
    : undefined;

  const output_config: Beta.BetaOutputConfig = {};
  const effort = body.reasoning?.effort;
  if (EFFORTS.includes(effort)) output_config.effort = effort as Effort;
  const schema = body.response_format?.json_schema?.schema;
  if (body.response_format?.type === "json_schema" && schema && !tools?.length) {
    output_config.format = { type: "json_schema", schema };
  }

  const params: Beta.MessageCreateParamsNonStreaming = {
    model,
    // Thinking is always on for these models and counts against max_tokens,
    // so leave room even when the client asked for a short answer.
    max_tokens: Math.max(Number(body.max_tokens) || 16000, 8192),
    messages,
    // Auto-cache the growing conversation; the explicit breakpoint below keeps
    // tools + the byte-stable server prompt cached even when the client's
    // per-request context (clock, widgets) in the next system block changes.
    cache_control: { type: "ephemeral" },
  };
  if (system.length) {
    system[0].cache_control = { type: "ephemeral" };
    params.system = system;
  }
  if (tools?.length) params.tools = tools;
  if (Object.keys(output_config).length) params.output_config = output_config;
  // Opus/Sonnet 5.5 re-run a declined request on Anthropic's recommended
  // fallback; Haiku has no server-side fallback.
  if (model !== HAIKU) {
    params.fallbacks = "default";
    params.betas = ["server-side-fallback-2026-07-01"];
  }
  return params;
}

const FINISH: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  pause_turn: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  refusal: "content_filter",
};

export function toOpenAIResponse(msg: Beta.BetaMessage) {
  const text = msg.content
    .filter((b): b is Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const tool_calls = msg.content
    .filter((b): b is Beta.BetaToolUseBlock => b.type === "tool_use")
    .map((b) => ({
      id: b.id,
      type: "function" as const,
      function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
    }));
  const u = msg.usage;
  const cached = u.cache_read_input_tokens ?? 0;
  const prompt = u.input_tokens + cached + (u.cache_creation_input_tokens ?? 0);
  return {
    id: msg.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: msg.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || (tool_calls.length ? null : ""),
          ...(tool_calls.length ? { tool_calls } : {}),
        },
        finish_reason: FINISH[msg.stop_reason ?? ""] ?? "stop",
      },
    ],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: u.output_tokens,
      total_tokens: prompt + u.output_tokens,
      prompt_tokens_details: { cached_tokens: cached },
    },
  };
}
