// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Store items queries and mutations

import { v } from "convex/values";
import { internalQuery as query, internalMutation as mutation } from "../_generated/server";

// minAtlasVersion was renamed minBhaiVersion. Accept either name, and write
// both so clients from before the rename (reading minAtlasVersion) still see it.
export function minVersionFields(row: { minBhaiVersion?: string; minAtlasVersion?: string }) {
  const min = row.minBhaiVersion ?? row.minAtlasVersion;
  return { minBhaiVersion: min, minAtlasVersion: min };
}

// ── Queries ────────────────────────────────────────────────────────────────

/**
 * Get all active store items with optional filters
 */
export const list = query({
  args: {
    type: v.optional(v.string()),
    category: v.optional(v.string()),
    featured: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;

    let items;

    if (args.featured) {
      items = await ctx.db
        .query("store_items")
        .withIndex("by_featured")
        .filter((q) => q.eq(q.field("status"), "active"))
        .take(limit);
    } else if (args.type && args.category) {
      items = await ctx.db
        .query("store_items")
        .withIndex("by_status_type", (q) =>
          q.eq("status", "active").eq("type", args.type!)
        )
        .filter((q) => q.eq(q.field("category"), args.category))
        .take(limit);
    } else if (args.type) {
      items = await ctx.db
        .query("store_items")
        .withIndex("by_status_type", (q) =>
          q.eq("status", "active").eq("type", args.type!)
        )
        .take(limit);
    } else if (args.category) {
      items = await ctx.db
        .query("store_items")
        .withIndex("by_category", (q) => q.eq("category", args.category!))
        .filter((q) => q.eq(q.field("status"), "active"))
        .take(limit);
    } else {
      items = await ctx.db
        .query("store_items")
        .withIndex("by_installs")
        .filter((q) => q.eq(q.field("status"), "active"))
        .take(limit);
    }

    // Sort by install count for popularity
    return items.sort((a, b) => b.installCount - a.installCount);
  },
});

/**
 * Search store items by name
 */
export const search = query({
  args: {
    query: v.string(),
    type: v.optional(v.string()),
    category: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;

    let searchQuery = ctx.db
      .query("store_items")
      .withSearchIndex("search_items", (q) => {
        let search = q.search("name", args.query);
        if (args.type) search = search.eq("type", args.type);
        if (args.category) search = search.eq("category", args.category);
        search = search.eq("status", "active");
        return search;
      });

    return await searchQuery.take(limit);
  },
});

/**
 * Get a single store item by slug
 */
export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const item = await ctx.db
      .query("store_items")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();

    if (!item || item.status !== "active") {
      return null;
    }

    // Get developer info
    const developer = await ctx.db.get(item.developerId);

    // Get download URL for icon
    let iconUrl = null;
    if (item.iconFileId) {
      iconUrl = await ctx.storage.getUrl(item.iconFileId);
    }

    // Get screenshot URLs
    const screenshotUrls: string[] = [];
    if (item.screenshotFileIds) {
      for (const fileId of item.screenshotFileIds) {
        const url = await ctx.storage.getUrl(fileId);
        if (url) screenshotUrls.push(url);
      }
    }

    return {
      ...item,
      iconUrl,
      screenshotUrls,
      developer: developer ? {
        displayName: developer.displayName,
        companyName: developer.companyName,
      } : null,
    };
  },
});

/**
 * Get a single store item by ID
 */
export const getById = query({
  args: { itemId: v.id("store_items") },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (!item) return null;

    // Get download URL for content (for installation)
    const contentUrl = await ctx.storage.getUrl(item.contentFileId);

    return {
      ...item,
      contentUrl,
    };
  },
});

/**
 * Get items by developer
 */
export const getByDeveloper = query({
  args: { developerId: v.id("developers") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("store_items")
      .withIndex("by_developer", (q) => q.eq("developerId", args.developerId))
      .take(5000);
  },
});

/**
 * List items by developer (alias for developer portal)
 */
export const listByDeveloper = query({
  args: {
    developerId: v.string(), // Can be "current" or actual ID
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;

    // In real implementation, "current" would be resolved from session
    // For now, return all items if "current" is passed
    if (args.developerId === "current") {
      return [];
    }

    const items = await ctx.db
      .query("store_items")
      .withIndex("by_developer", (q) =>
        q.eq("developerId", args.developerId as any)
      )
      .take(limit);

    return items;
  },
});

/**
 * Get featured items for homepage
 */
export const getFeatured = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 10;

    return await ctx.db
      .query("store_items")
      .withIndex("by_featured")
      .filter((q) =>
        q.and(
          q.eq(q.field("status"), "active"),
          q.neq(q.field("featuredRank"), undefined)
        )
      )
      .take(limit);
  },
});

/**
 * Get trending items (most installs this week).
 *
 * Uses the compound by_status_weekly index declared on store_items
 * to fetch the top-N active rows in weeklyInstalls-descending order
 * without any in-memory sort. Correct at any catalog size — no
 * scan cap required.
 */
export const getTrending = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 10;

    return await ctx.db
      .query("store_items")
      .withIndex("by_status_weekly", (q) => q.eq("status", "active"))
      .order("desc")
      .take(limit);
  },
});

/**
 * Get all categories with item counts
 */
export const getCategories = query({
  handler: async (ctx) => {
    const items = await ctx.db
      .query("store_items")
      .filter((q) => q.eq(q.field("status"), "active"))
      .take(10000);

    const counts: Record<string, number> = {};
    for (const item of items) {
      counts[item.category] = (counts[item.category] || 0) + 1;
    }

    return Object.entries(counts).map(([name, count]) => ({ name, count }));
  },
});

// ── Mutations ──────────────────────────────────────────────────────────────

/**
 * Increment install count (called when user installs)
 */
export const incrementInstallCount = mutation({
  args: { itemId: v.id("store_items") },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (!item) throw new Error("Item not found");

    await ctx.db.patch(args.itemId, {
      installCount: item.installCount + 1,
      weeklyInstalls: item.weeklyInstalls + 1,
    });

    // Also update developer stats
    const developer = await ctx.db.get(item.developerId);
    if (developer) {
      await ctx.db.patch(item.developerId, {
        totalInstalls: developer.totalInstalls + 1,
      });
    }
  },
});

/**
 * Update item rating (recalculate average after new review)
 */
export const updateRating = mutation({
  args: {
    itemId: v.id("store_items"),
    newRating: v.number(),
  },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (!item) throw new Error("Item not found");

    // Calculate new average
    const totalRating = item.rating * item.ratingCount + args.newRating;
    const newCount = item.ratingCount + 1;
    const newAverage = totalRating / newCount;

    await ctx.db.patch(args.itemId, {
      rating: Math.round(newAverage * 10) / 10, // Round to 1 decimal
      ratingCount: newCount,
    });
  },
});

/**
 * Set featured rank for an item (admin only)
 */
export const setFeatured = mutation({
  args: {
    itemId: v.id("store_items"),
    rank: v.optional(v.number()), // null to unfeature
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.itemId, {
      featuredRank: args.rank,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Update item status (admin only)
 */
export const updateStatus = mutation({
  args: {
    itemId: v.id("store_items"),
    status: v.string(), // "active" | "deprecated" | "removed"
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.itemId, {
      status: args.status,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Create a new store item (called when submission is approved)
 */
export const create = mutation({
  args: {
    slug: v.string(),
    type: v.string(),
    name: v.string(),
    description: v.string(),
    longDescription: v.optional(v.string()),
    developerId: v.id("developers"),
    version: v.string(),
    changelog: v.optional(v.string()),
    minBhaiVersion: v.optional(v.string()),
    minAtlasVersion: v.optional(v.string()),
    contentFileId: v.id("_storage"),
    iconFileId: v.optional(v.id("_storage")),
    screenshotFileIds: v.optional(v.array(v.id("_storage"))),
    readmeFileId: v.optional(v.id("_storage")),
    category: v.string(),
    tags: v.array(v.string()),
    permissions: v.array(v.string()),
    pricing: v.string(),
    priceCredits: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Check slug uniqueness
    const existing = await ctx.db
      .query("store_items")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();

    if (existing) {
      throw new Error(`Slug "${args.slug}" already exists`);
    }

    const itemId = await ctx.db.insert("store_items", {
      ...args,
      ...minVersionFields(args),
      installCount: 0,
      rating: 0,
      ratingCount: 0,
      weeklyInstalls: 0,
      status: "active",
      featuredRank: undefined,
      createdAt: now,
      updatedAt: now,
      publishedAt: now,
    });

    // Update developer's total apps count
    const developer = await ctx.db.get(args.developerId);
    if (developer) {
      await ctx.db.patch(args.developerId, {
        totalApps: developer.totalApps + 1,
      });
    }

    return itemId;
  },
});

/**
 * Update an existing store item (for new version release)
 */
export const update = mutation({
  args: {
    itemId: v.id("store_items"),
    version: v.string(),
    changelog: v.optional(v.string()),
    description: v.optional(v.string()),
    longDescription: v.optional(v.string()),
    contentFileId: v.optional(v.id("_storage")),
    iconFileId: v.optional(v.id("_storage")),
    screenshotFileIds: v.optional(v.array(v.id("_storage"))),
    minBhaiVersion: v.optional(v.string()),
    minAtlasVersion: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    permissions: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const { itemId, minBhaiVersion, minAtlasVersion, ...updates } = args;

    await ctx.db.patch(itemId, {
      ...updates,
      ...((minBhaiVersion ?? minAtlasVersion) !== undefined ? minVersionFields(args) : {}),
      updatedAt: Date.now(),
    });
  },
});

/**
 * Reset weekly install counts (run weekly via cron)
 */
export const resetWeeklyInstalls = mutation({
  handler: async (ctx) => {
    // Weekly install reset; 10k cap to avoid a single mutation exceeding
    // Convex write limits. Catalogs larger than this should switch to a
    // paginated cron using ctx.scheduler.runAfter + a cursor.
    const items = await ctx.db.query("store_items").take(10000);

    for (const item of items) {
      await ctx.db.patch(item._id, { weeklyInstalls: 0 });
    }

    return { reset: items.length };
  },
});

/**
 * One-off, run by hand (npx convex run store/items:backfillMinBhaiVersion):
 * copies minAtlasVersion into minBhaiVersion on rows from before the rename.
 * Never scheduled. Same 10k cap as resetWeeklyInstalls.
 */
export const backfillMinBhaiVersion = mutation({
  args: {},
  handler: async (ctx) => {
    let patched = 0;
    for (const table of ["store_items", "submissions"] as const) {
      for (const row of await ctx.db.query(table).take(10000)) {
        if (row.minAtlasVersion !== undefined && row.minBhaiVersion === undefined) {
          await ctx.db.patch(row._id, { minBhaiVersion: row.minAtlasVersion });
          patched++;
        }
      }
    }
    return { patched };
  },
});
