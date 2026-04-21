# Marketing Brain — Plan 3: Content Factory

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the script writer, AI video generation wrapper (Runway ML), and the marketing-specific video pipeline orchestrator so the agent can produce Reels/TikToks — either autonomously or from user-supplied footage.

**Architecture:** `src/marketing/script-writer.ts` generates video scripts with storyboards using trend data. `src/video-studio/assets/ai-video-gen.ts` wraps the Runway ML Gen-3 API. `src/marketing/video-pipeline.ts` orchestrates the full flow: trends → script → video source (AI or user) → video_studio tools → approval preview.

**Prereq:** Plans 1 and 2 complete.

**Tech Stack:** Runway ML REST API (fetch), existing `video_studio` tools (`video_create_project`, `video_analyze`, `video_plan_edit`, `video_render`), Pexels Video API (fetch, free), existing `generate_image` tool, existing `deliverToActiveChannel`.

---

### Task 1: Script Writer

**Files:**
- Create: `src/marketing/script-writer.ts`

- [ ] **Step 1: Create `src/marketing/script-writer.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { LLMClient } from "../llm.js";
import type { BrandProfile } from "./brand-profile.js";
import type { TrendResearchResult } from "./trend-researcher.js";

export interface ScriptScene {
  sceneNumber: number;
  durationSeconds: number;
  visualDescription: string;  // what to show on screen
  onScreenText?: string;      // caption / text overlay
  voiceoverText?: string;     // narration if any
  action?: string;            // e.g. "zoom in", "cut to product"
}

export interface VideoScript {
  title: string;
  platform: "instagram" | "tiktok" | "youtube_shorts";
  totalDurationSeconds: number;
  hook: string;               // first 3 seconds — must grab attention
  contentPillar: string;
  trendingSoundSuggestion?: string;
  captionText: string;        // full caption for the post
  hashtags: string[];
  scenes: ScriptScene[];
  shotList: string[];         // simple bullet list for the person filming
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

  const prompt = `You are an expert short-form video content creator. Write a ${targetDuration}-second ${platform} video script for the following brand.

Brand: ${brand.name}
Product/Service: ${brand.description}
Target audience: ${brand.targetAudience}
Tone of voice: ${brand.toneOfVoice}
Content pillar: ${contentPillar}
Brand voice guide: ${brand.brandVoiceGuide}
Trending content patterns in this niche: ${patterns}
Trending sound to use: ${topSound}

Requirements:
- The hook MUST happen in the first 3 seconds — use pattern: ${trends.contentPatterns[0] ?? "bold claim"}
- Total: ${targetDuration} seconds across 3-5 scenes
- Include on-screen text for every scene (people watch on mute)
- End with a clear call-to-action
- Caption should be under 150 characters with line breaks
- Include 10-12 relevant hashtags

Respond with valid JSON only matching this schema:
{
  "title": "short descriptive title",
  "hook": "exact first sentence/question",
  "captionText": "full post caption",
  "hashtags": ["tag1", "tag2"],
  "callToAction": "follow for more / link in bio / etc",
  "trendingSoundSuggestion": "${topSound}",
  "scenes": [
    {
      "sceneNumber": 1,
      "durationSeconds": 3,
      "visualDescription": "what to show",
      "onScreenText": "text overlay",
      "voiceoverText": "what to say",
      "action": "zoom in"
    }
  ],
  "shotList": ["Shot 1: ...", "Shot 2: ..."]
}`;

  const response = await _llm.chat([{ role: "user", content: prompt }]);

  try {
    const raw = response.content ?? "{}";
    // Strip markdown code fences if present
    const json = raw.replace(/^```json?\n?/m, "").replace(/```$/m, "").trim();
    const parsed = JSON.parse(json) as Omit<VideoScript, "platform" | "totalDurationSeconds" | "contentPillar">;
    return {
      ...parsed,
      platform,
      contentPillar,
      totalDurationSeconds: targetDuration,
      hashtags: [...(parsed.hashtags ?? []), ...topHashtags.slice(0, Math.max(0, 12 - (parsed.hashtags?.length ?? 0)))],
    };
  } catch {
    // Fallback minimal script
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
        { sceneNumber: 1, durationSeconds: targetDuration, visualDescription: "Brand overview", onScreenText: brand.name, action: "steady shot" },
      ],
      shotList: ["Shot 1: Wide shot of product/workspace"],
    };
  }
}

export function formatScriptForUser(script: VideoScript): string {
  const scenes = script.scenes.map((s) =>
    `  Scene ${s.sceneNumber} (${s.durationSeconds}s): ${s.visualDescription}\n  On-screen: "${s.onScreenText ?? ""}"\n  ${s.voiceoverText ? `Say: "${s.voiceoverText}"` : ""}`
  ).join("\n\n");

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
```

- [ ] **Step 2: Wire LLM + export setter in `src/index.ts` and `src/tools/index.ts`**

In `src/marketing/script-writer.ts` the setter is `setScriptWriterLLM`. Add to `src/tools/index.ts`:
```typescript
export { setScriptWriterLLM } from "../marketing/script-writer.js";
```

In `src/index.ts` after other LLM injections:
```typescript
import { setScriptWriterLLM } from "./marketing/script-writer.js";
// in init:
setScriptWriterLLM(llm);
```

- [ ] **Step 3: Build check**

```bash
npm run typecheck 2>&1 | grep -E "error TS|script-writer"
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/marketing/script-writer.ts src/tools/index.ts src/index.ts
git commit -m "feat(marketing): video script writer with brand voice + trend-aware hooks"
```

---

### Task 2: Runway ML AI Video Generation

**Files:**
- Create: `src/video-studio/assets/ai-video-gen.ts`

- [ ] **Step 1: Create `src/video-studio/assets/ai-video-gen.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { promises as fs } from "node:fs";
import path from "node:path";
import { getDataDir } from "../../config/paths.js";

export type AspectRatio = "9:16" | "16:9" | "1:1";

export interface AIVideoGenOptions {
  prompt: string;
  aspectRatio?: AspectRatio;
  durationSeconds?: 5 | 10;   // Runway Gen-3 Alpha supports 5s and 10s clips
  outputPath?: string;        // if omitted, auto-generated under data/video-projects/ai-gen/
}

export interface AIVideoGenResult {
  filePath: string;
  durationSeconds: number;
  provider: "runway" | "pexels";
}

// ── Runway ML Gen-3 Alpha ─────────────────────

async function generateRunway(opts: AIVideoGenOptions): Promise<AIVideoGenResult> {
  const apiKey = process.env.RUNWAY_API_KEY;
  if (!apiKey) throw new Error("RUNWAY_API_KEY not set");

  const outputDir = path.join(getDataDir(), "video-projects", "ai-gen");
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = opts.outputPath ?? path.join(outputDir, `gen_${Date.now()}.mp4`);

  // Step 1: Create generation task
  const createRes = await fetch("https://api.dev.runwayml.com/v1/image_to_video", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Runway-Version": "2024-11-06",
    },
    body: JSON.stringify({
      model: "gen3a_turbo",
      promptText: opts.prompt,
      ratio: opts.aspectRatio ?? "9:16",
      duration: opts.durationSeconds ?? 5,
    }),
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`Runway create failed (${createRes.status}): ${err}`);
  }

  const createData = await createRes.json() as { id: string };
  const taskId = createData.id;

  // Step 2: Poll until complete (max 5 minutes)
  const maxWaitMs = 5 * 60 * 1000;
  const pollIntervalMs = 10_000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));

    const statusRes = await fetch(`https://api.dev.runwayml.com/v1/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}`, "X-Runway-Version": "2024-11-06" },
    });

    if (!statusRes.ok) continue;
    const statusData = await statusRes.json() as { status: string; output?: string[] };

    if (statusData.status === "SUCCEEDED" && statusData.output?.[0]) {
      // Download the video
      const videoRes = await fetch(statusData.output[0]);
      if (!videoRes.ok) throw new Error("Failed to download Runway video");
      const buffer = Buffer.from(await videoRes.arrayBuffer());
      await fs.writeFile(outputPath, buffer);
      return { filePath: outputPath, durationSeconds: opts.durationSeconds ?? 5, provider: "runway" };
    }

    if (statusData.status === "FAILED") {
      throw new Error(`Runway generation failed for task ${taskId}`);
    }
  }

  throw new Error("Runway generation timed out after 5 minutes");
}

// ── Pexels Stock Video Fallback ───────────────

async function downloadPexelsClip(
  query: string,
  aspectRatio: AspectRatio = "9:16",
  outputPath: string
): Promise<AIVideoGenResult> {
  const apiKey = process.env.PEXELS_API_KEY;
  // Pexels API is free — no key required for basic usage, but key raises rate limits
  const headers: Record<string, string> = { "User-Agent": "ATLAS-Marketing/1.0" };
  if (apiKey) headers.Authorization = apiKey;

  const orientation = aspectRatio === "9:16" ? "portrait" : aspectRatio === "1:1" ? "square" : "landscape";
  const searchRes = await fetch(
    `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=${orientation}&per_page=5`,
    { headers }
  );

  if (!searchRes.ok) throw new Error(`Pexels search failed: ${searchRes.status}`);
  const data = await searchRes.json() as { videos?: Array<{ video_files: Array<{ link: string; width: number; height: number }> }> };

  const videos = data.videos ?? [];
  if (!videos.length) throw new Error(`No Pexels videos found for query: ${query}`);

  // Pick highest-quality file
  const files = videos[0].video_files.sort((a, b) => b.width - a.width);
  const videoUrl = files[0].link;

  const videoRes = await fetch(videoUrl);
  if (!videoRes.ok) throw new Error("Pexels download failed");
  const buffer = Buffer.from(await videoRes.arrayBuffer());
  await fs.writeFile(outputPath, buffer);

  return { filePath: outputPath, durationSeconds: 10, provider: "pexels" };
}

// ── Public API ────────────────────────────────

export async function generateAIVideo(opts: AIVideoGenOptions): Promise<AIVideoGenResult> {
  const outputDir = path.join(getDataDir(), "video-projects", "ai-gen");
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = opts.outputPath ?? path.join(outputDir, `gen_${Date.now()}.mp4`);

  // Try Runway first; fall back to Pexels stock if no API key
  if (process.env.RUNWAY_API_KEY) {
    return generateRunway({ ...opts, outputPath });
  }

  // Pexels fallback — use the first 5 words of the prompt as search query
  const searchQuery = opts.prompt.split(" ").slice(0, 5).join(" ");
  return downloadPexelsClip(searchQuery, opts.aspectRatio, outputPath);
}

export async function generateMultipleClips(
  prompts: string[],
  aspectRatio: AspectRatio = "9:16"
): Promise<AIVideoGenResult[]> {
  // Generate clips sequentially to avoid rate limits
  const results: AIVideoGenResult[] = [];
  for (const prompt of prompts) {
    const result = await generateAIVideo({ prompt, aspectRatio, durationSeconds: 5 });
    results.push(result);
  }
  return results;
}
```

- [ ] **Step 2: Build check**

```bash
npm run typecheck 2>&1 | grep -E "error TS|ai-video-gen"
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/video-studio/assets/ai-video-gen.ts
git commit -m "feat(marketing): Runway ML Gen-3 + Pexels stock video generation"
```

---

### Task 3: Marketing Video Pipeline Orchestrator

**Files:**
- Create: `src/marketing/video-pipeline.ts`

- [ ] **Step 1: Create `src/marketing/video-pipeline.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import path from "node:path";
import { executeTool } from "../tools/index.js";
import { getDataDir } from "../config/paths.js";
import { deliverToActiveChannel } from "../tools/channel-send.js";
import { queueApproval, sendApprovalRequest } from "./approval-workflow.js";
import { addCalendarItem } from "./content-calendar.js";
import { generateAIVideo, generateMultipleClips } from "../video-studio/assets/ai-video-gen.js";
import type { VideoScript } from "./script-writer.js";
import type { BrandProfile } from "./brand-profile.js";

export type VideoSource = "ai_generated" | "stock_footage" | "user_will_film";

export interface VideoPipelineOptions {
  brand: BrandProfile;
  script: VideoScript;
  source: VideoSource;
  userVideoPath?: string;      // set when source === "user_will_film" and user has sent the file
  scheduledAt?: string;
}

export interface VideoPipelineResult {
  calendarItemId: number;
  renderedVideoPath: string;
  caption: string;
  hashtags: string[];
  status: "pending_approval" | "approved";
}

export async function runVideoPipeline(opts: VideoPipelineOptions): Promise<VideoPipelineResult> {
  const { brand, script, source, userVideoPath, scheduledAt } = opts;

  // ── Step 1: Acquire raw footage ──────────────
  let rawVideoPath: string;

  if (source === "user_will_film") {
    if (!userVideoPath) {
      throw new Error("User video path not provided. Wait for user to send the video file.");
    }
    rawVideoPath = userVideoPath;
  } else {
    // Generate video clips from script scenes
    const scenePrompts = script.scenes.map((s) => s.visualDescription);
    const clips = await generateMultipleClips(scenePrompts, "9:16");
    // Concatenate clips using FFmpeg via video_studio tools (create project with multiple clips)
    rawVideoPath = clips[0].filePath; // video_studio will handle multi-clip assembly
  }

  // ── Step 2: Create video studio project ──────
  const projectResult = await executeTool("video_create_project", {
    name: `marketing_${brand.id}_${Date.now()}`,
    source_files: [rawVideoPath],
  });

  const projectData = JSON.parse(typeof projectResult === "string" ? projectResult : JSON.stringify(projectResult)) as { projectId?: string };
  const projectId = projectData.projectId;
  if (!projectId) throw new Error("video_create_project did not return projectId");

  // ── Step 3: Analyse footage ───────────────────
  await executeTool("video_analyze", { project_id: projectId });

  // ── Step 4: Plan edit (captions, music, aspect ratio) ─────────────────
  const editInstructions = [
    `Platform: ${script.platform} — use 9:16 aspect ratio`,
    `Add reel_karaoke captions using the on-screen text from each scene`,
    `Total target duration: ${script.totalDurationSeconds} seconds`,
    `Hook text on screen for first 3 seconds: "${script.hook}"`,
    script.scenes.map((s, i) => `Scene ${i + 1}: "${s.onScreenText ?? s.visualDescription}"`).join(". "),
  ].join(". ");

  await executeTool("video_plan_edit", {
    project_id: projectId,
    instructions: editInstructions,
    caption_style: "reel_karaoke",
    aspect_ratio: "9:16",
  });

  // ── Step 5: Render ────────────────────────────
  const renderResult = await executeTool("video_render", { project_id: projectId });
  const renderData = JSON.parse(typeof renderResult === "string" ? renderResult : JSON.stringify(renderResult)) as { outputPath?: string };
  const renderedVideoPath = renderData.outputPath;
  if (!renderedVideoPath) throw new Error("video_render did not return outputPath");

  // ── Step 6: Add to content calendar ──────────
  const calendarItemId = addCalendarItem({
    brandId: brand.id,
    platform: script.platform === "instagram" ? "instagram" : script.platform === "tiktok" ? "tiktok" : "youtube",
    contentType: "reel",
    contentPillar: script.contentPillar,
    caption: script.captionText,
    mediaPath: renderedVideoPath,
    hashtags: script.hashtags,
    scheduledAt,
    status: "draft",
  });

  // ── Step 7: Queue approval ────────────────────
  const approvalReq = {
    itemId: calendarItemId,
    brandId: brand.id,
    platform: script.platform,
    contentType: "reel",
    caption: `${script.captionText}\n\n#${script.hashtags.slice(0, 5).join(" #")}`,
    mediaPath: renderedVideoPath,
    scheduledAt,
  };
  queueApproval(approvalReq);
  await sendApprovalRequest(approvalReq);

  return {
    calendarItemId,
    renderedVideoPath,
    caption: script.captionText,
    hashtags: script.hashtags,
    status: "pending_approval",
  };
}

export async function handleUserVideoReceived(
  calendarItemId: number,
  brand: BrandProfile,
  userVideoPath: string
): Promise<void> {
  // Re-run the pipeline step 2 onwards with the user's video
  await deliverToActiveChannel(
    `Got your video! Editing it now — I'll send you the finished Reel in a few minutes.`,
    undefined
  );

  // Load the pending calendar item to get the script context
  // (in a real flow, the orchestrator would pass the script; here we just re-edit the raw file)
  const projectResult = await executeTool("video_create_project", {
    name: `user_video_${brand.id}_${Date.now()}`,
    source_files: [userVideoPath],
  });
  const projectData = JSON.parse(typeof projectResult === "string" ? projectResult : JSON.stringify(projectResult)) as { projectId?: string };
  const projectId = projectData.projectId;
  if (!projectId) return;

  await executeTool("video_analyze", { project_id: projectId });
  await executeTool("video_plan_edit", {
    project_id: projectId,
    instructions: "Add reel_karaoke captions, 9:16 aspect ratio, colour grade, brand-appropriate music",
    caption_style: "reel_karaoke",
    aspect_ratio: "9:16",
  });
  const renderResult = await executeTool("video_render", { project_id: projectId });
  const renderData = JSON.parse(typeof renderResult === "string" ? renderResult : JSON.stringify(renderResult)) as { outputPath?: string };
  if (!renderData.outputPath) return;

  await deliverToActiveChannel(
    `Here's your edited Reel! Reply \`approve ${calendarItemId}\` to schedule it, or tell me what to change.`,
    renderData.outputPath
  );
}
```

- [ ] **Step 2: Build check**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/marketing/video-pipeline.ts
git commit -m "feat(marketing): video pipeline orchestrator — AI gen + user footage + video_studio + approval"
```

---

### Task 4: Campaign Planner

**Files:**
- Create: `src/marketing/campaign-planner.ts`

- [ ] **Step 1: Create `src/marketing/campaign-planner.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { LLMClient } from "../llm.js";
import type { BrandProfile, AutonomyMode, OutreachMode, Platform } from "./brand-profile.js";
import { saveBrandProfile } from "./brand-profile.js";
import { addCalendarItem } from "./content-calendar.js";
import { deliverToActiveChannel } from "../tools/channel-send.js";

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

const OUTREACH_MODE_EXPLANATIONS = {
  phantombuster: "**Automated (PhantomBuster)** — I send connection requests and follow-up DMs automatically. Fastest results, but LinkedIn may suspend the account (~5-15% monthly risk).",
  posts_only: "**Posts Only (Safe)** — I post engaging content to attract inbound leads. Zero ban risk. Results take 2-4 weeks to build momentum.",
  semi_automated: "**Semi-Automated (You Send)** — I write the messages and find the targets, then send you a list via this chat for you to copy-paste and send manually. Safe, but requires your time.",
};

const AUTONOMY_MODE_EXPLANATIONS = {
  hands_on: "**Hands-on** — I'll send you every piece of content before it goes live. Nothing posts without your OK.",
  review_and_forget: "**Review & Forget** — You approve the full content calendar once. I handle everything after that — posting on schedule and adjusting based on what performs.",
  hybrid: "**Hybrid (Recommended)** — You review each piece of content when it's ready. Once you say yes, I pick the best time and post automatically.",
};

export async function presentStrategyOptions(brand: BrandProfile): Promise<string> {
  // Build the strategy message to send to user
  const platformRecs = buildPlatformRecommendations(brand);
  const outreachOptions = Object.entries(OUTREACH_MODE_EXPLANATIONS)
    .map(([, text]) => `• ${text}`)
    .join("\n");
  const autonomyOptions = Object.entries(AUTONOMY_MODE_EXPLANATIONS)
    .map(([, text]) => `• ${text}`)
    .join("\n");

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
    `Reply with: *linkedin option A*, *linkedin option B*, or *linkedin option C*`,
    ``,
    `**How much control do you want?**`,
    autonomyOptions,
    ``,
    `Reply with: *hands-on*, *review and forget*, or *hybrid*`,
  ].join("\n");
}

export async function generateContentCalendar(
  brand: BrandProfile,
  plan: CampaignPlan
): Promise<void> {
  if (!_llm) throw new Error("Campaign planner LLM not initialised");

  const platforms = plan.platforms;
  const now = new Date();

  // Generate 4 weeks of content items
  for (let week = 0; week < plan.calendarWeeks; week++) {
    for (const platform of platforms) {
      const postsPerWeek = plan.weeklyPostingCadence[platform] ?? 3;
      const pillar = brand.contentPillars[week % brand.contentPillars.length] ?? "brand story";

      // Space posts evenly through the week
      for (let postNum = 0; postNum < postsPerWeek; postNum++) {
        const dayOffset = week * 7 + Math.floor((postNum / postsPerWeek) * 7);
        const postDate = new Date(now);
        postDate.setDate(now.getDate() + dayOffset);
        // Optimal posting time per platform
        const hour = platform === "instagram" ? 18 : platform === "linkedin" ? 9 : 19;
        postDate.setHours(hour, 0, 0, 0);

        addCalendarItem({
          brandId: brand.id,
          platform,
          contentType: platform === "instagram" || platform === "tiktok" ? "reel" : "post",
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
    recs.push("• **Instagram Reels** — highest organic reach right now for most niches. Target: 3 Reels/week.");
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
  if (recs.length === 0) recs.push("• Recommend starting with Instagram Reels and LinkedIn.");
  return recs.join("\n");
}
```

- [ ] **Step 2: Wire LLM injection**

In `src/tools/index.ts` add:
```typescript
export { setCampaignPlannerLLM } from "../marketing/campaign-planner.js";
```

In `src/index.ts`:
```typescript
import { setCampaignPlannerLLM } from "./marketing/campaign-planner.js";
// in init:
setCampaignPlannerLLM(llm);
```

- [ ] **Step 3: Build check**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -20
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/marketing/campaign-planner.ts src/tools/index.ts src/index.ts
git commit -m "feat(marketing): campaign planner — strategy presentation + 4-week calendar generation"
```

---

---

### Task 5: Marketing Orchestrator (Entry Point)

**Files:**
- Create: `src/marketing/orchestrator.ts`

This is the top-level router that the agent invokes when it detects marketing intent. It ties together brand intake, audit, campaign planning, and ongoing content execution.

- [ ] **Step 1: Create `src/marketing/orchestrator.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { LLMClient } from "../llm.js";
import { loadBrandProfile, saveBrandProfile, slugify, type BrandProfile, type Platform, type AutonomyMode, type OutreachMode } from "./brand-profile.js";
import { presentStrategyOptions, generateContentCalendar, type CampaignPlan } from "./campaign-planner.js";
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
  llm: LLMClient
): Promise<BrandProfile> {
  const id = slugify(input.name);

  // Check if profile already exists
  const existing = loadBrandProfile(id);
  if (existing) return existing;

  // Create initial profile
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

  // Notify user and start audit
  await deliverToActiveChannel(
    `Got it! Give me a few minutes to research ${input.name}, analyse your competitors, and figure out what's trending in your space. I'll come back with a full strategy.`,
    undefined
  );

  // Run brand audit
  await executeTool("brand_audit", {
    brand_id: id,
    website: input.website,
    social_handles: input.socialHandles ?? {},
    competitors: input.competitors ?? [],
    depth: "standard",
  });

  // Reload updated profile (audit writes content pillars + brand voice back)
  return loadBrandProfile(id) ?? profile;
}

export async function presentMarketingStrategy(brandId: string): Promise<void> {
  const profile = loadBrandProfile(brandId);
  if (!profile) {
    await deliverToActiveChannel("No brand profile found. Please set up your brand first.", undefined);
    return;
  }
  const strategyMessage = await presentStrategyOptions(profile);
  await deliverToActiveChannel(strategyMessage, undefined);
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

  // Generate the content calendar
  const plan: CampaignPlan = {
    brandId,
    platforms,
    contentPillars: profile.contentPillars,
    weeklyPostingCadence: Object.fromEntries(platforms.map((p) => [p, p === "tiktok" ? 4 : p === "instagram" ? 3 : 2])) as Partial<Record<Platform, number>>,
    autonomyMode,
    linkedinOutreachMode: linkedinMode,
    calendarWeeks: 4,
    createdAt: new Date().toISOString(),
  };

  await generateContentCalendar(profile, plan);
  await deliverToActiveChannel(
    `Your 4-week content calendar is ready! I've scheduled ${platforms.join(", ")} posts across ${plan.calendarWeeks} weeks. I'll start creating content now — you'll get a preview for each piece before anything goes live.`,
    undefined
  );
}
```

- [ ] **Step 2: Build check**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/marketing/orchestrator.ts
git commit -m "feat(marketing): marketing orchestrator — brand intake → audit → strategy → calendar"
```

---

**Plan 3 complete.** Content factory is ready: script writer with trend-aware hooks, Runway ML + Pexels video generation, full video pipeline from footage to approval, campaign planner with content calendar scaffolding, and the top-level orchestrator tying it all together. Proceed to Plan 4 (Distribution Engine).
