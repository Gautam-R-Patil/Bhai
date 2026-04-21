// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { executeTool } from "../tools/index.js";
import { deliverToActiveChannel } from "../tools/channel-send.js";
import { queueApproval, sendApprovalRequest } from "./approval-workflow.js";
import { addCalendarItem } from "./content-calendar.js";
import { generateMultipleClips } from "../video-studio/assets/ai-video-gen.js";
import type { VideoScript } from "./script-writer.js";
import type { BrandProfile } from "./brand-profile.js";

export type VideoSource = "ai_generated" | "stock_footage" | "user_will_film";

export interface VideoPipelineOptions {
  brand: BrandProfile;
  script: VideoScript;
  source: VideoSource;
  userVideoPath?: string;
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
    const scenePrompts = script.scenes.map((s) => s.visualDescription);
    const clips = await generateMultipleClips(scenePrompts, "9:16");
    rawVideoPath = clips[0].filePath;
  }

  // ── Step 2: Create video studio project ──────
  const projectResult = await executeTool("video_create_project", {
    name: `marketing_${brand.id}_${Date.now()}`,
    source_files: [rawVideoPath],
  });
  const projectData = JSON.parse(projectResult) as { projectId?: string };
  const projectId = projectData.projectId;
  if (!projectId) throw new Error("video_create_project did not return projectId");

  // ── Step 3: Analyse footage ───────────────────
  await executeTool("video_analyze", { project_id: projectId });

  // ── Step 4: Plan edit ─────────────────────────
  const editInstructions = [
    `Platform: ${script.platform} — use 9:16 aspect ratio`,
    `Add reel_karaoke captions using the on-screen text from each scene`,
    `Total target duration: ${script.totalDurationSeconds} seconds`,
    `Hook text on screen for first 3 seconds: "${script.hook}"`,
    script.scenes
      .map((s, i) => `Scene ${i + 1}: "${s.onScreenText ?? s.visualDescription}"`)
      .join(". "),
  ].join(". ");

  await executeTool("video_plan_edit", {
    project_id: projectId,
    instructions: editInstructions,
    caption_style: "reel_karaoke",
    aspect_ratio: "9:16",
  });

  // ── Step 5: Render ────────────────────────────
  const renderResult = await executeTool("video_render", { project_id: projectId });
  const renderData = JSON.parse(renderResult) as { outputPath?: string };
  const renderedVideoPath = renderData.outputPath;
  if (!renderedVideoPath) throw new Error("video_render did not return outputPath");

  // ── Step 6: Add to content calendar ──────────
  const calendarItemId = addCalendarItem({
    brandId: brand.id,
    platform: script.platform === "youtube_shorts" ? "youtube" : script.platform,
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
  await deliverToActiveChannel(
    `Got your video! Editing it now — I'll send you the finished Reel in a few minutes.`,
    ""
  );

  const projectResult = await executeTool("video_create_project", {
    name: `user_video_${brand.id}_${Date.now()}`,
    source_files: [userVideoPath],
  });
  const projectData = JSON.parse(projectResult) as { projectId?: string };
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
  const renderData = JSON.parse(renderResult) as { outputPath?: string };
  if (!renderData.outputPath) return;

  await deliverToActiveChannel(
    `Here's your edited Reel! Reply \`approve ${calendarItemId}\` to schedule it, or tell me what to change.`,
    renderData.outputPath
  );
}
