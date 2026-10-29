// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Store client — communicates with Convex via session-authenticated HTTP proxy.
// No deploy keys on client. All auth via session tokens.

import type {
  StoreItem,
  StoreItemWithUrls,
  StoreItemType,
  StoreItemCategory,
  Install,
  InstallWithItem,
  UpdateAvailable,
  Review,
  ReviewSummary,
  CategoryInfo,
  StoreListOptions,
} from "./types.js";
import { getConvexSiteUrl } from "../config/keys.js";
import { getSessionToken, handleAuthError } from "../session.js";
import { encryptedFetch } from "../crypto-transport.js";

// ── Session-authenticated Convex Helpers ─────────

async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = await getSessionToken();
  if (!token) throw new Error("Not authenticated");
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,
  };
}

async function convexQuery<T>(functionPath: string, args: Record<string, unknown> = {}): Promise<T> {
  const convexUrl = getConvexSiteUrl();
  const headers = await getAuthHeaders();

  let response = await encryptedFetch(`${convexUrl}/api/store/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({ functionPath, args }),
  });

  // Handle auth expiry
  if (response.status === 401) {
    const newToken = await handleAuthError();
    if (!newToken) throw new Error("Authentication failed");
    response = await encryptedFetch(`${convexUrl}/api/store/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${newToken}`,
      },
      body: JSON.stringify({ functionPath, args }),
    });
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error((err as any).error || `Store query failed: ${response.status}`);
  }

  const data = await response.json() as { status: string; value: T };
  return data.value;
}

async function convexMutation<T>(functionPath: string, args: Record<string, unknown> = {}): Promise<T> {
  const convexUrl = getConvexSiteUrl();
  const headers = await getAuthHeaders();

  let response = await encryptedFetch(`${convexUrl}/api/store/mutation`, {
    method: "POST",
    headers,
    body: JSON.stringify({ functionPath, args }),
  });

  // Handle auth expiry
  if (response.status === 401) {
    const newToken = await handleAuthError();
    if (!newToken) throw new Error("Authentication failed");
    response = await encryptedFetch(`${convexUrl}/api/store/mutation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${newToken}`,
      },
      body: JSON.stringify({ functionPath, args }),
    });
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error((err as any).error || `Store mutation failed: ${response.status}`);
  }

  const data = await response.json() as { status: string; value: T };
  return data.value;
}

// ── Store Item Queries ────────────────────────────

export async function listItems(opts: StoreListOptions = {}): Promise<StoreItem[]> {
  return await convexQuery<StoreItem[]>("store/items:list", {
    type: opts.type,
    category: opts.category,
    featured: opts.featured,
    limit: opts.limit,
  });
}

export async function searchItems(
  query: string,
  opts: { type?: StoreItemType; category?: StoreItemCategory; limit?: number } = {}
): Promise<StoreItem[]> {
  return await convexQuery<StoreItem[]>("store/items:search", {
    query,
    type: opts.type,
    category: opts.category,
    limit: opts.limit,
  });
}

export async function getItemBySlug(slug: string): Promise<StoreItemWithUrls | null> {
  return await convexQuery<StoreItemWithUrls | null>("store/items:getBySlug", { slug });
}

export async function getItemById(itemId: string): Promise<(StoreItem & { contentUrl: string }) | null> {
  return await convexQuery<(StoreItem & { contentUrl: string }) | null>("store/items:getById", {
    itemId,
  });
}

export async function getFeaturedItems(limit = 10): Promise<StoreItem[]> {
  return await convexQuery<StoreItem[]>("store/items:getFeatured", { limit });
}

export async function getTrendingItems(limit = 10): Promise<StoreItem[]> {
  return await convexQuery<StoreItem[]>("store/items:getTrending", { limit });
}

export async function getCategories(): Promise<CategoryInfo[]> {
  return await convexQuery<CategoryInfo[]>("store/items:getCategories", {});
}

// ── Install Operations ────────────────────────────

export async function getUserInstalls(): Promise<InstallWithItem[]> {
  const userId = process.env.ATLAS_OTPLESS_USER_ID;
  if (!userId) return [];
  return await convexQuery<InstallWithItem[]>("store/installs:getByUser", { userId });
}

export async function isItemInstalled(itemId: string): Promise<boolean> {
  const userId = process.env.ATLAS_OTPLESS_USER_ID;
  if (!userId) return false;
  return await convexQuery<boolean>("store/installs:isInstalled", { userId, itemId });
}

export async function startInstall(
  itemId: string,
  version: string
): Promise<{ contentUrl: string; slug: string; type: StoreItemType; version: string }> {
  const userId = process.env.ATLAS_OTPLESS_USER_ID;
  if (!userId) throw new Error("Not logged in");
  return await convexMutation<{
    contentUrl: string;
    slug: string;
    type: StoreItemType;
    version: string;
  }>("store/installs:startInstall", { userId, itemId, version });
}

export async function confirmInstall(itemId: string): Promise<string> {
  const userId = process.env.ATLAS_OTPLESS_USER_ID;
  if (!userId) throw new Error("Not logged in");
  return await convexMutation<string>("store/installs:confirmInstall", { userId, itemId });
}

export async function uninstall(itemId: string): Promise<void> {
  const userId = process.env.ATLAS_OTPLESS_USER_ID;
  if (!userId) throw new Error("Not logged in");
  await convexMutation<void>("store/installs:uninstall", { userId, itemId });
}

export async function checkUpdates(): Promise<UpdateAvailable[]> {
  const userId = process.env.ATLAS_OTPLESS_USER_ID;
  if (!userId) return [];
  return await convexQuery<UpdateAvailable[]>("store/installs:checkUpdates", { userId });
}

export async function getUpdateDownload(itemId: string): Promise<{
  contentUrl: string;
  slug: string;
  type: StoreItemType;
  currentVersion: string;
  newVersion: string;
  changelog?: string;
}> {
  const userId = process.env.ATLAS_OTPLESS_USER_ID;
  if (!userId) throw new Error("Not logged in");
  return await convexMutation<{
    contentUrl: string;
    slug: string;
    type: StoreItemType;
    currentVersion: string;
    newVersion: string;
    changelog?: string;
  }>("store/installs:getUpdateDownload", { userId, itemId });
}

export async function updateVersion(itemId: string, newVersion: string): Promise<void> {
  const userId = process.env.ATLAS_OTPLESS_USER_ID;
  if (!userId) throw new Error("Not logged in");
  await convexMutation<void>("store/installs:updateVersion", { userId, itemId, newVersion });
}

export async function setAutoUpdate(itemId: string, autoUpdate: boolean): Promise<void> {
  const userId = process.env.ATLAS_OTPLESS_USER_ID;
  if (!userId) throw new Error("Not logged in");
  await convexMutation<void>("store/installs:setAutoUpdate", { userId, itemId, autoUpdate });
}

// ── Review Operations ─────────────────────────────

export async function getItemReviews(
  itemId: string,
  opts: { limit?: number; sortBy?: "recent" | "helpful" } = {}
): Promise<Review[]> {
  return await convexQuery<Review[]>("store/reviews:getByItem", {
    itemId,
    limit: opts.limit,
    sortBy: opts.sortBy,
  });
}

export async function getReviewSummary(itemId: string): Promise<ReviewSummary> {
  return await convexQuery<ReviewSummary>("store/reviews:getSummary", { itemId });
}

export async function getUserReview(itemId: string): Promise<Review | null> {
  const userId = process.env.ATLAS_OTPLESS_USER_ID;
  if (!userId) return null;
  return await convexQuery<Review | null>("store/reviews:getUserReview", { userId, itemId });
}

export async function submitReview(
  itemId: string,
  rating: number,
  opts: { title?: string; review?: string } = {}
): Promise<string> {
  const userId = process.env.ATLAS_OTPLESS_USER_ID;
  if (!userId) throw new Error("Not logged in");
  return await convexMutation<string>("store/reviews:submit", {
    userId,
    itemId,
    rating,
    title: opts.title,
    review: opts.review,
  });
}

export async function deleteReview(reviewId: string): Promise<void> {
  const userId = process.env.ATLAS_OTPLESS_USER_ID;
  if (!userId) throw new Error("Not logged in");
  await convexMutation<void>("store/reviews:remove", { userId, reviewId });
}

export async function markReviewHelpful(reviewId: string): Promise<void> {
  await convexMutation<void>("store/reviews:markHelpful", { reviewId });
}

// ── Storage Operations ────────────────────────────

export async function getFileUrl(storageId: string): Promise<string | null> {
  return await convexQuery<string | null>("store/storage:getFileUrl", { storageId });
}

export async function getItemContentUrl(itemId: string): Promise<{
  url: string;
  slug: string;
  type: StoreItemType;
  version: string;
  permissions: string[];
}> {
  const userId = process.env.ATLAS_OTPLESS_USER_ID;
  if (!userId) throw new Error("Not logged in");
  return await convexMutation<{
    url: string;
    slug: string;
    type: StoreItemType;
    version: string;
    permissions: string[];
  }>("store/storage:getItemContentUrl", { itemId, userId });
}

// ── Export convex helpers for other modules ───────

export { convexQuery, convexMutation };
