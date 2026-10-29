// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { LLMClient } from "../llm.js";
import { deliverToActiveChannel } from "../tools/channel-send.js";

let _llm: LLMClient | null = null;
export function setProductHuntLLM(llm: LLMClient): void { _llm = llm; }

const PH_GRAPHQL = "https://api.producthunt.com/v2/api/graphql";

export interface LaunchChecklist {
  productName: string;
  tagline: string;
  description: string;
  galleryImages: string[];
  firstComment: string;
  launchInstructions: string;
}

interface PHStats {
  votesCount: number;
  commentsCount: number;
  rank: number;
  topComments: Array<{ author: string; body: string }>;
}

export function prepareLaunchChecklist(
  productName: string,
  tagline: string,
  description: string,
  galleryImagePaths: string[]
): LaunchChecklist {
  const firstComment = `Hi Product Hunt! 👋 I'm the founder of ${productName}.\n\n${description}\n\nWould love your feedback — what would make this even more useful for you?`;
  const instructions = [
    `✅ Launch checklist for ${productName}`,
    ``,
    `1. Go to producthunt.com and log in`,
    `2. Click "Submit" → "New Product"`,
    `3. Name: ${productName}`,
    `4. Tagline: ${tagline}`,
    `5. Upload gallery images (${galleryImagePaths.length} images ready)`,
    `6. Schedule for 12:01 AM Pacific Time on your launch day`,
    ``,
    `**First comment to post immediately when live:**`,
    firstComment,
    ``,
    `Reply "launched" when it's live and I'll monitor upvotes and comments.`,
  ].join("\n");
  return { productName, tagline, description, galleryImages: galleryImagePaths, firstComment, launchInstructions: instructions };
}

export async function sendLaunchChecklist(checklist: LaunchChecklist): Promise<void> {
  await deliverToActiveChannel(checklist.launchInstructions, "");
}

export async function monitorLaunch(productSlug: string): Promise<PHStats | null> {
  const token = process.env.PH_API_TOKEN;
  if (!token) return null;
  const query = `{ post(slug: "${productSlug}") { votesCount commentsCount dailyRank comments(first: 5, order: VOTES_COUNT) { edges { node { body user { name } } } } } }`;
  try {
    const res = await fetch(PH_GRAPHQL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: { post?: { votesCount: number; commentsCount: number; dailyRank: number; comments: { edges: Array<{ node: { body: string; user: { name: string } } }> } } } };
    const post = data.data?.post;
    if (!post) return null;
    return {
      votesCount: post.votesCount,
      commentsCount: post.commentsCount,
      rank: post.dailyRank,
      topComments: post.comments.edges.map((e) => ({ author: e.node.user.name, body: e.node.body })),
    };
  } catch { return null; }
}

export async function draftResponseComment(stats: PHStats, productName: string): Promise<string> {
  if (!_llm) return `Thanks for the support! We hit #${stats.rank} with ${stats.votesCount} votes! 🎉`;
  try {
    const response = await _llm.chat({
      messages: [{
        role: "user",
        content: `Write a warm, genuine founder comment for ${productName} on Product Hunt. Currently ranked #${stats.rank} with ${stats.votesCount} upvotes. Top comment from ${stats.topComments[0]?.author ?? "a user"}: "${stats.topComments[0]?.body ?? "Great product!"}". Under 100 words, personal and grateful.`,
      }],
    });
    return response.choices[0]?.message?.content ?? "";
  } catch { return ""; }
}
