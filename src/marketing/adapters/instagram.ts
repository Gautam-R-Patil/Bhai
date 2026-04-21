// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getMemoryDB } from "../../memory/sqlite.js";
import { resolveCredential } from "../brand-profile.js";

export type IGContentType = "reel" | "image" | "carousel";

export interface IGPostResult {
  postId: string;
  url: string;
}

function checkRateLimit(brandId: string): void {
  const db = getMemoryDB();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = db.exec(
    `SELECT COUNT(*) as cnt FROM marketing_calendar WHERE brand_id = ? AND platform = 'instagram' AND status = 'posted' AND created_at >= ?`,
    [brandId, since]
  );
  const count = (rows[0]?.values[0]?.[0] as number) ?? 0;
  if (count >= 25) {
    throw new Error(`Instagram rate limit: ${count} posts in the last 24 h (max 25). Try again later.`);
  }
}

async function uploadToTempUrl(filePath: string): Promise<string> {
  const dir = path.dirname(filePath);
  const file = path.basename(filePath);
  const port = 40000 + Math.floor(Math.random() * 10000);
  console.warn("[instagram adapter] WARNING: uploadToTempUrl uses localhost — Meta servers cannot reach this URL. Replace with a real CDN for production.");
  execSync(`npx serve --no-clipboard --listen ${port} "${dir}" &`, { stdio: "ignore", shell: "/bin/sh" });
  await new Promise<void>((res) => setTimeout(res, 1500));
  return `http://localhost:${port}/${encodeURIComponent(file)}`;
}

export async function postInstagram(
  brandId: string,
  contentType: IGContentType,
  caption: string,
  mediaPath: string,
  hashtags: string[] = []
): Promise<IGPostResult> {
  const userId = resolveCredential(`IG_USER_ID_${brandId}`);
  const accessToken = resolveCredential(`IG_ACCESS_TOKEN_${brandId}`);
  if (!userId || !accessToken) {
    throw new Error(`Missing Instagram credentials for brand "${brandId}". Set IG_USER_ID_${brandId} and IG_ACCESS_TOKEN_${brandId} in .env`);
  }
  checkRateLimit(brandId);
  if (!fs.existsSync(mediaPath)) throw new Error(`Media file not found: ${mediaPath}`);

  const fullCaption = hashtags.length > 0 ? `${caption}\n\n${hashtags.map((h) => `#${h}`).join(" ")}` : caption;
  const baseUrl = `https://graph.facebook.com/v19.0/${userId}`;
  const isReel = contentType === "reel";
  const mediaType = isReel ? "REELS" : "IMAGE";
  const mediaUrl = await uploadToTempUrl(mediaPath);

  const containerBody: Record<string, string> = { caption: fullCaption, access_token: accessToken, media_type: mediaType };
  if (isReel) { containerBody.video_url = mediaUrl; } else { containerBody.image_url = mediaUrl; }

  const containerRes = await fetch(`${baseUrl}/media`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(containerBody),
  });
  if (!containerRes.ok) throw new Error(`Instagram container creation failed: ${await containerRes.text()}`);

  const { id: containerId } = (await containerRes.json()) as { id: string };
  const pollDeadline = Date.now() + 3 * 60 * 1000;
  let containerStatus = "IN_PROGRESS";

  while (containerStatus !== "FINISHED" && Date.now() < pollDeadline) {
    await new Promise<void>((res) => setTimeout(res, 5000));
    const statusRes = await fetch(`${baseUrl}/${containerId}?fields=status_code&access_token=${accessToken}`);
    if (!statusRes.ok) throw new Error(`Instagram status poll failed: ${await statusRes.text()}`);
    const statusBody = (await statusRes.json()) as { status_code: string };
    containerStatus = statusBody.status_code;
    if (containerStatus === "ERROR" || containerStatus === "EXPIRED") {
      throw new Error(`Instagram media container entered terminal state: ${containerStatus}`);
    }
  }
  if (containerStatus !== "FINISHED") throw new Error("Instagram media container did not finish within 3 minutes.");

  const publishRes = await fetch(`${baseUrl}/media_publish`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: containerId, access_token: accessToken }),
  });
  if (!publishRes.ok) throw new Error(`Instagram publish failed: ${await publishRes.text()}`);

  const { id: postId } = (await publishRes.json()) as { id: string };
  const handle = resolveCredential(`IG_HANDLE_${brandId}`) ?? userId;
  return { postId, url: `https://www.instagram.com/${handle}/` };
}
