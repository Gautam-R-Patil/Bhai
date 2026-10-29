// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Unhinged mode (an 18+ owner opt-in) runs on xAI Grok through Azure AI
// Foundry. The client's request is already OpenAI chat-completion format, which
// Azure's /openai/v1 endpoint speaks, so it passes through with only the fields
// Grok understands. The key lives in Convex env (AZURE_GROK_API_KEY) and never
// reaches the client.

export function isGrokModel(id: unknown): boolean {
  return /^xai\/grok/i.test(String(id ?? ""));
}

const PASS = ["tools", "tool_choice", "temperature", "top_p", "stop", "response_format"] as const;

function cleanContent(content: any): any {
  if (!Array.isArray(content)) return content;
  return content
    .map((p: any) =>
      p?.type === "text" ? { type: "text", text: p.text ?? "" } : p?.type === "image_url" ? { type: "image_url", image_url: p.image_url } : null,
    )
    .filter(Boolean);
}

/** The Azure request body: Bhai's messages, tools and sampling, low reasoning. */
export function toGrokRequest(body: any, messages: any[], model: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    model,
    // Grok reasons before answering; low keeps a chat reply near 10s.
    reasoning_effort: "low",
    // Reasoning tokens count against the cap, so a small client cap would cut
    // the visible reply short.
    max_tokens: Math.max(Number(body.max_tokens ?? body.max_completion_tokens) || 0, 4000),
    messages: messages.map((m: any) => {
      const msg: Record<string, unknown> = { role: m.role, content: cleanContent(m.content) ?? "" };
      if (m.name) msg.name = m.name;
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      return msg;
    }),
  };
  for (const k of PASS) if (body[k] !== undefined) out[k] = body[k];
  return out;
}

/** Calls Grok, or returns null (caller falls back to Claude) on any failure. */
export async function callGrok(body: any, messages: any[]): Promise<any | null> {
  const key = process.env.AZURE_GROK_API_KEY;
  const endpoint = process.env.AZURE_GROK_ENDPOINT;
  if (!key || !endpoint) return null;
  try {
    const r = await fetch(`${endpoint.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(toGrokRequest(body, messages, process.env.AZURE_GROK_MODEL || "grok-4.7")),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await r.json().catch(() => null);
    if (r.ok && Array.isArray(data?.choices) && data.choices.length) return data;
    console.error(`[HTTP Proxy] Grok error ${r.status}:`, JSON.stringify(data?.error ?? data).slice(0, 300));
  } catch (err) {
    console.error("[HTTP Proxy] Grok request failed:", (err as Error).message);
  }
  return null;
}
