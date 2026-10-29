// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Models served from Bhai's Azure AI Foundry resource: xAI Grok (unhinged mode,
// an 18+ owner opt-in) and any deployment named as "azure/<deployment>" (the
// CAPTCHA solver's models). The client's request is already OpenAI
// chat-completion format, which Azure's /openai/v1 endpoint speaks, so it passes
// through with only the fields the model understands. The key lives in Convex
// env (AZURE_GROK_API_KEY / AZURE_GROK_ENDPOINT, one resource) and never reaches
// the client.

export function isGrokModel(id: unknown): boolean {
  return /^xai\/grok/i.test(String(id ?? ""));
}

export function isAzureModel(id: unknown): boolean {
  return isGrokModel(id) || /^azure\//i.test(String(id ?? ""));
}

/** The Azure deployment for a client model ID. */
export function azureDeployment(id: string): string {
  return isGrokModel(id) ? process.env.AZURE_GROK_MODEL || "grok-4.7" : id.replace(/^azure\//i, "");
}

const PASS = ["tools", "tool_choice", "temperature", "top_p", "stop", "response_format"] as const;

function cleanContent(content: any): any {
  if (!Array.isArray(content)) return content;
  return content
    .map((p: any) =>
      p?.type === "text"
        ? { type: "text", text: p.text ?? "" }
        : p?.type === "image_url"
         ? { type: "image_url", image_url: p.image_url }
         : null,
    )
    .filter(Boolean);
}

/** The Azure request body: Bhai's messages, tools and sampling, low reasoning. */
export function toGrokRequest(body: any, messages: any[], model: string): Record<string, unknown> {
  // GPT reasoning models take max_completion_tokens and reject sampling knobs.
  const gpt = /^(gpt|o\d)/i.test(model);
  // gpt-4.x / 4o don't reason and reject reasoning_effort.
  const reasons = /^(gpt-[5-9]|o\d|grok)/i.test(model);
  const out: Record<string, unknown> = {
    model,
    // Both reason before answering; low keeps a reply near 10s.
    ...(reasons && { reasoning_effort: "low" }),
    // Reasoning tokens count against the cap, so a small client cap would cut
    // the visible reply short.
    [gpt ? "max_completion_tokens" : "max_tokens"]: Math.max(
      Number(body.max_tokens ?? body.max_completion_tokens) || 0,
      4000,
    ),
    messages: messages.map((m: any) => {
      const msg: Record<string, unknown> = { role: m.role, content: cleanContent(m.content) ?? "" };
      if (m.name) msg.name = m.name;
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      return msg;
    }),
  };
  for (const k of PASS)
    if (body[k] !== undefined && !(gpt && (k === "temperature" || k === "top_p"))) out[k] = body[k];
  return out;
}

/** Calls the Azure model, or returns null (caller falls back to Claude) on any failure. */
export async function callAzure(body: any, messages: any[]): Promise<any | null> {
  const key = process.env.AZURE_GROK_API_KEY;
  const endpoint = process.env.AZURE_GROK_ENDPOINT;
  if (!key || !endpoint) return null;
  try {
    const r = await fetch(`${endpoint.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(toGrokRequest(body, messages, azureDeployment(String(body.model)))),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await r.json().catch(() => null);
    if (r.ok && Array.isArray(data?.choices) && data.choices.length) return data;
    console.error(
      `[HTTP Proxy] Azure ${body.model} error ${r.status}:`,
      JSON.stringify(data?.error ?? data).slice(0, 300),
    );
  } catch (err) {
    console.error(`[HTTP Proxy] Azure ${body.model} request failed:`, (err as Error).message);
  }
  return null;
}
