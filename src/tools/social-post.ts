// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ToolDefinition } from "./get-current-time.js";

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
        },
        required: ["platform", "brand_id", "content_type", "caption"],
      },
    },
  },
  async handler(_input) {
    return JSON.stringify({ status: "stub", message: "social_post not yet implemented — Plan 4" });
  },
};
