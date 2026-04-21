// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { LLMClient } from "../llm.js";
import type { BrandProfile, AutonomyMode, OutreachMode, Platform } from "./brand-profile.js";
import { addCalendarItem } from "./content-calendar.js";

export interface CampaignPlan {
  brandId: string;
  platforms: Platform[];
  contentPillars: string[];
  weeklyPostingCadence: Partial<Record<Platform, number>>;
  autonomyMode: AutonomyMode;
  linkedinOutreachMode: OutreachMode;
  calendarWeeks: number;
  createdAt: string;
}

let _llm: LLMClient | null = null;
export function setCampaignPlannerLLM(llm: LLMClient): void { _llm = llm; }

// Intentionally stored for future LLM-powered caption generation.
void (_llm as unknown);

const OUTREACH_EXPLANATIONS: Record<string, string> = {
  phantombuster:
    "**Option A — Automated (PhantomBuster)**: I send connection requests and follow-up DMs automatically. Fastest results, but LinkedIn may suspend the account (~5-15% monthly risk).",
  posts_only:
    "**Option B — Posts Only (Safe)**: I post engaging content to attract inbound leads. Zero ban risk. Results build over 2-4 weeks.",
  semi_automated:
    "**Option C — Semi-Automated**: I write the messages and find the targets, then send you the list here for you to copy-paste and send manually. Safe, requires your time.",
};

const AUTONOMY_EXPLANATIONS: Record<string, string> = {
  hands_on:
    "**Hands-on**: I'll send you every piece of content for your approval before anything goes live. Nothing posts without your OK.",
  review_and_forget:
    "**Review & Forget**: You approve the full content calendar once. I handle everything after — posting on schedule and adjusting based on what performs.",
  hybrid:
    "**Hybrid (Recommended)**: You review each piece of content when it's ready. Once you approve it, I pick the best time and post automatically.",
};

export async function presentStrategyOptions(brand: BrandProfile): Promise<string> {
  const platformRecs = buildPlatformRecommendations(brand);
  const outreachOptions = Object.values(OUTREACH_EXPLANATIONS).map((t) => `• ${t}`).join("\n");
  const autonomyOptions = Object.values(AUTONOMY_EXPLANATIONS).map((t) => `• ${t}`).join("\n");

  return [
    `📊 **Marketing Strategy for ${brand.name}**`,
    ``,
    `Based on my research, here's what I recommend:`,
    ``,
    `**Platforms:**`,
    platformRecs,
    ``,
    `**Content pillars** (topics we'll post about):`,
    brand.contentPillars.map((p, i) => `${i + 1}. ${p}`).join("\n"),
    ``,
    `**LinkedIn Outreach Options:**`,
    outreachOptions,
    ``,
    `Reply: *linkedin option A*, *linkedin option B*, or *linkedin option C*`,
    ``,
    `**How much control do you want?**`,
    autonomyOptions,
    ``,
    `Reply: *hands-on*, *review and forget*, or *hybrid*`,
  ].join("\n");
}

export async function generateContentCalendar(
  brand: BrandProfile,
  plan: CampaignPlan
): Promise<void> {
  const now = new Date();

  for (let week = 0; week < plan.calendarWeeks; week++) {
    for (const platform of plan.platforms) {
      const postsPerWeek = plan.weeklyPostingCadence[platform] ?? 3;
      const pillar =
        brand.contentPillars[week % Math.max(brand.contentPillars.length, 1)] ?? "brand story";

      for (let postNum = 0; postNum < postsPerWeek; postNum++) {
        const dayOffset = week * 7 + Math.floor((postNum / postsPerWeek) * 7);
        const postDate = new Date(now);
        postDate.setDate(now.getDate() + dayOffset);
        const hour = platform === "instagram" ? 18 : platform === "linkedin" ? 9 : 19;
        postDate.setHours(hour, 0, 0, 0);

        addCalendarItem({
          brandId: brand.id,
          platform,
          contentType:
            platform === "instagram" || platform === "tiktok" ? "reel" : "post",
          contentPillar: pillar,
          scheduledAt: postDate.toISOString(),
          status: "draft",
        });
      }
    }
  }
}

function buildPlatformRecommendations(brand: BrandProfile): string {
  const recs: string[] = [];
  if (brand.activePlatforms.includes("instagram")) {
    recs.push("• **Instagram Reels** — highest organic reach right now. Target: 3 Reels/week.");
  }
  if (brand.activePlatforms.includes("linkedin")) {
    recs.push("• **LinkedIn** — essential for B2B credibility. 2 posts/week + outreach.");
  }
  if (brand.activePlatforms.includes("tiktok")) {
    recs.push("• **TikTok** — massive discovery potential. 4 videos/week recommended.");
  }
  if (brand.activePlatforms.includes("twitter")) {
    recs.push("• **Twitter/X** — good for real-time engagement. 1 thread/week.");
  }
  if (recs.length === 0) {
    recs.push("• Recommend starting with Instagram Reels and LinkedIn.");
  }
  return recs.join("\n");
}
