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

/**
 * The reasoning effort for an Azure reasoning model, from the client's effort
 * (none/low/medium/high/xhigh/max). Grok stays at low (~10s replies). GPT-6 takes
 * function tools on chat completions only with reasoning off. GPT-5's lowest is
 * "minimal".
 */
export function azureEffort(model: string, body: any): string | undefined {
  if (/^grok/i.test(model)) return "low";
  const asked = String(body?.reasoning?.effort ?? "low");
  if (/^gpt-6/i.test(model) && Array.isArray(body?.tools) && body.tools.length) return "none";
  const level = asked === "none" ? "none" : asked === "xhigh" || asked === "max" ? "high" : asked;
  if (/^gpt-5/i.test(model) && level === "none") return "minimal";
  return ["none", "low", "medium", "high"].includes(level) ? level : "low";
}

/**
 * Azure's share of the client's attempt (body.attemptTimeoutMs, src/llm.ts): under half, so
 * the Claude fallback still fits before the client gives up and the call isn't paid twice.
 */
export function azureTimeoutMs(body: any): number {
  return Math.max(5_000, Math.floor(clientAttemptMs(body) * 0.45));
}

/** The client's per-attempt deadline, from the request or its effort (as src/llm.ts sizes it). */
export function clientAttemptMs(body: any): number {
  const sent = Number(body?.attemptTimeoutMs);
  if (sent > 0) return sent;
  const effort = String(body?.reasoning?.effort ?? "low");
  return effort === "medium" ? 60_000 : effort === "high" ? 120_000 : effort === "xhigh" || effort === "max" ? 180_000 : 25_000;
}

const OUTPUT_CAP: Record<string, number> = { "gpt-4o-mini": 16_384, "gpt-4.1-nano": 32_768 };

/**
 * Azure takes images only in user messages: a screenshot in a tool result is a 400 (and the
 * request falls back to Claude). Keep each tool result's text where it is and show its images
 * in one user message after that run of tool results (they must stay together).
 */
export function liftToolImages(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let images: unknown[] = [];
  const flush = () => {
    if (images.length)
      out.push({ role: "user", content: [{ type: "text", text: "Images from the tool results above:" }, ...images] });
    images = [];
  };
  for (const m of messages) {
    if (m.role !== "tool") flush();
    if (m.role === "tool" && Array.isArray(m.content)) {
      const parts = m.content as { type?: string }[];
      images.push(...parts.filter((p) => p.type === "image_url"));
      const text = parts.filter((p) => p.type !== "image_url");
      out.push({ ...m, content: text.length ? text : "(image below)" });
    } else out.push(m);
  }
  flush();
  return out;
}

/** The Azure request body: Bhai's messages, tools and sampling, at the asked-for reasoning. */
export function toGrokRequest(body: any, messages: any[], model: string): Record<string, unknown> {
  // GPT reasoning models take max_completion_tokens and reject sampling knobs.
  const gpt = /^(gpt|o\d)/i.test(model);
  // gpt-4.x / 4o don't reason and reject reasoning_effort.
  const reasons = /^(gpt-[5-9]|o\d|grok)/i.test(model);
  const effort = azureEffort(model, body);
  // Output caps of the small deployments: asking for more is a 400 (then a silent Claude fallback).
  const cap = OUTPUT_CAP[model.toLowerCase()] ?? Number.POSITIVE_INFINITY;
  const out: Record<string, unknown> = {
    model,
    ...(reasons && effort && { reasoning_effort: effort }),
    // Reasoning tokens count against the cap, so a small client cap would cut
    // the visible reply short.
    [gpt ? "max_completion_tokens" : "max_tokens"]: Math.min(
      cap,
      Math.max(Number(body.max_tokens ?? body.max_completion_tokens) || 0, 4000),
    ),
    messages: liftToolImages(
      messages.map((m: any) => {
        const msg: Record<string, unknown> = { role: m.role, content: cleanContent(m.content) ?? "" };
        if (m.name) msg.name = m.name;
        if (m.tool_calls) msg.tool_calls = m.tool_calls;
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        return msg;
      }),
    ),
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
      signal: AbortSignal.timeout(azureTimeoutMs(body)),
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
