// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Reviews and ratings for store items

import { v } from "convex/values";
import { internalQuery as query, internalMutation as mutation } from "../_generated/server";

// ── Queries ────────────────────────────────────────────────────────────────

/**
 * Get reviews for an item.
 *
 * Does NOT enrich with reviewer names — reviewers haven't opted into
 * having their account name shown alongside their reviews, and exposing
 * it lets any caller correlate userId → name across the catalog.
 */
export const getByItem = query({
  args: {
    itemId: v.id("store_items"),
    limit: v.optional(v.number()),
    sortBy: v.optional(v.string()), // "recent" | "helpful"
  },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(1, args.limit ?? 20), 100);

    let reviews;

    if (args.sortBy === "helpful") {
      reviews = await ctx.db
        .query("store_reviews")
        .withIndex("by_helpful", (q) => q.eq("itemId", args.itemId))
        .order("desc")
        .take(limit);
    } else {
      reviews = await ctx.db
        .query("store_reviews")
        .withIndex("by_item", (q) => q.eq("itemId", args.itemId))
        .order("desc")
        .take(limit);
    }

    // Never the reviewer's account id: it is what /api/auth/session takes, so handing it
    // to every signed-in user exposed reviewers' accounts.
    return reviews.map(({ userId: _userId, ...rest }) => rest);
  },
});

/**
 * Get a user's review for an item
 */
export const getUserReview = query({
  args: {
    userId: v.string(),
    itemId: v.id("store_items"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("store_reviews")
      .withIndex("by_user_item", (q) =>
        q.eq("userId", args.userId).eq("itemId", args.itemId)
      )
      .first();
  },
});

/**
 * Get review summary for an item
 */
export const getSummary = query({
  args: { itemId: v.id("store_items") },
  handler: async (ctx, args) => {
    // getSummary reads every review per item to compute the rating
    // distribution. 10k cap handles all realistic items; beyond that
    // this should be a denormalized summary doc on store_items itself.
    const reviews = await ctx.db
      .query("store_reviews")
      .withIndex("by_item", (q) => q.eq("itemId", args.itemId))
      .take(10000);

    if (reviews.length === 0) {
      return {
        totalReviews: 0,
        averageRating: 0,
        distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      };
    }

    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let totalRating = 0;

    for (const review of reviews) {
      distribution[review.rating]++;
      totalRating += review.rating;
    }

    return {
      totalReviews: reviews.length,
      averageRating: Math.round((totalRating / reviews.length) * 10) / 10,
      distribution,
    };
  },
});

/**
 * Get all reviews by a user.
 *
 * Cap at 500 — a user with >500 reviews is unusual but possible for
 * long-tenured accounts. Raise further if that's expected; beyond ~5k
 * this should paginate.
 */
export const getByUser = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const reviews = await ctx.db
      .query("store_reviews")
      .filter((q) => q.eq(q.field("userId"), args.userId))
      .order("desc")
      .take(500);

    // Enrich with item info
    const enriched = await Promise.all(
      reviews.map(async (review) => {
        const item = await ctx.db.get(review.itemId);
        return {
          ...review,
          itemName: item?.name || "Unknown",
          itemType: item?.type || "unknown",
        };
      })
    );

    return enriched;
  },
});

// ── Mutations ──────────────────────────────────────────────────────────────

/**
 * Create or update a review
 */
export const submit = mutation({
  args: {
    userId: v.string(),
    itemId: v.id("store_items"),
    rating: v.number(),
    title: v.optional(v.string()),
    review: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Validate rating
    if (args.rating < 1 || args.rating > 5) {
      throw new Error("Rating must be between 1 and 5");
    }

    // Check if item exists
    const item = await ctx.db.get(args.itemId);
    if (!item) throw new Error("Item not found");

    // Check if user has installed the item
    const install = await ctx.db
      .query("store_installs")
      .withIndex("by_user_item", (q) =>
        q.eq("userId", args.userId).eq("itemId", args.itemId)
      )
      .first();

    if (!install) {
      throw new Error("You must install the item before reviewing");
    }

    const now = Date.now();

    // Check for existing review
    const existing = await ctx.db
      .query("store_reviews")
      .withIndex("by_user_item", (q) =>
        q.eq("userId", args.userId).eq("itemId", args.itemId)
      )
      .first();

    if (existing) {
      // Update existing review
      const oldRating = existing.rating;

      await ctx.db.patch(existing._id, {
        rating: args.rating,
        title: args.title,
        review: args.review,
        updatedAt: now,
      });

      // Update item average rating
      const totalRating = item.rating * item.ratingCount - oldRating + args.rating;
      const newAverage = totalRating / item.ratingCount;

      await ctx.db.patch(args.itemId, {
        rating: Math.round(newAverage * 10) / 10,
      });

      return existing._id;
    } else {
      // Create new review
      const reviewId = await ctx.db.insert("store_reviews", {
        userId: args.userId,
        itemId: args.itemId,
        rating: args.rating,
        title: args.title,
        review: args.review,
        helpful: 0,
        createdAt: now,
        updatedAt: now,
      });

      // Update item rating
      const totalRating = item.rating * item.ratingCount + args.rating;
      const newCount = item.ratingCount + 1;
      const newAverage = totalRating / newCount;

      await ctx.db.patch(args.itemId, {
        rating: Math.round(newAverage * 10) / 10,
        ratingCount: newCount,
      });

      // Log activity
      await ctx.db.insert("store_activity_log", {
        type: "review",
        userId: args.userId,
        itemId: args.itemId,
        metadata: JSON.stringify({ rating: args.rating }),
        timestamp: now,
      });

      return reviewId;
    }
  },
});

/**
 * Delete a review
 */
export const remove = mutation({
  args: {
    userId: v.string(),
    reviewId: v.id("store_reviews"),
  },
  handler: async (ctx, args) => {
    const review = await ctx.db.get(args.reviewId);
    if (!review) throw new Error("Review not found");
    if (review.userId !== args.userId) {
      throw new Error("You can only delete your own reviews");
    }

    // Update item rating
    const item = await ctx.db.get(review.itemId);
    if (item && item.ratingCount > 1) {
      const totalRating = item.rating * item.ratingCount - review.rating;
      const newCount = item.ratingCount - 1;
      const newAverage = totalRating / newCount;

      await ctx.db.patch(review.itemId, {
        rating: Math.round(newAverage * 10) / 10,
        ratingCount: newCount,
      });
    } else if (item) {
      // Last review - reset rating
      await ctx.db.patch(review.itemId, {
        rating: 0,
        ratingCount: 0,
      });
    }

    await ctx.db.delete(args.reviewId);
  },
});

/**
 * Mark a review as helpful
 */
export const markHelpful = mutation({
  args: {
    reviewId: v.id("store_reviews"),
    userId: v.string(), // set by the HTTP route from the session, never the caller
  },
  handler: async (ctx, args) => {
    const review = await ctx.db.get(args.reviewId);
    if (!review) throw new Error("Review not found");
    const by = review.helpfulBy ?? [];
    if (by.includes(args.userId)) return; // one vote each

    await ctx.db.patch(args.reviewId, {
      helpful: review.helpful + 1,
      helpfulBy: [...by, args.userId],
    });
  },
});

/**
 * Admin: Delete any review
 */
export const adminDelete = mutation({
  args: {
    reviewId: v.id("store_reviews"),
    adminId: v.id("admins"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const review = await ctx.db.get(args.reviewId);
    if (!review) throw new Error("Review not found");

    // Update item rating
    const item = await ctx.db.get(review.itemId);
    if (item && item.ratingCount > 1) {
      const totalRating = item.rating * item.ratingCount - review.rating;
      const newCount = item.ratingCount - 1;
      const newAverage = totalRating / newCount;

      await ctx.db.patch(review.itemId, {
        rating: Math.round(newAverage * 10) / 10,
        ratingCount: newCount,
      });
    } else if (item) {
      await ctx.db.patch(review.itemId, {
        rating: 0,
        ratingCount: 0,
      });
    }

    // Log activity
    await ctx.db.insert("store_activity_log", {
      type: "review_deleted",
      userId: review.userId,
      itemId: review.itemId,
      adminId: args.adminId,
      metadata: JSON.stringify({ reason: args.reason }),
      timestamp: Date.now(),
    });

    await ctx.db.delete(args.reviewId);
  },
});
