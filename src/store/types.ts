// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// TypeScript types for the A.T.L.A.S Store

// ── Item Types ─────────────────────────────────────────────────────────────

export type StoreItemType = "skill" | "mcp" | "tool" | "dynamic";

export type StoreItemStatus = "active" | "deprecated" | "removed";

export type StoreItemCategory =
  | "automation"
  | "research"
  | "coding"
  | "productivity"
  | "media"
  | "communication"
  | "utilities";

export type StoreItemPricing = "free" | "paid" | "freemium";

export interface StoreItem {
  _id: string;
  slug: string;
  type: StoreItemType;
  name: string;
  description: string;
  longDescription?: string;
  developerId: string;
  version: string;
  changelog?: string;
  minAtlasVersion?: string;
  contentFileId: string;
  iconFileId?: string;
  screenshotFileIds?: string[];
  readmeFileId?: string;
  category: StoreItemCategory;
  tags: string[];
  permissions: string[];
  pricing: StoreItemPricing;
  priceCredits?: number;
  installCount: number;
  rating: number;
  ratingCount: number;
  weeklyInstalls: number;
  status: StoreItemStatus;
  featuredRank?: number;
  createdAt: number;
  updatedAt: number;
  publishedAt: number;
}

export interface StoreItemWithUrls extends StoreItem {
  iconUrl?: string | null;
  screenshotUrls?: string[];
  contentUrl?: string | null;
  developer?: {
    displayName: string;
    companyName?: string;
  } | null;
}

// ── Developer Types ────────────────────────────────────────────────────────

export type DeveloperStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "suspended"
  | "banned";

export interface Developer {
  _id: string;
  email: string;
  displayName: string;
  companyName?: string;
  website?: string;
  bio?: string;
  avatarFileId?: string;
  avatarUrl?: string;
  status: DeveloperStatus;
  verificationNotes?: string;
  totalApps: number;
  totalInstalls: number;
  createdAt: number;
  lastLoginAt?: number;
}

// ── Admin Types ────────────────────────────────────────────────────────────

export type AdminRole = "super_admin" | "moderator" | "reviewer";

export interface Admin {
  _id: string;
  email: string;
  name: string;
  role: AdminRole;
  permissions: string[];
  createdAt: number;
  lastLoginAt?: number;
}

// ── Submission Types ───────────────────────────────────────────────────────

export type SubmissionStatus =
  | "pending"
  | "in_review"
  | "approved"
  | "rejected"
  | "revision_requested";

export interface Submission {
  _id: string;
  developerId: string;
  existingItemId?: string;
  isUpdate: boolean;
  type: StoreItemType;
  name: string;
  slug: string;
  description: string;
  longDescription?: string;
  version: string;
  changelog?: string;
  minAtlasVersion?: string;
  contentFileId: string;
  iconFileId?: string;
  screenshotFileIds?: string[];
  readmeFileId?: string;
  category: StoreItemCategory;
  tags: string[];
  permissions: string[];
  pricing: StoreItemPricing;
  priceCredits?: number;
  status: SubmissionStatus;
  reviewNotes?: string;
  reviewedBy?: string;
  reviewedAt?: number;
  submittedAt: number;
}

export interface SubmissionWithUrls extends Submission {
  contentUrl?: string | null;
  iconUrl?: string | null;
  screenshotUrls?: string[];
  developer?: {
    displayName: string;
    email: string;
    companyName?: string;
  } | null;
}

// ── Install Types ──────────────────────────────────────────────────────────

export interface Install {
  _id: string;
  userId: string;
  itemId: string;
  itemSlug: string;
  itemType: StoreItemType;
  version: string;
  installedAt: number;
  updatedAt: number;
  autoUpdate: boolean;
}

export interface InstallWithItem extends Install {
  item?: {
    name: string;
    type: StoreItemType;
    version: string;
    iconFileId?: string;
    status: StoreItemStatus;
  } | null;
}

export interface UpdateAvailable {
  installId: string;
  itemId: string;
  itemName: string;
  currentVersion: string;
  latestVersion: string;
}

// ── Review Types ───────────────────────────────────────────────────────────

export interface Review {
  _id: string;
  userId: string;
  itemId: string;
  rating: number;
  title?: string;
  review?: string;
  helpful: number;
  createdAt: number;
  updatedAt: number;
  userName?: string;
}

export interface ReviewSummary {
  totalReviews: number;
  averageRating: number;
  distribution: Record<number, number>;
}

// ── Installation Progress ──────────────────────────────────────────────────

export type InstallStage =
  | "downloading"
  | "extracting"
  | "installing_deps"
  | "configuring"
  | "done"
  | "error";

export interface InstallProgress {
  stage: InstallStage;
  percent: number;
  message: string;
}

export type ProgressCallback = (progress: InstallProgress) => void;

// ── Local Install Manifest ─────────────────────────────────────────────────

export interface LocalInstallItem {
  itemId: string;
  type: StoreItemType;
  name: string;
  version: string;
  installedAt: number;
  autoUpdate: boolean;
  path: string;
  forgeMeta?: {
    source: "synchronous" | "dream_replay" | "sideloaded" | "migrated";
    originIntent?: string;
    synthesisModelId?: string;
    verifierAttempts?: number;
  };
}

export interface LocalInstallManifest {
  items: {
    [slug: string]: LocalInstallItem;
  };
  lastUpdated: number;
}

// ── MCP Server Config ──────────────────────────────────────────────────────

export interface StoreMCPConfig {
  [serverName: string]: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
}

// ── Activity Log ───────────────────────────────────────────────────────────

export type ActivityType =
  | "install"
  | "uninstall"
  | "update"
  | "review"
  | "submission"
  | "approval"
  | "rejection"
  | "developer_registered"
  | "developer_approved"
  | "developer_rejected"
  | "developer_suspended"
  | "developer_banned";

export interface ActivityLogEntry {
  _id: string;
  type: ActivityType;
  userId?: string;
  developerId?: string;
  itemId?: string;
  adminId?: string;
  metadata?: string;
  timestamp: number;
}

// ── Dashboard Stats ────────────────────────────────────────────────────────

export interface DashboardStats {
  totalUsers: number;
  totalDevelopers: number;
  pendingDevelopers: number;
  totalItems: number;
  activeItems: number;
  totalInstalls: number;
  pendingSubmissions: number;
  recentActivity: ActivityLogEntry[];
}

// ── Category Info ──────────────────────────────────────────────────────────

export interface CategoryInfo {
  name: StoreItemCategory;
  count: number;
}

// ── Search/Filter Options ──────────────────────────────────────────────────

export interface StoreListOptions {
  type?: StoreItemType;
  category?: StoreItemCategory;
  search?: string;
  featured?: boolean;
  limit?: number;
  cursor?: string;
}

export interface StoreListResult {
  items: StoreItemWithUrls[];
  nextCursor?: string;
}
