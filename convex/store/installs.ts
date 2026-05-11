// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// User install tracking for the store

import { v } from "convex/values";
import { internalQuery as query, internalMutation as mutation } from "../_generated/server";

// ── Queries ────────────────────────────────────────────────────────────────

/**
 * Get all installs for a user
 */
export const getByUser = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const installs = await ctx.db
      .query("store_installs")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(5000);

    // Enrich with item details
    const enriched = await Promise.all(
      installs.map(async (install) => {
        const item = await ctx.db.get(install.itemId);
        return {
          ...install,
          item: item
            ? {
                name: item.name,
                type: item.type,
                version: item.version,
                iconFileId: item.iconFileId,
                status: item.status,
              }
            : null,
        };
      })
    );

    return enriched;
  },
});

/**
 * Check if user has installed an item
 */
export const isInstalled = query({
  args: {
    userId: v.string(),
    itemId: v.id("store_items"),
  },
  handler: async (ctx, args) => {
    const install = await ctx.db
      .query("store_installs")
      .withIndex("by_user_item", (q) =>
        q.eq("userId", args.userId).eq("itemId", args.itemId)
      )
      .first();

    return install !== null;
  },
});

/**
 * Get install by user and item
 */
export const get = query({
  args: {
    userId: v.string(),
    itemId: v.id("store_items"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("store_installs")
      .withIndex("by_user_item", (q) =>
        q.eq("userId", args.userId).eq("itemId", args.itemId)
      )
      .first();
  },
});

/**
 * Check for available updates for a user's installs
 */
export const checkUpdates = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const installs = await ctx.db
      .query("store_installs")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .filter((q) => q.eq(q.field("autoUpdate"), true))
      .take(5000);

    const updates: Array<{
      installId: typeof installs[0]["_id"];
      itemId: typeof installs[0]["itemId"];
      itemName: string;
      currentVersion: string;
      latestVersion: string;
    }> = [];

    for (const install of installs) {
      const item = await ctx.db.get(install.itemId);
      if (!item || item.status !== "active") continue;

      // Compare versions (simple string comparison works for semver)
      if (item.version !== install.version) {
        updates.push({
          installId: install._id,
          itemId: install.itemId,
          itemName: item.name,
          currentVersion: install.version,
          latestVersion: item.version,
        });
      }
    }

    return updates;
  },
});

/**
 * Get install count for an item
 */
export const getInstallCount = query({
  args: { itemId: v.id("store_items") },
  handler: async (ctx, args) => {
    // getInstallCount: 10k cap. Beyond that, this should be a
    // denormalized counter on store_items.installCount (which already
    // exists and is maintained by startInstall/confirmInstall).
    const installs = await ctx.db
      .query("store_installs")
      .withIndex("by_item", (q) => q.eq("itemId", args.itemId))
      .take(10000);

    return installs.length;
  },
});

// ── Mutations ──────────────────────────────────────────────────────────────

/**
 * Start an installation (returns download URL)
 */
export const startInstall = mutation({
  args: {
    userId: v.string(),
    itemId: v.id("store_items"),
    version: v.string(),
  },
  handler: async (ctx, args) => {
    // Check if already installed
    const existing = await ctx.db
      .query("store_installs")
      .withIndex("by_user_item", (q) =>
        q.eq("userId", args.userId).eq("itemId", args.itemId)
      )
      .first();

    if (existing) {
      throw new Error("Item already installed");
    }

    // Get item details
    const item = await ctx.db.get(args.itemId);
    if (!item) throw new Error("Item not found");
    if (item.status !== "active") throw new Error("Item not available");

    // Get download URL
    const contentUrl = await ctx.storage.getUrl(item.contentFileId);
    if (!contentUrl) throw new Error("Content not found");

    return {
      contentUrl,
      slug: item.slug,
      type: item.type,
      version: item.version,
    };
  },
});

/**
 * Confirm installation complete
 */
export const confirmInstall = mutation({
  args: {
    userId: v.string(),
    itemId: v.id("store_items"),
  },
  handler: async (ctx, args) => {
    // Check if already installed
    const existing = await ctx.db
      .query("store_installs")
      .withIndex("by_user_item", (q) =>
        q.eq("userId", args.userId).eq("itemId", args.itemId)
      )
      .first();

    if (existing) {
      return existing._id; // Already recorded
    }

    // Get item details
    const item = await ctx.db.get(args.itemId);
    if (!item) throw new Error("Item not found");

    const now = Date.now();

    // Create install record
    const installId = await ctx.db.insert("store_installs", {
      userId: args.userId,
      itemId: args.itemId,
      itemSlug: item.slug,
      itemType: item.type,
      version: item.version,
      installedAt: now,
      updatedAt: now,
      autoUpdate: true,
    });

    // Increment item install count
    await ctx.db.patch(args.itemId, {
      installCount: item.installCount + 1,
      weeklyInstalls: item.weeklyInstalls + 1,
    });

    // Update developer stats
    const developer = await ctx.db.get(item.developerId);
    if (developer) {
      await ctx.db.patch(item.developerId, {
        totalInstalls: developer.totalInstalls + 1,
      });
    }

    // Log activity
    await ctx.db.insert("store_activity_log", {
      type: "install",
      userId: args.userId,
      itemId: args.itemId,
      timestamp: now,
    });

    return installId;
  },
});

/**
 * Uninstall an item
 */
export const uninstall = mutation({
  args: {
    userId: v.string(),
    itemId: v.id("store_items"),
  },
  handler: async (ctx, args) => {
    const install = await ctx.db
      .query("store_installs")
      .withIndex("by_user_item", (q) =>
        q.eq("userId", args.userId).eq("itemId", args.itemId)
      )
      .first();

    if (!install) {
      throw new Error("Item not installed");
    }

    // Delete install record
    await ctx.db.delete(install._id);

    // Log activity
    await ctx.db.insert("store_activity_log", {
      type: "uninstall",
      userId: args.userId,
      itemId: args.itemId,
      timestamp: Date.now(),
    });
  },
});

/**
 * Update to a new version
 */
export const updateVersion = mutation({
  args: {
    userId: v.string(),
    itemId: v.id("store_items"),
    newVersion: v.string(),
  },
  handler: async (ctx, args) => {
    const install = await ctx.db
      .query("store_installs")
      .withIndex("by_user_item", (q) =>
        q.eq("userId", args.userId).eq("itemId", args.itemId)
      )
      .first();

    if (!install) {
      throw new Error("Item not installed");
    }

    const now = Date.now();

    await ctx.db.patch(install._id, {
      version: args.newVersion,
      updatedAt: now,
    });

    // Log activity
    await ctx.db.insert("store_activity_log", {
      type: "update",
      userId: args.userId,
      itemId: args.itemId,
      metadata: JSON.stringify({
        oldVersion: install.version,
        newVersion: args.newVersion,
      }),
      timestamp: now,
    });
  },
});

/**
 * Toggle auto-update setting
 */
export const setAutoUpdate = mutation({
  args: {
    userId: v.string(),
    itemId: v.id("store_items"),
    autoUpdate: v.boolean(),
  },
  handler: async (ctx, args) => {
    const install = await ctx.db
      .query("store_installs")
      .withIndex("by_user_item", (q) =>
        q.eq("userId", args.userId).eq("itemId", args.itemId)
      )
      .first();

    if (!install) {
      throw new Error("Item not installed");
    }

    await ctx.db.patch(install._id, {
      autoUpdate: args.autoUpdate,
    });
  },
});

/**
 * Get download info for update
 */
export const getUpdateDownload = mutation({
  args: {
    userId: v.string(),
    itemId: v.id("store_items"),
  },
  handler: async (ctx, args) => {
    const install = await ctx.db
      .query("store_installs")
      .withIndex("by_user_item", (q) =>
        q.eq("userId", args.userId).eq("itemId", args.itemId)
      )
      .first();

    if (!install) {
      throw new Error("Item not installed");
    }

    const item = await ctx.db.get(args.itemId);
    if (!item) throw new Error("Item not found");
    if (item.status !== "active") throw new Error("Item not available");

    const contentUrl = await ctx.storage.getUrl(item.contentFileId);
    if (!contentUrl) throw new Error("Content not found");

    return {
      contentUrl,
      slug: item.slug,
      type: item.type,
      currentVersion: install.version,
      newVersion: item.version,
      changelog: item.changelog,
    };
  },
});
