// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Convex HTTP Actions — server-side API key proxy for A.T.L.A.S.
// ALL API keys (OpenRouter, etc.) live here as Convex env vars. Never sent to client.

import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  generateServerKeyPair,
  deriveSharedKey,
  encryptResponse,
  decryptRequest,
  validateTimestamp,
  KDF_VERSION_LEGACY,
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

    // 2. Check credits
    if (account.ai_credits <= 0) {
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
      return new Response(
        JSON.stringify({ error: err.message || "Invalid request body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const model = body.model || "anthropic/claude-sonnet-4.6";

    // 3b. Precise credit pre-check — reject before calling the LLM if the
    //     account can't afford the selected model. The earlier `<= 0` gate
    //     is a cheap fast-path; this catches e.g. a 0.5-credit account
    //     trying to invoke a 3-credit model.
    const cost = getCreditCost(model);
    if (account.ai_credits < cost) {
      return new Response(
        JSON.stringify({
          error: "Insufficient credits",
          required: cost,
          available: account.ai_credits,
        }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      );
    }

    // 4. Get OpenRouter API key from Convex env (NEVER leaves server)
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    if (!openrouterKey) {
      console.error("[HTTP Proxy] OPENROUTER_API_KEY not set in Convex environment");
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // 5. Assemble system prompt
    //    If client sends systemPromptOverride, use it directly (for sub-agents, classifiers, etc.)
    //    Otherwise, build from server DB using platform + skillSlugs.
    const messages = Array.isArray(body.messages) ? [...body.messages] : [];

    if (body.systemPromptOverride && typeof body.systemPromptOverride === "string") {
      // Client-specified override: sub-agents, JSON planners, and classifiers
      // still want the narrow task-specific prompt — but we always prepend the
      // server-side `rules` slug so core safety rails are non-overridable even
      // by an authenticated client. If the rules slug is missing (fresh seed
      // state) we fall through without it rather than blocking the call.
      let safetyRules = "";
      try {
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
        const serverPrompt = await ctx.runQuery(
          internal.systemContent.assembleSystemPrompt,
          {
            platform,
            skillSlugs,
            userId: account.otplessUserId,
          }
        );

        if (serverPrompt) {
          // Merge with any existing system message from client (dynamic context like time, widgets)
          if (messages.length > 0 && messages[0].role === "system") {
            // Prepend server prompt to client's dynamic context
            messages[0] = {
              ...messages[0],
              content: serverPrompt + "\n\n" + (messages[0].content || ""),
            };
          } else {
            // No client system message — insert server prompt as first message
            messages.unshift({ role: "system", content: serverPrompt });
          }
        }
      } catch (err: any) {
        // Non-fatal: if prompt assembly fails, proceed without server prompt
        console.error("[HTTP Proxy] System prompt assembly failed:", err.message);
      }
    }

    // 5b. Anthropic prompt caching — add cache_control breakpoints
    //     Reduces cost by up to 90% for repeated system prompt + tool definitions.
    //     Only applied for Anthropic models (via OpenRouter's anthropic/ prefix).
    const isAnthropicModel = typeof model === "string" && model.startsWith("anthropic/");
    if (isAnthropicModel) {
      // Cache the system prompt: convert string content to content-block array
      // with cache_control on the last block
      if (messages.length > 0 && messages[0].role === "system") {
        const sysContent = messages[0].content;
        if (typeof sysContent === "string") {
          messages[0] = {
            ...messages[0],
            content: [
              { type: "text", text: sysContent, cache_control: { type: "ephemeral" } },
            ],
          };
        } else if (Array.isArray(sysContent) && sysContent.length > 0) {
          // Already an array of content blocks — add cache_control to the last one
          const blocks = [...sysContent];
          blocks[blocks.length - 1] = {
            ...blocks[blocks.length - 1],
            cache_control: { type: "ephemeral" },
          };
          messages[0] = { ...messages[0], content: blocks };
        }
      }

      // Cache tool definitions: add cache_control to the last tool
      if (Array.isArray(body.tools) && body.tools.length > 0) {
        const tools = body.tools.map((t: any) => ({ ...t }));
        tools[tools.length - 1] = {
          ...tools[tools.length - 1],
          cache_control: { type: "ephemeral" },
        };
        body.tools = tools;
      }

      // Cache conversation history: place a third cache_control marker on
      // the second-to-last message so the growing prefix is cached across
      // agent-loop iterations. The last message is excluded so each new
      // turn adds unique content beyond the cached prefix (otherwise the
      // cache would miss on every fresh user/tool message).
      // Anthropic allows up to 4 cache breakpoints; we now use 3 (system
      // + tools + history prefix).
      if (messages.length > 2) {
        const cutIdx = messages.length - 2;
        const msg = messages[cutIdx];
        if (msg && typeof msg === "object") {
          const content = (msg as any).content;
          if (typeof content === "string") {
            (msg as any).content = [
              { type: "text", text: content, cache_control: { type: "ephemeral" } },
            ];
          } else if (Array.isArray(content) && content.length > 0) {
            const blocks = [...content];
            blocks[blocks.length - 1] = {
              ...blocks[blocks.length - 1],
              cache_control: { type: "ephemeral" },
            };
            (msg as any).content = blocks;
          }
        }
      }
    }

    // 6. Build the OpenRouter request
    // OpenRouter's `reasoning` parameter is unified across all providers
    // (Anthropic, Google, OpenAI) — same { effort: "high" } format works for all.
    const openrouterBody: any = {
      model: body.model,
      messages,
      max_tokens: body.max_tokens,
      tools: body.tools,
      reasoning: body.reasoning,
      provider: body.provider,
      modalities: body.modalities,
      // Grammar-constrained decoding: forwarded to OpenRouter which maps
      // to each provider's native JSON mode. Drop when tools are present
      // — the two are mutually exclusive on most providers and tool use
      // already produces structured output.
      response_format:
        body.response_format && (!body.tools || body.tools.length === 0) ? body.response_format : undefined,
    };

    // Remove undefined fields
    for (const key of Object.keys(openrouterBody)) {
      if (openrouterBody[key] === undefined) {
        delete openrouterBody[key];
      }
    }

    // 7. Forward to OpenRouter
    try {
      const orResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openrouterKey}`,
          "HTTP-Referer": "https://atlas.xagilab.com",
          "X-Title": "A.T.L.A.S",
        },
        body: JSON.stringify(openrouterBody),
      });

      const responseData = await orResponse.json();

      // 8. If OpenRouter returned an error, log it and pass it through
      if (!orResponse.ok) {
        console.error(`[HTTP Proxy] OpenRouter error ${orResponse.status} for ${model}:`, JSON.stringify(responseData).slice(0, 500));
        return new Response(JSON.stringify(responseData), {
          status: orResponse.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      // 9. Deduct credits atomically (server-side).
      //    Pre-checked at step 3b, so under normal conditions this succeeds.
      //    If it still fails (e.g. extreme concurrency race across parallel
      //    tool calls) the provider tokens have already been burned — log
      //    loudly for manual reconciliation, but return the response anyway
      //    since the user got value.
      try {
        const deductResult = await ctx.runMutation(internal.accounts.deductCreditsInternal, {
          otplessUserId: account.otplessUserId,
          amount: cost,
        });
        if (deductResult && !deductResult.success) {
          console.error(
            `[HTTP Proxy] POST-LLM credit deduction REJECTED for user=${account.otplessUserId} ` +
              `model=${model} cost=${cost} remaining=${deductResult.remaining}: ${deductResult.error}. ` +
              `Tokens already consumed on provider — manual reconciliation may be required.`,
          );
        }
      } catch (err) {
        console.error(
          `[HTTP Proxy] POST-LLM credit deduction THREW for user=${account.otplessUserId} ` +
            `model=${model} cost=${cost}. Tokens already consumed on provider — manual reconciliation may be required. ` +
            `Error:`,
          err,
        );
      }

      // 10. Return the OpenRouter response (encrypted if client uses E2E)
      return await buildResponse(responseData, 200, isEncrypted, account.sharedKey, request);
    } catch (err: any) {
      console.error("[HTTP Proxy] OpenRouter request failed:", err.message);
      return new Response(
        JSON.stringify({ error: "LLM service temporarily unavailable" }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }
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
      const requestedKdf = typeof body.kdfVersion === "number" ? body.kdfVersion : KDF_VERSION_LEGACY;
      const kdfVersion = (SUPPORTED_KDF_VERSIONS as readonly number[]).includes(requestedKdf)
        ? requestedKdf
        : KDF_VERSION_LEGACY;

      if (clientPublicKey && typeof clientPublicKey === "string") {
        const serverKP = await generateServerKeyPair();
        serverPublicKey = serverKP.publicKey;
        sharedKey = await deriveSharedKey(serverKP.privateKey, clientPublicKey, kdfVersion);
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
      const status = err.message?.includes("not found") ? 404 : 403;
      return new Response(
        JSON.stringify({ error: err.message }),
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

const STORE_QUERY_ALLOWLIST: Record<string, any> = {
  // store/items
  "store/items:list":            internal.store.items.list,
  "store/items:search":          internal.store.items.search,
  "store/items:getBySlug":       internal.store.items.getBySlug,
  "store/items:getById":         internal.store.items.getById,
  "store/items:getByDeveloper":  internal.store.items.getByDeveloper,
  "store/items:listByDeveloper": internal.store.items.listByDeveloper,
  "store/items:getFeatured":     internal.store.items.getFeatured,
  "store/items:getTrending":     internal.store.items.getTrending,
  "store/items:getCategories":   internal.store.items.getCategories,
  // store/developers
  "store/developers:getByEmail":      internal.store.developers.getByEmail,
  "store/developers:getById":         internal.store.developers.getById,
  "store/developers:listByStatus":    internal.store.developers.listByStatus,
  "store/developers:listAll":         internal.store.developers.listAll,
  "store/developers:getStats":        internal.store.developers.getStats,
  "store/developers:getPasswordHash": internal.store.developers.getPasswordHash,
  "store/developers:list":            internal.store.developers.list,
  // store/admins
  "store/admins:getByEmail":        internal.store.admins.getByEmail,
  "store/admins:getById":           internal.store.admins.getById,
  "store/admins:listAll":           internal.store.admins.listAll,
  "store/admins:hasPermission":     internal.store.admins.hasPermission,
  "store/admins:getDashboardStats": internal.store.admins.getDashboardStats,
  "store/admins:getPasswordHash":   internal.store.admins.getPasswordHash,
  "store/admins:list":              internal.store.admins.list,
  "store/admins:getActivityLogs":   internal.store.admins.getActivityLogs,
  // store/reviews
  "store/reviews:getByItem":    internal.store.reviews.getByItem,
  "store/reviews:getUserReview": internal.store.reviews.getUserReview,
  "store/reviews:getSummary":   internal.store.reviews.getSummary,
  "store/reviews:getByUser":    internal.store.reviews.getByUser,
  // store/installs
  "store/installs:getByUser":       internal.store.installs.getByUser,
  "store/installs:isInstalled":     internal.store.installs.isInstalled,
  "store/installs:get":             internal.store.installs.get,
  "store/installs:checkUpdates":    internal.store.installs.checkUpdates,
  "store/installs:getInstallCount": internal.store.installs.getInstallCount,
  // store/submissions
  "store/submissions:getById":         internal.store.submissions.getById,
  "store/submissions:listByStatus":    internal.store.submissions.listByStatus,
  "store/submissions:getPendingCount": internal.store.submissions.getPendingCount,
  "store/submissions:getByDeveloper":  internal.store.submissions.getByDeveloper,
  "store/submissions:listByDeveloper": internal.store.submissions.listByDeveloper,
  "store/submissions:listPending":     internal.store.submissions.listPending,
  // store/storage
  "store/storage:getFileUrl":  internal.store.storage.getFileUrl,
  "store/storage:getFileUrls": internal.store.storage.getFileUrls,
};

const STORE_MUTATION_ALLOWLIST: Record<string, any> = {
  // store/items
  "store/items:incrementInstallCount": internal.store.items.incrementInstallCount,
  "store/items:updateRating":          internal.store.items.updateRating,
  "store/items:setFeatured":           internal.store.items.setFeatured,
  "store/items:updateStatus":          internal.store.items.updateStatus,
  "store/items:create":                internal.store.items.create,
  "store/items:update":                internal.store.items.update,
  "store/items:resetWeeklyInstalls":   internal.store.items.resetWeeklyInstalls,
  // store/developers
  "store/developers:register":        internal.store.developers.register,
  "store/developers:updateProfile":   internal.store.developers.updateProfile,
  "store/developers:recordLogin":     internal.store.developers.recordLogin,
  "store/developers:approve":         internal.store.developers.approve,
  "store/developers:reject":          internal.store.developers.reject,
  "store/developers:suspend":         internal.store.developers.suspend,
  "store/developers:ban":             internal.store.developers.ban,
  "store/developers:reinstate":       internal.store.developers.reinstate,
  "store/developers:changePassword":  internal.store.developers.changePassword,
  "store/developers:updateLastLogin": internal.store.developers.updateLastLogin,
  // store/admins
  "store/admins:create":          internal.store.admins.create,
  "store/admins:update":          internal.store.admins.update,
  "store/admins:recordLogin":     internal.store.admins.recordLogin,
  "store/admins:changePassword":  internal.store.admins.changePassword,
  "store/admins:remove":          internal.store.admins.remove,
  "store/admins:initSuperAdmin":  internal.store.admins.initSuperAdmin,
  "store/admins:updateLastLogin": internal.store.admins.updateLastLogin,
  "store/admins:deleteAdmin":     internal.store.admins.deleteAdmin,
  // store/reviews
  "store/reviews:submit":      internal.store.reviews.submit,
  "store/reviews:remove":      internal.store.reviews.remove,
  "store/reviews:markHelpful": internal.store.reviews.markHelpful,
  "store/reviews:adminDelete": internal.store.reviews.adminDelete,
  // store/installs
  "store/installs:startInstall":      internal.store.installs.startInstall,
  "store/installs:confirmInstall":    internal.store.installs.confirmInstall,
  "store/installs:uninstall":         internal.store.installs.uninstall,
  "store/installs:updateVersion":     internal.store.installs.updateVersion,
  "store/installs:setAutoUpdate":     internal.store.installs.setAutoUpdate,
  "store/installs:getUpdateDownload": internal.store.installs.getUpdateDownload,
  // store/submissions
  "store/submissions:create":          internal.store.submissions.create,
  "store/submissions:startReview":     internal.store.submissions.startReview,
  "store/submissions:approve":         internal.store.submissions.approve,
  "store/submissions:reject":          internal.store.submissions.reject,
  "store/submissions:requestRevision": internal.store.submissions.requestRevision,
  "store/submissions:resubmit":        internal.store.submissions.resubmit,
  "store/submissions:cancel":          internal.store.submissions.cancel,
  // store/storage
  "store/storage:generateUploadUrl":      internal.store.storage.generateUploadUrl,
  "store/storage:generateAdminUploadUrl": internal.store.storage.generateAdminUploadUrl,
  "store/storage:deleteFile":             internal.store.storage.deleteFile,
  "store/storage:getItemContentUrl":      internal.store.storage.getItemContentUrl,
  "store/storage:cleanupOrphanedFiles":   internal.store.storage.cleanupOrphanedFiles,
};

// ── POST /api/store/query — Proxy Convex store queries via session auth ──

http.route({
  path: "/api/store/query",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const validation = await validateRequest(ctx, request);
    if (validation instanceof Response) return validation;

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

    try {
      const result = await ctx.runQuery(queryRef, args || {});
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

    const mutationRef = STORE_MUTATION_ALLOWLIST[functionPath];
    if (!mutationRef) {
      return new Response(
        JSON.stringify({ error: "Forbidden: function path not in allowlist" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    try {
      const result = await ctx.runMutation(mutationRef, args || {});
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
        defaultFilename: `A.T.L.A.S-${process.env.UPDATE_VERSION || "0.0.0"}-arm64.dmg`,
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
        defaultFilename: `A.T.L.A.S-${process.env.UPDATE_VERSION || "0.0.0"}-Setup.exe`,
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

    return new Response(JSON.stringify(secrets), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
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

    // Return available voice API keys
    const keys: Record<string, string> = {};

    const googleKey = process.env.GOOGLE_API_KEY;
    if (googleKey) keys.googleApiKey = googleKey;

    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) keys.openaiApiKey = openaiKey;

    const deepgramKey = process.env.DEEPGRAM_API_KEY;
    if (deepgramKey) keys.deepgramApiKey = deepgramKey;

    return new Response(JSON.stringify(keys), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
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
// model IDs ATLAS references. Never exposes the key to the client.
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
// ATLAS sessions. clientId/clientSecret stay server-side in Convex env vars.
// ══════════════════════════════════════════════════════════════════════════

http.route({
  path: "/api/otpless/validate-token",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
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

export default http;
