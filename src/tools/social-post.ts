// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ToolDefinition } from "./get-current-time.js";
import { updateCalendarItem } from "../marketing/content-calendar.js";
import { postInstagram } from "../marketing/adapters/instagram.js";
import { postLinkedIn } from "../marketing/adapters/linkedin.js";
import { postTikTok } from "../marketing/adapters/tiktok.js";
import { postTwitter } from "../marketing/adapters/twitter.js";

export const socialPost: ToolDefinition = {
  schema: {
    type: "function",
    function: {
      name: "social_post",
      description: "Post or schedule content to a social media platform (Instagram, LinkedIn, TikTok, Twitter/X, Facebook, YouTube, Reddit). Handles media upload, caption, hashtags, and optional scheduling.",
      parameters: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["instagram", "linkedin", "tiktok", "twitter", "facebook", "youtube", "reddit"] },
          brand_id: { type: "string" },
          content_type: { type: "string", enum: ["reel", "post", "story", "carousel", "thread", "article", "video", "text"] },
          caption: { type: "string" },
          media_path: { type: "string" },
          hashtags: { type: "array", items: { type: "string" } },
          scheduled_at: { type: "string" },
          subreddit: { type: "string" },
          item_id: { type: "number", description: "Calendar item ID to mark as posted on success" },
        },
        required: ["platform", "brand_id", "content_type", "caption"],
      },
    },
  },
  async handler(input) {
    const platform = input.platform as string;
    const brandId = input.brand_id as string;
    const caption = input.caption as string;
    const mediaPath = input.media_path as string | undefined;
    const hashtags = (input.hashtags as string[]) ?? [];
    const itemId = input.item_id as number | undefined;

    try {
      let postUrl = "";

      switch (platform) {
        case "instagram": {
          const contentType = (input.content_type as string) === "reel" ? "reel" : "image";
          if (!mediaPath) return JSON.stringify({ error: "media_path required for Instagram" });
          const result = await postInstagram(brandId, contentType as "reel" | "image", caption, mediaPath, hashtags);
          postUrl = result.url;
          break;
        }
        case "linkedin": {
          const contentType = mediaPath ? "image" : "text";
          const result = await postLinkedIn(brandId, contentType as "text" | "image", caption, mediaPath);
          postUrl = result.url;
          break;
        }
        case "tiktok": {
          if (!mediaPath) return JSON.stringify({ error: "media_path required for TikTok" });
          await postTikTok(brandId, caption, mediaPath);
          postUrl = "https://tiktok.com";
          break;
        }
        case "twitter": {
          const result = await postTwitter(brandId, caption, mediaPath);
          postUrl = result.url;
          break;
        }
        case "facebook":
        case "youtube":
        case "reddit":
          return JSON.stringify({ status: "stub", message: `${platform} posting implemented in Plan 4B` });
        default:
          return JSON.stringify({ error: `Unknown platform: ${platform}` });
      }

      if (itemId) {
        updateCalendarItem(itemId, { status: "posted", postUrl });
      }

      return JSON.stringify({ success: true, platform, postUrl });
    } catch (err) {
      return JSON.stringify({ error: (err as Error).message });
    }
  },
};
