// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { setCredential, validateCredential } from "../credential-manager.js";
import { navigateToUrl, extractFromPage } from "./browser-helper.js";
import { deliverToActiveChannel } from "../../tools/channel-send.js";

export async function setupInstagramAutonomous(
  brandId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Open Meta Developer Portal in user's Chrome
    await navigateToUrl("https://developers.facebook.com/apps");

    await deliverToActiveChannel(
      [
        "📱 **Instagram Setup — Step 1 of 3**",
        "",
        "I've opened the Meta Developer Portal. Please:",
        "1. Click **Create App** → Select **Business** → Click Next",
        `2. Name it \`ATLAS-${brandId}\` → Click Create App`,
        "3. On the app dashboard, click **Add Product** → **Instagram** → **Set Up**",
        "4. Go to **Tools → Graph API Explorer**",
        "5. Select your app and click **Generate User Token**",
        "6. Check these permissions: `instagram_basic`, `instagram_content_publish`, `pages_manage_posts`, `pages_read_engagement`",
        "7. Click **Generate Access Token** and copy it",
        "",
        "Reply with your **Page Access Token** and I'll save it.",
      ].join("\n"),
      ""
    );

    // Return waiting status — the actual token will come via user reply
    // The agent will call saveInstagramCredentials() when user provides the token
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function saveInstagramCredentials(
  brandId: string,
  accessToken: string,
  userId: string
): Promise<{ success: boolean; error?: string }> {
  setCredential(`IG_ACCESS_TOKEN_${brandId}`, accessToken);
  setCredential(`IG_USER_ID_${brandId}`, userId);

  const valid = await validateCredential("instagram", brandId);
  if (!valid) {
    return { success: false, error: "Instagram token validation failed — token may be invalid or expired" };
  }

  await deliverToActiveChannel(
    `✅ Instagram connected for brand \`${brandId}\`! Reels and posts are now enabled.`,
    ""
  );
  return { success: true };
}

export function getInstagramGuidedInstructions(brandId: string): string {
  return [
    "**Setting up Instagram (Meta Graph API):**",
    "",
    "**Step 1 — Create a Meta App:**",
    "1. Go to https://developers.facebook.com/apps",
    "2. Click **Create App** → **Business** → Next",
    `3. Name: \`ATLAS-${brandId}\` → Create App`,
    "",
    "**Step 2 — Add Instagram:**",
    "4. Click **Add Product** → **Instagram** → **Set Up**",
    "",
    "**Step 3 — Generate Access Token:**",
    "5. Go to **Tools** → **Graph API Explorer**",
    "6. Select your new app",
    "7. Click **Generate User Token** → check permissions:",
    "   - `instagram_basic`",
    "   - `instagram_content_publish`",
    "   - `pages_manage_posts`",
    "   - `pages_read_engagement`",
    "8. Click **Generate Access Token** → copy it",
    "",
    "**Step 4 — Get your Instagram User ID:**",
    "9. In Graph API Explorer, make a GET request to `/me?fields=id`",
    "10. Copy the `id` value",
    "",
    "Reply with: `token: YOUR_TOKEN user_id: YOUR_ID`",
  ].join("\n");
}
