// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import { getMemoryDB } from "../../memory/sqlite.js";
import { resolveCredential } from "../brand-profile.js";

export interface TikTokPostResult {
  publishId: string;
}

function checkTikTokRateLimit(brandId: string): void {
  const db = getMemoryDB();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = db.exec(
    `SELECT COUNT(*) as cnt FROM marketing_calendar WHERE brand_id = ? AND platform = 'tiktok' AND status = 'posted' AND created_at >= ?`,
    [brandId, since]
  );
  const count = (rows[0]?.values[0]?.[0] as number) ?? 0;
  if (count >= 15) throw new Error(`TikTok rate limit: ${count} posts in last 24h (max 15)`);
}

export async function postTikTok(
  brandId: string,
  caption: string,
  videoPath: string
): Promise<TikTokPostResult> {
  const accessToken = resolveCredential(`TIKTOK_ACCESS_TOKEN_${brandId}`);
  if (!accessToken) throw new Error(`TIKTOK_ACCESS_TOKEN_${brandId} not set`);
  checkTikTokRateLimit(brandId);
  if (!fs.existsSync(videoPath)) throw new Error(`Video file not found: ${videoPath}`);

  const fileSize = fs.statSync(videoPath).size;

  // Step 1: Initialize upload
  const initRes = await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      post_info: {
        title: caption.slice(0, 150),
        privacy_level: "PUBLIC_TO_EVERYONE",
        disable_duet: false,
        disable_comment: false,
        video_cover_timestamp_ms: 1000,
      },
      source_info: {
        source: "FILE_UPLOAD",
        video_size: fileSize,
        chunk_size: fileSize,
        total_chunk_count: 1,
      },
    }),
  });
  if (!initRes.ok) throw new Error(`TikTok init failed: ${await initRes.text()}`);
  const initData = (await initRes.json()) as { data: { publish_id: string; upload_url: string } };
  const { publish_id: publishId, upload_url: uploadUrl } = initData.data;

  // Step 2: Upload video
  const videoBuffer = fs.readFileSync(videoPath);
  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Range": `bytes 0-${fileSize - 1}/${fileSize}`,
      "Content-Length": String(fileSize),
    },
    body: videoBuffer,
  });
  if (!uploadRes.ok && uploadRes.status !== 206) {
    throw new Error(`TikTok upload failed: ${uploadRes.status}`);
  }

  // Step 3: Poll until published (max 5 minutes)
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10_000));
    const statusRes = await fetch("https://open.tiktokapis.com/v2/post/publish/status/fetch/", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ publish_id: publishId }),
    });
    if (!statusRes.ok) continue;
    const statusData = (await statusRes.json()) as { data: { status: string } };
    if (statusData.data.status === "PUBLISH_COMPLETE") return { publishId };
    if (statusData.data.status === "FAILED") throw new Error(`TikTok publish failed for ${publishId}`);
  }
  throw new Error("TikTok publish timed out after 5 minutes");
}
