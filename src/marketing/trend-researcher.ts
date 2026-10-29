// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ApifyClient } from "apify-client";

export interface TrendingPost {
  platform: "instagram" | "tiktok";
  caption: string;
  likesCount: number;
  viewCount?: number;
  commentsCount: number;
  audioName?: string;
  hashtags: string[];
  url?: string;
}

export interface TrendResearchResult {
  platform: string;
  niche: string;
  topPosts: TrendingPost[];
  trendingHashtags: string[];
  trendingSounds: string[];
  contentPatterns: string[];
  recommendedPostingTime: string;
}

// Loaded on first use: the SDK is ~24MB and most sessions never research trends.
async function getApifyClient(): Promise<ApifyClient> {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error("APIFY_TOKEN not set in environment");
  const { ApifyClient } = await import("apify-client");
  return new ApifyClient({ token });
}

export async function researchInstagramTrends(
  hashtags: string[],
  resultsLimit = 50
): Promise<TrendResearchResult> {
  const client = await getApifyClient();
  const run = await client.actor("apify/instagram-hashtag-scraper").call({
    hashtags: hashtags.slice(0, 5),
    resultsLimit,
    addParentData: false,
  });
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  const posts = (items as Record<string, unknown>[]).map((item) => ({
    platform: "instagram" as const,
    caption: (item.caption as string) ?? "",
    likesCount: (item.likesCount as number) ?? 0,
    viewCount: (item.videoViewCount as number) ?? undefined,
    commentsCount: (item.commentsCount as number) ?? 0,
    audioName: (item.musicInfo as Record<string, unknown> | undefined)?.title as string | undefined,
    hashtags: extractHashtags((item.caption as string) ?? ""),
    url: (item.url as string) ?? undefined,
  }));
  posts.sort((a, b) => (b.likesCount + b.commentsCount) - (a.likesCount + a.commentsCount));
  const topPosts = posts.slice(0, 10);
  return {
    platform: "instagram",
    niche: hashtags[0] ?? "general",
    topPosts,
    trendingHashtags: countTopHashtags(posts, 15),
    trendingSounds: countTopSounds(posts, 5),
    contentPatterns: analyseContentPatterns(topPosts),
    recommendedPostingTime: "6:00 PM - 9:00 PM local time (Mon/Wed/Fri peak)",
  };
}

export async function researchTikTokTrends(
  hashtags: string[],
  resultsLimit = 30
): Promise<TrendResearchResult> {
  const client = await getApifyClient();
  const run = await client.actor("clockworks/tiktok-scraper").call({
    hashtags: hashtags.slice(0, 3),
    resultsPerPage: resultsLimit,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
  });
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  const posts = (items as Record<string, unknown>[]).map((item) => ({
    platform: "tiktok" as const,
    caption: (item.text as string) ?? "",
    likesCount: (item.diggCount as number) ?? 0,
    viewCount: (item.playCount as number) ?? undefined,
    commentsCount: (item.commentCount as number) ?? 0,
    audioName: (item.musicMeta as Record<string, unknown> | undefined)?.musicName as string | undefined,
    hashtags: ((item.hashtags as Record<string, unknown>[]) ?? []).map((h) => h.name as string),
    url: (item.webVideoUrl as string) ?? undefined,
  }));
  posts.sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0));
  const topPosts = posts.slice(0, 10);
  return {
    platform: "tiktok",
    niche: hashtags[0] ?? "general",
    topPosts,
    trendingHashtags: countTopHashtags(posts, 15),
    trendingSounds: countTopSounds(posts, 5),
    contentPatterns: analyseContentPatterns(topPosts),
    recommendedPostingTime: "7:00 PM - 11:00 PM local time (Tue/Thu/Sat peak)",
  };
}

export async function scrapeCompetitorPosts(
  instagramHandle: string,
  limit = 20
): Promise<TrendingPost[]> {
  const client = await getApifyClient();
  const run = await client.actor("apify/instagram-profile-scraper").call({
    usernames: [instagramHandle],
    resultsLimit: limit,
  });
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  return (items as Record<string, unknown>[]).flatMap((item) => {
    const posts = (item.latestPosts as Record<string, unknown>[]) ?? [];
    return posts.map((p) => ({
      platform: "instagram" as const,
      caption: (p.caption as string) ?? "",
      likesCount: (p.likesCount as number) ?? 0,
      viewCount: (p.videoViewCount as number) ?? undefined,
      commentsCount: (p.commentsCount as number) ?? 0,
      hashtags: extractHashtags((p.caption as string) ?? ""),
      url: (p.url as string) ?? undefined,
    }));
  });
}

function extractHashtags(text: string): string[] {
  return (text.match(/#\w+/g) ?? []).map((h) => h.slice(1).toLowerCase());
}

function countTopHashtags(posts: TrendingPost[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const p of posts) {
    for (const h of p.hashtags) {
      counts.set(h, (counts.get(h) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([h]) => h);
}

function countTopSounds(posts: TrendingPost[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const p of posts) {
    if (p.audioName) counts.set(p.audioName, (counts.get(p.audioName) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([s]) => s);
}

function analyseContentPatterns(posts: TrendingPost[]): string[] {
  const patterns: string[] = [];
  const questionHooks = posts.filter((p) => p.caption.includes("?")).length;
  const boldClaims = posts.filter((p) => /^(never|always|stop|you need|secret|truth|why)/i.test(p.caption)).length;
  const listPosts = posts.filter((p) => /^\d+\s|^#\d+/m.test(p.caption)).length;
  if (questionHooks >= 3) patterns.push("hook: question (popular in this niche)");
  if (boldClaims >= 3) patterns.push("hook: bold claim or counterintuitive statement");
  if (listPosts >= 3) patterns.push("format: numbered list / tips");
  if (patterns.length === 0) patterns.push("hook: storytelling / personal experience");
  return patterns;
}
