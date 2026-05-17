// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Developer account management for the store

import { v } from "convex/values";
import { internalQuery as query, internalMutation as mutation } from "../_generated/server";

// ── Queries ────────────────────────────────────────────────────────────────

// Strip the bcrypt hash before returning a developer row to any caller other
// than getPasswordHash. Exposing the hash anywhere else lets an attacker who
// reaches a developer-returning endpoint pull hashes for offline cracking.
type DeveloperDoc = {
  passwordHash?: string;
  [k: string]: unknown;
};
function stripPasswordHash<T extends DeveloperDoc | null | undefined>(dev: T): T {
  if (!dev) return dev;
  const { passwordHash: _ph, ...rest } = dev;
  return rest as unknown as T;
}

/**
 * Get developer by email (for login)
 */
export const getByEmail = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const dev = await ctx.db
      .query("developers")
      .withIndex("by_email", (q) => q.eq("email", args.email.toLowerCase()))
      .first();
    return stripPasswordHash(dev);
  },
});

/**
 * Get developer by ID
 */
export const getById = query({
  args: { developerId: v.id("developers") },
  handler: async (ctx, args) => {
    const developer = await ctx.db.get(args.developerId);
    if (!developer) return null;

    // Get avatar URL if exists
    let avatarUrl = null;
    if (developer.avatarFileId) {
      avatarUrl = await ctx.storage.getUrl(developer.avatarFileId);
    }

    return stripPasswordHash({ ...developer, avatarUrl });
  },
});

/**
 * List developers by status (for admin panel)
 */
export const listByStatus = query({
  args: {
    status: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;

    const rows = await ctx.db
      .query("developers")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .take(limit);
    return rows.map(stripPasswordHash);
  },
});

/**
 * Get all developers (for admin panel)
 */
export const listAll = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;

    const rows = await ctx.db
      .query("developers")
      .order("desc")
      .take(limit);
    return rows.map(stripPasswordHash);
  },
});

/**
 * Get developer stats
 */
export const getStats = query({
  args: { developerId: v.id("developers") },
  handler: async (ctx, args) => {
    const developer = await ctx.db.get(args.developerId);
    if (!developer) return null;

    // Get all items by this developer
    const items = await ctx.db
      .query("store_items")
      .withIndex("by_developer", (q) => q.eq("developerId", args.developerId))
      .take(5000);

    // Get pending submissions count
    const submissions = await ctx.db
      .query("submissions")
      .withIndex("by_developer", (q) => q.eq("developerId", args.developerId))
      .take(5000);
    const pendingSubmissions = submissions.filter(
      (s) => s.status === "pending" || s.status === "in_review"
    ).length;

    // Calculate total reviews
    let totalReviews = 0;
    let averageRating = 0;
    for (const item of items) {
      totalReviews += item.ratingCount;
      averageRating += item.rating * item.ratingCount;
    }
    if (totalReviews > 0) {
      averageRating = averageRating / totalReviews;
    }

    return {
      totalApps: developer.totalApps,
      totalInstalls: developer.totalInstalls,
      totalReviews,
      averageRating: Math.round(averageRating * 10) / 10,
      activeItems: items.filter((i) => i.status === "active").length,
      pendingSubmissions,
    };
  },
});

// ── Mutations ──────────────────────────────────────────────────────────────

/**
 * Register a new developer (pending approval)
 */
export const register = mutation({
  args: {
    email: v.string(),
    passwordHash: v.string(),
    displayName: v.string(),
    companyName: v.optional(v.string()),
    website: v.optional(v.string()),
    bio: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const email = args.email.toLowerCase();

    // Check if email already exists
    const existing = await ctx.db
      .query("developers")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();

    if (existing) {
      throw new Error("Email already registered");
    }

    const now = Date.now();

    const developerId = await ctx.db.insert("developers", {
      email,
      passwordHash: args.passwordHash,
      displayName: args.displayName,
      companyName: args.companyName,
      website: args.website,
      bio: args.bio,
      avatarFileId: undefined,
      status: "pending",
      verificationNotes: undefined,
      approvedBy: undefined,
      approvedAt: undefined,
      totalApps: 0,
      totalInstalls: 0,
      createdAt: now,
      lastLoginAt: undefined,
    });

    // Log activity
    await ctx.db.insert("store_activity_log", {
      type: "developer_registered",
      developerId,
      timestamp: now,
    });

    return developerId;
  },
});

/**
 * Update developer profile
 */
export const updateProfile = mutation({
  args: {
    developerId: v.id("developers"),
    displayName: v.optional(v.string()),
    companyName: v.optional(v.string()),
    website: v.optional(v.string()),
    bio: v.optional(v.string()),
    avatarFileId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const { developerId, ...updates } = args;

    // Remove undefined values
    const cleanUpdates = Object.fromEntries(
      Object.entries(updates).filter(([_, v]) => v !== undefined)
    );

    if (Object.keys(cleanUpdates).length > 0) {
      await ctx.db.patch(developerId, cleanUpdates);
    }
  },
});

/**
 * Record developer login
 */
export const recordLogin = mutation({
  args: { developerId: v.id("developers") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.developerId, {
      lastLoginAt: Date.now(),
    });
  },
});

/**
 * Approve a developer (admin only)
 */
export const approve = mutation({
  args: {
    developerId: v.id("developers"),
    adminEmail: v.string(),
  },
  handler: async (ctx, args) => {
    const developer = await ctx.db.get(args.developerId);
    if (!developer) throw new Error("Developer not found");

    const now = Date.now();

    await ctx.db.patch(args.developerId, {
      status: "approved",
      approvedBy: args.adminEmail,
      approvedAt: now,
      verificationNotes: undefined,
    });

    // Log activity
    await ctx.db.insert("store_activity_log", {
      type: "developer_approved",
      developerId: args.developerId,
      metadata: JSON.stringify({ approvedBy: args.adminEmail }),
      timestamp: now,
    });
  },
});

/**
 * Reject a developer (admin only)
 */
export const reject = mutation({
  args: {
    developerId: v.id("developers"),
    reason: v.string(),
    adminEmail: v.string(),
  },
  handler: async (ctx, args) => {
    const developer = await ctx.db.get(args.developerId);
    if (!developer) throw new Error("Developer not found");

    const now = Date.now();

    await ctx.db.patch(args.developerId, {
      status: "rejected",
      verificationNotes: args.reason,
    });

    // Log activity
    await ctx.db.insert("store_activity_log", {
      type: "developer_rejected",
      developerId: args.developerId,
      metadata: JSON.stringify({ reason: args.reason, rejectedBy: args.adminEmail }),
      timestamp: now,
    });
  },
});

/**
 * Suspend a developer (admin only)
 */
export const suspend = mutation({
  args: {
    developerId: v.id("developers"),
    reason: v.string(),
    adminEmail: v.string(),
  },
  handler: async (ctx, args) => {
    const developer = await ctx.db.get(args.developerId);
    if (!developer) throw new Error("Developer not found");

    const now = Date.now();

    await ctx.db.patch(args.developerId, {
      status: "suspended",
      verificationNotes: args.reason,
    });

    // Also deprecate all their active apps
    const items = await ctx.db
      .query("store_items")
      .withIndex("by_developer", (q) => q.eq("developerId", args.developerId))
      .take(5000);

    for (const item of items) {
      if (item.status === "active") {
        await ctx.db.patch(item._id, {
          status: "deprecated",
          updatedAt: now,
        });
      }
    }

    // Log activity
    await ctx.db.insert("store_activity_log", {
      type: "developer_suspended",
      developerId: args.developerId,
      metadata: JSON.stringify({ reason: args.reason, suspendedBy: args.adminEmail }),
      timestamp: now,
    });
  },
});

/**
 * Ban a developer (admin only) - permanent
 */
export const ban = mutation({
  args: {
    developerId: v.id("developers"),
    reason: v.string(),
    adminEmail: v.string(),
  },
  handler: async (ctx, args) => {
    const developer = await ctx.db.get(args.developerId);
    if (!developer) throw new Error("Developer not found");

    const now = Date.now();

    await ctx.db.patch(args.developerId, {
      status: "banned",
      verificationNotes: args.reason,
    });

    // Remove all their apps
    const items = await ctx.db
      .query("store_items")
      .withIndex("by_developer", (q) => q.eq("developerId", args.developerId))
      .take(5000);

    for (const item of items) {
      await ctx.db.patch(item._id, {
        status: "removed",
        updatedAt: now,
      });
    }

    // Log activity
    await ctx.db.insert("store_activity_log", {
      type: "developer_banned",
      developerId: args.developerId,
      metadata: JSON.stringify({ reason: args.reason, bannedBy: args.adminEmail }),
      timestamp: now,
    });
  },
});

/**
 * Reinstate a suspended developer (admin only)
 */
export const reinstate = mutation({
  args: {
    developerId: v.id("developers"),
    adminEmail: v.string(),
  },
  handler: async (ctx, args) => {
    const developer = await ctx.db.get(args.developerId);
    if (!developer) throw new Error("Developer not found");
    if (developer.status === "banned") {
      throw new Error("Cannot reinstate banned developers");
    }

    const now = Date.now();

    await ctx.db.patch(args.developerId, {
      status: "approved",
      verificationNotes: undefined,
    });

    // Log activity
    await ctx.db.insert("store_activity_log", {
      type: "developer_reinstated",
      developerId: args.developerId,
      metadata: JSON.stringify({ reinstatedBy: args.adminEmail }),
      timestamp: now,
    });
  },
});

/**
 * Change developer password
 */
export const changePassword = mutation({
  args: {
    developerId: v.id("developers"),
    newPasswordHash: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.developerId, {
      passwordHash: args.newPasswordHash,
    });
  },
});

/**
 * Get password hash for verification.
 * TODO (Phase 1): Replace with an HTTP action that does bcrypt.compare server-side
 * and returns { valid: boolean } instead of exposing the hash. Portals currently
 * depend on this being a public query — migrate portals to the HTTP action first.
 */
export const getPasswordHash = query({
  args: { developerId: v.id("developers") },
  handler: async (ctx, args) => {
    const developer = await ctx.db.get(args.developerId);
    if (!developer) return null;
    return { passwordHash: developer.passwordHash };
  },
});

/**
 * Update last login timestamp
 */
export const updateLastLogin = mutation({
  args: { developerId: v.id("developers") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.developerId, {
      lastLoginAt: Date.now(),
    });
  },
});

/**
 * List all developers (alias for admin panel)
 */
export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    const rows = await ctx.db
      .query("developers")
      .order("desc")
      .take(limit);
    return rows.map(stripPasswordHash);
  },
});
