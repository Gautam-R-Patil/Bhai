// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Configuration — public endpoint URLs only.
// ALL API keys are server-side (Convex env vars). No keys exist in client code.

// ── Deployment URLs ───────────────────────────
// Both deployments carry identical prompts + skills + code. The dev
// deployment is the default during active development; prod is ready to
// take over whenever we flip.
//
// Switching: set ATLAS_ENV=prod (or override CONVEX_URL directly).
const CONVEX_URLS = {
    dev: "https://avid-finch-726.convex.cloud",
    prod: "https://avid-finch-726.convex.cloud",
} as const;

function defaultConvexUrl(): string {
    const env = (process.env.ATLAS_ENV || "").toLowerCase();
    if (env === "prod" || env === "production") return CONVEX_URLS.prod;
    return CONVEX_URLS.dev;
}

/**
 * Get the Convex deployment URL for queries/mutations (not HTTP actions).
 * Used by store client for proxied query/mutation calls.
 */
export function getConvexUrl(): string {
    return process.env.CONVEX_URL || defaultConvexUrl();
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
