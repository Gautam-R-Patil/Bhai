// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { LLMClient } from "../llm.js";
import { saveBrandProfile, loadBrandProfile, type BrandProfile, type Platform } from "./brand-profile.js";
import { researchInstagramTrends, scrapeCompetitorPosts } from "./trend-researcher.js";
import { executeTool } from "../tools/index.js";

export interface BrandAuditInput {
  brandId: string;
  website: string;
  socialHandles?: Partial<Record<Platform, string>>;
  competitors?: string[];
  depth?: "quick" | "standard" | "deep";
}

export interface BrandAuditReport {
  brandId: string;
  websiteSummary: string;
  existingSocialSummary: string;
  competitorSummary: string;
  brandVoiceGuide: string;
  contentPillars: string[];
  trendingTopics: string[];
  trendingSounds: string[];
  opportunities: string[];
  warnings: string[];
  auditedAt: string;
}

export async function runBrandAudit(
  input: BrandAuditInput,
  llm: LLMClient
): Promise<BrandAuditReport> {
  const { brandId, website, socialHandles = {}, competitors = [], depth = "standard" } = input;

  // 1. Scrape website
  let websiteText = "";
  try {
    await executeTool("browser_navigate", { url: website, mode: "fast" });
    const extractResult = await executeTool("browser_extract", {
      type: "text",
      instructions:
        "Extract: product description, target audience, unique value proposition, tone of voice, main features",
    });
    websiteText = extractResult.slice(0, 3000);
  } catch (err) {
    websiteText = `Website scrape failed: ${(err as Error).message}`;
  }

  // 2. Research competitors
  let competitorSummary = "No competitors provided.";
  if (competitors.length > 0) {
    try {
      const researchResult = await executeTool("deep_research", {
        query: `Competitor analysis for ${competitors.join(", ")} — marketing strategy, content approach, target audience, strengths and weaknesses`,
        profile: depth === "deep" ? "deep" : "standard",
      });
      competitorSummary = researchResult.slice(0, 2000);
    } catch (err) {
      competitorSummary = `Competitor research failed: ${(err as Error).message}`;
    }
  }

  // 3. Research social trends for the brand's niche
  const nicheKeywords = deriveNicheKeywords(websiteText);
  let trendingSounds: string[] = [];
  let trendingTopics: string[] = [];
  try {
    const instaTrends = await researchInstagramTrends(nicheKeywords, 30);
    trendingSounds = instaTrends.trendingSounds;
    trendingTopics = instaTrends.trendingHashtags.slice(0, 10);
  } catch {
    // Apify optional — continue without
  }

  // 4. Scrape own Instagram profile if handle provided
  let existingSocialSummary = "No social handles provided.";
  const igHandle = socialHandles.instagram;
  if (igHandle) {
    try {
      const posts = await scrapeCompetitorPosts(igHandle, 10);
      const engagements = posts.map((p) => p.likesCount + p.commentsCount);
      const avgEng = engagements.length
        ? Math.round(engagements.reduce((a, b) => a + b, 0) / engagements.length)
        : 0;
      existingSocialSummary = `Instagram @${igHandle}: ${posts.length} recent posts, avg engagement ${avgEng}. Top hashtags: ${[...new Set(posts.flatMap((p) => p.hashtags))].slice(0, 8).join(", ")}`;
    } catch {
      existingSocialSummary = `Instagram @${igHandle} (scrape unavailable)`;
    }
  }

  // 5. LLM synthesizes brand voice + content pillars + opportunities
  const synthesisResponse = await llm.chat({
    messages: [
      {
        role: "user",
        content: `You are a senior brand strategist. Based on the following data, extract:
1. Brand voice guide (3-5 sentences describing tone, vocabulary, style)
2. 5 content pillars (themes the brand should consistently post about)
3. 3-5 growth opportunities (specific, actionable)
4. 2-3 warnings (things to avoid)

Website analysis: ${websiteText.slice(0, 2000)}
Competitor analysis: ${competitorSummary.slice(0, 1500)}
Social analysis: ${existingSocialSummary}
Trending topics: ${trendingTopics.join(", ")}

Respond with valid JSON only:
{"brandVoiceGuide":"...","contentPillars":["..."],"opportunities":["..."],"warnings":["..."]}`,
      },
    ],
    responseFormat: "json_object",
  });

  let brandVoiceGuide = "";
  let contentPillars: string[] = [];
  let opportunities: string[] = [];
  let warnings: string[] = [];

  const rawContent = synthesisResponse.choices[0]?.message?.content ?? "{}";
  try {
    const json = rawContent.replace(/^```json?\n?/m, "").replace(/```$/m, "").trim();
    const parsed = JSON.parse(json) as {
      brandVoiceGuide?: string;
      contentPillars?: string[];
      opportunities?: string[];
      warnings?: string[];
    };
    brandVoiceGuide = parsed.brandVoiceGuide ?? "";
    contentPillars = parsed.contentPillars ?? [];
    opportunities = parsed.opportunities ?? [];
    warnings = parsed.warnings ?? [];
  } catch {
    brandVoiceGuide = rawContent;
  }

  // 6. Update brand profile in memory with audit findings
  const existing = loadBrandProfile(brandId);
  if (existing) {
    saveBrandProfile({
      ...existing,
      brandVoiceGuide,
      contentPillars,
      auditSummary: opportunities.join("; "),
      updatedAt: new Date().toISOString(),
    });
  }

  return {
    brandId,
    websiteSummary: websiteText.slice(0, 500),
    existingSocialSummary,
    competitorSummary: competitorSummary.slice(0, 800),
    brandVoiceGuide,
    contentPillars,
    trendingTopics,
    trendingSounds,
    opportunities,
    warnings,
    auditedAt: new Date().toISOString(),
  };
}

function deriveNicheKeywords(websiteText: string): string[] {
  const text = websiteText.slice(0, 500).toLowerCase();
  const known = [
    "saas", "startup", "ecommerce", "fashion", "fitness", "food",
    "tech", "ai", "design", "marketing", "education", "health", "finance",
  ];
  const found = known.filter((k) => text.includes(k));
  return found.length ? found.slice(0, 3) : ["business", "startup"];
}
