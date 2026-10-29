// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { LLMClient } from "../llm.js";
import type { BrandProfile } from "./brand-profile.js";
import type { TrendResearchResult } from "./trend-researcher.js";

export interface ScriptScene {
  sceneNumber: number;
  durationSeconds: number;
  visualDescription: string;
  onScreenText?: string;
  voiceoverText?: string;
  action?: string;
}

export interface VideoScript {
  title: string;
  platform: "instagram" | "tiktok" | "youtube_shorts";
  totalDurationSeconds: number;
  hook: string;
  contentPillar: string;
  trendingSoundSuggestion?: string;
  captionText: string;
  hashtags: string[];
  scenes: ScriptScene[];
  shotList: string[];
  callToAction: string;
}

let _llm: LLMClient | null = null;
export function setScriptWriterLLM(llm: LLMClient): void { _llm = llm; }

export async function writeVideoScript(
  brand: BrandProfile,
  platform: VideoScript["platform"],
  contentPillar: string,
  trends: TrendResearchResult
): Promise<VideoScript> {
  if (!_llm) throw new Error("Script writer LLM not initialised");

  const durationMap = { instagram: 30, tiktok: 45, youtube_shorts: 60 };
  const targetDuration = durationMap[platform];
  const topSound = trends.trendingSounds[0] ?? "trending audio";
  const topHashtags = trends.trendingHashtags.slice(0, 12);
  const patterns = trends.contentPatterns.join("; ");

  const prompt = `You are an expert short-form video content creator. Write a ${targetDuration}-second ${platform} video script for this brand.

Brand: ${brand.name}
Product/Service: ${brand.description}
Target audience: ${brand.targetAudience}
Tone of voice: ${brand.toneOfVoice}
Content pillar: ${contentPillar}
Brand voice guide: ${brand.brandVoiceGuide}
Trending content patterns in this niche: ${patterns}
Trending sound to use: ${topSound}

Requirements:
- Hook MUST happen in the first 3 seconds — use pattern: ${trends.contentPatterns[0] ?? "bold claim"}
- Total: ${targetDuration} seconds across 3-5 scenes
- Include on-screen text for every scene (people watch on mute)
- End with a clear call-to-action
- Caption should be under 150 characters
- Include 10-12 relevant hashtags

Respond with valid JSON only:
{
  "title": "short descriptive title",
  "hook": "exact first sentence/question",
  "captionText": "full post caption",
  "hashtags": ["tag1","tag2"],
  "callToAction": "follow for more / link in bio / etc",
  "scenes": [{"sceneNumber":1,"durationSeconds":3,"visualDescription":"what to show","onScreenText":"text overlay","voiceoverText":"what to say","action":"zoom in"}],
  "shotList": ["Shot 1: ...", "Shot 2: ..."]
}`;

  const response = await _llm.chat({
    messages: [{ role: "user", content: prompt }],
    responseFormat: "json_object",
  });

  try {
    const raw = response.choices[0]?.message?.content ?? "{}";
    const json = raw.replace(/^```json?\n?/m, "").replace(/```$/m, "").trim();
    const parsed = JSON.parse(json) as Omit<VideoScript, "platform" | "totalDurationSeconds" | "contentPillar" | "trendingSoundSuggestion">;
    return {
      ...parsed,
      platform,
      contentPillar,
      totalDurationSeconds: targetDuration,
      trendingSoundSuggestion: topSound,
      hashtags: [
        ...(parsed.hashtags ?? []),
        ...topHashtags.slice(0, Math.max(0, 12 - (parsed.hashtags?.length ?? 0))),
      ],
    };
  } catch {
    return {
      title: `${contentPillar} video`,
      platform,
      totalDurationSeconds: targetDuration,
      hook: `Here's something most ${brand.targetAudience} don't know about ${brand.name}...`,
      contentPillar,
      captionText: `${brand.description}\n\nLink in bio 👆`,
      hashtags: topHashtags,
      trendingSoundSuggestion: topSound,
      callToAction: "Follow for more tips",
      scenes: [
        {
          sceneNumber: 1,
          durationSeconds: targetDuration,
          visualDescription: "Brand overview",
          onScreenText: brand.name,
          action: "steady shot",
        },
      ],
      shotList: ["Shot 1: Wide shot of product/workspace"],
    };
  }
}

export function formatScriptForUser(script: VideoScript): string {
  const scenes = script.scenes
    .map(
      (s) =>
        `  Scene ${s.sceneNumber} (${s.durationSeconds}s): ${s.visualDescription}\n  On-screen: "${s.onScreenText ?? ""}"\n  ${s.voiceoverText ? `Say: "${s.voiceoverText}"` : ""}`
    )
    .join("\n\n");

  return [
    `📹 **${script.title}** (${script.totalDurationSeconds}s ${script.platform})`,
    ``,
    `🎣 Hook: "${script.hook}"`,
    ``,
    `**Scenes:**`,
    scenes,
    ``,
    `📢 CTA: ${script.callToAction}`,
    `🎵 Trending sound: ${script.trendingSoundSuggestion ?? "your choice"}`,
    ``,
    `**Caption:**`,
    script.captionText,
    ``,
    `**Hashtags:** #${script.hashtags.slice(0, 10).join(" #")}`,
    ``,
    `**Shot list (if you're filming):**`,
    script.shotList.map((s) => `• ${s}`).join("\n"),
  ].join("\n");
}
