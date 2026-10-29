// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { promises as fs } from "node:fs";
import path from "node:path";
import { getDataDir } from "../../config/paths.js";

export type AspectRatio = "9:16" | "16:9" | "1:1";

export interface AIVideoGenOptions {
  prompt: string;
  aspectRatio?: AspectRatio;
  durationSeconds?: 5 | 10;
  outputPath?: string;
}

export interface AIVideoGenResult {
  filePath: string;
  durationSeconds: number;
  provider: "runway" | "pexels";
}

async function generateRunway(opts: AIVideoGenOptions & { outputPath: string }): Promise<AIVideoGenResult> {
  const apiKey = process.env.RUNWAY_API_KEY;
  if (!apiKey) throw new Error("RUNWAY_API_KEY not set");

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

  if (!createRes.ok) throw new Error(`Runway create failed (${createRes.status}): ${await createRes.text()}`);

  const { id: taskId } = (await createRes.json()) as { id: string };
  const maxWaitMs = 5 * 60 * 1000;
  const pollIntervalMs = 10_000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const statusRes = await fetch(`https://api.dev.runwayml.com/v1/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}`, "X-Runway-Version": "2024-11-06" },
    });
    if (!statusRes.ok) continue;
    const statusData = (await statusRes.json()) as { status: string; output?: string[] };
    if (statusData.status === "SUCCEEDED" && statusData.output?.[0]) {
      const videoRes = await fetch(statusData.output[0]);
      if (!videoRes.ok) throw new Error("Failed to download Runway video");
      await fs.writeFile(opts.outputPath, Buffer.from(await videoRes.arrayBuffer()));
      return { filePath: opts.outputPath, durationSeconds: opts.durationSeconds ?? 5, provider: "runway" };
    }
    if (statusData.status === "FAILED") throw new Error(`Runway generation failed for task ${taskId}`);
  }
  throw new Error("Runway generation timed out after 5 minutes");
}

async function downloadPexelsClip(
  query: string,
  aspectRatio: AspectRatio,
  outputPath: string
): Promise<AIVideoGenResult> {
  const apiKey = process.env.PEXELS_API_KEY;
  const headers: Record<string, string> = { "User-Agent": "ATLAS-Marketing/1.0" };
  if (apiKey) headers.Authorization = apiKey;

  const orientation =
    aspectRatio === "9:16" ? "portrait" : aspectRatio === "1:1" ? "square" : "landscape";
  const searchRes = await fetch(
    `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=${orientation}&per_page=5`,
    { headers }
  );
  if (!searchRes.ok) throw new Error(`Pexels search failed: ${searchRes.status}`);

  const data = (await searchRes.json()) as {
    videos?: Array<{ video_files: Array<{ link: string; width: number }> }>;
  };
  const videos = data.videos ?? [];
  if (!videos.length) throw new Error(`No Pexels videos found for: ${query}`);

  const files = videos[0].video_files.sort((a, b) => b.width - a.width);
  const videoRes = await fetch(files[0].link);
  if (!videoRes.ok) throw new Error("Pexels download failed");
  await fs.writeFile(outputPath, Buffer.from(await videoRes.arrayBuffer()));
  return { filePath: outputPath, durationSeconds: 10, provider: "pexels" };
}

export async function generateAIVideo(opts: AIVideoGenOptions): Promise<AIVideoGenResult> {
  const outputDir = path.join(getDataDir(), "video-projects", "ai-gen");
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = opts.outputPath ?? path.join(outputDir, `gen_${Date.now()}.mp4`);

  if (process.env.RUNWAY_API_KEY) {
    return generateRunway({ ...opts, outputPath });
  }

  const searchQuery = opts.prompt.split(" ").slice(0, 5).join(" ");
  return downloadPexelsClip(searchQuery, opts.aspectRatio ?? "9:16", outputPath);
}

export async function generateMultipleClips(
  prompts: string[],
  aspectRatio: AspectRatio = "9:16"
): Promise<AIVideoGenResult[]> {
  const results: AIVideoGenResult[] = [];
  for (const prompt of prompts) {
    const result = await generateAIVideo({ prompt, aspectRatio, durationSeconds: 5 });
    results.push(result);
  }
  return results;
}
