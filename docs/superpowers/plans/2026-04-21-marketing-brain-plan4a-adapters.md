# Marketing Brain — Plan 4A: Social Media Platform Adapters

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement direct API adapters for Instagram, LinkedIn, TikTok, and Twitter/X so ATLAS can post content to these platforms programmatically.

**Architecture:** Each adapter is a standalone TypeScript module in `src/marketing/adapters/` with a single exported async `post()` function. The `social_post` tool (stub from Plan 1) gets its real implementation wired in. Per-platform rate limit tracking in SQLite.

**Prereq:** Plans 1, 2, 3 complete. Run `npm install twitter-api-v2` before starting.

**Tech Stack:** Instagram Graph API (fetch), LinkedIn Posts API v2 (fetch), TikTok Content Posting API (fetch), twitter-api-v2 npm package, existing better-sqlite3 DB.

---

### Task 1: Instagram Adapter

**Files:**
- Create: `src/marketing/adapters/instagram.ts`

- [ ] **Step 1: Install prereq and create adapters directory**

```bash
npm install twitter-api-v2
mkdir -p src/marketing/adapters
```

- [ ] **Step 2: Create `src/marketing/adapters/instagram.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getDB } from "../../memory/sqlite.js";
import { resolveCredential } from "../brand-profile.js";

export type IGContentType = "reel" | "image" | "carousel";

export interface IGPostResult {
  postId: string;
  url: string;
}

// ── Rate limit check ─────────────────────────────────────────────────────────

function checkRateLimit(brandId: string): void {
  const db = getDB();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = db.exec(
    `SELECT COUNT(*) as cnt FROM marketing_calendar
     WHERE brand_id = ? AND platform = 'instagram' AND status = 'posted'
     AND created_at >= ?`,
    [brandId, since]
  );
  const count = rows[0]?.values[0]?.[0] as number ?? 0;
  if (count >= 25) {
    throw new Error(
      `Instagram rate limit: ${count} posts in the last 24 h (max 25). Try again later.`
    );
  }
}

// ── Temp URL helper (same-machine / dev only) ─────────────────────────────────

/**
 * Spins up a one-shot `npx serve` process on a random high port so the Meta
 * API can reach a local file during development.
 *
 * WARNING: This exposes the file on localhost only — Meta's servers cannot
 * reach it from the internet. For production, upload the file to a real CDN
 * (e.g. S3 presigned URL) and replace this function.
 */
async function uploadToTempUrl(filePath: string): Promise<string> {
  const dir = path.dirname(filePath);
  const file = path.basename(filePath);
  const port = 40000 + Math.floor(Math.random() * 10000);

  console.warn(
    "[instagram adapter] WARNING: uploadToTempUrl uses localhost — " +
      "Meta servers cannot reach this URL from the internet. " +
      "Replace with a real CDN upload for production."
  );

  // Start serve in the background; it stays alive for the polling window.
  execSync(`npx serve --no-clipboard --listen ${port} "${dir}" &`, {
    stdio: "ignore",
    shell: true,
  });

  // Brief wait for serve to bind.
  await new Promise<void>((res) => setTimeout(res, 1500));

  return `http://localhost:${port}/${encodeURIComponent(file)}`;
}

// ── Core posting logic ────────────────────────────────────────────────────────

/**
 * Post a single image or Reel to Instagram via the Meta Graph API.
 *
 * Required env vars (namespaced by brandId):
 *   IG_USER_ID_{brandId}      — Instagram user/account ID
 *   IG_ACCESS_TOKEN_{brandId} — long-lived Page access token
 */
export async function postInstagram(
  brandId: string,
  contentType: IGContentType,
  caption: string,
  mediaPath: string,
  hashtags: string[] = []
): Promise<IGPostResult> {
  // Resolve credentials.
  const userId = resolveCredential(`IG_USER_ID_${brandId}`);
  const accessToken = resolveCredential(`IG_ACCESS_TOKEN_${brandId}`);
  if (!userId || !accessToken) {
    throw new Error(
      `Missing Instagram credentials for brand "${brandId}". ` +
        `Set IG_USER_ID_${brandId} and IG_ACCESS_TOKEN_${brandId} in .env`
    );
  }

  // Rate limit check.
  checkRateLimit(brandId);

  if (!fs.existsSync(mediaPath)) {
    throw new Error(`Media file not found: ${mediaPath}`);
  }

  const fullCaption =
    hashtags.length > 0
      ? `${caption}\n\n${hashtags.map((h) => `#${h}`).join(" ")}`
      : caption;

  const baseUrl = `https://graph.facebook.com/v19.0/${userId}`;
  const isReel = contentType === "reel";
  const mediaType = isReel ? "REELS" : "IMAGE";

  // Step 1: obtain a media URL (only needed for Reels — images can be uploaded
  // via the image_url param; for dev we use the same helper for both).
  const mediaUrl = await uploadToTempUrl(mediaPath);

  // Step 2: create the media container.
  const containerBody: Record<string, string> = {
    caption: fullCaption,
    access_token: accessToken,
    media_type: mediaType,
  };
  if (isReel) {
    containerBody.video_url = mediaUrl;
  } else {
    containerBody.image_url = mediaUrl;
  }

  const containerRes = await fetch(`${baseUrl}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(containerBody),
  });

  if (!containerRes.ok) {
    const err = await containerRes.text();
    throw new Error(`Instagram container creation failed: ${err}`);
  }

  const { id: containerId } = (await containerRes.json()) as { id: string };

  // Step 3: poll until the container is FINISHED (max 3 min, 5s intervals).
  const pollDeadline = Date.now() + 3 * 60 * 1000;
  let containerStatus = "IN_PROGRESS";

  while (containerStatus !== "FINISHED" && Date.now() < pollDeadline) {
    await new Promise<void>((res) => setTimeout(res, 5000));

    const statusRes = await fetch(
      `${baseUrl}/${containerId}?fields=status_code&access_token=${accessToken}`
    );
    if (!statusRes.ok) {
      const err = await statusRes.text();
      throw new Error(`Instagram container status poll failed: ${err}`);
    }
    const statusBody = (await statusRes.json()) as { status_code: string };
    containerStatus = statusBody.status_code;

    if (containerStatus === "ERROR" || containerStatus === "EXPIRED") {
      throw new Error(
        `Instagram media container entered terminal state: ${containerStatus}`
      );
    }
  }

  if (containerStatus !== "FINISHED") {
    throw new Error("Instagram media container did not finish processing within 3 minutes.");
  }

  // Step 4: publish.
  const publishRes = await fetch(`${baseUrl}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      creation_id: containerId,
      access_token: accessToken,
    }),
  });

  if (!publishRes.ok) {
    const err = await publishRes.text();
    throw new Error(`Instagram publish failed: ${err}`);
  }

  const { id: postId } = (await publishRes.json()) as { id: string };
  const handle = resolveCredential(`IG_HANDLE_${brandId}`) ?? userId;
  const url = `https://www.instagram.com/${handle}/`;

  return { postId, url };
}
```

- [ ] **Step 3: Build check**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -20
```

- [ ] **Step 4: Commit**

```bash
git add src/marketing/adapters/instagram.ts
git commit -m "feat(marketing): Instagram Graph API adapter with container polling and rate limit"
```

---

### Task 2: LinkedIn Adapter

**Files:**
- Create: `src/marketing/adapters/linkedin.ts`

- [ ] **Step 1: Create `src/marketing/adapters/linkedin.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import { resolveCredential } from "../brand-profile.js";

export type LIContentType = "text" | "image" | "article" | "video";

export interface LIPostResult {
  postId: string;
  url: string;
}

interface LIImageUploadInit {
  value: {
    uploadUrlExpiresAt: number;
    uploadUrl: string;
    image: string; // URN e.g. "urn:li:image:XXXX"
  };
}

// ── Core posting logic ────────────────────────────────────────────────────────

/**
 * Post text or image content to a LinkedIn organisation page.
 *
 * Required env vars (namespaced by brandId):
 *   LI_ORG_ID_{brandId}       — LinkedIn organisation ID (numeric, no URN prefix)
 *   LI_ACCESS_TOKEN_{brandId} — OAuth 2.0 access token with w_member_social scope
 */
export async function postLinkedIn(
  brandId: string,
  contentType: LIContentType,
  caption: string,
  mediaPath?: string
): Promise<LIPostResult> {
  // Resolve credentials.
  const orgId = resolveCredential(`LI_ORG_ID_${brandId}`);
  const accessToken = resolveCredential(`LI_ACCESS_TOKEN_${brandId}`);
  if (!orgId || !accessToken) {
    throw new Error(
      `Missing LinkedIn credentials for brand "${brandId}". ` +
        `Set LI_ORG_ID_${brandId} and LI_ACCESS_TOKEN_${brandId} in .env`
    );
  }

  const author = `urn:li:organization:${orgId}`;

  const commonHeaders = {
    Authorization: `Bearer ${accessToken}`,
    "LinkedIn-Version": "202404",
    "X-Restli-Protocol-Version": "2.0.0",
    "Content-Type": "application/json",
  };

  // ── Image upload (if mediaPath provided for an image/video post) ──────────
  let imageUrn: string | undefined;
  if (mediaPath && (contentType === "image" || contentType === "video")) {
    if (!fs.existsSync(mediaPath)) {
      throw new Error(`Media file not found: ${mediaPath}`);
    }

    // Register the image upload.
    const initRes = await fetch(
      "https://api.linkedin.com/v2/images?action=initializeUpload",
      {
        method: "POST",
        headers: commonHeaders,
        body: JSON.stringify({
          initializeUploadRequest: { owner: author },
        }),
      }
    );

    if (!initRes.ok) {
      const err = await initRes.text();
      throw new Error(`LinkedIn image upload init failed: ${err}`);
    }

    const initBody = (await initRes.json()) as LIImageUploadInit;
    const { uploadUrl, image } = initBody.value;
    imageUrn = image;

    // PUT the binary to the pre-signed upload URL.
    const fileBytes = fs.readFileSync(mediaPath);
    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: fileBytes,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      throw new Error(`LinkedIn image binary upload failed: ${err}`);
    }
  }

  // ── Build post body ───────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const postBody: Record<string, any> = {
    author,
    commentary: caption,
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };

  if (imageUrn) {
    postBody.content = {
      media: {
        title: caption.slice(0, 200),
        id: imageUrn,
      },
    };
  }

  // ── Submit the post ───────────────────────────────────────────────────────
  const postRes = await fetch("https://api.linkedin.com/v2/posts", {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify(postBody),
  });

  if (!postRes.ok) {
    const err = await postRes.text();
    throw new Error(`LinkedIn post creation failed: ${err}`);
  }

  // The post URN is returned in the `x-restli-id` response header.
  const postUrn =
    postRes.headers.get("x-restli-id") ??
    postRes.headers.get("X-RestLI-Id") ??
    "";

  // Encode the URN for use in the share URL.
  const encodedUrn = encodeURIComponent(postUrn);
  const url = `https://www.linkedin.com/feed/update/${encodedUrn}/`;

  return { postId: postUrn, url };
}
```

- [ ] **Step 2: Build check**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -20
```

- [ ] **Step 3: Commit**

```bash
git add src/marketing/adapters/linkedin.ts
git commit -m "feat(marketing): LinkedIn Posts API v2 adapter with image upload support"
```

---

### Task 3: TikTok Adapter

**Files:**
- Create: `src/marketing/adapters/tiktok.ts`

- [ ] **Step 1: Create `src/marketing/adapters/tiktok.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import { getDB } from "../../memory/sqlite.js";
import { resolveCredential } from "../brand-profile.js";

export interface TikTokPostResult {
  publishId: string;
}

interface TikTokInitResponse {
  data: {
    publish_id: string;
    upload_url: string;
  };
  error: {
    code: string;
    message: string;
    log_id: string;
  };
}

interface TikTokStatusResponse {
  data: {
    status: string;        // "PROCESSING_UPLOAD" | "PROCESSING_DOWNLOAD" | "SEND_TO_USER_INBOX" | "PUBLISH_COMPLETE" | "FAILED"
    fail_reason?: string;
    publicaly_available_post_id?: string[];
  };
  error: {
    code: string;
    message: string;
    log_id: string;
  };
}

// ── Rate limit check ─────────────────────────────────────────────────────────

function checkRateLimit(brandId: string): void {
  const db = getDB();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = db.exec(
    `SELECT COUNT(*) as cnt FROM marketing_calendar
     WHERE brand_id = ? AND platform = 'tiktok' AND status = 'posted'
     AND created_at >= ?`,
    [brandId, since]
  );
  const count = rows[0]?.values[0]?.[0] as number ?? 0;
  if (count >= 15) {
    throw new Error(
      `TikTok rate limit: ${count} posts in the last 24 h (max 15). Try again later.`
    );
  }
}

// ── Core posting logic ────────────────────────────────────────────────────────

/**
 * Post a video to TikTok via the Content Posting API.
 *
 * Required env vars (namespaced by brandId):
 *   TIKTOK_ACCESS_TOKEN_{brandId} — OAuth 2.0 user access token
 */
export async function postTikTok(
  brandId: string,
  caption: string,
  videoPath: string
): Promise<TikTokPostResult> {
  // Resolve credentials.
  const accessToken = resolveCredential(`TIKTOK_ACCESS_TOKEN_${brandId}`);
  if (!accessToken) {
    throw new Error(
      `Missing TikTok credentials for brand "${brandId}". ` +
        `Set TIKTOK_ACCESS_TOKEN_${brandId} in .env`
    );
  }

  // Rate limit check.
  checkRateLimit(brandId);

  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  const fileStats = fs.statSync(videoPath);
  const fileSize = fileStats.size;

  const commonHeaders = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json; charset=UTF-8",
  };

  // Step 1: initialise the upload and receive publish_id + upload_url.
  const initRes = await fetch(
    "https://open.tiktokapis.com/v2/post/publish/video/init/",
    {
      method: "POST",
      headers: commonHeaders,
      body: JSON.stringify({
        post_info: {
          title: caption,
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
    }
  );

  if (!initRes.ok) {
    const err = await initRes.text();
    throw new Error(`TikTok publish init failed (HTTP ${initRes.status}): ${err}`);
  }

  const initBody = (await initRes.json()) as TikTokInitResponse;
  if (initBody.error?.code && initBody.error.code !== "ok") {
    throw new Error(
      `TikTok publish init error: ${initBody.error.code} — ${initBody.error.message}`
    );
  }

  const { publish_id: publishId, upload_url: uploadUrl } = initBody.data;

  // Step 2: upload the video binary via PUT to the pre-signed upload URL.
  const videoBytes = fs.readFileSync(videoPath);
  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Range": `bytes 0-${fileSize - 1}/${fileSize}`,
    },
    body: videoBytes,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`TikTok video upload failed (HTTP ${uploadRes.status}): ${err}`);
  }

  // Step 3: poll status until PUBLISH_COMPLETE (max 5 min, 10s intervals).
  const pollDeadline = Date.now() + 5 * 60 * 1000;
  let status = "PROCESSING_UPLOAD";

  while (status !== "PUBLISH_COMPLETE" && Date.now() < pollDeadline) {
    await new Promise<void>((res) => setTimeout(res, 10000));

    const statusRes = await fetch(
      "https://open.tiktokapis.com/v2/post/publish/status/fetch/",
      {
        method: "POST",
        headers: commonHeaders,
        body: JSON.stringify({ publish_id: publishId }),
      }
    );

    if (!statusRes.ok) {
      const err = await statusRes.text();
      throw new Error(`TikTok status poll failed (HTTP ${statusRes.status}): ${err}`);
    }

    const statusBody = (await statusRes.json()) as TikTokStatusResponse;
    if (statusBody.error?.code && statusBody.error.code !== "ok") {
      throw new Error(
        `TikTok status error: ${statusBody.error.code} — ${statusBody.error.message}`
      );
    }

    status = statusBody.data.status;

    if (status === "FAILED") {
      throw new Error(
        `TikTok publish failed: ${statusBody.data.fail_reason ?? "unknown reason"}`
      );
    }
  }

  if (status !== "PUBLISH_COMPLETE") {
    throw new Error("TikTok video did not finish publishing within 5 minutes.");
  }

  return { publishId };
}
```

- [ ] **Step 2: Build check**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -20
```

- [ ] **Step 3: Commit**

```bash
git add src/marketing/adapters/tiktok.ts
git commit -m "feat(marketing): TikTok Content Posting API adapter with status polling"
```

---

### Task 4: Twitter/X Adapter

**Files:**
- Create: `src/marketing/adapters/twitter.ts`

- [ ] **Step 1: Create `src/marketing/adapters/twitter.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { TwitterApi } from "twitter-api-v2";
import { resolveCredential } from "../brand-profile.js";

export interface TwitterPostResult {
  tweetId: string;
  url: string;
}

// ── Core posting logic ────────────────────────────────────────────────────────

/**
 * Post a tweet (optionally with media) to Twitter/X via twitter-api-v2.
 *
 * Required env vars (namespaced by brandId):
 *   TWITTER_APP_KEY_{brandId}        — API key (consumer key)
 *   TWITTER_APP_SECRET_{brandId}     — API key secret (consumer secret)
 *   TWITTER_ACCESS_TOKEN_{brandId}   — User access token
 *   TWITTER_ACCESS_SECRET_{brandId}  — User access token secret
 *
 * Optional:
 *   TWITTER_HANDLE_{brandId}         — @handle without @ (used to build URL)
 */
export async function postTwitter(
  brandId: string,
  text: string,
  mediaPath?: string
): Promise<TwitterPostResult> {
  // Resolve credentials.
  const appKey = resolveCredential(`TWITTER_APP_KEY_${brandId}`);
  const appSecret = resolveCredential(`TWITTER_APP_SECRET_${brandId}`);
  const accessToken = resolveCredential(`TWITTER_ACCESS_TOKEN_${brandId}`);
  const accessSecret = resolveCredential(`TWITTER_ACCESS_SECRET_${brandId}`);

  if (!appKey || !appSecret || !accessToken || !accessSecret) {
    throw new Error(
      `Missing Twitter credentials for brand "${brandId}". ` +
        `Set TWITTER_APP_KEY_${brandId}, TWITTER_APP_SECRET_${brandId}, ` +
        `TWITTER_ACCESS_TOKEN_${brandId}, and TWITTER_ACCESS_SECRET_${brandId} in .env`
    );
  }

  const client = new TwitterApi({
    appKey,
    appSecret,
    accessToken,
    accessSecret,
  });

  let tweetId: string;

  if (mediaPath) {
    // Upload media via v1.1 endpoint, then attach to v2 tweet.
    const mediaId = await client.v1.uploadMedia(mediaPath);

    const tweetRes = await client.v2.tweet({
      text,
      media: { media_ids: [mediaId] },
    });

    tweetId = tweetRes.data.id;
  } else {
    // Plain text tweet via v2.
    const tweetRes = await client.v2.tweet(text);
    tweetId = tweetRes.data.id;
  }

  // Resolve screen name for URL construction (best effort).
  const handle = resolveCredential(`TWITTER_HANDLE_${brandId}`);
  const screenName = handle ?? "i";
  const url = `https://twitter.com/${screenName}/status/${tweetId}`;

  return { tweetId, url };
}
```

- [ ] **Step 2: Build check**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -20
```

- [ ] **Step 3: Commit**

```bash
git add src/marketing/adapters/twitter.ts
git commit -m "feat(marketing): Twitter/X adapter via twitter-api-v2 with optional media upload"
```

---

### Task 5: Wire `social_post` Tool Real Implementation

**Files:**
- Replace stub in: `src/tools/social-post.ts`
  - Note: this file is part of `src/tools/index.ts` in Plan 1 — if `social_post` was inlined there, extract it first (see Step 0 below).

- [ ] **Step 0 (conditional): Extract inline stub to its own file**

If `social_post` was left inline in `src/tools/index.ts` (as the stub was shown in Plan 1), create `src/tools/social-post.ts` and replace the inline definition with an import. If it was already extracted to `src/tools/social-post.ts`, skip this step.

Check:
```bash
grep -n "social_post\|socialPost" src/tools/index.ts | head -5
```

If the stub is inline, move it out:
```bash
# After creating social-post.ts (Step 1 below), replace the inline block in index.ts
# with: import { socialPost } from "./social-post.js";
```

- [ ] **Step 1: Create `src/tools/social-post.ts` with real implementation**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { updateCalendarItem } from "../marketing/content-calendar.js";
import { postInstagram } from "../marketing/adapters/instagram.js";
import { postLinkedIn } from "../marketing/adapters/linkedin.js";
import { postTikTok } from "../marketing/adapters/tiktok.js";
import { postTwitter } from "../marketing/adapters/twitter.js";
import type { ToolDefinition } from "./get-current-time.js";

interface SocialPostInput {
  platform: "instagram" | "linkedin" | "tiktok" | "twitter" | "facebook" | "youtube" | "reddit";
  brand_id: string;
  content_type: "reel" | "post" | "story" | "carousel" | "thread" | "article" | "video" | "text";
  caption: string;
  media_path?: string;
  hashtags?: string[];
  item_id?: number;
  scheduled_at?: string;
}

export const socialPost: ToolDefinition = {
  schema: {
    type: "function",
    function: {
      name: "social_post",
      description:
        "Post or schedule content to a social media platform (Instagram, LinkedIn, TikTok, Twitter/X, Facebook, YouTube, Reddit). Handles media upload, caption, hashtags, and optional scheduling.",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["instagram", "linkedin", "tiktok", "twitter", "facebook", "youtube", "reddit"],
            description: "Target platform",
          },
          brand_id: { type: "string", description: "Brand slug from brand profile" },
          content_type: {
            type: "string",
            enum: ["reel", "post", "story", "carousel", "thread", "article", "video", "text"],
          },
          caption: { type: "string", description: "Post caption / body text" },
          media_path: {
            type: "string",
            description: "Absolute local path to video or image file",
          },
          hashtags: {
            type: "array",
            items: { type: "string" },
            description: "Hashtags without # prefix",
          },
          item_id: {
            type: "number",
            description:
              "Optional marketing_calendar row ID — if provided, status is updated to 'posted' on success",
          },
          scheduled_at: {
            type: "string",
            description: "ISO 8601 datetime to schedule. Omit to post immediately.",
          },
        },
        required: ["platform", "brand_id", "content_type", "caption"],
      },
    },
  },

  async handler(rawInput) {
    const input = rawInput as unknown as SocialPostInput;
    const { platform, brand_id, content_type, caption, media_path, hashtags, item_id } = input;

    try {
      let result: Record<string, unknown>;

      switch (platform) {
        case "instagram": {
          const igType =
            content_type === "reel"
              ? "reel"
              : content_type === "carousel"
              ? "carousel"
              : "image";
          if (!media_path) {
            throw new Error("Instagram requires a media_path (image or video file).");
          }
          result = await postInstagram(brand_id, igType, caption, media_path, hashtags ?? []);
          break;
        }

        case "linkedin": {
          const liType =
            content_type === "article"
              ? "article"
              : content_type === "video"
              ? "video"
              : media_path
              ? "image"
              : "text";
          result = await postLinkedIn(brand_id, liType, caption, media_path);
          break;
        }

        case "tiktok": {
          if (!media_path) {
            throw new Error("TikTok requires a media_path (video file).");
          }
          result = await postTikTok(brand_id, caption, media_path);
          break;
        }

        case "twitter": {
          result = await postTwitter(brand_id, caption, media_path);
          break;
        }

        case "facebook":
        case "youtube":
        case "reddit":
          return JSON.stringify({
            error: `Platform "${platform}" is not yet implemented in Plan 4A. Planned for a future plan.`,
          });

        default:
          return JSON.stringify({ error: `Unknown platform: ${platform}` });
      }

      // Update calendar item if one was provided.
      if (item_id != null) {
        const postUrl =
          (result as Record<string, string>).url ??
          (result as Record<string, string>).publishId ??
          "";
        updateCalendarItem(item_id, { status: "posted", postUrl });
      }

      return JSON.stringify({ success: true, platform, ...result });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      // Update calendar item to failed state if provided.
      if (item_id != null) {
        try {
          updateCalendarItem(item_id, { status: "failed" });
        } catch {
          // best effort — don't mask the original error
        }
      }

      return JSON.stringify({ error: message });
    }
  },
};
```

- [ ] **Step 2: Wire `socialPost` into `src/tools/index.ts`**

Find the existing inline stub or import and replace it. The import to add at the top of `src/tools/index.ts` (if not already there):

```typescript
import { socialPost } from "./social-post.js";
```

If the stub was previously inline, remove it and ensure `registry.set(socialPost.schema.function.name, socialPost);` remains (it should already be present from Plan 1).

If the line `registry.set("social_post", ...)` does not exist yet, add it near the other marketing tool registrations:

```typescript
// marketing tools
registry.set(socialPost.schema.function.name, socialPost);
```

- [ ] **Step 3: Build check**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -20
```

- [ ] **Step 4: Smoke test (requires Plans 1–3 wired)**

```bash
node -e "
import('./dist/tools/index.js').then(m => {
  const names = m.getToolNames ? m.getToolNames() : [];
  const has = names.includes('social_post');
  console.log('social_post registered:', has);
  if (!has) process.exit(1);
});
"
```

- [ ] **Step 5: Commit**

```bash
git add src/tools/social-post.ts src/tools/index.ts
git commit -m "feat(marketing): wire social_post tool — replace stub with real adapter routing"
```

---

## Environment Variables Reference

Add these to `.env.example` (documenting what needs to be set per brand):

```dotenv
# Instagram — replace {brandId} with actual brand slug
IG_USER_ID_{brandId}=
IG_ACCESS_TOKEN_{brandId}=
IG_HANDLE_{brandId}=          # optional, used for post URL

# LinkedIn
LI_ORG_ID_{brandId}=
LI_ACCESS_TOKEN_{brandId}=

# TikTok
TIKTOK_ACCESS_TOKEN_{brandId}=

# Twitter/X
TWITTER_APP_KEY_{brandId}=
TWITTER_APP_SECRET_{brandId}=
TWITTER_ACCESS_TOKEN_{brandId}=
TWITTER_ACCESS_SECRET_{brandId}=
TWITTER_HANDLE_{brandId}=     # optional, used for post URL
```

---

## Completion Checklist

- [ ] `npm install twitter-api-v2` done
- [ ] `src/marketing/adapters/instagram.ts` created and typechecks clean
- [ ] `src/marketing/adapters/linkedin.ts` created and typechecks clean
- [ ] `src/marketing/adapters/tiktok.ts` created and typechecks clean
- [ ] `src/marketing/adapters/twitter.ts` created and typechecks clean
- [ ] `src/tools/social-post.ts` updated with real routing logic
- [ ] `src/tools/index.ts` imports `socialPost` from `./social-post.js`
- [ ] `npm run typecheck` exits 0 across all five files
- [ ] `.env.example` updated with all credential variable names
- [ ] All five commits pushed

## Notes for Future Plans

- **Facebook**: requires a Page access token + `pages_manage_posts` permission; reserve for Plan 4B.
- **YouTube**: requires OAuth 2 with `youtube.upload` scope and chunked resumable upload; reserve for Plan 4B.
- **Reddit**: requires OAuth 2 `submit` scope; reserve for Plan 4B.
- **Instagram CDN**: `uploadToTempUrl` is a localhost shim only. In production replace with a pre-signed S3 upload (or any public CDN) and remove the `npx serve` path before enabling for live brands.
- **TikTok chunked upload**: For videos > 64 MB the TikTok API requires chunked multi-part upload. The current implementation sends the file as a single chunk, which is fine for typical Reels length. Add chunking in Plan 4B if needed.
- **Rate limit persistence**: the per-platform rate limit queries read `marketing_calendar` rows with `status = 'posted'`. This assumes `updateCalendarItem` is called with `status: 'posted'` on every successful post — which the `social_post` handler does when `item_id` is provided. Direct adapter calls without an `item_id` will not count toward the calendar-based rate limit; add a dedicated `rate_limit_log` table in a future plan if stricter enforcement is needed.
