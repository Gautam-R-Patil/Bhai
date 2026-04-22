// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import Snoowrap from "snoowrap";
import { resolveCredential } from "../brand-profile.js";

export interface RedditPostResult {
  postId: string;
  url: string;
}

export async function postReddit(
  brandId: string,
  subreddit: string,
  title: string,
  text?: string
): Promise<RedditPostResult> {
  const clientId = resolveCredential(`REDDIT_CLIENT_ID_${brandId}`);
  const clientSecret = resolveCredential(`REDDIT_CLIENT_SECRET_${brandId}`);
  const refreshToken = resolveCredential(`REDDIT_REFRESH_TOKEN_${brandId}`);
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(`Reddit credentials not set for brand "${brandId}"`);
  }

  const r = new Snoowrap({
    userAgent: "ATLAS-Marketing/1.0",
    clientId,
    clientSecret,
    refreshToken,
  });

  // snoowrap returns a self-referential thenable Submission — cast through unknown to break the
  // circular-then TS1062 error while still resolving the async value at runtime.
  type SubmissionLike = { id: string };
  const submitPromise: Promise<SubmissionLike> = Promise.resolve(
    r.submitSelfpost({
      subredditName: subreddit,
      title: title.slice(0, 300),
      text: text ?? "",
    }) as unknown as SubmissionLike
  );
  const submission = await submitPromise;

  const postId = submission.id;
  return { postId, url: `https://reddit.com/r/${subreddit}/comments/${postId}` };
}
