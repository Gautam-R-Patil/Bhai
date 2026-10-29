// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { promises as fs } from "node:fs";
import { resolveCredential } from "../brand-profile.js";

export interface FacebookPostResult {
  postId: string;
}

export async function postFacebook(
  brandId: string,
  caption: string,
  mediaPath?: string
): Promise<FacebookPostResult> {
  const pageId = resolveCredential(`FB_PAGE_ID_${brandId}`);
  const accessToken = resolveCredential(`FB_ACCESS_TOKEN_${brandId}`);
  if (!pageId || !accessToken) throw new Error(`Facebook credentials not set for brand "${brandId}"`);

  if (mediaPath) {
    const imageBuffer = await fs.readFile(mediaPath);
    const form = new FormData();
    form.append("caption", caption);
    form.append("access_token", accessToken);
    form.append("source", new Blob([imageBuffer]), "image.jpg");
    const res = await fetch(`https://graph.facebook.com/v20.0/${pageId}/photos`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`Facebook photo post failed: ${await res.text()}`);
    const data = (await res.json()) as { id: string };
    return { postId: data.id };
  }

  const res = await fetch(`https://graph.facebook.com/v20.0/${pageId}/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: caption, access_token: accessToken }),
  });
  if (!res.ok) throw new Error(`Facebook feed post failed: ${await res.text()}`);
  const data = (await res.json()) as { id: string };
  return { postId: data.id };
}
