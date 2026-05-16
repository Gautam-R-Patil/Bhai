// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// App submission handling for the store

import { v } from "convex/values";
import { internalQuery as query, internalMutation as mutation } from "../_generated/server";

// ── Queries ────────────────────────────────────────────────────────────────

/**
 * Get submission by ID
 */
export const getById = query({
  args: { submissionId: v.id("submissions") },
  handler: async (ctx, args) => {
    const submission = await ctx.db.get(args.submissionId);
    if (!submission) return null;

    // Get file URLs
    const contentUrl = await ctx.storage.getUrl(submission.contentFileId);

    let iconUrl = null;
    if (submission.iconFileId) {
      iconUrl = await ctx.storage.getUrl(submission.iconFileId);
    }

    const screenshotUrls: string[] = [];
    if (submission.screenshotFileIds) {
      for (const fileId of submission.screenshotFileIds) {
        const url = await ctx.storage.getUrl(fileId);
        if (url) screenshotUrls.push(url);
      }
    }

    // Get developer info
    const developer = await ctx.db.get(submission.developerId);

    return {
      ...submission,
      contentUrl,
      iconUrl,
      screenshotUrls,
      developer: developer
        ? {
            displayName: developer.displayName,
            email: developer.email,
            companyName: developer.companyName,
          }
        : null,
    };
  },
});

/**
 * List submissions by status (for admin panel)
 */
export const listByStatus = query({
  args: {
    status: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;

    const submissions = await ctx.db
      .query("submissions")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .order("desc")
      .take(limit);

    // Enrich with developer info
    const enriched = await Promise.all(
      submissions.map(async (sub) => {
        const developer = await ctx.db.get(sub.developerId);
        return {
          ...sub,
          developerName: developer?.displayName || "Unknown",
        };
      })
    );

    return enriched;
  },
});

/**
 * Get pending submissions count (for admin dashboard badge)
 */
export const getPendingCount = query({
  handler: async (ctx) => {
    // 5k cap; see denormalization TODO in store/admins.ts. If pending
    // submissions grow past this the badge will undercount — swap to a
    // counter maintained by the submit/approve/reject mutations.
    const pending = await ctx.db
      .query("submissions")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .take(5000);

    return pending.length;
  },
});

/**
 * Get submissions by developer
 */
export const getByDeveloper = query({
  args: {
    developerId: v.id("developers"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;

    return await ctx.db
      .query("submissions")
      .withIndex("by_developer", (q) => q.eq("developerId", args.developerId))
      .order("desc")
      .take(limit);
  },
});

/**
 * List submissions by developer (alias for frontend)
 */
export const listByDeveloper = query({
  args: {
    developerId: v.id("developers"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;

    return await ctx.db
      .query("submissions")
      .withIndex("by_developer", (q) => q.eq("developerId", args.developerId))
      .order("desc")
      .take(limit);
  },
});

/**
 * List pending submissions (for admin dashboard)
 */
export const listPending = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;

    const submissions = await ctx.db
      .query("submissions")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .order("desc")
      .take(limit);

    // Enrich with developer info
    const enriched = await Promise.all(
      submissions.map(async (sub) => {
        const developer = await ctx.db.get(sub.developerId);
        return {
          ...sub,
          developerName: developer?.displayName || "Unknown",
        };
      })
    );

    return enriched;
  },
});

/**
 * List submissions across all statuses (admin "All" filter).
 * Sorted newest-first via the _creationTime index; capped at `limit`.
 */
export const list = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const submissions = await ctx.db.query("submissions").order("desc").take(limit);
    const enriched = await Promise.all(
      submissions.map(async (sub) => {
        const developer = await ctx.db.get(sub.developerId);
        return { ...sub, developerName: developer?.displayName || "Unknown" };
      }),
    );
    return enriched;
  },
});

// ── Mutations ──────────────────────────────────────────────────────────────

/**
 * Create a new submission
 */
export const create = mutation({
  args: {
    developerId: v.id("developers"),
    existingItemId: v.optional(v.id("store_items")),
    isUpdate: v.boolean(),
    type: v.string(),
    name: v.string(),
    slug: v.string(),
    description: v.string(),
    longDescription: v.optional(v.string()),
    version: v.string(),
    changelog: v.optional(v.string()),
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
    // Verify developer is approved
    const developer = await ctx.db.get(args.developerId);
    if (!developer) throw new Error("Developer not found");
    if (developer.status !== "approved") {
      throw new Error("Developer account not approved");
    }

    // If it's an update, verify the developer owns the item
    if (args.isUpdate && args.existingItemId) {
      const existingItem = await ctx.db.get(args.existingItemId);
      if (!existingItem) throw new Error("Item not found");
      if (!existingItem.developerId.equals(args.developerId)) {
        throw new Error("You don't own this item");
      }
    }

    // Check slug uniqueness (for new submissions)
    if (!args.isUpdate) {
      const existingSlug = await ctx.db
        .query("store_items")
        .withIndex("by_slug", (q) => q.eq("slug", args.slug))
        .first();

      if (existingSlug) {
        throw new Error(`Slug "${args.slug}" already exists`);
      }

      // Also check pending submissions
      const pendingWithSlug = await ctx.db
        .query("submissions")
        .filter((q) =>
          q.and(
            q.eq(q.field("slug"), args.slug),
            q.neq(q.field("status"), "rejected")
          )
        )
        .first();

      if (pendingWithSlug) {
        throw new Error(`Slug "${args.slug}" is already pending review`);
      }
    }

    const now = Date.now();

    const submissionId = await ctx.db.insert("submissions", {
      ...args,
      status: "pending",
      reviewNotes: undefined,
      reviewedBy: undefined,
      reviewedAt: undefined,
      submittedAt: now,
    });

    // Log activity
    await ctx.db.insert("store_activity_log", {
      type: "submission",
      developerId: args.developerId,
      metadata: JSON.stringify({
        submissionId,
        name: args.name,
        isUpdate: args.isUpdate,
      }),
      timestamp: now,
    });

    return submissionId;
  },
});

/**
 * Start reviewing a submission (mark as in_review)
 */
export const startReview = mutation({
  args: {
    submissionId: v.id("submissions"),
    adminId: v.id("admins"),
  },
  handler: async (ctx, args) => {
    const submission = await ctx.db.get(args.submissionId);
    if (!submission) throw new Error("Submission not found");
    if (submission.status !== "pending") {
      throw new Error("Submission is not pending");
    }

    await ctx.db.patch(args.submissionId, {
      status: "in_review",
      reviewedBy: args.adminId,
    });
  },
});

/**
 * Approve a submission (publishes to store)
 */
export const approve = mutation({
  args: {
    submissionId: v.id("submissions"),
    adminId: v.id("admins"),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const submission = await ctx.db.get(args.submissionId);
    if (!submission) throw new Error("Submission not found");

    const now = Date.now();

    // Update submission status
    await ctx.db.patch(args.submissionId, {
      status: "approved",
      reviewNotes: args.notes,
      reviewedBy: args.adminId,
      reviewedAt: now,
    });

    // Create or update store item
    if (submission.isUpdate && submission.existingItemId) {
      // Update existing item
      await ctx.db.patch(submission.existingItemId, {
        version: submission.version,
        changelog: submission.changelog,
        description: submission.description,
        longDescription: submission.longDescription,
        contentFileId: submission.contentFileId,
        iconFileId: submission.iconFileId,
        screenshotFileIds: submission.screenshotFileIds,
        minAtlasVersion: submission.minAtlasVersion,
        tags: submission.tags,
        permissions: submission.permissions,
        updatedAt: now,
      });

      // Log activity
      await ctx.db.insert("store_activity_log", {
        type: "approval",
        developerId: submission.developerId,
        itemId: submission.existingItemId,
        adminId: args.adminId,
        metadata: JSON.stringify({
          submissionId: args.submissionId,
          type: "update",
          version: submission.version,
        }),
        timestamp: now,
      });
    } else {
      // Create new item
      const itemId = await ctx.db.insert("store_items", {
        slug: submission.slug,
        type: submission.type,
        name: submission.name,
        description: submission.description,
        longDescription: submission.longDescription,
        developerId: submission.developerId,
        version: submission.version,
        changelog: submission.changelog,
        minAtlasVersion: submission.minAtlasVersion,
        contentFileId: submission.contentFileId,
        iconFileId: submission.iconFileId,
        screenshotFileIds: submission.screenshotFileIds,
        readmeFileId: submission.readmeFileId,
        category: submission.category,
        tags: submission.tags,
        permissions: submission.permissions,
        pricing: submission.pricing,
        priceCredits: submission.priceCredits,
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

      // Update developer stats
      const developer = await ctx.db.get(submission.developerId);
      if (developer) {
        await ctx.db.patch(submission.developerId, {
          totalApps: developer.totalApps + 1,
        });
      }

      // Log activity
      await ctx.db.insert("store_activity_log", {
        type: "approval",
        developerId: submission.developerId,
        itemId,
        adminId: args.adminId,
        metadata: JSON.stringify({
          submissionId: args.submissionId,
          type: "new",
          version: submission.version,
        }),
        timestamp: now,
      });
    }
  },
});

/**
 * Reject a submission
 */
export const reject = mutation({
  args: {
    submissionId: v.id("submissions"),
    adminId: v.id("admins"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const submission = await ctx.db.get(args.submissionId);
    if (!submission) throw new Error("Submission not found");

    const now = Date.now();

    await ctx.db.patch(args.submissionId, {
      status: "rejected",
      reviewNotes: args.reason,
      reviewedBy: args.adminId,
      reviewedAt: now,
    });

    // Log activity
    await ctx.db.insert("store_activity_log", {
      type: "rejection",
      developerId: submission.developerId,
      adminId: args.adminId,
      metadata: JSON.stringify({
        submissionId: args.submissionId,
        reason: args.reason,
      }),
      timestamp: now,
    });
  },
});

/**
 * Request revision on a submission
 */
export const requestRevision = mutation({
  args: {
    submissionId: v.id("submissions"),
    adminId: v.id("admins"),
    notes: v.string(),
  },
  handler: async (ctx, args) => {
    const submission = await ctx.db.get(args.submissionId);
    if (!submission) throw new Error("Submission not found");

    const now = Date.now();

    await ctx.db.patch(args.submissionId, {
      status: "revision_requested",
      reviewNotes: args.notes,
      reviewedBy: args.adminId,
      reviewedAt: now,
    });

    // Log activity
    await ctx.db.insert("store_activity_log", {
      type: "revision_requested",
      developerId: submission.developerId,
      adminId: args.adminId,
      metadata: JSON.stringify({
        submissionId: args.submissionId,
        notes: args.notes,
      }),
      timestamp: now,
    });
  },
});

/**
 * Resubmit after revision (developer action)
 */
export const resubmit = mutation({
  args: {
    submissionId: v.id("submissions"),
    developerId: v.id("developers"),
    contentFileId: v.optional(v.id("_storage")),
    iconFileId: v.optional(v.id("_storage")),
    screenshotFileIds: v.optional(v.array(v.id("_storage"))),
    description: v.optional(v.string()),
    longDescription: v.optional(v.string()),
    changelog: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const submission = await ctx.db.get(args.submissionId);
    if (!submission) throw new Error("Submission not found");
    if (!submission.developerId.equals(args.developerId)) {
      throw new Error("You don't own this submission");
    }
    if (submission.status !== "revision_requested") {
      throw new Error("Submission is not awaiting revision");
    }

    const now = Date.now();

    // Build updates
    const updates: Record<string, unknown> = {
      status: "pending",
      reviewNotes: undefined,
      submittedAt: now,
    };

    if (args.contentFileId) updates.contentFileId = args.contentFileId;
    if (args.iconFileId) updates.iconFileId = args.iconFileId;
    if (args.screenshotFileIds) updates.screenshotFileIds = args.screenshotFileIds;
    if (args.description) updates.description = args.description;
    if (args.longDescription) updates.longDescription = args.longDescription;
    if (args.changelog) updates.changelog = args.changelog;

    await ctx.db.patch(args.submissionId, updates);

    // Log activity
    await ctx.db.insert("store_activity_log", {
      type: "resubmission",
      developerId: args.developerId,
      metadata: JSON.stringify({ submissionId: args.submissionId }),
      timestamp: now,
    });
  },
});

/**
 * Cancel a submission (developer action)
 */
export const cancel = mutation({
  args: {
    submissionId: v.id("submissions"),
    developerId: v.id("developers"),
  },
  handler: async (ctx, args) => {
    const submission = await ctx.db.get(args.submissionId);
    if (!submission) throw new Error("Submission not found");
    if (!submission.developerId.equals(args.developerId)) {
      throw new Error("You don't own this submission");
    }
    if (submission.status === "approved") {
      throw new Error("Cannot cancel approved submission");
    }

    // Delete the submission
    await ctx.db.delete(args.submissionId);

    // Clean up uploaded files
    if (submission.contentFileId) {
      await ctx.storage.delete(submission.contentFileId);
    }
    if (submission.iconFileId) {
      await ctx.storage.delete(submission.iconFileId);
    }
    if (submission.screenshotFileIds) {
      for (const fileId of submission.screenshotFileIds) {
        await ctx.storage.delete(fileId);
      }
    }
    if (submission.readmeFileId) {
      await ctx.storage.delete(submission.readmeFileId);
    }
  },
});
