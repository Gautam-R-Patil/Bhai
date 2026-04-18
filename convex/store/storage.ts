// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// File storage helpers for the store

import { v } from "convex/values";
import { mutation, query } from "../_generated/server";

// ── Queries ────────────────────────────────────────────────────────────────

/**
 * Get a file download URL by storage ID
 */
export const getFileUrl = query({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    return await ctx.storage.getUrl(args.storageId);
  },
});

/**
 * Get multiple file URLs
 */
export const getFileUrls = query({
  args: { storageIds: v.array(v.id("_storage")) },
  handler: async (ctx, args) => {
    const urls: Record<string, string | null> = {};

    for (const storageId of args.storageIds) {
      urls[storageId] = await ctx.storage.getUrl(storageId);
    }

    return urls;
  },
});

// ── Mutations ──────────────────────────────────────────────────────────────

/**
 * Generate an upload URL for developers to upload files
 */
export const generateUploadUrl = mutation({
  args: {
    developerId: v.optional(v.id("developers")),
  },
  handler: async (ctx, args) => {
    // If developerId is provided, verify they're approved
    if (args.developerId) {
      const developer = await ctx.db.get(args.developerId);
      if (!developer) throw new Error("Developer not found");
      if (developer.status !== "approved") {
        throw new Error("Developer account not approved");
      }
    }
    // Allow system/seed uploads without developer (for seeding)

    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Generate an upload URL for admins (no developer check)
 */
export const generateAdminUploadUrl = mutation({
  args: {
    adminId: v.id("admins"),
  },
  handler: async (ctx, args) => {
    // Verify admin exists
    const admin = await ctx.db.get(args.adminId);
    if (!admin) throw new Error("Admin not found");

    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Delete a file from storage
 */
export const deleteFile = mutation({
  args: {
    storageId: v.id("_storage"),
    developerId: v.optional(v.id("developers")),
    adminId: v.optional(v.id("admins")),
  },
  handler: async (ctx, args) => {
    // Verify caller is authorized (either developer or admin)
    if (args.developerId) {
      const developer = await ctx.db.get(args.developerId);
      if (!developer) throw new Error("Developer not found");
    } else if (args.adminId) {
      const admin = await ctx.db.get(args.adminId);
      if (!admin) throw new Error("Admin not found");
    } else {
      throw new Error("Must provide either developerId or adminId");
    }

    await ctx.storage.delete(args.storageId);
  },
});

/**
 * Get the content download URL for an installed item
 * This is what users call when installing
 */
export const getItemContentUrl = mutation({
  args: {
    itemId: v.id("store_items"),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    // Get item
    const item = await ctx.db.get(args.itemId);
    if (!item) throw new Error("Item not found");
    if (item.status !== "active") throw new Error("Item not available");

    // Get content URL
    const contentUrl = await ctx.storage.getUrl(item.contentFileId);
    if (!contentUrl) throw new Error("Content not found");

    return {
      url: contentUrl,
      slug: item.slug,
      type: item.type,
      version: item.version,
      permissions: item.permissions,
    };
  },
});

/**
 * Store-maintained file cleanup (for orphaned files)
 * Run periodically as a scheduled job
 */
export const cleanupOrphanedFiles = mutation({
  handler: async (ctx) => {
    // This is a placeholder - in production, you'd want to:
    // 1. List all files in storage
    // 2. Check which are referenced by store_items or submissions
    // 3. Delete orphaned files older than X days

    // For now, just return success
    return { cleaned: 0, message: "Cleanup not implemented yet" };
  },
});
