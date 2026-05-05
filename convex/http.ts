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
async function parseRequestBody(
  request: Request,
  sharedKey: string | null,
): Promise<{ body: any; encrypted: boolean }> {
  const isEncrypted = request.headers.get("X-Encryption") === "ecdh-aes-256-gcm";

  if (isEncrypted && sharedKey) {
    const envelope = (await request.json()) as EncryptedEnvelope;

    // Replay protection
    if (!validateTimestamp(envelope.ts)) {
      throw new Error("Request expired (replay protection)");
    }

    const plaintext = await decryptRequest(envelope, sharedKey);
    return { body: JSON.parse(plaintext), encrypted: true };
  }

  // Unencrypted fallback
  return { body: await request.json(), encrypted: false };
}

/**
 * Build response, encrypting if the request was encrypted.
 */
async function buildResponse(
  data: any,
  status: number,
  encrypted: boolean,
  sharedKey: string | null,
): Promise<Response> {
  if (encrypted && sharedKey) {
    const envelope = await encryptResponse(JSON.stringify(data), sharedKey);
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
      return await buildResponse(responseData, 200, isEncrypted, account.sharedKey);
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

    const { otplessUserId, deviceFingerprint, clientPublicKey, email, phone, name } = body;
    if (!otplessUserId || typeof otplessUserId !== "string") {
      return new Response(
        JSON.stringify({ error: "otplessUserId is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    try {
      // Auto-upsert account so clients don't need a deploy key for this
      await ctx.runMutation(internal.accounts.upsertAccountInternal, {
        otplessUserId,
        email: email || undefined,
        phone: phone || undefined,
        name: name || undefined,
      });

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
      return await buildResponse({ error: "query is required" }, 400, encrypted, account.sharedKey);
    }

    const tavilyKey = process.env.TAVILY_API_KEY;
    if (!tavilyKey) {
      return await buildResponse({ error: "Tavily not configured" }, 500, encrypted, account.sharedKey);
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
      return await buildResponse(data, response.ok ? 200 : response.status, encrypted, account.sharedKey);
    } catch (err: any) {
      return await buildResponse({ error: err.message }, 500, encrypted, account.sharedKey);
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
      return await buildResponse({ error: "query is required" }, 400, encrypted, account.sharedKey);
    }

    const exaKey = process.env.EXA_API_KEY;
    if (!exaKey) {
      return await buildResponse({ error: "Exa not configured" }, 500, encrypted, account.sharedKey);
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
      return await buildResponse(data, response.ok ? 200 : response.status, encrypted, account.sharedKey);
    } catch (err: any) {
      return await buildResponse({ error: err.message }, 500, encrypted, account.sharedKey);
    }
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// GET /api/updates/* — Generic auto-updater endpoint for electron-updater
// Serves update metadata YAML (latest-mac.yml, latest.yml, latest-linux.yml).
// No GitHub token needed — update metadata is read from Convex env vars.
//
// Required Convex env vars:
//   UPDATE_VERSION  — e.g. "0.2.1"
//   UPDATE_URL_MAC  — direct download URL for the macOS .dmg / .zip
//   UPDATE_URL_WIN  — direct download URL for the Windows .exe / .nsis
//   UPDATE_SHA512_MAC — SHA-512 hash of the macOS artifact
//   UPDATE_SHA512_WIN — SHA-512 hash of the Windows artifact
//   UPDATE_RELEASE_DATE — ISO date string, e.g. "2026-04-15T00:00:00Z"
//
// electron-updater expects the YAML at <feedURL>/latest-mac.yml (macOS)
// or <feedURL>/latest.yml (Windows).
// ══════════════════════════════════════════════════════════════════════════

http.route({
  path: "/api/updates/latest-mac.yml",
  method: "GET",
  handler: httpAction(async (_ctx, _request) => {
    const version = process.env.UPDATE_VERSION;
    const url = process.env.UPDATE_URL_MAC;
    const sha512 = process.env.UPDATE_SHA512_MAC;
    const releaseDate = process.env.UPDATE_RELEASE_DATE || new Date().toISOString();

    if (!version || !url) {
      return new Response("version: 0.0.0\npath: \"\"\nsha512: \"\"\nreleaseDate: \"\"\n", {
        status: 200,
        headers: { "Content-Type": "text/yaml; charset=utf-8", "Cache-Control": "no-cache" },
      });
    }

    // Extract filename from URL for the path field
    const filename = url.split("/").pop() || `A.T.L.A.S-${version}-arm64.dmg`;
    const yaml = [
      `version: ${version}`,
      `files:`,
      `  - url: ${url}`,
      `    sha512: ${sha512 || ""}`,
      `    size: 0`,
      `path: ${filename}`,
      `sha512: ${sha512 || ""}`,
      `releaseDate: ${releaseDate}`,
    ].join("\n") + "\n";

    return new Response(yaml, {
      status: 200,
      headers: { "Content-Type": "text/yaml; charset=utf-8", "Cache-Control": "no-cache" },
    });
  }),
});

http.route({
  path: "/api/updates/latest.yml",
  method: "GET",
  handler: httpAction(async (_ctx, _request) => {
    const version = process.env.UPDATE_VERSION;
    const url = process.env.UPDATE_URL_WIN;
    const sha512 = process.env.UPDATE_SHA512_WIN;
    const releaseDate = process.env.UPDATE_RELEASE_DATE || new Date().toISOString();

    if (!version || !url) {
      return new Response("version: 0.0.0\npath: \"\"\nsha512: \"\"\nreleaseDate: \"\"\n", {
        status: 200,
        headers: { "Content-Type": "text/yaml; charset=utf-8", "Cache-Control": "no-cache" },
      });
    }

    const filename = url.split("/").pop() || `A.T.L.A.S-${version}-Setup.exe`;
    const yaml = [
      `version: ${version}`,
      `files:`,
      `  - url: ${url}`,
      `    sha512: ${sha512 || ""}`,
      `    size: 0`,
      `path: ${filename}`,
      `sha512: ${sha512 || ""}`,
      `releaseDate: ${releaseDate}`,
    ].join("\n") + "\n";

    return new Response(yaml, {
      status: 200,
      headers: { "Content-Type": "text/yaml; charset=utf-8", "Cache-Control": "no-cache" },
    });
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
        );
      }
      return await buildResponse(
        { access_token: data.access_token, expires_in: data.expires_in, token_type: data.token_type || "Bearer" },
        200,
        isEncrypted,
        account.sharedKey,
      );
    } catch (err: any) {
      return await buildResponse(
        { error: err.message || "Spotify token network error" },
        502,
        isEncrypted,
        account.sharedKey,
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

export default http;
