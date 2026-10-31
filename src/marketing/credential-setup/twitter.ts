// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { setCredential } from "../credential-manager.js";
import { navigateToUrl } from "./browser-helper.js";
import { deliverToActiveChannel } from "../../tools/channel-send.js";

export async function setupTwitterGuided(
  brandId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Open Twitter Developer Portal — user handles CAPTCHA manually
    await navigateToUrl("https://developer.twitter.com/en/portal/projects-and-apps");

    await deliverToActiveChannel(
      [
        "🐦 **Twitter/X Setup (Manual Required)**",
        "",
        "Twitter's developer portal has CAPTCHA, so I've opened it for you.",
        "Please follow these steps:",
        "",
        "1. Click **Add App** (or create a new Project + App)",
        "2. Name your app `Bhai-" + brandId + "`",
        "3. Go to **Keys and Tokens**",
        "4. Under 'Consumer Keys': copy **API Key** and **API Key Secret**",
        "5. Under 'Authentication Tokens': click **Generate** for Access Token and Secret",
        "6. Copy **Access Token** and **Access Token Secret**",
        "",
        "Reply with:",
        "`api_key: X api_secret: X access_token: X access_secret: X`",
      ].join("\n"),
      ""
    );

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function saveTwitterCredentials(
  brandId: string,
  apiKey: string,
  apiSecret: string,
  accessToken: string,
  accessSecret: string
): Promise<{ success: boolean; error?: string }> {
  setCredential(`X_API_KEY_${brandId}`, apiKey);
  setCredential(`X_API_SECRET_${brandId}`, apiSecret);
  setCredential(`X_ACCESS_TOKEN_${brandId}`, accessToken);
  setCredential(`X_ACCESS_SECRET_${brandId}`, accessSecret);

  await deliverToActiveChannel(
    `✅ Twitter/X connected for brand \`${brandId}\`! Tweets and threads are now enabled.`,
    ""
  );
  return { success: true };
}

export function getTwitterGuidedInstructions(brandId: string): string {
  return [
    "**Setting up Twitter/X:**",
    "",
    "1. Go to https://developer.twitter.com/en/portal/projects-and-apps",
    `2. Create app named \`Bhai-${brandId}\``,
    "3. Copy API Key, API Secret, Access Token, Access Token Secret",
    "4. Reply with: `api_key: X api_secret: X access_token: X access_secret: X`",
  ].join("\n");
}
