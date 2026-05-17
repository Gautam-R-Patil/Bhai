// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Admin account management for the store

import { v } from "convex/values";
import { internalQuery as query, internalMutation as mutation } from "../_generated/server";

// ── Permission Constants ──────────────────────────────────────────────────

export const PERMISSIONS = {
  APPROVE_DEVS: "approve_devs",
  APPROVE_APPS: "approve_apps",
  MANAGE_USERS: "manage_users",
  MANAGE_ADMINS: "manage_admins",
  FEATURE_APPS: "feature_apps",
  VIEW_ANALYTICS: "view_analytics",
  MANAGE_SETTINGS: "manage_settings",
  MANAGE_ENTERPRISE: "manage_enterprise",
} as const;

export const ROLES = {
  SUPER_ADMIN: "super_admin",   // All permissions
  MODERATOR: "moderator",       // Approve devs & apps, manage users
  REVIEWER: "reviewer",         // Only review apps
} as const;

const ROLE_PERMISSIONS: Record<string, string[]> = {
  [ROLES.SUPER_ADMIN]: Object.values(PERMISSIONS),
  [ROLES.MODERATOR]: [
    PERMISSIONS.APPROVE_DEVS,
    PERMISSIONS.APPROVE_APPS,
    PERMISSIONS.MANAGE_USERS,
    PERMISSIONS.FEATURE_APPS,
    PERMISSIONS.VIEW_ANALYTICS,
  ],
  [ROLES.REVIEWER]: [
    PERMISSIONS.APPROVE_APPS,
    PERMISSIONS.VIEW_ANALYTICS,
  ],
};

// ── Queries ────────────────────────────────────────────────────────────────

/**
 * Get admin by email (for login)
 */
export const getByEmail = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("admins")
      .withIndex("by_email", (q) => q.eq("email", args.email.toLowerCase()))
      .first();
  },
});

/**
 * Get admin by ID
 */
export const getById = query({
  args: { adminId: v.id("admins") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.adminId);
  },
});

/**
 * List all admins (super_admin only)
 */
export const listAll = query({
  handler: async (ctx) => {
    // admins is a tiny, hand-curated table. 200 is orders of magnitude
    // above realistic use and protects the query from unbounded growth.
    return await ctx.db
      .query("admins")
      .order("desc")
      .take(200);
  },
});

/**
 * Check if admin has permission
 */
export const hasPermission = query({
  args: {
    adminId: v.id("admins"),
    permission: v.string(),
  },
  handler: async (ctx, args) => {
    const admin = await ctx.db.get(args.adminId);
    if (!admin) return false;

    // Super admin has all permissions
    if (admin.role === ROLES.SUPER_ADMIN) return true;

    return admin.permissions.includes(args.permission);
  },
});

/**
 * Get dashboard stats for admin panel
 */
export const getDashboardStats = query({
  handler: async (ctx) => {
    // TODO: every .take() here is a rough cap because the current stats
    // shape requires summing/filtering on the whole table. Once any of
    // these tables grow past the cap this dashboard will undercount.
    // The proper fix is per-table denormalized counters maintained by
    // each insert/update/delete mutation — then these become O(1) doc
    // reads instead of O(N) scans.

    // Users
    const accounts = await ctx.db.query("accounts").take(10000);
    const totalUsers = accounts.length;

    // Developers
    const developers = await ctx.db.query("developers").take(5000);
    const totalDevelopers = developers.length;
    const pendingDevelopers = developers.filter((d) => d.status === "pending").length;

    // Store items
    const items = await ctx.db.query("store_items").take(5000);
    const totalItems = items.length;
    const activeItems = items.filter((i) => i.status === "active").length;
    const totalInstalls = items.reduce((sum, i) => sum + i.installCount, 0);

    // Submissions
    const submissions = await ctx.db.query("submissions").take(5000);
    const pendingSubmissions = submissions.filter((s) => s.status === "pending").length;

    // Recent activity
    const recentActivity = await ctx.db
      .query("store_activity_log")
      .withIndex("by_timestamp")
      .order("desc")
      .take(10);

    return {
      totalUsers,
      totalDevelopers,
      pendingDevelopers,
      totalItems,
      activeItems,
      totalInstalls,
      pendingSubmissions,
      recentActivity,
    };
  },
});

// ── Mutations ──────────────────────────────────────────────────────────────

/**
 * Create a new admin (super_admin only)
 */
export const create = mutation({
  args: {
    email: v.string(),
    passwordHash: v.string(),
    name: v.string(),
    role: v.string(),
  },
  handler: async (ctx, args) => {
    const email = args.email.toLowerCase();

    // Check if email already exists
    const existing = await ctx.db
      .query("admins")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();

    if (existing) {
      throw new Error("Admin with this email already exists");
    }

    // Get permissions for role
    const permissions = ROLE_PERMISSIONS[args.role] || [];

    const adminId = await ctx.db.insert("admins", {
      email,
      passwordHash: args.passwordHash,
      name: args.name,
      role: args.role,
      permissions,
      createdAt: Date.now(),
      lastLoginAt: undefined,
    });

    return adminId;
  },
});

/**
 * Update admin details
 */
export const update = mutation({
  args: {
    adminId: v.id("admins"),
    name: v.optional(v.string()),
    role: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { adminId, name, role } = args;

    const updates: Record<string, unknown> = {};

    if (name !== undefined) updates.name = name;

    if (role !== undefined) {
      updates.role = role;
      updates.permissions = ROLE_PERMISSIONS[role] || [];
    }

    if (Object.keys(updates).length > 0) {
      await ctx.db.patch(adminId, updates);
    }
  },
});

/**
 * Record admin login
 */
export const recordLogin = mutation({
  args: { adminId: v.id("admins") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.adminId, {
      lastLoginAt: Date.now(),
    });
  },
});

/**
 * Change admin password
 */
export const changePassword = mutation({
  args: {
    adminId: v.id("admins"),
    newPasswordHash: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.adminId, {
      passwordHash: args.newPasswordHash,
    });
  },
});

/**
 * Delete admin (super_admin only)
 */
export const remove = mutation({
  args: { adminId: v.id("admins") },
  handler: async (ctx, args) => {
    const admin = await ctx.db.get(args.adminId);
    if (!admin) throw new Error("Admin not found");

    // Cannot delete super_admin if it's the last one
    if (admin.role === ROLES.SUPER_ADMIN) {
      // Only called on delete; .take(10) is enough to prove "more than
      // one super admin exists" without loading a full-table result.
      const superAdmins = await ctx.db
        .query("admins")
        .filter((q) => q.eq(q.field("role"), ROLES.SUPER_ADMIN))
        .take(10);

      if (superAdmins.length <= 1) {
        throw new Error("Cannot delete the last super admin");
      }
    }

    await ctx.db.delete(args.adminId);
  },
});

/**
 * Initialize first super admin (one-time setup)
 */
export const initSuperAdmin = mutation({
  args: {
    email: v.string(),
    passwordHash: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    // Check if any admin exists
    const existingAdmins = await ctx.db.query("admins").first();
    if (existingAdmins) {
      throw new Error("Admins already exist. Use create() instead.");
    }

    const email = args.email.toLowerCase();

    const adminId = await ctx.db.insert("admins", {
      email,
      passwordHash: args.passwordHash,
      name: args.name,
      role: ROLES.SUPER_ADMIN,
      permissions: Object.values(PERMISSIONS),
      createdAt: Date.now(),
      lastLoginAt: undefined,
    });

    return adminId;
  },
});

/**
 * Get password hash for verification.
 * TODO (Phase 1): Replace with an HTTP action that does bcrypt.compare server-side
 * and returns { valid: boolean } instead of exposing the hash. Portals currently
 * depend on this being a public query — migrate portals to the HTTP action first.
 */
export const getPasswordHash = query({
  args: { adminId: v.id("admins") },
  handler: async (ctx, args) => {
    const admin = await ctx.db.get(args.adminId);
    if (!admin) return null;
    return { passwordHash: admin.passwordHash };
  },
});

/**
 * Update last login timestamp
 */
export const updateLastLogin = mutation({
  args: { adminId: v.id("admins") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.adminId, {
      lastLoginAt: Date.now(),
    });
  },
});

/**
 * List all admins (alias)
 */
export const list = query({
  handler: async (ctx) => {
    return await ctx.db
      .query("admins")
      .order("desc")
      .take(200);
  },
});

/**
 * Delete admin (alias for remove)
 */
export const deleteAdmin = mutation({
  args: { adminId: v.id("admins") },
  handler: async (ctx, args) => {
    const admin = await ctx.db.get(args.adminId);
    if (!admin) throw new Error("Admin not found");

    if (admin.role === ROLES.SUPER_ADMIN) {
      // Only called on delete; .take(10) is enough to prove "more than
      // one super admin exists" without loading a full-table result.
      const superAdmins = await ctx.db
        .query("admins")
        .filter((q) => q.eq(q.field("role"), ROLES.SUPER_ADMIN))
        .take(10);

      if (superAdmins.length <= 1) {
        throw new Error("Cannot delete the last super admin");
      }
    }

    await ctx.db.delete(args.adminId);
  },
});

/**
 * Get activity logs for admin panel
 */
export const getActivityLogs = query({
  args: {
    type: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;

    const query = ctx.db
      .query("store_activity_log")
      .withIndex("by_timestamp")
      .order("desc");

    const logs = await query.take(limit);

    if (args.type) {
      return logs.filter((log) => log.type === args.type);
    }

    return logs;
  },
});
