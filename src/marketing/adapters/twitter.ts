// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { TwitterApi } from "twitter-api-v2";
import { resolveCredential } from "../brand-profile.js";

export interface TwitterPostResult {
  tweetId: string;
  url: string;
}

function getTwitterClient(brandId: string): TwitterApi {
  const appKey = resolveCredential(`X_API_KEY_${brandId}`);
  const appSecret = resolveCredential(`X_API_SECRET_${brandId}`);
  const accessToken = resolveCredential(`X_ACCESS_TOKEN_${brandId}`);
  const accessSecret = resolveCredential(`X_ACCESS_SECRET_${brandId}`);
  if (!appKey || !appSecret || !accessToken || !accessSecret) {
    throw new Error(`Missing Twitter credentials for brand "${brandId}". Set X_API_KEY_${brandId}, X_API_SECRET_${brandId}, X_ACCESS_TOKEN_${brandId}, X_ACCESS_SECRET_${brandId} in .env`);
  }
  return new TwitterApi({ appKey, appSecret, accessToken, accessSecret });
}

export async function postTwitter(
  brandId: string,
  text: string,
  mediaPath?: string
): Promise<TwitterPostResult> {
  const client = getTwitterClient(brandId);

  if (mediaPath) {
    const mediaId = await client.v1.uploadMedia(mediaPath);
    const tweet = await client.v2.tweet({ text, media: { media_ids: [mediaId] } });
    const tweetId = tweet.data.id;
    return { tweetId, url: `https://twitter.com/i/status/${tweetId}` };
  }

  const tweet = await client.v2.tweet(text);
  const tweetId = tweet.data.id;
  return { tweetId, url: `https://twitter.com/i/status/${tweetId}` };
}
