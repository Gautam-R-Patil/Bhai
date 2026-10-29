// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import { resolveCredential } from "../brand-profile.js";

export type LIContentType = "text" | "image" | "article" | "video";

export interface LIPostResult {
  postId: string;
  url: string;
}

export async function postLinkedIn(
  brandId: string,
  contentType: LIContentType,
  caption: string,
  mediaPath?: string
): Promise<LIPostResult> {
  const orgId = resolveCredential(`LI_ORG_ID_${brandId}`);
  const accessToken = resolveCredential(`LI_ACCESS_TOKEN_${brandId}`);
  if (!orgId || !accessToken) {
    throw new Error(`Missing LinkedIn credentials for brand "${brandId}". Set LI_ORG_ID_${brandId} and LI_ACCESS_TOKEN_${brandId} in .env`);
  }
  const author = `urn:li:organization:${orgId}`;
  const commonHeaders = {
    Authorization: `Bearer ${accessToken}`,
    "LinkedIn-Version": "202404",
    "X-Restli-Protocol-Version": "2.0.0",
    "Content-Type": "application/json",
  };

  let mediaContent: Record<string, unknown> | undefined;

  if (mediaPath && fs.existsSync(mediaPath) && (contentType === "image" || contentType === "video")) {
    // Step 1: initialise upload
    const initRes = await fetch("https://api.linkedin.com/v2/images?action=initializeUpload", {
      method: "POST",
      headers: commonHeaders,
      body: JSON.stringify({ initializeUploadRequest: { owner: author } }),
    });
    if (!initRes.ok) throw new Error(`LinkedIn image upload init failed: ${await initRes.text()}`);
    const initData = (await initRes.json()) as { value: { uploadUrl: string; image: string } };
    const { uploadUrl, image: imageUrn } = initData.value;

    // Step 2: upload binary
    const fileBuffer = fs.readFileSync(mediaPath);
    const mimeType = mediaPath.endsWith(".mp4") ? "video/mp4"
      : mediaPath.endsWith(".png") ? "image/png"
      : mediaPath.endsWith(".gif") ? "image/gif"
      : "image/jpeg";
    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": mimeType },
      body: fileBuffer,
    });
    if (!uploadRes.ok) throw new Error(`LinkedIn image upload failed: ${await uploadRes.text()}`);

    mediaContent = { media: { id: imageUrn } };
  }

  // Step 3: create post
  const postBody: Record<string, unknown> = {
    author,
    commentary: caption,
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  if (mediaContent) postBody.content = mediaContent;

  const postRes = await fetch("https://api.linkedin.com/v2/posts", {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify(postBody),
  });
  if (!postRes.ok) throw new Error(`LinkedIn post creation failed: ${await postRes.text()}`);

  const postId = postRes.headers.get("x-restli-id") ?? postRes.headers.get("x-linkedin-id") ?? "unknown";
  return { postId, url: `https://www.linkedin.com/company/${orgId}/posts/` };
}
