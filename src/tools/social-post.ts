// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { postFacebook } from "../marketing/adapters/facebook.js";
import { postInstagram } from "../marketing/adapters/instagram.js";
import { postLinkedIn } from "../marketing/adapters/linkedin.js";
import { postReddit } from "../marketing/adapters/reddit.js";
import { postTikTok } from "../marketing/adapters/tiktok.js";
import { postTwitter } from "../marketing/adapters/twitter.js";
import { postYouTube } from "../marketing/adapters/youtube.js";
import { updateCalendarItem } from "../marketing/content-calendar.js";
import { prepareLaunchChecklist, sendLaunchChecklist } from "../marketing/product-hunt.js";
import type { ToolDefinition } from "./get-current-time.js";

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
                        enum: [
                            "instagram",
                            "linkedin",
                            "tiktok",
                            "twitter",
                            "facebook",
                            "youtube",
                            "reddit",
                            "producthunt",
                        ],
                    },
                    brand_id: { type: "string" },
                    content_type: {
                        type: "string",
                        enum: ["reel", "post", "story", "carousel", "thread", "article", "video", "text"],
                    },
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
                    const result = await postInstagram(
                        brandId,
                        contentType as "reel" | "image",
                        caption,
                        mediaPath,
                        hashtags,
                    );
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
                case "facebook": {
                    const result = await postFacebook(brandId, caption, mediaPath);
                    postUrl = `https://facebook.com/${result.postId}`;
                    break;
                }
                case "youtube": {
                    if (!mediaPath) return JSON.stringify({ error: "media_path required for YouTube" });
                    const titleLine = caption.split("\n")[0].slice(0, 100);
                    const result = await postYouTube(brandId, titleLine, caption, mediaPath);
                    postUrl = result.url;
                    break;
                }
                case "reddit": {
                    const subreddit = (input.subreddit as string) ?? "general";
                    const titleLine = caption.split("\n")[0].slice(0, 300);
                    const result = await postReddit(brandId, subreddit, titleLine, caption);
                    postUrl = result.url;
                    break;
                }
                case "producthunt": {
                    const checklist = prepareLaunchChecklist(
                        brandId,
                        caption.split("\n")[0].slice(0, 60),
                        caption,
                        mediaPath ? [mediaPath] : [],
                    );
                    await sendLaunchChecklist(checklist);
                    return JSON.stringify({
                        status: "checklist_sent",
                        message: "Launch checklist sent to your active channel",
                    });
                }
                default:
                    return JSON.stringify({ error: `Unknown platform: ${platform}` });
            }

            if (itemId) {
                updateCalendarItem(itemId, { status: "posted", postUrl });
            }

            return JSON.stringify({ success: true, platform, postUrl });
        } catch (err) {
            const msg = (err as Error).message;
            if (
                msg.toLowerCase().includes("credential") ||
                msg.toLowerCase().includes("not set") ||
                msg.toLowerCase().includes("missing")
            ) {
                return JSON.stringify({
                    error: msg,
                    action_required: "credential_setup",
                    hint: `Call credential_setup with platform="${platform}" and brand_id="${brandId}" to set up the missing credentials, then retry social_post.`,
                });
            }
            return JSON.stringify({ error: msg });
        }
    },
};
