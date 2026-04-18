// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Configuration — public endpoint URLs only.
// ALL API keys are server-side (Convex env vars). No keys exist in client code.

/**
 * Get the Convex deployment URL for queries/mutations (not HTTP actions).
 * Used by store client for proxied query/mutation calls.
 */
export function getConvexUrl(): string {
    return process.env.CONVEX_URL || "https://zany-kudu-607.convex.cloud";
}

/**
 * Get the Convex HTTP actions site URL.
 * HTTP actions (LLM proxy, auth, account status) are served at .convex.site.
 */
export function getConvexSiteUrl(): string {
    // Derive .site URL from .cloud URL, or use env override
    if (process.env.CONVEX_SITE_URL) return process.env.CONVEX_SITE_URL;

    const cloudUrl = getConvexUrl();
    // Replace .convex.cloud with .convex.site
    return cloudUrl.replace(".convex.cloud", ".convex.site");
}
