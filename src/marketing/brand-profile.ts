// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { remember, listMemories, getRawDb } from "../memory/sqlite.js";

export type Platform =
  | "instagram"
  | "linkedin"
  | "tiktok"
  | "twitter"
  | "facebook"
  | "youtube"
  | "reddit";
export type AutonomyMode = "hands_on" | "review_and_forget" | "hybrid";
export type OutreachMode = "phantombuster" | "posts_only" | "semi_automated";

export interface BrandProfile {
  id: string;
  name: string;
  website: string;
  logoPath: string;
  socialHandles: Partial<Record<Platform, string>>;
  description: string;
  targetAudience: string;
  toneOfVoice: string;
  competitors: string[];
  contentPillars: string[];
  brandVoiceGuide: string;
  auditSummary: string;
  autonomyMode: AutonomyMode;
  linkedinOutreachMode: OutreachMode;
  activePlatforms: Platform[];
  credentialKeys: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

const BRAND_CATEGORY = "brand";

function brandTag(id: string): string {
  return `brand:${id}`;
}

export function saveBrandProfile(profile: BrandProfile): void {
  const db = getRawDb();
  if (db) {
    // Upsert: delete previous record for this brand id before inserting
    db.prepare("DELETE FROM memories WHERE category = ? AND tags = ?").run(
      BRAND_CATEGORY,
      brandTag(profile.id)
    );
  }
  remember(JSON.stringify(profile), BRAND_CATEGORY, brandTag(profile.id), 10);
}

export function loadBrandProfile(id: string): BrandProfile | null {
  const tag = brandTag(id);
  const db = getRawDb();
  if (db) {
    const row = db
      .prepare(
        "SELECT content FROM memories WHERE category = ? AND tags = ? ORDER BY created_at DESC LIMIT 1"
      )
      .get(BRAND_CATEGORY, tag) as { content: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.content) as BrandProfile;
    } catch {
      return null;
    }
  }
  // Fallback when rawDb not available
  const results = listMemories(BRAND_CATEGORY, 200);
  const record = results.find((r) => r.tags.split(",").map((t) => t.trim()).includes(tag));
  if (!record) return null;
  try {
    return JSON.parse(record.content) as BrandProfile;
  } catch {
    return null;
  }
}

export function listBrandProfiles(): BrandProfile[] {
  const db = getRawDb();
  if (db) {
    const rows = db
      .prepare(
        "SELECT content FROM memories WHERE category = ? ORDER BY created_at DESC"
      )
      .all(BRAND_CATEGORY) as { content: string }[];
    return rows.flatMap((r) => {
      try {
        return [JSON.parse(r.content) as BrandProfile];
      } catch {
        return [];
      }
    });
  }
  // Fallback
  const results = listMemories(BRAND_CATEGORY, 200);
  return results.flatMap((r) => {
    try {
      return [JSON.parse(r.content) as BrandProfile];
    } catch {
      return [];
    }
  });
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function resolveCredential(envKey: string): string | undefined {
  return process.env[envKey];
}
