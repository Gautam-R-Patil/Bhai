// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Convex database schema for A.T.L.A.S account management and store.

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // ── User Accounts (existing) ─────────────────────────────────────────────
  accounts: defineTable({
    otplessUserId: v.string(),      // Primary identity from OTPless
    email: v.optional(v.string()),  // From OTPless identity
    phone: v.optional(v.string()),  // From OTPless identity
    name: v.optional(v.string()),   // Display name
    status: v.string(),             // "active" | "suspended" | "blocked"
    plan: v.string(),               // "free" | "pro" | "enterprise"
    ai_credits: v.number(),         // Remaining AI credits
    activations: v.number(),        // Current device activations
    max_activations: v.number(),    // Max allowed activations
  })
    .index("by_otpless_id", ["otplessUserId"])
    .index("by_email", ["email"]),

  // ── Sessions (server-side token auth — replaces client-side deploy key) ──
  sessions: defineTable({
    otplessUserId: v.string(),       // Links to accounts.otplessUserId
    token: v.string(),               // Crypto-random session token (client credential)
    expiresAt: v.number(),           // Unix timestamp (ms), 24h TTL
    deviceFingerprint: v.optional(v.string()),  // Optional device binding
    sharedKey: v.optional(v.string()),           // ECDH-derived AES-256 key (base64) for E2E encryption
    createdAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_user", ["otplessUserId"])
    .index("by_expires", ["expiresAt"]),

  // ── Rate Limits (per-session sliding window counters) ───────────────────
  rate_limits: defineTable({
    sessionToken: v.string(),        // Links to sessions.token
    windowStart: v.number(),         // Start of the current 60s window (Unix ms)
    requestCount: v.number(),        // Number of requests in this window
  })
    .index("by_token", ["sessionToken"]),

  // ── Request rate limits (per-IP sliding window for unauthenticated paths)
  request_rate_limits: defineTable({
    key: v.string(),                 // composite: "<route>|<ip>"
    windowStart: v.number(),         // Start of the current window (Unix ms)
    requestCount: v.number(),        // Number of requests in this window
  })
    .index("by_key", ["key"]),

  // ══════════════════════════════════════════════════════════════════════════
  // A.T.L.A.S STORE - Marketplace for Skills, MCP Servers, and Tools
  // ══════════════════════════════════════════════════════════════════════════

  // ── Developers (must be approved before publishing) ──────────────────────
  developers: defineTable({
    // Auth
    email: v.string(),
    passwordHash: v.string(),            // bcrypt hashed

    // Profile
    displayName: v.string(),
    companyName: v.optional(v.string()),
    website: v.optional(v.string()),
    bio: v.optional(v.string()),
    avatarFileId: v.optional(v.id("_storage")),

    // Verification
    status: v.string(),                  // "pending" | "approved" | "rejected" | "suspended" | "banned"
    verificationNotes: v.optional(v.string()),  // Why rejected/suspended
    approvedBy: v.optional(v.string()),  // Admin who approved
    approvedAt: v.optional(v.number()),

    // Stats
    totalApps: v.number(),
    totalInstalls: v.number(),

    // Timestamps
    createdAt: v.number(),
    lastLoginAt: v.optional(v.number()),
  })
    .index("by_email", ["email"])
    .index("by_status", ["status"]),

  // ── Admin Users (for admin panel) ────────────────────────────────────────
  admins: defineTable({
    email: v.string(),
    passwordHash: v.string(),
    name: v.string(),
    role: v.string(),                    // "super_admin" | "moderator" | "reviewer"
    permissions: v.array(v.string()),    // ["approve_devs", "approve_apps", "manage_users", etc.]
    lastLoginAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_email", ["email"]),

  // ── Store Items (approved, published items) ──────────────────────────────
  store_items: defineTable({
    slug: v.string(),                    // URL-friendly unique ID
    type: v.string(),                    // "skill" | "mcp" | "tool"
    name: v.string(),
    description: v.string(),             // Short description (max 200 chars)
    longDescription: v.optional(v.string()), // Full markdown description

    developerId: v.id("developers"),

    version: v.string(),                 // Semver: "1.0.0"
    changelog: v.optional(v.string()),
    minAtlasVersion: v.optional(v.string()), // Minimum A.T.L.A.S version required

    // File references (Convex storage)
    contentFileId: v.id("_storage"),     // Main content (skill.md, bundle.zip)
    iconFileId: v.optional(v.id("_storage")),
    screenshotFileIds: v.optional(v.array(v.id("_storage"))),
    readmeFileId: v.optional(v.id("_storage")),

    // Metadata
    category: v.string(),                // "automation" | "research" | "coding" | "productivity" | "media" | "communication" | "utilities"
    tags: v.array(v.string()),
    permissions: v.array(v.string()),    // Required permissions: ["file_system", "network", "shell", etc.]

    // Pricing (for future)
    pricing: v.string(),                 // "free" | "paid" | "freemium"
    priceCredits: v.optional(v.number()),

    // Stats
    installCount: v.number(),
    rating: v.number(),                  // 0-5 average
    ratingCount: v.number(),
    weeklyInstalls: v.number(),          // For trending

    // Status
    status: v.string(),                  // "active" | "deprecated" | "removed"
    featuredRank: v.optional(v.number()), // For featured section (lower = higher priority)

    // Timestamps
    createdAt: v.number(),
    updatedAt: v.number(),
    publishedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_type", ["type"])
    .index("by_developer", ["developerId"])
    .index("by_category", ["category"])
    .index("by_status_type", ["status", "type"])
    .index("by_featured", ["featuredRank"])
    .index("by_installs", ["installCount"])
    // Used by store/items.ts::getTrending for ORDER BY weeklyInstalls DESC
    // WHERE status='active'. Without this compound index the query would
    // have to scan every active row and sort in memory, which breaks once
    // the catalog exceeds the scan cap.
    .index("by_status_weekly", ["status", "weeklyInstalls"])
    .searchIndex("search_items", {
      searchField: "name",
      filterFields: ["type", "category", "status"],
    }),

  // ── Submissions (pending review - for new apps or updates) ───────────────
  submissions: defineTable({
    developerId: v.id("developers"),

    // Can be new item or update to existing
    existingItemId: v.optional(v.id("store_items")),
    isUpdate: v.boolean(),

    type: v.string(),                    // "skill" | "mcp" | "tool"
    name: v.string(),
    slug: v.string(),                    // Proposed slug
    description: v.string(),
    longDescription: v.optional(v.string()),
    version: v.string(),
    changelog: v.optional(v.string()),
    minAtlasVersion: v.optional(v.string()),

    // Uploaded files
    contentFileId: v.id("_storage"),
    iconFileId: v.optional(v.id("_storage")),
    screenshotFileIds: v.optional(v.array(v.id("_storage"))),
    readmeFileId: v.optional(v.id("_storage")),

    // Metadata
    category: v.string(),
    tags: v.array(v.string()),
    permissions: v.array(v.string()),
    pricing: v.string(),
    priceCredits: v.optional(v.number()),

    // Review status
    status: v.string(),                  // "pending" | "in_review" | "approved" | "rejected" | "revision_requested"
    reviewNotes: v.optional(v.string()), // Admin feedback
    reviewedBy: v.optional(v.id("admins")),
    reviewedAt: v.optional(v.number()),

    // Timestamps
    submittedAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_developer", ["developerId"])
    .index("by_submitted", ["submittedAt"]),

  // ── User Installs (tracks what each user has installed) ──────────────────
  store_installs: defineTable({
    userId: v.string(),                  // otplessUserId from accounts
    itemId: v.id("store_items"),
    itemSlug: v.string(),                // Denormalized for quick lookup
    itemType: v.string(),                // "skill" | "mcp" | "tool"
    version: v.string(),                 // Installed version
    installedAt: v.number(),
    updatedAt: v.number(),
    autoUpdate: v.boolean(),             // Auto-update enabled (default true)
  })
    .index("by_user", ["userId"])
    .index("by_item", ["itemId"])
    .index("by_user_item", ["userId", "itemId"]),

  // ── Reviews/Ratings ──────────────────────────────────────────────────────
  store_reviews: defineTable({
    userId: v.string(),
    itemId: v.id("store_items"),
    rating: v.number(),                  // 1-5
    title: v.optional(v.string()),
    review: v.optional(v.string()),
    helpful: v.number(),                 // Upvotes
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_item", ["itemId"])
    .index("by_user_item", ["userId", "itemId"])
    .index("by_helpful", ["itemId", "helpful"]),

  // ── Activity Log (for admin panel analytics) ─────────────────────────────
  store_activity_log: defineTable({
    type: v.string(),                    // "install" | "uninstall" | "update" | "review" | "submission" | "approval"
    userId: v.optional(v.string()),      // User who performed action
    developerId: v.optional(v.id("developers")),
    itemId: v.optional(v.id("store_items")),
    adminId: v.optional(v.id("admins")),
    metadata: v.optional(v.string()),    // JSON string with extra data
    timestamp: v.number(),
  })
    .index("by_type", ["type"])
    .index("by_timestamp", ["timestamp"])
    .index("by_item", ["itemId"]),

  // ══════════════════════════════════════════════════════════════════════════
  // SYSTEM CONTENT - Server-side prompts and skills (never sent to client)
  // ══════════════════════════════════════════════════════════════════════════

  // ── System Prompts (identity, rules, browsing, etc.) ────────────────────
  system_prompts: defineTable({
    slug: v.string(),                    // "identity" | "rules" | "rules-mac" | "rules-windows" | "browsing"
    content: v.string(),                 // Full markdown content
    version: v.number(),                 // Bumped on each edit
    updatedAt: v.number(),
    updatedBy: v.optional(v.string()),   // Admin email/ID who made the change
  })
    .index("by_slug", ["slug"]),

  // ── System Skills (built-in skills managed server-side) ─────────────────
  system_skills: defineTable({
    slug: v.string(),                    // "coding_best_practices", "data_scientist", etc.
    name: v.string(),                    // Display name
    description: v.string(),             // Short description
    instructions: v.string(),            // Full skill instructions (markdown)
    categories: v.array(v.string()),     // Tool-router categories: ["shell", "file_system", etc.]
    isActive: v.boolean(),               // Can be disabled without deleting
    version: v.number(),
    updatedAt: v.number(),
    updatedBy: v.optional(v.string()),
  })
    .index("by_slug", ["slug"])
    .index("by_active", ["isActive"]),

  // ══════════════════════════════════════════════════════════════════════════
  // LLM USAGE COUNTERS — Denormalized per-model counters for the admin dashboard.
  // Incremented atomically by the LLM proxy after each successful provider
  // response. Cheaper than scanning request logs at admin-page load time.
  // ══════════════════════════════════════════════════════════════════════════
  llm_usage_counters: defineTable({
    model: v.string(),               // OpenRouter model id, e.g. "anthropic/claude-sonnet-4.6"
    count: v.number(),               // total successful invocations
    creditsCharged: v.number(),      // total credits deducted for this model
    lastCalledAt: v.number(),        // most recent successful call (Unix ms)
  }).index("by_model", ["model"]),

  // ── Per-call LLM log. One row per /api/llm/chat invocation, success or
  // failure. The aggregate counters above are still authoritative for "top
  // models" because they're cheap to read; this table is the drill-down for
  // the admin LLM Logs page. Swept nightly to keep the table bounded.
  llm_call_log: defineTable({
    accountId: v.optional(v.id("accounts")),
    otplessUserId: v.optional(v.string()),
    model: v.string(),
    status: v.string(),              // "success" | "failed" | "rejected"
    credits: v.number(),             // 0 when failed/rejected before billing
    latencyMs: v.number(),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
    hasMedia: v.optional(v.boolean()),
    timestamp: v.number(),
  })
    .index("by_timestamp", ["timestamp"])
    .index("by_account_timestamp", ["accountId", "timestamp"])
    .index("by_model_timestamp", ["model", "timestamp"])
    .index("by_status_timestamp", ["status", "timestamp"]),

  // ── Generic error log writable by any subsystem (LLM proxy, auth,
  // sessions, waitlist, admin, etc.). The dashboard's "Recent Errors"
  // panel reads from here so issues across the whole backend surface in
  // one place — `store_activity_log` was scoped to marketplace events
  // and missed everything else. Swept nightly.
  error_log: defineTable({
    source: v.string(),              // "llm_proxy" | "auth" | "session" | "waitlist" | "store" | "admin" | "system"
    type: v.string(),                // short error code, e.g. "openrouter_5xx", "credit_deduction_failed"
    message: v.string(),             // human-readable summary
    metadata: v.optional(v.string()),// JSON-stringified details (stack, request id, model, etc.)
    accountId: v.optional(v.id("accounts")),
    otplessUserId: v.optional(v.string()),
    ipAddress: v.optional(v.string()),
    severity: v.string(),            // "error" | "warning" | "info"
    timestamp: v.number(),
  })
    .index("by_timestamp", ["timestamp"])
    .index("by_source_timestamp", ["source", "timestamp"])
    .index("by_severity_timestamp", ["severity", "timestamp"]),

  // ══════════════════════════════════════════════════════════════════════════
  // WAITLIST — Isolated marketing signup pipeline. No foreign keys to anything;
  // public submit endpoint writes here directly, admin panel reads via the
  // ADMIN_API_KEY-gated /api/admin/waitlist routes.
  // ══════════════════════════════════════════════════════════════════════════
  waitlist: defineTable({
    firstName: v.string(),
    lastName: v.string(),
    email: v.string(),
    role: v.string(),
    company: v.optional(v.string()),
    useCase: v.string(),
    status: v.string(),                  // "new" | "contacted" | "accepted" | "rejected"
    adminNotes: v.optional(v.string()),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    referrer: v.optional(v.string()),
    submittedAt: v.number(),
    // Applicant-facing email delivery status (separate from status-change history).
    // Surfaced in the admin panel so failures get a Resend button.
    lastEmailKind: v.optional(v.string()),    // "contacted" | "accepted"
    lastEmailStatus: v.optional(v.string()),  // "sent" | "failed"
    lastEmailError: v.optional(v.string()),
    lastEmailAt: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_email", ["email"])
    .index("by_submittedAt", ["submittedAt"]),

  // ── Per-user bot-authored prompt addenda (layered on top of core prompts)
  // Bot CANNOT edit system_prompts/system_skills. It writes here instead, per
  // user, and the assembler appends these after the core prompts.
  user_prompt_addenda: defineTable({
    otplessUserId: v.string(),
    slug: v.string(),                    // e.g. "self-improvement" or "skill-coding-style"
    kind: v.union(
      v.literal("personality"),
      v.literal("skill"),
      v.literal("memory"),
    ),
    title: v.string(),
    content: v.string(),                 // markdown, ≤ 50KB enforced at write
    version: v.number(),
    isActive: v.boolean(),
    hits: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["otplessUserId"])
    .index("by_user_active", ["otplessUserId", "isActive"])
    .index("by_user_slug", ["otplessUserId", "slug"]),

  user_prompt_addendum_history: defineTable({
    otplessUserId: v.string(),
    addendumId: v.id("user_prompt_addenda"),
    slug: v.string(),
    content: v.string(),
    version: v.number(),
    authoredAt: v.number(),
    reason: v.string(),                  // why the bot made this edit
    revertedFrom: v.optional(v.number()),
  })
    .index("by_addendum_version", ["addendumId", "version"])
    .index("by_user", ["otplessUserId"])
    .index("by_user_authoredAt", ["otplessUserId", "authoredAt"]),
});
