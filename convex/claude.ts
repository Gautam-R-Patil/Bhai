// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Translates the client's OpenAI-format chat requests (previously forwarded to
// OpenRouter) into Claude Messages API calls, and Claude's reply back into the
// OpenAI chat-completion shape the client already parses.

import type * as Beta from "@anthropic-ai/sdk/resources/beta/messages/messages";

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";

// The client still routes by OpenRouter ids across vendors. Keep its tiering:
// heavy → Opus, light/cheap → Haiku, everything else → Sonnet. Size words must
// be whole id segments, so "gemini-3.1-pro" isn't read as "mini".
export function toClaudeModel(id: unknown): string {
  const m = String(id ?? "").toLowerCase();
  if (m.includes("opus")) return OPUS;
  if (/(^|[/._:-])(haiku|nano|mini|micro|lite|flash|flash-lite)([/._:-]|$)/.test(m)) return HAIKU;
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

  let pendingReminder = "";
  // Leading system messages after the first (the client's per-request context:
  // clock, language, memory) change every call. Sent with the latest turn
  // instead, so the system prompt and conversation history stay cacheable.
  const tailReminders: string[] = [];
  for (const msg of chat) {
    if (msg?.role === "system" || msg?.role === "developer") {
      const t = textOf(msg.content);
      if (!t) continue;
      if (!messages.length) {
        if (!system.length) system.push({ type: "text", text: t });
        else tailReminders.push(t);
      } else {
        const reminder = `<system-reminder>\n${t}\n</system-reminder>`;
        const last = messages[messages.length - 1];
        // Append to the latest user turn (after any tool results); otherwise
        // carry it into the next user turn.
        if (last.role === "user" && Array.isArray(last.content)) last.content.push({ type: "text", text: reminder });
        else pendingReminder += (pendingReminder ? "\n" : "") + reminder;
      }
      continue;
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
      const parts = toBlocks(msg.content).filter(
        (b): b is Beta.BetaTextBlockParam | Beta.BetaImageBlockParam => b.type === "text" || b.type === "image",
      );
      const result: Beta.BetaToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: parts.length ? parts : "(empty)",
      };
      // All results for one assistant turn go back in a single user message,
      // tool results first and any reminders after them.
      const last = messages[messages.length - 1];
      if (last?.role === "user" && Array.isArray(last.content) && last.content[0]?.type === "tool_result") {
        const firstOther = last.content.findIndex((b) => b.type !== "tool_result");
        last.content.splice(firstOther === -1 ? last.content.length : firstOther, 0, result);
      } else {
        messages.push({ role: "user", content: [result] });
      }
      if (pendingReminder) {
        (messages[messages.length - 1].content as Beta.BetaContentBlockParam[]).push({ type: "text", text: pendingReminder });
        pendingReminder = "";
      }
    } else {
      const content = toBlocks(msg?.content);
      if (pendingReminder) {
        content.push({ type: "text", text: pendingReminder });
        pendingReminder = "";
      }
      if (content.length) messages.push({ role: "user", content });
    }
  }
  if (pendingReminder) messages.push({ role: "user", content: [{ type: "text", text: pendingReminder }] });
  if (tailReminders.length) {
    const block = { type: "text" as const, text: `<system-reminder>\n${tailReminders.join("\n\n")}\n</system-reminder>` };
    const last = messages[messages.length - 1];
    if (last?.role === "user" && Array.isArray(last.content)) last.content.push(block);
    else messages.push({ role: "user", content: [block] });
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
  // "none"/"minimal" mean no thinking: Haiku 5.5 accepts thinking "disabled"
  // and Sonnet 5.5 "between_tools" (both at effort high or below); Opus 5.5
  // can't turn thinking off, so it just gets the lowest effort.
  const raw = body.reasoning?.effort;
  const thinkingOff = raw === "minimal" || raw === "none";
  const effort = thinkingOff ? "low" : raw;
  if (EFFORTS.includes(effort)) output_config.effort = effort as Effort;
  const schema = body.response_format?.json_schema?.schema;
  if (body.response_format?.type === "json_schema" && schema && !tools?.length) {
    output_config.format = { type: "json_schema", schema };
  }

  const params: Beta.MessageCreateParamsNonStreaming = {
    model,
    // Thinking is always on for these models and counts against max_tokens,
    // so leave room even when the client asked for a short answer.
    // Billed per call, so the size per call is capped: an unbounded max_tokens let one
    // free-tier credit buy a huge Opus generation.
    max_tokens: Math.min(Math.max(Number(body.max_tokens) || 16000, 8192), 32_000),
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
  if (thinkingOff && model === HAIKU) params.thinking = { type: "disabled" };
  if (thinkingOff && model === SONNET) params.thinking = { type: "between_tools" };
  // Opus/Sonnet 5.5 re-run a declined request on Anthropic's recommended
  // fallback; Haiku has no server-side fallback.
  if (model !== HAIKU) {
    params.fallbacks = "default";
    params.betas = ["server-side-fallback-2026-07-01"];
  }
  // Opus/Sonnet 5.5 run adaptive thinking by default but return it omitted;
  // "updates" makes the short progress notes readable. Set on every main-loop
  // call, streamed or not, so the prompt-cache prefix stays the same.
  if (model !== HAIKU && body.lean !== true && !thinkingOff) {
    params.thinking = { type: "adaptive", display: "updates" };
    params.betas = [...(params.betas ?? []), "thinking-display-updates-2026-08-18"];
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
  // Tool calls from a declined attempt must never run: those before the last
  // fallback block, and any half-built call on a refusal.
  const lastFallback = msg.content.findLastIndex((b) => b.type === "fallback");
  const tool_calls = msg.content
    .filter((b, i): b is Beta.BetaToolUseBlock => b.type === "tool_use" && i > lastFallback && msg.stop_reason !== "refusal")
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
