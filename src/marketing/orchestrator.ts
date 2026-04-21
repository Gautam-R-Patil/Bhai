// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { LLMClient } from "../llm.js";
import {
  loadBrandProfile,
  saveBrandProfile,
  slugify,
  type BrandProfile,
  type Platform,
  type AutonomyMode,
  type OutreachMode,
} from "./brand-profile.js";
import {
  presentStrategyOptions,
  generateContentCalendar,
  type CampaignPlan,
} from "./campaign-planner.js";
import { deliverToActiveChannel } from "../tools/channel-send.js";
import { executeTool } from "../tools/index.js";

export interface BrandIntakeInput {
  name: string;
  website: string;
  description: string;
  targetAudience: string;
  toneOfVoice: string;
  socialHandles?: Partial<Record<Platform, string>>;
  competitors?: string[];
  logoPath?: string;
}

export async function startBrandOnboarding(
  input: BrandIntakeInput,
  _llm: LLMClient
): Promise<BrandProfile> {
  const id = slugify(input.name);

  const existing = loadBrandProfile(id);
  if (existing) return existing;

  const profile: BrandProfile = {
    id,
    name: input.name,
    website: input.website,
    logoPath: input.logoPath ?? "",
    socialHandles: input.socialHandles ?? {},
    description: input.description,
    targetAudience: input.targetAudience,
    toneOfVoice: input.toneOfVoice,
    competitors: input.competitors ?? [],
    contentPillars: [],
    brandVoiceGuide: "",
    auditSummary: "",
    autonomyMode: "hybrid",
    linkedinOutreachMode: "posts_only",
    activePlatforms: Object.keys(input.socialHandles ?? {}) as Platform[],
    credentialKeys: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveBrandProfile(profile);

  await deliverToActiveChannel(
    `Got it! Give me a few minutes to research ${input.name}, analyse your competitors, and find what's trending in your space. I'll come back with a full strategy.`,
    ""
  );

  await executeTool("brand_audit", {
    brand_id: id,
    website: input.website,
    social_handles: input.socialHandles ?? {},
    competitors: input.competitors ?? [],
    depth: "standard",
  });

  return loadBrandProfile(id) ?? profile;
}

export async function presentMarketingStrategy(brandId: string): Promise<void> {
  const profile = loadBrandProfile(brandId);
  if (!profile) {
    await deliverToActiveChannel(
      "No brand profile found. Please set up your brand first.",
      ""
    );
    return;
  }
  const strategyMessage = await presentStrategyOptions(profile);
  await deliverToActiveChannel(strategyMessage, "");
}

export async function applyUserChoices(
  brandId: string,
  autonomyMode: AutonomyMode,
  linkedinMode: OutreachMode,
  platforms: Platform[]
): Promise<void> {
  const profile = loadBrandProfile(brandId);
  if (!profile) return;
  saveBrandProfile({
    ...profile,
    autonomyMode,
    linkedinOutreachMode: linkedinMode,
    activePlatforms: platforms,
    updatedAt: new Date().toISOString(),
  });

  const postsPerWeek: Partial<Record<Platform, number>> = {};
  for (const p of platforms) {
    postsPerWeek[p] = p === "tiktok" ? 4 : p === "instagram" ? 3 : 2;
  }

  const plan: CampaignPlan = {
    brandId,
    platforms,
    contentPillars: profile.contentPillars,
    weeklyPostingCadence: postsPerWeek,
    autonomyMode,
    linkedinOutreachMode: linkedinMode,
    calendarWeeks: 4,
    createdAt: new Date().toISOString(),
  };

  await generateContentCalendar(profile, plan);
  await deliverToActiveChannel(
    `Your 4-week content calendar is ready! I've scheduled ${platforms.join(", ")} posts across 4 weeks. I'll start creating content now — you'll get a preview for each piece before anything goes live.`,
    ""
  );
}
