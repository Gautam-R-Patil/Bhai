// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Convex HTTP Actions — server-side API key proxy for Bhai.
// ALL API keys (OpenRouter, etc.) live here as Convex env vars. Never sent to client.

import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import Anthropic from "@anthropic-ai/sdk";
import { toClaudeRequest, toOpenAIResponse } from "./claude";
import { callGrok, isGrokModel } from "./grok";
import { decodeBase64, STT_CREDIT_COST, STT_MAX_AUDIO_BYTES, sttConfigFromEnv, transcribeWithProvider } from "./stt";
import {
  generateServerKeyPair,
  deriveSharedKey,
  encryptResponse,
  decryptRequest,
  validateTimestamp,
  KDF_VERSION_LATEST,
  SUPPORTED_KDF_VERSIONS,
  type EncryptedEnvelope,
} from "./crypto.js";

const http = httpRouter();

// ── Timing-safe string comparison (prevents timing attacks on key validation) ──
function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ── E2E Encryption Helpers ──────────────────────

/**
 * Parse request body, decrypting if E2E encryption is active.
 */
// In-memory sliding-window rid dedup. Convex hosts run as isolates, so
// state is per-isolate, not cluster-wide; a determined attacker who can
// route their replay to a different isolate could still get one extra
// shot. Convex ought to be moving to its own request-deduping layer in
// the future; until then this catches the bulk of accidental and naive
// replays. Entries auto-expire after RID_TTL_MS (matches the timestamp
// window) so the map can't grow unbounded.
const RID_TTL_MS = 90_000;
const seenRids = new Map<string, number>();

function checkAndRecordRid(rid: string): boolean {
  if (typeof rid !== "string" || rid.length === 0) return false;
  const now = Date.now();
  // Lazy GC: prune anything older than TTL on every Nth call to keep the
  // map small without paying GC cost on every request.
  if (seenRids.size > 1024) {
    for (const [k, ts] of seenRids) {
      if (now - ts > RID_TTL_MS) seenRids.delete(k);
    }
  }
  const prev = seenRids.get(rid);
  if (prev !== undefined && now - prev < RID_TTL_MS) return false;
  seenRids.set(rid, now);
  return true;
}

/**
 * Compute the AAD a given request envelope is bound to. Mirrors
 * src/crypto-transport.ts::buildAAD on the client. If the client did
 * not bind AAD (legacy clients pre-rollout), pass `legacy=true` and the
 * server will retry decryption with no AAD as a one-time fallback.
 */
function buildEnvelopeAad(method: string, urlPath: string, ts: number, rid: string): Uint8Array {
  return new TextEncoder().encode(`${method.toUpperCase()}|${urlPath}|${ts}|${rid}`);
}

// WeakMap that lets `buildResponse` learn whether `parseRequestBody` had to
// fall back to a no-AAD decrypt (i.e. the client is a legacy v1 build that
// doesn't bind AAD on requests). Without this, asymmetric AAD on responses
// would break legacy clients while we roll the v2 transport out. The map is
// keyed by the immutable Request object the runtime hands to each httpAction.
const _legacyAadByRequest = new WeakMap<Request, true>();

async function parseRequestBody(
  request: Request,
  sharedKey: string | null,
): Promise<{ body: any; encrypted: boolean; legacyAad: boolean }> {
  const isEncrypted = request.headers.get("X-Encryption") === "ecdh-aes-256-gcm";

  if (isEncrypted && sharedKey) {
    const envelope = (await request.json()) as EncryptedEnvelope;

    // Replay protection: time window + rid dedup. The window catches
    // long-replay attempts; rid dedup catches in-window duplicates that
    // would otherwise bill credits twice (cf. /api/llm/chat).
    if (!validateTimestamp(envelope.ts)) {
      throw new Error("Request expired (replay protection)");
    }
    if (!checkAndRecordRid(envelope.rid)) {
      throw new Error("Request rid already seen (replay rejected)");
    }

    const url = new URL(request.url);
    const aad = buildEnvelopeAad(request.method, url.pathname, envelope.ts, envelope.rid);
    let plaintext: string;
    let legacyAad = false;
    try {
      plaintext = await decryptRequest(envelope, sharedKey, aad);
    } catch (err) {
      // One-time legacy fallback: if the client didn't bind AAD, the
      // tag check fails. Retry without AAD so pre-rollout sessions keep
      // working until they refresh. Marked so the response path also
      // skips AAD — otherwise legacy clients can encrypt up but not
      // decrypt down. Logged so we can phase out.
      console.warn("[E2E] AAD-bound decryption failed, retrying legacy mode:", (err as Error).message);
      plaintext = await decryptRequest(envelope, sharedKey);
      legacyAad = true;
      _legacyAadByRequest.set(request, true);
    }
    return { body: JSON.parse(plaintext), encrypted: true, legacyAad };
  }

  // Unencrypted fallback
  return { body: await request.json(), encrypted: false, legacyAad: false };
}

/**
 * Build response, encrypting if the request was encrypted.
 *
 * AAD parity with the request: when `request` is supplied AND the client did
 * NOT use the legacy no-AAD fallback, we bind `${method}|${pathname}|ts|rid`
 * into the GCM tag. Clients verify the same on receive. Legacy v1 clients
 * (no request AAD) are auto-detected via the `_legacyAadByRequest` weakmap
 * and the response also ships AAD-less, matching what they can decrypt.
 */
async function buildResponse(
  data: any,
  status: number,
  encrypted: boolean,
  sharedKey: string | null,
  request?: Request,
): Promise<Response> {
  if (encrypted && sharedKey) {
    let aadBuilder: ((ts: number, rid: string) => string) | undefined;
    const isLegacy = request ? _legacyAadByRequest.get(request) === true : false;
    if (request && !isLegacy) {
      const url = new URL(request.url);
      const method = request.method.toUpperCase();
      aadBuilder = (ts, rid) => `${method}|${url.pathname}|${ts}|${rid}`;
    }
    const envelope = await encryptResponse(JSON.stringify(data), sharedKey, aadBuilder);
    return new Response(JSON.stringify(envelope), {
      status,
      headers: {
        "Content-Type": "application/json",
        "X-Encryption": "ecdh-aes-256-gcm",
      },
    });
  }

  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Credit cost table + lookup live in ./credit-cost.ts so the tier
// mapping is unit-testable without a Convex harness.
import { getCreditCost } from "./credit_cost.js";
import { AUTH_LOGIN_HTML, isHandoffNonce, isHandoffToken } from "./otpless.js";

// ── Waitlist helpers (per-IP rate limit + CORS + hCaptcha verify) ─────────
// Isolated subsystem — no coupling to session/credit machinery. Lives next
// to the existing in-memory rid-dedup map for symmetry; isolate-local
// counters are fine here because the rate limit is a politeness gate
// against accidental floods, not a security boundary (hCaptcha is).
const WAITLIST_IP_WINDOW_MS = 10 * 60_000;
const WAITLIST_IP_MAX = 5;
const waitlistIpHits = new Map<string, { count: number; windowStart: number }>();

function checkWaitlistIpRateLimit(ip: string): boolean {
  if (!ip || ip === "unknown") return true; // can't rate-limit what we can't identify
  const now = Date.now();
  const existing = waitlistIpHits.get(ip);
  if (waitlistIpHits.size > 1024) {
    for (const [k, v] of waitlistIpHits) {
      if (now - v.windowStart > WAITLIST_IP_WINDOW_MS) waitlistIpHits.delete(k);
    }
  }
  if (!existing || now - existing.windowStart > WAITLIST_IP_WINDOW_MS) {
    waitlistIpHits.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (existing.count >= WAITLIST_IP_MAX) return false;
  existing.count++;
  return true;
}

const WAITLIST_ALLOWED_ORIGIN = "https://tryatlasagi.com";

function waitlistCorsHeaders(origin: string | null): Record<string, string> {
  const allow = origin === WAITLIST_ALLOWED_ORIGIN ? origin : WAITLIST_ALLOWED_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

// In-memory dedup for hCaptcha tokens. Tokens are nominally single-use on
// hCaptcha's side but they accept replays within a small grace window; this
// closes that window on our side. Per-isolate state — fine for politeness,
// not relied on as a primary security boundary (that's hCaptcha itself).
const HCAPTCHA_TOKEN_TTL_MS = 2 * 60 * 1000;
const seenHcaptchaTokens = new Map<string, number>();

function checkAndRecordHcaptchaToken(token: string): boolean {
  if (!token) return false;
  const now = Date.now();
  if (seenHcaptchaTokens.size > 1024) {
    for (const [k, ts] of seenHcaptchaTokens) {
      if (now - ts > HCAPTCHA_TOKEN_TTL_MS) seenHcaptchaTokens.delete(k);
    }
  }
  const prev = seenHcaptchaTokens.get(token);
  if (prev !== undefined && now - prev < HCAPTCHA_TOKEN_TTL_MS) return false;
  seenHcaptchaTokens.set(token, now);
  return true;
}

async function verifyHCaptcha(token: string, remoteIp?: string): Promise<boolean> {
  const secret = process.env.HCAPTCHA_SECRET;
  // Fail-closed: if the secret isn't configured, reject everything. Loud
  // failure (every submit returns 403) is preferable to silent insecurity.
  if (!secret) {
    console.warn("[waitlist] HCAPTCHA_SECRET not set — submissions will fail until configured");
    return false;
  }
  // Refuse already-seen tokens server-side. hCaptcha invalidates tokens
  // post-verify, but cluster timing / network grace lets the same token slip
  // through more than once in rapid succession.
  if (!checkAndRecordHcaptchaToken(token)) {
    console.warn("[waitlist] hCaptcha token replay rejected");
    return false;
  }
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.append("remoteip", remoteIp);
  // Pin sitekey if configured so a token issued for a different site won't pass.
  const sitekey = process.env.HCAPTCHA_SITEKEY;
  if (sitekey) body.append("sitekey", sitekey);
  try {
    const resp = await fetch("https://api.hcaptcha.com/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const data: any = await resp.json().catch(() => null);
    if (!data?.success) return false;
    // Bind to our hostname so a token solved against a third-party hCaptcha
    // site can't be replayed here. WAITLIST_HOSTNAME defaults to the public
    // domain but is overridable via env for staging.
    const expectedHostname = process.env.WAITLIST_HOSTNAME || "tryatlasagi.com";
    if (data.hostname && data.hostname !== expectedHostname) {
      console.warn(
        `[waitlist] hCaptcha hostname mismatch: got '${data.hostname}', expected '${expectedHostname}'`,
      );
      return false;
    }
    return true;
  } catch (err: any) {
    console.error("[waitlist] hCaptcha verify network error:", err?.message);
    return false;
  }
}

function extractClientIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0].trim() ||
    request.headers.get("X-Real-IP") ||
    "unknown"
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Helper: extract + validate session token ──
async function validateRequest(
  ctx: any,
  request: Request
): Promise<{
  account: {
    otplessUserId: string;
    accountId: any;
    status: string;
    plan: string;
    ai_credits: number;
    sharedKey: string | null;
  };
} | Response> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const token = authHeader.slice(7);
  const account = await ctx.runQuery(internal.sessions.validateSessionInternal, { token });

  if (!account) {
    return new Response(JSON.stringify({ error: "Invalid or expired session" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (account.status !== "active") {
    return new Response(
      JSON.stringify({ error: `Account is ${account.status}` }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  // Rate limiting: 60 requests per 60-second window per session
  const rateCheck = await ctx.runMutation(internal.sessions.checkRateLimit, { token });
  if (rateCheck.limited) {
    return new Response(
      JSON.stringify({ error: "Rate limit exceeded. Please retry after a short wait." }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "60",
        },
      }
    );
  }

  return { account };
}

// ── Helper: validate admin API key ───────────────
async function validateAdminRequest(request: Request): Promise<Response | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(
      JSON.stringify({ error: "Missing Authorization header" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    return new Response(
      JSON.stringify({ error: "Admin API not configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!timingSafeCompare(authHeader.slice(7), adminKey)) {
    return new Response(
      JSON.stringify({ error: "Invalid admin API key" }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  return null; // Valid
}

// ══════════════════════════════════════════════════════════════════════════
// POST /api/llm/chat — LLM Proxy
// Client sends chat request with metadata (platform, skillSlugs).
// Server assembles system prompt from DB, injects it, then forwards to OpenRouter.
// Credits deducted atomically after successful response.
// ══════════════════════════════════════════════════════════════════════════

http.route({
  path: "/api/llm/chat",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // 1. Validate session
    const validation = await validateRequest(ctx, request);
    if (validation instanceof Response) return validation;
    const { account } = validation;

    // Start the latency clock AFTER auth so we measure the LLM round-trip,
    // not session validation. logCall() captures the row to llm_call_log
    // and (on failure) to error_log; both run best-effort so they never
    // block or change the response.
    const callStartedAt = Date.now();
    const logCall = async (params: {
      model: string;
      status: "success" | "failed" | "rejected";
      credits?: number;
      errorMessage?: string;
      errorType?: string;
      inputTokens?: number;
      outputTokens?: number;
      cachedTokens?: number;
      hasMedia?: boolean;
    }) => {
      const latencyMs = Date.now() - callStartedAt;
      try {
        await ctx.runMutation(internal.llmCallLog.record, {
          accountId: account.accountId,
          otplessUserId: account.otplessUserId,
          model: params.model,
          status: params.status,
          credits: params.credits ?? 0,
          latencyMs,
          inputTokens: params.inputTokens,
          outputTokens: params.outputTokens,
          cachedTokens: params.cachedTokens,
          errorMessage: params.errorMessage,
          hasMedia: params.hasMedia,
        });
      } catch (err) {
        console.warn("[HTTP Proxy] llm_call_log insert failed:", (err as Error).message);
      }
      if (params.status !== "success") {
        try {
          await ctx.runMutation(internal.errorLog.record, {
            source: "llm_proxy",
            type: params.errorType ?? `llm_${params.status}`,
            message: params.errorMessage ?? `LLM call ${params.status}`,
            metadata: JSON.stringify({
              model: params.model,
              latencyMs,
              credits: params.credits ?? 0,
            }),
            accountId: account.accountId,
            otplessUserId: account.otplessUserId,
            severity: params.status === "failed" ? "error" : "warning",
          });
        } catch (err) {
          console.warn("[HTTP Proxy] error_log insert failed:", (err as Error).message);
        }
      }
    };

    // 2. Check credits
    if (account.ai_credits <= 0) {
      await logCall({
        model: "unknown",
        status: "rejected",
        errorType: "insufficient_credits_fastpath",
        errorMessage: "Account has 0 credits",
      });
      return new Response(
        JSON.stringify({ error: "Insufficient credits" }),
        { status: 402, headers: { "Content-Type": "application/json" } }
      );
    }

    // 3. Parse client request (with E2E decryption if active)
    let body: any;
    let isEncrypted = false;
    try {
      const parsed = await parseRequestBody(request, account.sharedKey);
      body = parsed.body;
      isEncrypted = parsed.encrypted;
    } catch (err: any) {
      await logCall({
        model: "unknown",
        status: "failed",
        errorType: "bad_request_body",
        errorMessage: err?.message ?? "Invalid request body",
      });
      return new Response(
        JSON.stringify({ error: err.message || "Invalid request body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const model = body.model || "anthropic/claude-sonnet-4.6";

    // Detect whether the request payload contains image/media parts so the
    // logs page can filter to multimodal calls. Best-effort: looks for
    // `content` arrays whose blocks carry an `image` or `image_url` type.
    const hasMedia = Array.isArray(body.messages) && body.messages.some((m: any) =>
      Array.isArray(m?.content) &&
      m.content.some((b: any) => b && (b.type === "image" || b.type === "image_url")),
    );

    // 3b. Atomic PRE-deduction — Convex mutations are serializable, so N
    //     concurrent requests with low balance no longer all pass the
    //     pre-check and reach OpenRouter; only the ones whose deduction
    //     wins do. Refunded below on OpenRouter error or fetch exception.
    const cost = getCreditCost(model);
    let creditsDeducted = false;
    const preDeduct = await ctx.runMutation(internal.accounts.deductCreditsInternal, {
      otplessUserId: account.otplessUserId,
      amount: cost,
    });
    if (!preDeduct || !preDeduct.success) {
      await logCall({
        model: String(model),
        status: "rejected",
        errorType: preDeduct?.error ?? "insufficient_credits",
        errorMessage: `cost=${cost} available=${preDeduct?.remaining ?? account.ai_credits}`,
        hasMedia,
      });
      return new Response(
        JSON.stringify({
          error: "Insufficient credits",
          required: cost,
          available: preDeduct?.remaining ?? account.ai_credits,
        }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      );
    }
    creditsDeducted = true;

    const refundIfDeducted = async (reason: string) => {
      if (!creditsDeducted) return;
      creditsDeducted = false;
      try {
        await ctx.runMutation(internal.accounts.addCreditsInternal, {
          id: account.accountId,
          amount: cost,
        });
      } catch (err) {
        console.error(
          `[HTTP Proxy] REFUND FAILED for user=${account.otplessUserId} cost=${cost} reason=${reason}:`,
          err,
        );
        try {
          await ctx.runMutation(internal.errorLog.record, {
            source: "llm_proxy",
            type: "credit_refund_failed",
            message: `Refund of ${cost} credits failed: ${(err as Error).message}`,
            metadata: JSON.stringify({ model, cost, reason }),
            accountId: account.accountId,
            otplessUserId: account.otplessUserId,
            severity: "error",
          });
        } catch { /* best effort */ }
      }
    };

    // 4. Get Anthropic API key from Convex env (NEVER leaves server)
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      console.error("[HTTP Proxy] ANTHROPIC_API_KEY not set in Convex environment");
      await refundIfDeducted("missing_anthropic_key");
      await logCall({
        model: String(model),
        status: "failed",
        errorType: "missing_anthropic_key",
        errorMessage: "ANTHROPIC_API_KEY not set",
        hasMedia,
      });
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // 5. Assemble system prompt
    //    If client sends systemPromptOverride, use it directly (for sub-agents, classifiers, etc.)
    //    Otherwise, build from server DB using platform + skillSlugs.
    const messages = Array.isArray(body.messages) ? [...body.messages] : [];

    // A lean call (classifier, HyDE, memory briefing) can't act — it carries no
    // tools — so the agent's safety rules are dead weight there (~4.8K tokens
    // per call). Any call with tools still gets them.
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const skipRules = body.lean === true && !hasTools;

    if (body.systemPromptOverride && typeof body.systemPromptOverride === "string") {
      // Client-specified override: sub-agents, JSON planners, and classifiers
      // still want the narrow task-specific prompt — but we always prepend the
      // server-side `rules` slug so core safety rails are non-overridable even
      // by an authenticated client (unless the call is lean and tool-less, see
      // above). If the rules slug is missing (fresh seed state) we fall through
      // without it rather than blocking the call.
      let safetyRules = "";
      if (!skipRules) try {
        const rulesPrompt = await ctx.runQuery(
          internal.systemContent.getPromptBySlug,
          { slug: "rules" },
        );
        if (rulesPrompt && typeof rulesPrompt.content === "string") {
          safetyRules = rulesPrompt.content;
        }
      } catch { /* missing rules slug — proceed without */ }

      const composed = safetyRules
        ? `${safetyRules}\n\n${body.systemPromptOverride}`
        : body.systemPromptOverride;

      if (messages.length > 0 && messages[0].role === "system") {
        messages[0] = {
          ...messages[0],
          content: composed + "\n\n" + (messages[0].content || ""),
        };
      } else {
        messages.unshift({ role: "system", content: composed });
      }
    } else {
      // Normal path: assemble system prompt from server DB
      const platform = body.platform || "linux";
      const skillSlugs: string[] = Array.isArray(body.skillSlugs) ? body.skillSlugs : [];

      try {
        // A named base prompt (e.g. "orchestrator-base" for the planner) replaces
        // the full identity stack, with the safety rules still in front.
        const slug = typeof body.serverPromptSlug === "string" && /^[a-z0-9-]{1,40}$/.test(body.serverPromptSlug)
          ? body.serverPromptSlug
          : "";
        let serverPrompt: string | null = null;
        if (slug) {
          // Unhinged runs real tool turns too, so it also gets the platform rules.
          const platformSlug = slug !== "unhinged" ? null : body.platform === "mac" ? "rules-mac" : body.platform === "win" ? "rules-windows" : null;
          const [rules, base, platformRules] = await Promise.all([
            ctx.runQuery(internal.systemContent.getPromptBySlug, { slug: "rules" }),
            ctx.runQuery(internal.systemContent.getPromptBySlug, { slug }),
            platformSlug ? ctx.runQuery(internal.systemContent.getPromptBySlug, { slug: platformSlug }) : null,
          ]);
          if (base && typeof base.content === "string") {
            const parts = [rules?.content, platformRules?.content, base.content].filter((c): c is string => typeof c === "string");
            serverPrompt = parts.join("\n\n");
          }
        }
        if (!serverPrompt) serverPrompt = await ctx.runQuery(
          internal.systemContent.assembleSystemPrompt,
          {
            platform,
            skillSlugs,
            userId: account.otplessUserId,
          }
        );

        if (serverPrompt) {
          // Keep the static server prompt as its OWN first system message so the
          // prompt-cache breakpoint (added below, on messages[0]) covers a
          // byte-stable prefix. Do NOT concatenate the client's dynamic context
          // (SYSTEM CLOCK timestamp, widgets) into it — that volatile content
          // changes every request and would bust the cache on every call,
          // which is exactly what kept the cache hit-rate at 0%. The client's
          // dynamic system message stays as a SEPARATE block right after.
          messages.unshift({ role: "system", content: serverPrompt });

          // Record that this user's active addenda were exercised, so the
          // nightly staleness sweep can retire never-used ones. Opt-in via the
          // ATLAS_ADDENDA_HITS deployment env var; fire-and-forget, never blocks
          // or fails the request. (The assembler is a read-only query and can't
          // mutate, so the hit-bump happens here in the action.)
          if (process.env.ATLAS_ADDENDA_HITS === "true" && account.otplessUserId) {
            ctx
              .runMutation(internal.userAddenda.incrementActiveAddendaHits, {
                otplessUserId: account.otplessUserId,
              })
              .catch(() => {});
          }
        }
      } catch (err: any) {
        // Non-fatal: if prompt assembly fails, proceed without server prompt
        console.error("[HTTP Proxy] System prompt assembly failed:", err.message);
      }
    }

    // 6. Translate the OpenAI-format request into a Claude Messages call
    //    (prompt caching breakpoints are placed by the translator).
    const claudeParams = toClaudeRequest(body, messages);

    // 7. Call Claude (or Grok for unhinged mode, falling back to Claude Sonnet)
    try {
      const anthropic = new Anthropic({ apiKey: anthropicKey });
      let responseData = isGrokModel(model) ? await callGrok(body, messages) : null;
      if (!responseData) try {
        const message = await anthropic.beta.messages.stream(claudeParams).finalMessage();
        responseData = toOpenAIResponse(message);
      } catch (err) {
        // 8. If Claude returned an error, refund the pre-deduction and pass
        //    it through. Credits were already taken atomically at 3b, so
        //    the refund must run before returning.
        if (!(err instanceof Anthropic.APIError) || !err.status) throw err;
        const snippet = JSON.stringify(err.error ?? err.message).slice(0, 500);
        console.error(`[HTTP Proxy] Claude error ${err.status} for ${model}:`, snippet);
        await refundIfDeducted(`anthropic_${err.status}`);
        await logCall({
          model: String(model),
          status: "failed",
          errorType: `anthropic_${err.status}`,
          errorMessage: snippet,
          hasMedia,
        });
        return new Response(JSON.stringify(err.error ?? { error: err.message }), {
          status: err.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      // 9. Credits were already deducted atomically at step 3b before the
      //    fetch — the response is on the success path so we keep the
      //    deduction. No post-call deduction needed.

      // 9b. Bump per-model usage counter for the admin dashboard.
      //     Best-effort — never blocks or fails the LLM response.
      try {
        await ctx.runMutation(internal.llmUsage.incrementModelUsage, {
          model: String(model),
          credits: cost,
        });
      } catch (err) {
        console.warn("[HTTP Proxy] usage counter bump failed:", (err as Error).message);
      }

      // 9c. Per-call audit row. Pulled out of the response payload so we
      //     don't keep prompts/responses — just token totals + latency.
      const usage = responseData?.usage ?? {};
      const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
      await logCall({
        model: String(model),
        status: "success",
        credits: cost,
        inputTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
        outputTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined,
        cachedTokens: typeof cachedTokens === "number" ? cachedTokens : undefined,
        hasMedia,
      });

      // 10. Return the response (encrypted if client uses E2E)
      return await buildResponse(responseData, 200, isEncrypted, account.sharedKey, request);
    } catch (err: any) {
      console.error("[HTTP Proxy] Claude request failed:", err.message);
      await refundIfDeducted("anthropic_network");
      await logCall({
        model: String(model),
        status: "failed",
        errorType: "anthropic_network",
        errorMessage: err?.message ?? "Claude request threw",
        hasMedia,
      });
      return new Response(
        JSON.stringify({ error: "LLM service temporarily unavailable" }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// POST /api/stt — voice-note transcription (convex/stt.ts). Body (E2E):
// { audio: base64, mimeType, filename }. 503 when no STT provider is set.
// ══════════════════════════════════════════════════════════════════════════

http.route({
  path: "/api/stt",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const validation = await validateRequest(ctx, request);
    if (validation instanceof Response) return validation;
    const { account } = validation;

    const cfg = sttConfigFromEnv(process.env);
    if (!cfg) return buildResponse({ error: "stt_not_configured" }, 503, false, null);

    let body: any;
    let isEncrypted = false;
    try {
      const parsed = await parseRequestBody(request, account.sharedKey);
      body = parsed.body;
      isEncrypted = parsed.encrypted;
    } catch (err: any) {
      return buildResponse({ error: err?.message || "Invalid request body" }, 400, false, null);
    }
    const reply = (data: unknown, status: number) =>
      buildResponse(data, status, isEncrypted, account.sharedKey, request);

    if (typeof body?.audio !== "string" || !body.audio) return reply({ error: "audio required" }, 400);
    let audio: Uint8Array<ArrayBuffer>;
    try {
      audio = decodeBase64(body.audio);
    } catch {
      return reply({ error: "audio must be base64" }, 400);
    }
    if (audio.length > STT_MAX_AUDIO_BYTES) return reply({ error: "audio too large" }, 413);
    const mimeType = typeof body.mimeType === "string" ? body.mimeType : "audio/ogg";
    const filename = typeof body.filename === "string" ? body.filename.replace(/[^\w.-]/g, "_") : "audio.ogg";

    const deducted = await ctx.runMutation(internal.accounts.deductCreditsInternal, {
      otplessUserId: account.otplessUserId,
      amount: STT_CREDIT_COST,
    });
    if (!deducted?.success) return reply({ error: "Insufficient credits" }, 402);

    const startedAt = Date.now();
    const log = (status: "success" | "failed", errorMessage?: string) =>
      ctx
        .runMutation(internal.llmCallLog.record, {
          accountId: account.accountId,
          otplessUserId: account.otplessUserId,
          model: `stt:${cfg.model}`,
          status,
          credits: status === "success" ? STT_CREDIT_COST : 0,
          latencyMs: Date.now() - startedAt,
          errorMessage,
          hasMedia: true,
        })
        .catch(() => {});
    try {
      const text = await transcribeWithProvider(cfg, audio, mimeType, filename);
      await log("success");
      return reply({ text }, 200);
    } catch (err) {
      const message = (err as Error).message;
      await ctx
        .runMutation(internal.accounts.addCreditsInternal, { id: account.accountId, amount: STT_CREDIT_COST })
        .catch((e: unknown) => console.error("[STT] refund failed:", e));
      await log("failed", message);
      return reply({ error: "transcription failed" }, 502);
    }
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// GET /auth-login — OTPless sign-in page loaded by the desktop auth window
// (page source and the email-link handoff live in otpless.ts).
// ══════════════════════════════════════════════════════════════════════════

http.route({
  path: "/auth-login",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(AUTH_LOGIN_HTML, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }),
});

// POST /api/otpless/handoff — same-origin calls from /auth-login only (no
// CORS headers, so other sites can't read a claimed token).
//   start    { h }         Bhai window registers its nonce
//   complete { h, token }  browser tab opened from the email link parks the token, gets a code to show
//   claim    { h, code? }  Bhai window polls, then sends the code the user typed; returns the token once
http.route({
  path: "/api/otpless/handoff",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    let body: any;
    try { body = await request.json(); } catch { return json(400, { error: "Invalid JSON" }); }
    const { op, h, token, code } = body || {};
    if (!isHandoffNonce(h)) return json(400, { error: "Invalid sign-in request" });

    if (op === "start") {
      // Only `start` inserts rows, so it's the one that needs a flood gate.
      const ip = extractClientIp(request);
      const rl = await ctx.runMutation(internal.sessions.checkRequestRateLimit, {
        key: `otpless_handoff|${ip}`,
        windowMs: 60_000,
        maxRequests: 10,
      });
      if (rl.limited) return json(429, { error: "Rate limit exceeded" });
      await ctx.runMutation(internal.otpless.startHandoff, { nonce: h });
      return json(200, { ok: true });
    }
    if (op === "complete") {
      if (!isHandoffToken(token)) return json(400, { error: "Invalid token" });
      const parked = await ctx.runMutation(internal.otpless.completeHandoff, { nonce: h, token });
      return parked
        ? json(200, parked)
        : json(410, { error: "The Bhai sign-in window was closed, or this link was already used. Open sign-in in Bhai again and request a new link." });
    }
    if (op === "claim") {
      if (code !== undefined && !(typeof code === "string" && /^\d{6}$/.test(code))) return json(400, { error: "Enter the 6-digit code" });
      return json(200, await ctx.runMutation(internal.otpless.claimHandoff, { nonce: h, code }));
    }
    return json(400, { error: "Unknown op" });
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// POST /api/auth/session — Create a new session
// Called after OTPless authentication is verified.
// ══════════════════════════════════════════════════════════════════════════

http.route({
  path: "/api/auth/session",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // Per-IP rate limit BEFORE parsing — cheap shield against unauth flooders.
    const ip = extractClientIp(request);
    const rlKey = `auth_session|${ip}`;
    const rl = await ctx.runMutation(internal.sessions.checkRequestRateLimit, {
      key: rlKey,
      windowMs: 60_000,
      maxRequests: 10,
    });
    if (rl.limited) {
      return new Response(
        JSON.stringify({ error: "Rate limit exceeded" }),
        { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60" } },
      );
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const { otplessUserId, deviceFingerprint, clientPublicKey } = body;
    if (!otplessUserId || typeof otplessUserId !== "string") {
      return new Response(
        JSON.stringify({ error: "otplessUserId is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    try {
      // The account MUST already exist. /api/otpless/validate-token is the
      // only path that creates accounts — it calls OTPless server-side to
      // verify the supplied token before upserting. Without this gate,
      // /api/auth/session was an account-creation primitive: anyone on the
      // internet could pick any otplessUserId, supply email/phone/name, and
      // get a working 24h session that could call the LLM proxy and burn
      // ATLAS-owned provider tokens. We do NOT accept email/phone/name
      // here anymore — those fields are only honored during validate-token.
      const existingAccount = await ctx.runQuery(internal.accounts.getByOtplessIdInternal, {
        otplessUserId,
      });
      if (!existingAccount) {
        return new Response(
          JSON.stringify({
            error: "account_not_validated",
            message: "Validate via POST /api/otpless/validate-token first; /api/auth/session only refreshes ECDH for already-validated identities.",
          }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }

      // E2E Key Exchange: if client sends a public key, perform ECDH
      let serverPublicKey: string | undefined;
      let sharedKey: string | undefined;

      // Select KDF version. Accept the client's requested version if
      // it's one the server supports; otherwise fall back to v1 so
      // pre-rollout clients (no kdfVersion field) keep working.
      const requestedKdf = typeof body.kdfVersion === "number" ? body.kdfVersion : KDF_VERSION_LATEST;
      const kdfVersion = (SUPPORTED_KDF_VERSIONS as readonly number[]).includes(requestedKdf)
        ? requestedKdf
        : KDF_VERSION_LATEST;

      if (clientPublicKey && typeof clientPublicKey === "string") {
        const serverKP = await generateServerKeyPair();
        serverPublicKey = serverKP.publicKey;
        sharedKey = await deriveSharedKey(serverKP.privateKey, clientPublicKey, kdfVersion, serverPublicKey);
        // privateKey is NOT stored — only the derived sharedKey
      }

      const result = await ctx.runMutation(internal.sessions.createSessionInternal, {
        otplessUserId,
        deviceFingerprint: deviceFingerprint || undefined,
        clientPublicKey: clientPublicKey || undefined,
        serverPublicKey,
        sharedKey,
      });

      // Echo the KDF version the server actually used so the client
      // derives with the matching algorithm. Omitted when no client
      // public key was sent (no E2E → no shared key → nothing to match).
      return new Response(
        JSON.stringify({
          ...result,
          ...(sharedKey !== undefined ? { kdfVersion } : {}),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (err: any) {
      const msg = typeof err?.message === "string" ? err.message : "";
      const status = msg.includes("not found") ? 404 : 403;
      return new Response(
        JSON.stringify({ error: "Session creation failed" }),
        { status, headers: { "Content-Type": "application/json" } }
      );
    }
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// GET /api/account/status — Check account status and credits
// ══════════════════════════════════════════════════════════════════════════

http.route({
  path: "/api/account/status",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const validation = await validateRequest(ctx, request);
    if (validation instanceof Response) return validation;
    const { account } = validation;

    return await buildResponse(
      { status: account.status, plan: account.plan, ai_credits: account.ai_credits },
      200,
      request.headers.get("X-Encryption") === "ecdh-aes-256-gcm",
      account.sharedKey,
      request,
    );
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// GET /api/account/info — Full account info (session-authenticated)
// ══════════════════════════════════════════════════════════════════════════

http.route({
  path: "/api/account/info",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const validation = await validateRequest(ctx, request);
    if (validation instanceof Response) return validation;
    const { account } = validation;

    const fullAccount = await ctx.runQuery(internal.accounts.getByOtplessIdInternal, {
      otplessUserId: account.otplessUserId,
    });

    if (!fullAccount) {
      return new Response(
        JSON.stringify({ error: "Account not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    return await buildResponse(
      fullAccount,
      200,
      request.headers.get("X-Encryption") === "ecdh-aes-256-gcm",
      account.sharedKey,
      request,
    );
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// POST /api/auth/refresh — Refresh session token TTL
// ══════════════════════════════════════════════════════════════════════════

http.route({
  path: "/api/auth/refresh",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Missing Authorization header" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.slice(7);
    try {
      const result = await ctx.runMutation(internal.sessions.refreshSessionInternal, { token });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// POST /api/auth/revoke — Revoke current session (logout)
// ══════════════════════════════════════════════════════════════════════════

http.route({
  path: "/api/auth/revoke",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Missing Authorization header" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.slice(7);
    await ctx.runMutation(internal.sessions.revokeSessionInternal, { token });

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// Store proxy — strict allowlists for query and mutation function paths.
// SECURITY: Only explicitly listed function references are permitted.
// Any path not in the allowlist is rejected with 403.
// ══════════════════════════════════════════════════════════════════════════

// USER session-token reachable queries. Anything that returns per-user state,
// developer/admin listings, or submission moderation data MUST NOT be here —
// keep those on ADMIN_STORE_QUERY_ALLOWLIST. F2 moved the admin-only paths
// out of this list to prevent session holders from enumerating developer/
// admin/submission rows through /api/store/query.
const STORE_QUERY_ALLOWLIST: Record<string, any> = {
  // store/items — public catalog
  "store/items:list":            internal.store.items.list,
  "store/items:search":          internal.store.items.search,
  "store/items:getBySlug":       internal.store.items.getBySlug,
  "store/items:getById":         internal.store.items.getById,
  "store/items:getByDeveloper":  internal.store.items.getByDeveloper,
  "store/items:listByDeveloper": internal.store.items.listByDeveloper,
  "store/items:getFeatured":     internal.store.items.getFeatured,
  "store/items:getTrending":     internal.store.items.getTrending,
  "store/items:getCategories":   internal.store.items.getCategories,
  // store/reviews — public read except per-user; per-user paths are
  // rewritten by USER_BOUND_PATHS so callers can only see their own.
  "store/reviews:getByItem":     internal.store.reviews.getByItem,
  "store/reviews:getUserReview": internal.store.reviews.getUserReview,
  "store/reviews:getSummary":    internal.store.reviews.getSummary,
  "store/reviews:getByUser":     internal.store.reviews.getByUser,
  // store/installs — per-user paths rewritten by USER_BOUND_PATHS so the
  // session caller can only read their own install state. getInstallCount
  // is item-keyed and returns a count, not user data.
  "store/installs:getByUser":       internal.store.installs.getByUser,
  "store/installs:isInstalled":     internal.store.installs.isInstalled,
  "store/installs:get":             internal.store.installs.get,
  "store/installs:checkUpdates":    internal.store.installs.checkUpdates,
  "store/installs:getInstallCount": internal.store.installs.getInstallCount,
  // store/storage — public file URL fetches
  "store/storage:getFileUrl":  internal.store.storage.getFileUrl,
  "store/storage:getFileUrls": internal.store.storage.getFileUrls,
};

// ADMIN-only store queries. Reachable ONLY via /api/admin/store-query
// (ADMIN_API_KEY gated). Listing developers, admins, or submissions, or
// reading a developer/admin by id, must require admin-key reach — a
// session-token holder cannot enumerate or read these.
const ADMIN_STORE_QUERY_ALLOWLIST: Record<string, any> = {
  // All paths the user allowlist exposes (admin panel needs to read the
  // public catalog too).
  ...({
    "store/items:list":            internal.store.items.list,
    "store/items:search":          internal.store.items.search,
    "store/items:getBySlug":       internal.store.items.getBySlug,
    "store/items:getById":         internal.store.items.getById,
    "store/items:getByDeveloper":  internal.store.items.getByDeveloper,
    "store/items:listByDeveloper": internal.store.items.listByDeveloper,
    "store/items:getFeatured":     internal.store.items.getFeatured,
    "store/items:getTrending":     internal.store.items.getTrending,
    "store/items:getCategories":   internal.store.items.getCategories,
    "store/reviews:getByItem":     internal.store.reviews.getByItem,
    "store/reviews:getUserReview": internal.store.reviews.getUserReview,
    "store/reviews:getSummary":    internal.store.reviews.getSummary,
    "store/reviews:getByUser":     internal.store.reviews.getByUser,
    "store/installs:getByUser":       internal.store.installs.getByUser,
    "store/installs:isInstalled":     internal.store.installs.isInstalled,
    "store/installs:get":             internal.store.installs.get,
    "store/installs:checkUpdates":    internal.store.installs.checkUpdates,
    "store/installs:getInstallCount": internal.store.installs.getInstallCount,
    "store/storage:getFileUrl":       internal.store.storage.getFileUrl,
    "store/storage:getFileUrls":      internal.store.storage.getFileUrls,
  }),
  // Developer management — admin only.
  "store/developers:getByEmail":      internal.store.developers.getByEmail,
  "store/developers:getById":         internal.store.developers.getById,
  "store/developers:listByStatus":    internal.store.developers.listByStatus,
  "store/developers:listAll":         internal.store.developers.listAll,
  "store/developers:getStats":        internal.store.developers.getStats,
  "store/developers:getPasswordHash": internal.store.developers.getPasswordHash,
  "store/developers:list":            internal.store.developers.list,
  // Admin management — admin only. getPasswordHash intentionally absent
  // (routed via dedicated /api/admin/auth/get-password-hash).
  "store/admins:getByEmail":        internal.store.admins.getByEmail,
  "store/admins:getById":           internal.store.admins.getById,
  "store/admins:listAll":           internal.store.admins.listAll,
  "store/admins:hasPermission":     internal.store.admins.hasPermission,
  "store/admins:getDashboardStats": internal.store.admins.getDashboardStats,
  "store/admins:list":              internal.store.admins.list,
  "store/admins:getActivityLogs":   internal.store.admins.getActivityLogs,
  // Submission moderation — admin only.
  "store/submissions:getById":         internal.store.submissions.getById,
  "store/submissions:list":            internal.store.submissions.list,
  "store/submissions:listByStatus":    internal.store.submissions.listByStatus,
  "store/submissions:getPendingCount": internal.store.submissions.getPendingCount,
  "store/submissions:getByDeveloper":  internal.store.submissions.getByDeveloper,
  "store/submissions:listByDeveloper": internal.store.submissions.listByDeveloper,
  "store/submissions:listPending":     internal.store.submissions.listPending,
};

// Mutations reachable by a holder of a USER SESSION TOKEN (the desktop app /
// bot). Restricted to operations a regular Bhai end-user legitimately
// performs as themselves against the store (install/uninstall, submit review,
// register a developer profile). Anything that could escalate privilege
// (creating admins/developers, approving submissions, banning developers,
// promoting items) lives in `ADMIN_STORE_MUTATION_ALLOWLIST` below.
//
// ⚠ KEY INVARIANT: every mutation in this list either (a) takes NO foreign
// identifier from the caller, or (b) the Convex mutation handler itself binds
// the operation to `args.user`/`args.developerId` after deriving identity
// from a server-controlled source. Listing a mutation here that accepts a
// raw `developerId`/`adminId` would let any session-token holder act as any
// other developer/admin — see commit history for the developer-credential
// takeover vector this list explicitly avoids.
//
// `developers:changePassword`, `developers:updateProfile`, and the
// `submissions:create|resubmit|cancel` mutations were REMOVED from this list
// because they accept an attacker-supplied `developerId`. The developer
// portal (portals/developer-portal/) must use its own session-bound server
// route that re-derives the developerId from the developer's JWT — those
// mutations must NOT be exposed on the generic session-proxy.
const USER_STORE_MUTATION_ALLOWLIST: Record<string, any> = {
  // Reviews — end-user submits + edits their own review. Convex handler
  // binds by `args.user` (the otplessUserId) → safe.
  "store/reviews:submit":      internal.store.reviews.submit,
  "store/reviews:remove":      internal.store.reviews.remove,
  "store/reviews:markHelpful": internal.store.reviews.markHelpful,

  // Installs — end-user manages their own install state. Convex handlers
  // bind by `args.user` → safe.
  "store/installs:startInstall":      internal.store.installs.startInstall,
  "store/installs:confirmInstall":    internal.store.installs.confirmInstall,
  "store/installs:uninstall":         internal.store.installs.uninstall,
  "store/installs:updateVersion":     internal.store.installs.updateVersion,
  "store/installs:setAutoUpdate":     internal.store.installs.setAutoUpdate,
  "store/installs:getUpdateDownload": internal.store.installs.getUpdateDownload,

  // Developer registration — first-time sign-up; the handler refuses if the
  // email already has a developer row, so it can't overwrite anyone.
  "store/developers:register": internal.store.developers.register,

  // Developer login bookkeeping — recordLogin / updateLastLogin take a
  // developerId but only patch a timestamp. Worst-case abuse is timeline
  // pollution; not a credential or content-affecting mutation.
  "store/developers:recordLogin":     internal.store.developers.recordLogin,
  "store/developers:updateLastLogin": internal.store.developers.updateLastLogin,
};

// Mutations reachable ONLY by the admin panel (via ADMIN_API_KEY). These are
// the actions that affect other users' state, approve content, or modify the
// admins table itself. The two allowlists are intentionally disjoint — never
// merge them or you re-introduce the round-2 privilege-escalation regression.
const ADMIN_STORE_MUTATION_ALLOWLIST: Record<string, any> = {
  // Admin user management (browser-side bcrypt is BANNED — the dedicated
  // /api/admins/* server routes compute hashes and call these).
  "store/admins:create":          internal.store.admins.create,
  "store/admins:update":          internal.store.admins.update,
  "store/admins:changePassword":  internal.store.admins.changePassword,
  "store/admins:remove":          internal.store.admins.remove,
  "store/admins:deleteAdmin":     internal.store.admins.deleteAdmin,
  "store/admins:recordLogin":     internal.store.admins.recordLogin,
  "store/admins:updateLastLogin": internal.store.admins.updateLastLogin,
  // store/admins:initSuperAdmin is intentionally absent from BOTH lists.
  // It's only reachable via /api/admin/setup-super-admin, whose handler
  // calls the internal mutation directly. The mutation itself refuses if
  // any admin row already exists.

  // Developer review actions.
  "store/developers:approve":   internal.store.developers.approve,
  "store/developers:reject":    internal.store.developers.reject,
  "store/developers:suspend":   internal.store.developers.suspend,
  "store/developers:ban":       internal.store.developers.ban,
  "store/developers:reinstate": internal.store.developers.reinstate,

  // Store item moderation (feature / status changes).
  "store/items:setFeatured": internal.store.items.setFeatured,
  "store/items:updateStatus": internal.store.items.updateStatus,
  // create/update would let an admin impersonate a developer — kept out.
  // System-only counters (incrementInstallCount, updateRating,
  // resetWeeklyInstalls) are intentionally absent; they belong to cron /
  // user-flow paths, not admin actions.

  // Submission moderation.
  "store/submissions:startReview":     internal.store.submissions.startReview,
  "store/submissions:approve":         internal.store.submissions.approve,
  "store/submissions:reject":          internal.store.submissions.reject,
  "store/submissions:requestRevision": internal.store.submissions.requestRevision,

  // Admin-deleted reviews (moderation of user content).
  "store/reviews:adminDelete": internal.store.reviews.adminDelete,

  // Admin-upload + cleanup.
  "store/storage:generateAdminUploadUrl": internal.store.storage.generateAdminUploadUrl,
  "store/storage:deleteFile":             internal.store.storage.deleteFile,
  "store/storage:cleanupOrphanedFiles":   internal.store.storage.cleanupOrphanedFiles,

  // Admin can uninstall on a user's behalf (e.g. removing a banned skill
  // from every installed user). Convex handler still takes args.user, so
  // moderators must pass the target explicitly.
  "store/installs:uninstall": internal.store.installs.uninstall,
};

// Function paths that take a per-user `userId` argument (otplessUserId).
// The HTTP proxy MUST rewrite args.userId to the authenticated identity
// before invoking these — otherwise a session holder can act as any other
// user (IDOR). All other paths leave args alone.
const USER_BOUND_PATHS: Set<string> = new Set([
  // Mutations
  "store/installs:startInstall",
  "store/installs:confirmInstall",
  "store/installs:uninstall",
  "store/installs:updateVersion",
  "store/installs:setAutoUpdate",
  "store/installs:getUpdateDownload",
  "store/reviews:submit",
  "store/reviews:remove",
  // Queries
  "store/installs:getByUser",
  "store/installs:checkUpdates",
  "store/installs:get",
  "store/installs:isInstalled",
  "store/reviews:getUserReview",
  "store/reviews:getByUser",
]);

// ── POST /api/store/query — Proxy Convex store queries via session auth ──

http.route({
  path: "/api/store/query",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const validation = await validateRequest(ctx, request);
    if (validation instanceof Response) return validation;
    const { account } = validation;

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const { functionPath, args } = body;
    if (!functionPath || typeof functionPath !== "string") {
      return new Response(
        JSON.stringify({ error: "functionPath is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const queryRef = STORE_QUERY_ALLOWLIST[functionPath];
    if (!queryRef) {
      return new Response(
        JSON.stringify({ error: "Forbidden: function path not in allowlist" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    const safeArgs = USER_BOUND_PATHS.has(functionPath)
      ? { ...(args || {}), userId: account.otplessUserId }
      : (args || {});

    try {
      const result = await ctx.runQuery(queryRef, safeArgs);
      return new Response(
        JSON.stringify({ status: "success", value: result }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }),
});

// ── POST /api/store/mutation — Proxy Convex store mutations via session auth ──

http.route({
  path: "/api/store/mutation",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const validation = await validateRequest(ctx, request);
    if (validation instanceof Response) return validation;
    const { account } = validation;

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const { functionPath, args } = body;
    if (!functionPath || typeof functionPath !== "string") {
      return new Response(
        JSON.stringify({ error: "functionPath is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

        // ⚠ Session-token route MUST use the USER allowlist, NOT the admin one.
        // The admin allowlist contains privilege-escalating mutations (create
        // admin, approve/ban developers, moderate submissions). Merging the two
        // lets any signed-in Bhai user call those mutations through their
        // normal session.
        const mutationRef = USER_STORE_MUTATION_ALLOWLIST[functionPath];
        if (!mutationRef) {
            return new Response(JSON.stringify({ error: "Forbidden: function path not in allowlist" }), {
                status: 403,
                headers: { "Content-Type": "application/json" },
            });
        }

    // F1: rewrite userId to authenticated identity so a session holder cannot
    // mutate another user's installs/reviews by spoofing args.userId.
    const safeArgs = USER_BOUND_PATHS.has(functionPath)
      ? { ...(args || {}), userId: account.otplessUserId }
      : (args || {});

    try {
      const result = await ctx.runMutation(mutationRef, safeArgs);
      return new Response(
        JSON.stringify({ status: "success", value: result }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// GET /api/system/skill-metadata — Lightweight skill metadata (no instructions)
// Returns slug + categories for tool-router matching on the client.
// ══════════════════════════════════════════════════════════════════════════

http.route({
  path: "/api/system/skill-metadata",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const validation = await validateRequest(ctx, request);
    if (validation instanceof Response) return validation;
    const { account } = validation;

    try {
      const metadata = await ctx.runQuery(
        internal.systemContent.getSkillMetadata,
        { userId: account.otplessUserId }
      );

      return await buildResponse(
        { skills: metadata },
        200,
        request.headers.get("X-Encryption") === "ecdh-aes-256-gcm",
        account.sharedKey,
        request,
      );
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// GET /api/system/prompt?slug=<slug> — Fetch a single system prompt
// Used by client-side subsystems (voice live mode, dream replay) that need
// raw prompt content to assemble their own requests without bundling
// prompts/*.md into the desktop app package. Session-authenticated.
// ══════════════════════════════════════════════════════════════════════════

http.route({
  path: "/api/system/prompt",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const validation = await validateRequest(ctx, request);
    if (validation instanceof Response) return validation;
    const { account } = validation;

    const url = new URL(request.url);
    const slug = url.searchParams.get("slug");
    if (!slug) {
      return new Response(
        JSON.stringify({ error: "slug query parameter is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    try {
      const prompt = await ctx.runQuery(
        internal.systemContent.getPromptBySlug,
        { slug }
      );
      if (!prompt) {
        return new Response(
          JSON.stringify({ error: `Prompt not found: ${slug}` }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }

      return await buildResponse(
        { slug: prompt.slug, content: prompt.content, version: prompt.version },
        200,
        request.headers.get("X-Encryption") === "ecdh-aes-256-gcm",
        account.sharedKey,
        request,
      );
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES — System content management (prompts + skills)
// Authenticated via ADMIN_API_KEY environment variable.
// ══════════════════════════════════════════════════════════════════════════

// ── GET /api/admin/observability/overview — Admin observability panel ──
// These queries expose aggregate account + credit + activity data. Previously
// declared as public `query()` in convex/observability.ts — anyone with the
// Convex URL could `fetch("/api/query", { path: "observability:getObservabilityData" })`
// and read the whole admin dashboard. Now internalQuery + admin-key gated.
http.route({
  path: "/api/admin/observability/overview",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;

    const data = await ctx.runQuery(internal.observability.getObservabilityData, {});
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/api/admin/observability/system-overview",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;
    const data = await ctx.runQuery(internal.observability.getSystemOverview, {});
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// Cheap heartbeat — called frequently by the live dashboard. Returns only the
// numbers the Health badge / error pill / connectivity probe need; the heavy
// overview endpoint stays on a slower cadence.
http.route({
  path: "/api/admin/observability/heartbeat",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;
    const data = await ctx.runQuery(internal.observability.getDashboardHeartbeat, {});
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/api/admin/observability/top-models",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") || 10);
    const models = await ctx.runQuery(internal.llmUsage.getTopModels, {
      limit: Number.isFinite(limit) ? limit : 10,
    });
    return new Response(JSON.stringify({ models }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/api/admin/observability/credit-users",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;

    const users = await ctx.runQuery(internal.observability.getCreditUsagePerUser, {});
    return new Response(JSON.stringify({ users }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ── GET /api/admin/llm-logs — paginated per-call LLM audit log ─────────
// Query params:
//   accountId   v.id("accounts") — drill into one user's calls
//   model       OpenRouter model id — filter to one model
//   status      "success" | "failed" | "rejected"
//   sinceMs     window length (e.g. 86400000 for last 24h)
//   limit       page size (default 50, max 200)
//   cursor      pagination cursor from prior response
http.route({
  path: "/api/admin/llm-logs",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;
    const url = new URL(request.url);
    const args: Record<string, unknown> = {};
    const accountId = url.searchParams.get("accountId");
    if (accountId) args.accountId = accountId;
    const model = url.searchParams.get("model");
    if (model) args.model = model;
    const status = url.searchParams.get("status");
    if (status) args.status = status;
    const sinceMs = Number(url.searchParams.get("sinceMs") || "");
    if (Number.isFinite(sinceMs) && sinceMs > 0) args.sinceMs = sinceMs;
    const limit = Number(url.searchParams.get("limit") || "");
    if (Number.isFinite(limit) && limit > 0) args.limit = limit;
    const cursor = url.searchParams.get("cursor");
    if (cursor) args.cursor = cursor;

    const result = await ctx.runQuery(internal.llmCallLog.listRecent, args);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ── GET /api/admin/llm-logs/stats — latency percentiles + success rate
http.route({
  path: "/api/admin/llm-logs/stats",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;
    const url = new URL(request.url);
    const sinceMs = Number(url.searchParams.get("sinceMs") || "");
    const stats = await ctx.runQuery(internal.llmCallLog.getStats, {
      sinceMs: Number.isFinite(sinceMs) && sinceMs > 0 ? sinceMs : undefined,
    });
    return new Response(JSON.stringify({ stats }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ── GET /api/admin/error-logs — paginated generic error log ────────────
// Query params:
//   source     "llm_proxy" | "auth" | "session" | "waitlist" | "store" | "admin" | "system" | "otpless"
//   severity   "error" | "warning" | "info"
//   sinceMs, limit, cursor — same as llm-logs
http.route({
  path: "/api/admin/error-logs",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;
    const url = new URL(request.url);
    const args: Record<string, unknown> = {};
    const source = url.searchParams.get("source");
    if (source) args.source = source;
    const severity = url.searchParams.get("severity");
    if (severity) args.severity = severity;
    const sinceMs = Number(url.searchParams.get("sinceMs") || "");
    if (Number.isFinite(sinceMs) && sinceMs > 0) args.sinceMs = sinceMs;
    const limit = Number(url.searchParams.get("limit") || "");
    if (Number.isFinite(limit) && limit > 0) args.limit = limit;
    const cursor = url.searchParams.get("cursor");
    if (cursor) args.cursor = cursor;

    const result = await ctx.runQuery(internal.errorLog.listRecent, args);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ── GET /api/admin/prompts — List all system prompts ──────────────────
http.route({
  path: "/api/admin/prompts",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;

    const prompts = await ctx.runQuery(internal.systemContent.getAllPrompts, {});
    return new Response(JSON.stringify({ prompts }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ── POST /api/admin/prompts — Upsert a system prompt ─────────────────
http.route({
  path: "/api/admin/prompts",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const { slug, content, updatedBy } = body;
    if (!slug || !content) {
      return new Response(
        JSON.stringify({ error: "slug and content are required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const result = await ctx.runMutation(internal.systemContent.upsertPrompt, {
      slug,
      content,
      updatedBy: updatedBy || undefined,
    });

    return new Response(JSON.stringify({ success: true, ...result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ── GET /api/admin/skills — List all system skills ────────────────────
http.route({
  path: "/api/admin/skills",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;

    const skills = await ctx.runQuery(internal.systemContent.getAllActiveSkills, {});
    return new Response(JSON.stringify({ skills }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ── POST /api/admin/skills — Upsert a system skill ───────────────────
http.route({
  path: "/api/admin/skills",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const { slug, name, description, instructions, categories, updatedBy } = body;
    if (!slug || !name || !instructions) {
      return new Response(
        JSON.stringify({ error: "slug, name, and instructions are required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const result = await ctx.runMutation(internal.systemContent.upsertSkill, {
      slug,
      name,
      description: description || "",
      instructions,
      categories: categories || [],
      updatedBy: updatedBy || undefined,
    });

    return new Response(JSON.stringify({ success: true, ...result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ── DELETE /api/admin/skills — Delete a system skill ──────────────────
http.route({
  path: "/api/admin/skills",
  method: "DELETE",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const { slug } = body;
    if (!slug) {
      return new Response(
        JSON.stringify({ error: "slug is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    try {
      const result = await ctx.runMutation(internal.systemContent.deleteSkill, { slug });
      return new Response(JSON.stringify({ success: true, ...result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }
  }),
});

// ── PATCH /api/admin/skills/toggle — Toggle skill active status ───────
http.route({
  path: "/api/admin/skills/toggle",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const { slug, isActive, updatedBy } = body;
    if (!slug || typeof isActive !== "boolean") {
      return new Response(
        JSON.stringify({ error: "slug and isActive (boolean) are required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    try {
      const result = await ctx.runMutation(internal.systemContent.toggleSkill, {
        slug,
        isActive,
        updatedBy: updatedBy || undefined,
      });
      return new Response(JSON.stringify({ success: true, ...result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// POST /api/search/tavily — Tavily Search Proxy
// Client sends search query. Server uses Tavily API key to search.
// No credits deducted — search is free tier / already included.
// ══════════════════════════════════════════════════════════════════════════

http.route({
  path: "/api/search/tavily",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const validation = await validateRequest(ctx, request);
    if (validation instanceof Response) return validation;
    const { account } = validation;

    const { body, encrypted } = await parseRequestBody(request, account.sharedKey);
    const { query, search_depth, max_results } = body;

    if (!query) {
      return await buildResponse({ error: "query is required" }, 400, encrypted, account.sharedKey, request);
    }

    const tavilyKey = process.env.TAVILY_API_KEY;
    if (!tavilyKey) {
      return await buildResponse({ error: "Tavily not configured" }, 500, encrypted, account.sharedKey, request);
    }

    try {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: tavilyKey,
          query,
          search_depth: search_depth || "advanced",
          max_results: max_results || 15,
          include_answer: false,
          include_raw_content: false,
        }),
      });

      const data = await response.json();
      return await buildResponse(data, response.ok ? 200 : response.status, encrypted, account.sharedKey, request);
    } catch (err: any) {
      return await buildResponse({ error: err.message }, 500, encrypted, account.sharedKey, request);
    }
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// POST /api/search/claude — web search through Claude's server-side search tool
// Uses the Anthropic key the proxy already has (no Tavily/Exa account needed).
// Billed like one Haiku call, refunded if the search fails.
// ══════════════════════════════════════════════════════════════════════════

http.route({
    path: "/api/search/claude",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
        const validation = await validateRequest(ctx, request);
        if (validation instanceof Response) return validation;
        const { account } = validation;
        const { body, encrypted } = await parseRequestBody(request, account.sharedKey);
        const query = typeof body.query === "string" ? body.query.trim().slice(0, 400) : "";
        if (!query)
            return await buildResponse({ error: "query is required" }, 400, encrypted, account.sharedKey, request);

        const anthropicKey = process.env.ANTHROPIC_API_KEY;
        if (!anthropicKey)
            return await buildResponse({ error: "search not configured" }, 500, encrypted, account.sharedKey, request);

        const cost = getCreditCost("claude-haiku-5-5");
        const deducted = await ctx.runMutation(internal.accounts.deductCreditsInternal, {
            otplessUserId: account.otplessUserId,
            amount: cost,
        });
        if (!deducted || !deducted.success) {
            return await buildResponse({ error: "Insufficient credits" }, 402, encrypted, account.sharedKey, request);
        }

        // Approximate location makes results local ("under 5k" means rupees in India).
        const country = typeof body.country === "string" && /^[A-Z]{2}$/.test(body.country) ? body.country : undefined;
        const city = typeof body.city === "string" ? body.city.slice(0, 80) : undefined;
        const timezone = typeof body.timezone === "string" ? body.timezone.slice(0, 64) : undefined;
        const user_location =
            country || city || timezone ? { type: "approximate" as const, country, city, timezone } : undefined;

        try {
            const anthropic = new Anthropic({ apiKey: anthropicKey });
            const msg = await anthropic.messages.create({
                model: "claude-haiku-5-5",
                max_tokens: 1500,
                tools: [
                    {
                        type: "web_search_20250305",
                        name: "web_search",
                        max_uses: 1,
                        ...(user_location ? { user_location } : {}),
                    },
                ],
                messages: [
                    {
                        role: "user",
                        content: `Search the web for: ${query}\n\nThen, for each useful result, say in one line what that page says that answers the search, citing it.`,
                    },
                ],
            });
            const results: Array<{ url: string; title: string; snippet: string; page_age: string | null }> = [];
            const snippets = new Map<string, string>();
            for (const block of msg.content) {
                if (block.type === "text") {
                    for (const c of block.citations ?? []) {
                        if (c.type === "web_search_result_location" && !snippets.has(c.url))
                            snippets.set(c.url, c.cited_text);
                    }
                }
            }
            for (const block of msg.content) {
                if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
                    for (const r of block.content) {
                        if (r.type === "web_search_result") {
                            results.push({
                                url: r.url,
                                title: r.title,
                                snippet: (snippets.get(r.url) ?? "").slice(0, 300),
                                page_age: r.page_age ?? null,
                            });
                        }
                    }
                }
            }
            return await buildResponse({ query, results }, 200, encrypted, account.sharedKey, request);
        } catch (err: any) {
            try {
                await ctx.runMutation(internal.accounts.addCreditsInternal, { id: account.accountId, amount: cost });
            } catch {
                /* refund best-effort */
            }
            return await buildResponse(
                { error: String(err?.message ?? err).slice(0, 300) },
                502,
                encrypted,
                account.sharedKey,
                request,
            );
        }
    }),
});

// ══════════════════════════════════════════════════════════════════════════
// POST /api/search/exa — Exa Search Proxy
// Client sends search query. Server uses Exa API key to search.
// ══════════════════════════════════════════════════════════════════════════

http.route({
  path: "/api/search/exa",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const validation = await validateRequest(ctx, request);
    if (validation instanceof Response) return validation;
    const { account } = validation;

    const { body, encrypted } = await parseRequestBody(request, account.sharedKey);
    const { query, type, numResults, contents } = body;

    if (!query) {
      return await buildResponse({ error: "query is required" }, 400, encrypted, account.sharedKey, request);
    }

    const exaKey = process.env.EXA_API_KEY;
    if (!exaKey) {
      return await buildResponse({ error: "Exa not configured" }, 500, encrypted, account.sharedKey, request);
    }

    try {
      const response = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: {
          "x-api-key": exaKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          type: type || "auto",
          numResults: numResults || 15,
          contents: contents || { highlights: { maxCharacters: 300 } },
        }),
      });

      const data = await response.json();
      return await buildResponse(data, response.ok ? 200 : response.status, encrypted, account.sharedKey, request);
    } catch (err: any) {
      return await buildResponse({ error: err.message }, 500, encrypted, account.sharedKey, request);
    }
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// GET /api/updates/* — Generic auto-updater endpoint for electron-updater.
//
// Binaries live in an external object store (Cloudflare R2 recommended).
// This endpoint ONLY serves update metadata — it does not proxy the binary.
// The client uses the generic provider; electron-updater fetches the YAML
// here and then downloads the binary from whatever URL is in the YAML.
//
// Channels: the client may append ?channel=beta to the feed URL. When a
// channel is specified, the handler looks for <name>_<CHANNEL> env vars
// and falls back to the unsuffixed vars if the channel-specific ones are
// unset. Default channel is "stable" (no suffix).
//
// Env vars (per channel; replace <C> with STABLE / BETA / CANARY — or
// leave blank for the stable channel):
//   UPDATE_VERSION[_<C>]      — e.g. "0.2.1"
//   UPDATE_URL_MAC[_<C>]      — direct download URL for the macOS .dmg
//   UPDATE_URL_WIN[_<C>]      — direct download URL for the Windows .exe
//   UPDATE_SHA512_MAC[_<C>]   — SHA-512 (base64) of the macOS artifact
//   UPDATE_SHA512_WIN[_<C>]   — SHA-512 (base64) of the Windows artifact
//   UPDATE_SIZE_MAC[_<C>]     — byte size of the macOS artifact
//   UPDATE_SIZE_WIN[_<C>]     — byte size of the Windows artifact
//   UPDATE_RELEASE_DATE[_<C>] — ISO date string
//
// Optional mirror URLs for failover (electron-updater will try each
// entry in the `files:` array in order if the prior one fails):
//   UPDATE_URL_MAC_MIRROR[_<C>]
//   UPDATE_URL_WIN_MIRROR[_<C>]
// ══════════════════════════════════════════════════════════════════════════

const EMPTY_YAML = 'version: 0.0.0\npath: ""\nsha512: ""\nreleaseDate: ""\n';

function yamlHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/yaml; charset=utf-8",
    // Cache for 2 minutes at the edge so a thundering-herd recheck doesn't
    // hammer the backend. Clients can still bypass via ?t=<timestamp>.
    "Cache-Control": "public, max-age=120",
  };
}

function pickChannel(request: Request): string {
  try {
    const url = new URL(request.url);
    const ch = (url.searchParams.get("channel") || "stable").toLowerCase();
    // Only allow a small whitelist — env var names must be predictable.
    if (ch === "stable" || ch === "beta" || ch === "alpha" || ch === "canary") return ch;
  } catch { /* fall through */ }
  return "stable";
}

function envForChannel(name: string, channel: string): string | undefined {
  if (channel && channel !== "stable") {
    const v = process.env[`${name}_${channel.toUpperCase()}`];
    if (v) return v;
  }
  return process.env[name];
}

// Channels in descending stability order. When the client asks for a
// channel that hasn't been provisioned yet, we fall back to the most-stable
// channel that IS provisioned. So while only alpha exists, every client —
// stable, beta, alpha — gets the alpha yml. As soon as beta env vars are
// set, stable+beta clients flip to beta and alpha clients keep their own.
const CHANNEL_STABILITY: readonly string[] = ["stable", "beta", "alpha"];

function resolveChannelWithFallback(
  platform: "mac" | "win",
  requested: string,
): string {
  const P = platform.toUpperCase();
  const probe = (ch: string) =>
    !!envForChannel("UPDATE_VERSION", ch) && !!envForChannel(`UPDATE_URL_${P}`, ch);
  if (probe(requested)) return requested;
  // The requested channel has no artifacts — find a substitute. Walk
  // toward less-stable channels first (so when only alpha is provisioned,
  // a "stable" client gets alpha instead of nothing); then walk back
  // toward more-stable channels as a last resort.
  const startIdx = CHANNEL_STABILITY.indexOf(requested);
  if (startIdx >= 0) {
    for (let i = startIdx + 1; i < CHANNEL_STABILITY.length; i++) {
      if (probe(CHANNEL_STABILITY[i])) return CHANNEL_STABILITY[i];
    }
    for (let i = startIdx - 1; i >= 0; i--) {
      if (probe(CHANNEL_STABILITY[i])) return CHANNEL_STABILITY[i];
    }
  } else {
    for (const ch of CHANNEL_STABILITY) if (probe(ch)) return ch;
  }
  return requested; // nothing provisioned — caller will return EMPTY_YAML
}

function buildYaml(opts: {
  platform: "mac" | "win";
  channel: string;
  defaultFilename: string;
}): string | null {
  const { platform, defaultFilename } = opts;
  const P = platform.toUpperCase(); // MAC | WIN
  const channel = resolveChannelWithFallback(platform, opts.channel);

  const version = envForChannel("UPDATE_VERSION", channel);
  const url = envForChannel(`UPDATE_URL_${P}`, channel);
  if (!version || !url) return null;

  const sha512 = envForChannel(`UPDATE_SHA512_${P}`, channel) || "";
  const size = Number(envForChannel(`UPDATE_SIZE_${P}`, channel) || 0) || 0;
  const mirror = envForChannel(`UPDATE_URL_${P}_MIRROR`, channel);
  const releaseDate =
    envForChannel("UPDATE_RELEASE_DATE", channel) || new Date().toISOString();

  const filename = url.split("/").pop() || defaultFilename;

  // electron-updater reads the first entry in `files:`; additional entries
  // are tried as fallbacks. Top-level path/sha512 kept for v5 compat.
  const lines = [
    `version: ${version}`,
    `files:`,
    `  - url: ${url}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
  ];
  if (mirror) {
    lines.push(
      `  - url: ${mirror}`,
      `    sha512: ${sha512}`,
      `    size: ${size}`,
    );
  }
  lines.push(
    `path: ${filename}`,
    `sha512: ${sha512}`,
    `releaseDate: ${releaseDate}`,
  );
  return lines.join("\n") + "\n";
}

http.route({
  path: "/api/updates/latest-mac.yml",
  method: "GET",
  handler: httpAction(async (_ctx, request) => {
    const channel = pickChannel(request);
    const body =
      buildYaml({
        platform: "mac",
        channel,
        defaultFilename: `Bhai-${process.env.UPDATE_VERSION || "0.0.0"}-arm64.dmg`,
      }) || EMPTY_YAML;
    return new Response(body, { status: 200, headers: yamlHeaders() });
  }),
});

http.route({
  path: "/api/updates/latest.yml",
  method: "GET",
  handler: httpAction(async (_ctx, request) => {
    const channel = pickChannel(request);
    const body =
      buildYaml({
        platform: "win",
        channel,
        defaultFilename: `Bhai-${process.env.UPDATE_VERSION || "0.0.0"}-Setup.exe`,
      }) || EMPTY_YAML;
    return new Response(body, { status: 200, headers: yamlHeaders() });
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN: Account Management HTTP Endpoints
// All gated by ADMIN_API_KEY — replaces direct deploy-key Convex calls.
// ══════════════════════════════════════════════════════════════════════════

http.route({
  path: "/api/admin/accounts",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const error = await validateAdminRequest(request);
    if (error) return error;
    const accounts = await ctx.runQuery(internal.accounts.listAllInternal);
    return new Response(JSON.stringify(accounts), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/api/admin/accounts/stats",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const error = await validateAdminRequest(request);
    if (error) return error;
    const stats = await ctx.runQuery(internal.accounts.getStatsInternal);
    return new Response(JSON.stringify(stats), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/api/admin/accounts/update",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const error = await validateAdminRequest(request);
    if (error) return error;
    const body = await request.json();
    const result = await ctx.runMutation(internal.accounts.updateAccountInternal, body);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/api/admin/accounts/credits",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const error = await validateAdminRequest(request);
    if (error) return error;
    const body = await request.json();
    const result = await ctx.runMutation(internal.accounts.addCreditsInternal, body);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/api/admin/accounts/delete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const error = await validateAdminRequest(request);
    if (error) return error;
    const body = await request.json();
    const result = await ctx.runMutation(internal.accounts.deleteAccountInternal, body);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// GET /api/config/secrets — Fetch server-side secrets for authenticated sessions
// Returns only secrets the client needs at runtime (e.g., HF_TOKEN for model downloads).
// Keys are NEVER stored on the client — fetched per-boot and held in memory only.
// ══════════════════════════════════════════════════════════════════════════

http.route({
  path: "/api/config/secrets",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const auth = await validateRequest(ctx, request);
    if (auth instanceof Response) return auth;
    const { account } = auth;

    // Provider secrets are sensitive — refuse to ship them in cleartext.
    // The caller MUST have an established E2E session (sharedKey present)
    // AND must signal it on the request via X-Encryption header.
    const isEncrypted = request.headers.get("X-Encryption") === "ecdh-aes-256-gcm";
    if (!isEncrypted || !account.sharedKey) {
      return new Response(
        JSON.stringify({ error: "Encrypted transport required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Only return secrets that the client genuinely needs
    const secrets: Record<string, string> = {};

    const hfToken = process.env.HF_TOKEN;
    if (hfToken) secrets.HF_TOKEN = hfToken;

    // CAPTCHA solving keys — stored in Convex, never in the app bundle
    const nopechaKey = process.env.NOPECHA_API_KEY;
    if (nopechaKey) secrets.NOPECHA_API_KEY = nopechaKey;

    // TWO_CAPTCHA_API_KEY is an alias — both names work, returned as CAPTCHA_API_KEY to client
    const captchaKey = process.env.CAPTCHA_API_KEY || process.env.TWO_CAPTCHA_API_KEY;
    if (captchaKey) secrets.CAPTCHA_API_KEY = captchaKey;

    return await buildResponse(secrets, 200, true, account.sharedKey, request);
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// GET /api/keys/voice — Serve voice API keys for live voice mode
// Keys are stored in Convex env vars, fetched by client at boot,
// held in memory for direct WebSocket connections to Google/OpenAI.
// ══════════════════════════════════════════════════════════════════════════

http.route({
  path: "/api/keys/voice",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    // Validate session (same auth as LLM proxy)
    const validation = await validateRequest(ctx, request);
    if (validation instanceof Response) return validation;
    const { account } = validation;

    // Voice provider keys are sensitive — refuse to ship them in cleartext.
    const isEncrypted = request.headers.get("X-Encryption") === "ecdh-aes-256-gcm";
    if (!isEncrypted || !account.sharedKey) {
      return new Response(
        JSON.stringify({ error: "Encrypted transport required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Return available voice API keys
    const keys: Record<string, string> = {};

    const googleKey = process.env.GOOGLE_API_KEY;
    if (googleKey) keys.googleApiKey = googleKey;

    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) keys.openaiApiKey = openaiKey;

    const deepgramKey = process.env.DEEPGRAM_API_KEY;
    if (deepgramKey) keys.deepgramApiKey = deepgramKey;

    return await buildResponse(keys, 200, true, account.sharedKey, request);
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// POST /api/spotify/app-token — Mint a Spotify Client Credentials token
// Used by the spotify-search fast path for read-only catalog search. The
// client_id + client_secret stay on the server; the client only receives the
// resulting access_token (1h TTL).
// ══════════════════════════════════════════════════════════════════════════

http.route({
  path: "/api/spotify/app-token",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const validation = await validateRequest(ctx, request);
    if (validation instanceof Response) return validation;
    const { account } = validation;

    const isEncrypted = request.headers.get("X-Encryption") === "ecdh-aes-256-gcm";

    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return await buildResponse(
        { error: "SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not configured on server" },
        500,
        isEncrypted,
        account.sharedKey,
        request,
      );
    }

    try {
      const resp = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        },
        body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
      });
      const data = await resp.json();
      if (!resp.ok) {
        return await buildResponse(
          { error: data?.error_description || data?.error || `Spotify token endpoint ${resp.status}` },
          resp.status,
          isEncrypted,
          account.sharedKey,
          request,
        );
      }
      return await buildResponse(
        { access_token: data.access_token, expires_in: data.expires_in, token_type: data.token_type || "Bearer" },
        200,
        isEncrypted,
        account.sharedKey,
        request,
      );
    } catch (err: any) {
      return await buildResponse(
        { error: err.message || "Spotify token network error" },
        502,
        isEncrypted,
        account.sharedKey,
        request,
      );
    }
  }),
});

// ── POST /api/app/runtime-key — Per-installation XOR key delivery ──────────
http.route({
  path: "/api/app/runtime-key",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const validation = await validateRequest(ctx, request);
    if (validation instanceof Response) return validation;
    const { account } = validation;

    const authHeader = request.headers.get("Authorization")!;
    const token = authHeader.slice(7);
    const session = await ctx.runQuery(internal.sessions.getSessionByToken, { token });
    const deviceFingerprint = session?.deviceFingerprint ?? undefined;

    const runtimeKey: string = await ctx.runAction(
      internal.appRuntime.deriveRuntimeKey,
      {
        otplessUserId: account.otplessUserId,
        deviceFingerprint,
      },
    );

    return new Response(JSON.stringify({ key: runtimeKey }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// OpenRouter availability probe (admin-only, server-side)
// Hits OpenRouter /v1/models + /v1/credits with the server-held key and
// returns the raw data so a local audit script can diff it against the
// model IDs Bhai references. Never exposes the key to the client.
// ══════════════════════════════════════════════════════════════════════════

http.route({
  path: "/api/llm/audit",
  method: "GET",
  handler: httpAction(async (_ctx, request) => {
    const adminError = await validateAdminRequest(request);
    if (adminError) return adminError;

    const key = process.env.OPENROUTER_API_KEY;
    if (!key) {
      return new Response(
        JSON.stringify({ error: "OPENROUTER_API_KEY not set in Convex env" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    const fetchOr = async (path: string) => {
      const r = await fetch(`https://openrouter.ai/api/v1${path}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      const text = await r.text();
      let data: unknown = null;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      return { status: r.status, ok: r.ok, data };
    };

    const [models, credits] = await Promise.all([
      fetchOr("/models"),
      fetchOr("/credits").catch((e) => ({
        status: 0, ok: false, data: { error: (e as Error).message },
      })),
    ]);

    return new Response(JSON.stringify({ models, credits }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// OTPless auth proxy — validates OTPless SDK tokens server-side and issues
// Bhai sessions. clientId/clientSecret stay server-side in Convex env vars.
// ══════════════════════════════════════════════════════════════════════════

http.route({
  path: "/api/otpless/validate-token",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // Per-IP rate limit — unauthenticated bootstrap endpoint, must be
    // gated against credential-stuffing / brute-force on OTPless tokens.
    const ip = extractClientIp(request);
    const rl = await ctx.runMutation(internal.sessions.checkRequestRateLimit, {
      key: `otpless_validate|${ip}`,
      windowMs: 60_000,
      maxRequests: 10,
    });
    if (rl.limited) {
      return new Response(
        JSON.stringify({ error: "Rate limit exceeded" }),
        { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60" } },
      );
    }

    let body: any;
    try { body = await request.json(); } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    const { token, deviceFingerprint } = body || {};
    if (!token || typeof token !== "string") {
      return new Response(JSON.stringify({ error: "token is required" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    try {
      const identity = await ctx.runAction(internal.otpless.validateTokenInternal, { token });
      await ctx.runMutation(internal.accounts.upsertAccountInternal, {
        otplessUserId: identity.userId,
        email: identity.email,
        phone: identity.phone,
        name: identity.name,
      });
      const session = await ctx.runMutation(internal.sessions.createSessionInternal, {
        otplessUserId: identity.userId,
        deviceFingerprint: deviceFingerprint || undefined,
      });
      return new Response(JSON.stringify({ session, ...identity }), { status: 200, headers: { "Content-Type": "application/json" } });
    } catch (err: any) {
      const raw = (err?.message || "validate failed") as string;
      const clean = raw
        .replace(/^Uncaught Error:\s*/, "")
        .replace(/\s*at handler \([^\)]*\)\s*$/, "")
        .replace(/\n.*$/s, "")
        .trim();
      return new Response(JSON.stringify({ error: clean || "validate failed" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// WAITLIST — Public submit + admin manage
// ══════════════════════════════════════════════════════════════════════════

// OPTIONS preflight for the public submit endpoint
http.route({
  path: "/api/waitlist/submit",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => {
    const origin = request.headers.get("Origin");
    return new Response(null, { status: 204, headers: waitlistCorsHeaders(origin) });
  }),
});

// POST /api/waitlist/submit — PUBLIC. No session auth. hCaptcha + IP gated.
http.route({
  path: "/api/waitlist/submit",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const origin = request.headers.get("Origin");
    const corsHeaders = waitlistCorsHeaders(origin);
    const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

    if (origin !== WAITLIST_ALLOWED_ORIGIN) {
      return new Response(
        JSON.stringify({ error: "Origin not allowed" }),
        { status: 403, headers: jsonHeaders },
      );
    }

    const ip = extractClientIp(request);
    if (!checkWaitlistIpRateLimit(ip)) {
      return new Response(
        JSON.stringify({ error: "Too many submissions. Try again later." }),
        { status: 429, headers: { ...jsonHeaders, "Retry-After": "600" } },
      );
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: jsonHeaders },
      );
    }

    const firstName = typeof body.firstName === "string" ? body.firstName.trim() : "";
    const lastName = typeof body.lastName === "string" ? body.lastName.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const role = typeof body.role === "string" ? body.role.trim() : "";
    const company = typeof body.company === "string" ? body.company.trim() : undefined;
    const useCase = typeof body.useCase === "string" ? body.useCase.trim() : "";
    const hcaptchaToken = typeof body.hcaptchaToken === "string" ? body.hcaptchaToken : "";

    if (!firstName || !lastName || !email || !role || !useCase) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: jsonHeaders },
      );
    }
    if (!EMAIL_RE.test(email) || email.length > 320) {
      return new Response(
        JSON.stringify({ error: "Invalid email" }),
        { status: 400, headers: jsonHeaders },
      );
    }
    if (!hcaptchaToken) {
      return new Response(
        JSON.stringify({ error: "Captcha token missing" }),
        { status: 400, headers: jsonHeaders },
      );
    }

    const captchaOk = await verifyHCaptcha(hcaptchaToken, ip);
    if (!captchaOk) {
      return new Response(
        JSON.stringify({ error: "Captcha verification failed" }),
        { status: 403, headers: jsonHeaders },
      );
    }

    // Duplicate guard — return success so the user sees the same UI; ops
    // gets to see one row, not multiples, for the same person.
    const existing = await ctx.runQuery(internal.waitlist.getEmailDuplicate, { email });
    if (existing) {
      return new Response(
        JSON.stringify({ ok: true, duplicate: true }),
        { status: 200, headers: jsonHeaders },
      );
    }

    const userAgent = request.headers.get("User-Agent") || undefined;
    const referrer = request.headers.get("Referer") || undefined;

    const { id } = await ctx.runMutation(internal.waitlist.insertWaitlistEntry, {
      firstName,
      lastName,
      email,
      role,
      company: company || undefined,
      useCase,
      ipAddress: ip !== "unknown" ? ip : undefined,
      userAgent,
      referrer,
    });

    // Fire-and-forget notification — scheduled so a flaky SMTP can't slow
    // down or fail the submission response.
    await ctx.scheduler.runAfter(0, internal.waitlistMailer.sendNewEntryNotification, {
      entryId: id,
    });

    return new Response(
      JSON.stringify({ ok: true, id }),
      { status: 200, headers: jsonHeaders },
    );
  }),
});

// GET /api/admin/waitlist?status=...&cursor=...&limit=... — admin list
http.route({
  path: "/api/admin/waitlist",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;

    const url = new URL(request.url);
    const status = url.searchParams.get("status") || undefined;
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const cursor = url.searchParams.get("cursor") || undefined;

    const result = await ctx.runQuery(internal.waitlist.listWaitlist, {
      status,
      limit: Number.isFinite(limit) ? limit : undefined,
      cursor: cursor ?? null,
    });

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// GET /api/admin/waitlist/stats — admin stats
http.route({
  path: "/api/admin/waitlist/stats",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;

    const stats = await ctx.runQuery(internal.waitlist.getWaitlistStats, {});
    return new Response(JSON.stringify({ stats }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// POST /api/admin/waitlist/update — admin patch status / notes
http.route({
  path: "/api/admin/waitlist/update",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const { entryId, status, adminNotes } = body || {};
    if (!entryId) {
      return new Response(
        JSON.stringify({ error: "entryId is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    try {
      // Pre-read only when the patch could trigger an applicant-facing email,
      // so we can detect a real status transition (not an idempotent re-click
      // or an adminNotes-only edit).
      const before = (status === "accepted" || status === "contacted")
        ? await ctx.runQuery(internal.waitlist.getEntryById, { entryId })
        : null;

      const result = await ctx.runMutation(internal.waitlist.updateWaitlistEntry, {
        entryId,
        status,
        adminNotes,
      });

      // Scheduled async — a flaky SMTP shouldn't fail the patch.
      if (before && before.status !== status) {
        if (status === "accepted") {
          await ctx.scheduler.runAfter(0, internal.waitlistMailer.sendAcceptanceEmail, {
            entryId,
          });
        } else if (status === "contacted") {
          await ctx.scheduler.runAfter(0, internal.waitlistMailer.sendContactedEmail, {
            entryId,
          });
        }
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: err?.message || "Update failed" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  }),
});

// POST /api/admin/waitlist/resend — re-fires the applicant-facing email for
// an entry. Used by the admin panel's Resend button when lastEmailStatus is
// "failed". `kind` is optional and defaults to the entry's current status.
http.route({
  path: "/api/admin/waitlist/resend",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const { entryId, kind } = body || {};
    if (!entryId) {
      return new Response(
        JSON.stringify({ error: "entryId is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const entry = await ctx.runQuery(internal.waitlist.getEntryById, { entryId });
    if (!entry) {
      return new Response(
        JSON.stringify({ error: "Entry not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }

    // Caller can override which template to send; default to whatever the
    // last delivery tried (or the current entry status as a fallback for
    // entries that never got a first attempt).
    const which = (kind ?? entry.lastEmailKind ?? entry.status) as string;
    if (which !== "contacted" && which !== "accepted") {
      return new Response(
        JSON.stringify({
          error: `Nothing to resend for status "${entry.status}" (only "contacted" or "accepted" have applicant-facing emails)`,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const action = which === "accepted"
      ? internal.waitlistMailer.sendAcceptanceEmail
      : internal.waitlistMailer.sendContactedEmail;
    await ctx.scheduler.runAfter(0, action, { entryId });

    return new Response(
      JSON.stringify({ success: true, scheduled: which }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }),
});

// POST /api/admin/waitlist/delete — admin remove
http.route({
  path: "/api/admin/waitlist/delete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const { entryId } = body || {};
    if (!entryId) {
      return new Response(
        JSON.stringify({ error: "entryId is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    try {
      const result = await ctx.runMutation(internal.waitlist.deleteWaitlistEntry, { entryId });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: err?.message || "Delete failed" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  }),
});

// POST /api/admin/waitlist/import — bulk insert (admin). Idempotent: skips
// emails that already exist. Use to seed the existing ~7-8 users without
// resorting to hand-rolled SQL or going through the public hCaptcha flow.
http.route({
  path: "/api/admin/waitlist/import",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    if (!Array.isArray(body?.entries) || body.entries.length === 0) {
      return new Response(
        JSON.stringify({ error: "entries[] is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    try {
      const result = await ctx.runMutation(internal.waitlist.bulkImportWaitlist, {
        entries: body.entries,
      });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: err?.message || "Import failed" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// USER PROMPT ADDENDA — bot writes per-user learnings (server-side)
// The bot drafts learnings locally throughout the day, then synthesizes them
// at night via dream replay and posts the merged result here. Layered onto
// the system prompt by `assembleSystemPrompt` in systemContent.ts.
// ══════════════════════════════════════════════════════════════════════════

// POST /api/user/addendum/upsert — Create or replace a per-user addendum.
// The `allowUserControlled` flag is gated by an explicit request body field
// and is only respected when the slug is in the user-controlled set on the
// server side. There's no way for a caller to escalate privileges by setting
// it for a non-user-controlled slug.
http.route({
  path: "/api/user/addendum/upsert",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const validation = await validateRequest(ctx, request);
    if (validation instanceof Response) return validation;
    const { account } = validation;

    // The bot sends these bodies E2E-encrypted (encryptedFetch), like every
    // other authenticated route — request.json() alone saw only the envelope.
    let body: any;
    try { ({ body } = await parseRequestBody(request, account.sharedKey)); } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    const { slug, kind, title, content, reason, allowUserControlled } = body || {};
    if (!slug || !kind || !title || !content || !reason) {
      return new Response(JSON.stringify({ error: "slug, kind, title, content, reason are required" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    if (kind !== "personality" && kind !== "skill" && kind !== "memory") {
      return new Response(JSON.stringify({ error: "kind must be personality | skill | memory" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    try {
      const result = await ctx.runMutation(internal.userAddenda.upsertAddendum, {
        otplessUserId: account.otplessUserId,
        slug,
        kind,
        title,
        content,
        reason,
        allowUserControlled: allowUserControlled === true,
      });
      if (!result.success) {
        return new Response(JSON.stringify(result), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
    } catch (err: any) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  }),
});

// GET /api/user/addendum/list — List the caller's addenda
http.route({
  path: "/api/user/addendum/list",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const validation = await validateRequest(ctx, request);
    if (validation instanceof Response) return validation;
    const { account } = validation;
    try {
      const rows = await ctx.runQuery(internal.userAddenda.listForUser, { otplessUserId: account.otplessUserId });
      return new Response(JSON.stringify({ addenda: rows }), { status: 200, headers: { "Content-Type": "application/json" } });
    } catch (err: any) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  }),
});

// POST /api/user/addendum/revert — Revert an addendum to a prior version
http.route({
  path: "/api/user/addendum/revert",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const validation = await validateRequest(ctx, request);
    if (validation instanceof Response) return validation;
    const { account } = validation;

    // The bot sends these bodies E2E-encrypted (encryptedFetch), like every
    // other authenticated route — request.json() alone saw only the envelope.
    let body: any;
    try { ({ body } = await parseRequestBody(request, account.sharedKey)); } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    const { slug, toVersion } = body || {};
    if (!slug || typeof toVersion !== "number") {
      return new Response(JSON.stringify({ error: "slug and toVersion are required" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    try {
      const result = await ctx.runMutation(internal.userAddenda.revertAddendum, {
        otplessUserId: account.otplessUserId,
        slug,
        toVersion,
      });
      if (!result.success) {
        return new Response(JSON.stringify(result), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
    } catch (err: any) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  }),
});

// POST /api/user/addendum/deactivate — Soft-delete an addendum
http.route({
  path: "/api/user/addendum/deactivate",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const validation = await validateRequest(ctx, request);
    if (validation instanceof Response) return validation;
    const { account } = validation;

    // The bot sends these bodies E2E-encrypted (encryptedFetch), like every
    // other authenticated route — request.json() alone saw only the envelope.
    let body: any;
    try { ({ body } = await parseRequestBody(request, account.sharedKey)); } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    const { slug } = body || {};
    if (!slug) {
      return new Response(JSON.stringify({ error: "slug is required" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    try {
      const result = await ctx.runMutation(internal.userAddenda.deactivateAddendum, {
        otplessUserId: account.otplessUserId,
        slug,
      });
      return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
    } catch (err: any) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN PANEL AUTH — admin-key-gated wrappers around internal admin queries.
// store/admins.ts re-exports query()/mutation() as internalQuery/internalMutation
// (see admins.ts line 5), so the admin panel can't reach them via the public
// /api/query path. These HTTP routes bridge that gap using ADMIN_API_KEY,
// which the admin panel already has server-side as ATLAS_ADMIN_KEY.
// ══════════════════════════════════════════════════════════════════════════

http.route({
  path: "/api/admin/auth/get-by-email",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const { email } = body || {};
    if (!email || typeof email !== "string") {
      return new Response(
        JSON.stringify({ error: "email is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const admin = await ctx.runQuery(internal.store.admins.getByEmail, { email });
    return new Response(JSON.stringify({ admin }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/api/admin/auth/get-password-hash",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const { adminId } = body || {};
    if (!adminId) {
      return new Response(
        JSON.stringify({ error: "adminId is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const result = await ctx.runQuery(internal.store.admins.getPasswordHash, { adminId });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/api/admin/auth/update-last-login",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const { adminId } = body || {};
    if (!adminId) {
      return new Response(
        JSON.stringify({ error: "adminId is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    await ctx.runMutation(internal.store.admins.updateLastLogin, { adminId });
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// POST /api/admin/setup-super-admin — one-shot bootstrap.
// Admin-key-gated. Calls internal.store.admins.initSuperAdmin which itself
// refuses if any admin row already exists. Kept on a dedicated path (instead
// of the generic store-mutation proxy) so the allowlist there can omit
// initSuperAdmin entirely, removing a leaked-key replay vector.
// ══════════════════════════════════════════════════════════════════════════

http.route({
  path: "/api/admin/setup-super-admin",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const { email, passwordHash, name } = body || {};
    if (!email || !passwordHash || !name) {
      return new Response(
        JSON.stringify({ error: "email, passwordHash, name are required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    try {
      const adminId = await ctx.runMutation(internal.store.admins.initSuperAdmin, {
        email,
        passwordHash,
        name,
      });
      return new Response(JSON.stringify({ adminId }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err: any) {
      // The mutation throws "Admins already exist. Use create() instead."
      // when a row exists — surface that as a 409 so the caller can tell
      // bootstrap-already-done from a real error.
      const msg = err?.message || "Setup failed";
      const status = msg.includes("already exist") ? 409 : 500;
      return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN store proxy — admin-key-gated counterpart to /api/store/query|mutation.
// /api/store/* requires a SESSION token (used by the bot/desktop app); the
// admin panel doesn't have a session and shouldn't impersonate one. These
// routes use the same allowlists but check ADMIN_API_KEY instead, so the
// admin panel can read every store table without exposing them publicly.
// ══════════════════════════════════════════════════════════════════════════

http.route({
  path: "/api/admin/store-query",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const { functionPath, args } = body || {};
    if (!functionPath || typeof functionPath !== "string") {
      return new Response(
        JSON.stringify({ error: "functionPath is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const queryRef = ADMIN_STORE_QUERY_ALLOWLIST[functionPath];
    if (!queryRef) {
      return new Response(
        JSON.stringify({ error: "Forbidden: function path not in allowlist" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    try {
      const result = await ctx.runQuery(queryRef, args || {});
      return new Response(
        JSON.stringify({ status: "success", value: result }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: err?.message || "Query failed" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  }),
});

http.route({
  path: "/api/admin/store-mutation",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const { functionPath, args } = body || {};
    if (!functionPath || typeof functionPath !== "string") {
      return new Response(
        JSON.stringify({ error: "functionPath is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    // Admin route — strictly use the admin list. We previously fell through
    // to the user list ("admin is a superset"), but that re-exposed user-flow
    // mutations like developer-password rewrites under admin-key reach,
    // bypassing any per-admin permission gating + audit trail in /api/admins/*.
    // If an admin legitimately needs to uninstall on a user's behalf, add a
    // dedicated /api/admin/installs/uninstall route that logs the action.
    const mutationRef = ADMIN_STORE_MUTATION_ALLOWLIST[functionPath];
    if (!mutationRef) {
      return new Response(
        JSON.stringify({ error: "Forbidden: function path not in allowlist" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    try {
      const result = await ctx.runMutation(mutationRef, args || {});
      return new Response(
        JSON.stringify({ status: "success", value: result }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: err?.message || "Mutation failed" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// POST /api/account/update-profile — Update name on the caller's own account.
// Session-authenticated (NOT admin-key gated) — the user can only patch their
// own account, derived from the bearer token. Called by the bot's boot path
// to push the setup-wizard's name to Convex so the admin panel displays it.
// OTPless's identity often doesn't include a display name, so this is the
// authoritative source of `accounts.name`.
// ══════════════════════════════════════════════════════════════════════════

http.route({
  path: "/api/account/update-profile",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const validation = await validateRequest(ctx, request);
    if (validation instanceof Response) return validation;
    const { account } = validation;

    let body: any;
    let isEncrypted = false;
    try {
      const parsed = await parseRequestBody(request, account.sharedKey);
      body = parsed.body;
      isEncrypted = parsed.encrypted;
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: err.message || "Invalid request body" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) {
      return await buildResponse(
        { error: "name is required" },
        400,
        isEncrypted,
        account.sharedKey,
        request,
      );
    }
    if (name.length > 200) {
      return await buildResponse(
        { error: "name too long (max 200 chars)" },
        400,
        isEncrypted,
        account.sharedKey,
        request,
      );
    }

    // Body opt-in `overwrite: true` is required to replace an existing name.
    // Default behaviour is "set only if empty" so a wizard-driven boot-time
    // sync can never clobber an admin-panel edit that happened later.
    const overwrite = body?.overwrite === true;
    const existing = await ctx.runQuery(internal.accounts.getByOtplessIdInternal, {
      otplessUserId: account.otplessUserId,
    });
    if (existing && typeof existing.name === "string" && existing.name.trim() && !overwrite) {
      return await buildResponse(
        { success: false, skipped: true, reason: "name already set" },
        200,
        isEncrypted,
        account.sharedKey,
        request,
      );
    }

    await ctx.runMutation(internal.accounts.upsertAccountInternal, {
      otplessUserId: account.otplessUserId,
      name,
    });

    return await buildResponse(
      { success: true, name },
      200,
      isEncrypted,
      account.sharedKey,
      request,
    );
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// CONTACT FORM (xagilab.com) — Public submit + admin manage
// Isolated from /api/waitlist/submit. Uses its own table (contact_submissions),
// its own per-IP rate limit, its own CORS allowlist. No coupling to session/
// credit machinery. hCaptcha optional — gated by HCAPTCHA_SECRET as elsewhere.
// ══════════════════════════════════════════════════════════════════════════

const CONTACT_IP_WINDOW_MS = 10 * 60_000;
const CONTACT_IP_MAX = 4;
const contactIpHits = new Map<string, { count: number; windowStart: number }>();

function checkContactIpRateLimit(ip: string): boolean {
  if (!ip || ip === "unknown") return true;
  const now = Date.now();
  const existing = contactIpHits.get(ip);
  if (contactIpHits.size > 1024) {
    for (const [k, v] of contactIpHits) {
      if (now - v.windowStart > CONTACT_IP_WINDOW_MS) contactIpHits.delete(k);
    }
  }
  if (!existing || now - existing.windowStart > CONTACT_IP_WINDOW_MS) {
    contactIpHits.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (existing.count >= CONTACT_IP_MAX) return false;
  existing.count++;
  return true;
}

const CONTACT_ALLOWED_ORIGINS = new Set([
  "https://xagilab.com",
  "https://www.xagilab.com",
  "https://tryatlasagi.com",
  "https://www.tryatlasagi.com",
  // Local dev — only allowed when ATLAS_ENV !== 'prod'
  ...(process.env.ATLAS_ENV === "prod" ? [] : [
    "http://localhost:8088",
    "http://localhost:3000",
    "http://127.0.0.1:8088",
  ]),
]);

function contactCorsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && CONTACT_ALLOWED_ORIGINS.has(origin) ? origin : "https://xagilab.com";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

const CONTACT_INQUIRY_VALUES = new Set([
  "partnerships",
  "enterprise",
  "investors",
  "press",
  "hiring",
  "other",
]);

// OPTIONS preflight
http.route({
  path: "/api/contact/submit",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => {
    const origin = request.headers.get("Origin");
    return new Response(null, { status: 204, headers: contactCorsHeaders(origin) });
  }),
});

// POST /api/contact/submit — PUBLIC. No session auth. IP rate-limited.
// hCaptcha verified when HCAPTCHA_SECRET is set; otherwise (dev/local) the
// captcha check is skipped so local previews don't get 403s — production
// SHOULD set HCAPTCHA_SECRET + a token-bound site.
http.route({
  path: "/api/contact/submit",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const origin = request.headers.get("Origin");
    const corsHeaders = contactCorsHeaders(origin);
    const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

    if (!origin || !CONTACT_ALLOWED_ORIGINS.has(origin)) {
      return new Response(
        JSON.stringify({ error: "Origin not allowed" }),
        { status: 403, headers: jsonHeaders },
      );
    }

    const ip = extractClientIp(request);
    if (!checkContactIpRateLimit(ip)) {
      return new Response(
        JSON.stringify({ error: "Too many submissions. Please try again later." }),
        { status: 429, headers: { ...jsonHeaders, "Retry-After": "600" } },
      );
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: jsonHeaders },
      );
    }

    const name = typeof body.name === "string" ? body.name.trim().slice(0, 200) : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 320) : "";
    const company = typeof body.company === "string" ? body.company.trim().slice(0, 200) : "";
    const inquiryRaw = typeof body.inquiry === "string" ? body.inquiry.trim().toLowerCase() : "";
    const inquiry = CONTACT_INQUIRY_VALUES.has(inquiryRaw) ? inquiryRaw : "other";
    const message = typeof body.message === "string" ? body.message.trim().slice(0, 8000) : "";
    const hcaptchaToken = typeof body.hcaptchaToken === "string" ? body.hcaptchaToken : "";

    if (!name || !email || !message) {
      return new Response(
        JSON.stringify({ error: "Missing required fields (name, email, message)" }),
        { status: 400, headers: jsonHeaders },
      );
    }
    if (!EMAIL_RE.test(email)) {
      return new Response(
        JSON.stringify({ error: "Invalid email" }),
        { status: 400, headers: jsonHeaders },
      );
    }
    if (message.length < 10) {
      return new Response(
        JSON.stringify({ error: "Message is too short — a sentence or two helps us route it." }),
        { status: 400, headers: jsonHeaders },
      );
    }

    // Contact-form captcha is opt-in via CONTACT_REQUIRE_HCAPTCHA=true.
    // Decoupled from waitlist's HCAPTCHA_SECRET. Even when not required,
    // CORS allowlist + per-IP rate-limit still protect this endpoint.
    if (process.env.CONTACT_REQUIRE_HCAPTCHA === "true") {
      if (!hcaptchaToken) {
        return new Response(
          JSON.stringify({ error: "Captcha token missing" }),
          { status: 400, headers: jsonHeaders },
        );
      }
      const ok = await verifyContactHCaptcha(hcaptchaToken, ip);
      if (!ok) {
        return new Response(
          JSON.stringify({ error: "Captcha verification failed" }),
          { status: 403, headers: jsonHeaders },
        );
      }
    }

    // Soft dedup — same email + same message within 30 min collapses.
    const dup = await ctx.runQuery(internal.contact.getRecentDuplicate, { email, message });
    if (dup) {
      return new Response(
        JSON.stringify({ ok: true, duplicate: true }),
        { status: 200, headers: jsonHeaders },
      );
    }

    const userAgent = request.headers.get("User-Agent") || undefined;
    const referrer = request.headers.get("Referer") || undefined;

    const { id } = await ctx.runMutation(internal.contact.insertContactSubmission, {
      name,
      email,
      company: company || undefined,
      inquiry,
      message,
      ipAddress: ip !== "unknown" ? ip : undefined,
      userAgent,
      referrer,
      origin,
    });

    return new Response(
      JSON.stringify({ ok: true, id }),
      { status: 200, headers: jsonHeaders },
    );
  }),
});

async function verifyContactHCaptcha(token: string, remoteIp?: string): Promise<boolean> {
  const secret = process.env.HCAPTCHA_SECRET;
  if (!secret) return true; // never called when secret is missing — defensive
  if (!checkAndRecordHcaptchaToken(token)) return false;
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.append("remoteip", remoteIp);
  const sitekey = process.env.HCAPTCHA_SITEKEY_XAGI || process.env.HCAPTCHA_SITEKEY;
  if (sitekey) body.append("sitekey", sitekey);
  try {
    const resp = await fetch("https://api.hcaptcha.com/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const data: any = await resp.json().catch(() => null);
    if (!data?.success) return false;
    // Accept either xagilab.com or tryatlasagi.com by default; override with
    // a comma-separated list via CONTACT_HCAPTCHA_HOSTNAMES.
    const allowed = (process.env.CONTACT_HCAPTCHA_HOSTNAMES
      || "xagilab.com,www.xagilab.com,tryatlasagi.com,www.tryatlasagi.com"
    ).split(",").map(h => h.trim()).filter(Boolean);
    if (data.hostname && !allowed.includes(data.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

// GET /api/admin/contact?status=&inquiry=&limit=&cursor= — admin list
http.route({
  path: "/api/admin/contact",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;

    const url = new URL(request.url);
    const status = url.searchParams.get("status") || undefined;
    const inquiry = url.searchParams.get("inquiry") || undefined;
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const cursor = url.searchParams.get("cursor") || undefined;

    const result = await ctx.runQuery(internal.contact.listContactSubmissions, {
      status,
      inquiry,
      limit: Number.isFinite(limit) ? limit : undefined,
      cursor: cursor ?? null,
    });

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// GET /api/admin/contact/stats — admin stats
http.route({
  path: "/api/admin/contact/stats",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;
    const stats = await ctx.runQuery(internal.contact.getContactStats, {});
    return new Response(JSON.stringify({ stats }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// POST /api/admin/contact/update — admin patch status / notes
http.route({
  path: "/api/admin/contact/update",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const { entryId, status, adminNotes } = body || {};
    if (!entryId) {
      return new Response(
        JSON.stringify({ error: "entryId is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    if (status !== undefined && !["new", "replied", "archived"].includes(status)) {
      return new Response(
        JSON.stringify({ error: "Invalid status" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    await ctx.runMutation(internal.contact.updateContactSubmission, {
      entryId,
      status,
      adminNotes,
    });
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// POST /api/admin/contact/delete — admin delete entry
http.route({
  path: "/api/admin/contact/delete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authErr = await validateAdminRequest(request);
    if (authErr) return authErr;

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const { entryId } = body || {};
    if (!entryId) {
      return new Response(
        JSON.stringify({ error: "entryId is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    await ctx.runMutation(internal.contact.deleteContactSubmission, { entryId });
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

export default http;
