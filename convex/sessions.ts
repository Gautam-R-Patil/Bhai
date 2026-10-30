// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Server-side session management for Bhai.
// Sessions replace client-side deploy keys — clients authenticate with a session token.

import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";
import { noteDevice } from "./devices";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Create a new session ─────────────────────────
// Called by the client after OTPless auth. Returns a session token.
export const createSession = internalMutation({
  args: {
    otplessUserId: v.string(),
    deviceFingerprint: v.optional(v.string()),
  },
  handler: async (ctx, { otplessUserId, deviceFingerprint }) => {
    // Verify the account exists and is active
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_otpless_id", (q) => q.eq("otplessUserId", otplessUserId))
      .unique();

    if (!account) {
      throw new Error("Account not found");
    }
    if (account.status !== "active") {
      throw new Error(`Account is ${account.status}`);
    }

    // Clean up expired sessions for this user
    const userSessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("otplessUserId", otplessUserId))
      .take(1000);

    const now = Date.now();
    for (const s of userSessions) {
      if (s.expiresAt < now) {
        await ctx.db.delete(s._id);
      }
    }

    // Generate a crypto-random token (64 hex chars = 256 bits)
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

    await ctx.db.insert("sessions", {
      otplessUserId,
      token,
      expiresAt: now + SESSION_TTL_MS,
      deviceFingerprint,
      createdAt: now,
    });

    return {
      token,
      expiresAt: now + SESSION_TTL_MS,
    };
  },
});

// ── Validate a session token ─────────────────────
// Returns account info if valid, throws if expired/invalid.
export const validateSession = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();

    if (!session) {
      return null;
    }

    if (session.expiresAt < Date.now()) {
      return null;
    }

    // Fetch the linked account
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_otpless_id", (q) => q.eq("otplessUserId", session.otplessUserId))
      .unique();

    if (!account) {
      return null;
    }

    return {
      otplessUserId: session.otplessUserId,
      status: account.status,
      plan: account.plan,
      ai_credits: account.ai_credits,
      name: account.name,
    };
  },
});

// ── Internal session validation (for HTTP actions) ──
export const validateSessionInternal = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();

    if (!session || session.expiresAt < Date.now()) {
      return null;
    }

    const account = await ctx.db
      .query("accounts")
      .withIndex("by_otpless_id", (q) => q.eq("otplessUserId", session.otplessUserId))
      .unique();

    if (!account) {
      return null;
    }

    return {
      otplessUserId: session.otplessUserId,
      accountId: account._id,
      status: account.status,
      plan: account.plan,
      ai_credits: account.ai_credits,
      sharedKey: session.sharedKey || null,
      deviceFingerprint: session.deviceFingerprint ?? null,
      email: account.email ?? null, // the OTPless-verified sign-in email
    };
  },
});

// ── Revoke a session ─────────────────────────────
export const revokeSession = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();

    if (session) {
      await ctx.db.delete(session._id);
    }
    return { success: true };
  },
});

// ── Refresh a session (extend TTL) ───────────────
export const refreshSession = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();

    if (!session || session.expiresAt < Date.now()) {
      throw new Error("Session expired or not found");
    }

    const newExpiry = Date.now() + SESSION_TTL_MS;
    await ctx.db.patch(session._id, { expiresAt: newExpiry });

    return { expiresAt: newExpiry };
  },
});

// ══════════════════════════════════════════════════════════════════════════
// INTERNAL variants — called by HTTP actions (not directly by clients)
// ══════════════════════════════════════════════════════════════════════════

export const createSessionInternal = internalMutation({
  args: {
    otplessUserId: v.string(),
    deviceFingerprint: v.optional(v.string()),
    clientPublicKey: v.optional(v.string()),
    serverPublicKey: v.optional(v.string()),
    sharedKey: v.optional(v.string()),
    // A fresh OTPless-verified sign-in (validate-token): brings back a removed device.
    reactivate: v.optional(v.boolean()),
  },
  handler: async (ctx, { otplessUserId, deviceFingerprint, clientPublicKey, serverPublicKey, sharedKey, reactivate }) => {
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_otpless_id", (q) => q.eq("otplessUserId", otplessUserId))
      .unique();

    if (!account) {
      throw new Error("Account not found");
    }
    if (account.status !== "active") {
      throw new Error(`Account is ${account.status}`);
    }

    // A device the owner removed gets no session until someone signs in on it again.
    if (deviceFingerprint && !(await noteDevice(ctx, otplessUserId, deviceFingerprint, reactivate === true))) {
      throw new Error("device_removed");
    }

    // Clean up expired sessions
    const userSessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("otplessUserId", otplessUserId))
      .take(1000);

    const now = Date.now();
    for (const s of userSessions) {
      if (s.expiresAt < now) {
        await ctx.db.delete(s._id);
      }
    }

    // Generate token
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

    await ctx.db.insert("sessions", {
      otplessUserId,
      token,
      expiresAt: now + SESSION_TTL_MS,
      deviceFingerprint,
      sharedKey,
      createdAt: now,
    });

    return { token, expiresAt: now + SESSION_TTL_MS, serverPublicKey: serverPublicKey || undefined };
  },
});

export const refreshSessionInternal = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();

    if (!session || session.expiresAt < Date.now()) {
      throw new Error("Session expired or not found");
    }

    const newExpiry = Date.now() + SESSION_TTL_MS;
    await ctx.db.patch(session._id, { expiresAt: newExpiry });
    return { expiresAt: newExpiry };
  },
});

export const revokeSessionInternal = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();

    if (session) {
      await ctx.db.delete(session._id);
    }
    return { success: true };
  },
});

// ── Rate Limiting ───────────────────────────────────
// Sliding-window rate limiter: 60 requests per 60-second window per session.
// Uses a dedicated rate_limits table with atomic check-and-increment.
const RATE_LIMIT_WINDOW_MS = 60_000; // 60 seconds
const RATE_LIMIT_MAX_REQUESTS = 60;  // 60 requests per window

export const checkRateLimit = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<{ limited: boolean }> => {
    const now = Date.now();

    const existing = await ctx.db
      .query("rate_limits")
      .withIndex("by_token", (q) => q.eq("sessionToken", token))
      .unique();

    if (!existing) {
      // First request for this session — create a new window
      await ctx.db.insert("rate_limits", {
        sessionToken: token,
        windowStart: now,
        requestCount: 1,
      });
      return { limited: false };
    }

    // Check if the current window has expired
    if (now - existing.windowStart >= RATE_LIMIT_WINDOW_MS) {
      // Reset window
      await ctx.db.patch(existing._id, {
        windowStart: now,
        requestCount: 1,
      });
      return { limited: false };
    }

    // Within current window — check the count
    if (existing.requestCount >= RATE_LIMIT_MAX_REQUESTS) {
      return { limited: true };
    }

    // Increment and allow
    await ctx.db.patch(existing._id, {
      requestCount: existing.requestCount + 1,
    });
    return { limited: false };
  },
});

// ── Per-IP rate limit for unauthenticated routes ─────────────────────
// Sliding-window: up to `maxRequests` per `windowMs` per (route, ip).
// Reused by /api/auth/session and /api/otpless/validate-token so unauth'd
// flooders can't grind on either endpoint.
export const checkRequestRateLimit = internalMutation({
  args: {
    key: v.string(),
    windowMs: v.number(),
    maxRequests: v.number(),
  },
  handler: async (ctx, { key, windowMs, maxRequests }): Promise<{ limited: boolean }> => {
    const now = Date.now();
    const existing = await ctx.db
      .query("request_rate_limits")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();

    if (!existing) {
      await ctx.db.insert("request_rate_limits", {
        key,
        windowStart: now,
        requestCount: 1,
      });
      return { limited: false };
    }

    if (now - existing.windowStart >= windowMs) {
      await ctx.db.patch(existing._id, { windowStart: now, requestCount: 1 });
      return { limited: false };
    }

    if (existing.requestCount >= maxRequests) {
      return { limited: true };
    }

    await ctx.db.patch(existing._id, { requestCount: existing.requestCount + 1 });
    return { limited: false };
  },
});

// ── Sweep expired sessions + orphan rate-limit rows ────────────────────
// Called nightly by crons.ts. Bounded per run so a long-outage backlog
// can't blow past the mutation row limit; remaining rows are picked up
// the next night.
export const sweepExpired = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ sessionsDeleted: number; rateLimitsDeleted: number }> => {
    const now = Date.now();
    const expiredSessions = await ctx.db
      .query("sessions")
      .withIndex("by_expires", (q) => q.lt("expiresAt", now))
      .take(500);
    const expiredTokens = new Set<string>();
    for (const s of expiredSessions) {
      expiredTokens.add(s.token);
      await ctx.db.delete(s._id);
    }

    let rateLimitsDeleted = 0;
    if (expiredTokens.size > 0) {
      const rateRows = await ctx.db.query("rate_limits").take(2000);
      for (const r of rateRows) {
        if (expiredTokens.has(r.sessionToken)) {
          await ctx.db.delete(r._id);
          rateLimitsDeleted++;
        }
      }
    }

    // Also age out stale request-rate-limit rows whose window has long passed.
    const STALE_REQUEST_RL_AFTER_MS = 24 * 60 * 60 * 1000;
    const reqRows = await ctx.db.query("request_rate_limits").take(2000);
    for (const r of reqRows) {
      if (now - r.windowStart > STALE_REQUEST_RL_AFTER_MS) {
        await ctx.db.delete(r._id);
      }
    }

    return { sessionsDeleted: expiredSessions.length, rateLimitsDeleted };
  },
});

/** Lightweight session lookup — returns only fields needed for key derivation. */
export const getSessionByToken = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();

    if (!session || session.expiresAt < Date.now()) return null;

    return {
      deviceFingerprint: session.deviceFingerprint ?? null,
    };
  },
});

