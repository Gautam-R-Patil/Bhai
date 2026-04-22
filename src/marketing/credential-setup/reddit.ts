// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { setCredential, validateCredential } from "../credential-manager.js";
import { navigateToUrl } from "./browser-helper.js";
import { startOAuthCallback } from "./oauth-callback.js";
import { deliverToActiveChannel } from "../../tools/channel-send.js";

const REDDIT_CALLBACK_PORT = 18844;
const REDDIT_REDIRECT_URI = `http://localhost:${REDDIT_CALLBACK_PORT}/callback`;
const REDDIT_SCOPES = "submit read identity";

export async function setupRedditAutonomous(
  brandId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await navigateToUrl("https://www.reddit.com/prefs/apps");

    await deliverToActiveChannel(
      [
        "🤖 **Reddit Setup — Step 1 of 2**",
        "",
        "I've opened Reddit app preferences. Please:",
        "1. Click **are you a developer? create an app...**",
        `2. Name: \`ATLAS-${brandId}\` → Type: **script**`,
        `3. Redirect URI: \`${REDDIT_REDIRECT_URI}\``,
        "4. Click **Create App**",
        "5. Copy the **Client ID** (shown under the app name, short string)",
        "6. Copy the **Client Secret** (labeled 'secret')",
        "",
        "Reply with: `client_id: YOUR_ID client_secret: YOUR_SECRET`",
      ].join("\n"),
      ""
    );

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function completeRedditOAuth(
  brandId: string,
  clientId: string,
  clientSecret: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const authUrl =
      `https://www.reddit.com/api/v1/authorize` +
      `?client_id=${encodeURIComponent(clientId)}` +
      `&response_type=code` +
      `&state=atlas-${brandId}` +
      `&redirect_uri=${encodeURIComponent(REDDIT_REDIRECT_URI)}` +
      `&duration=permanent` +
      `&scope=${encodeURIComponent(REDDIT_SCOPES)}`;

    await deliverToActiveChannel(
      "Opening Reddit authorization page — please click **Allow** when prompted.",
      ""
    );

    const [callbackResult] = await Promise.all([
      startOAuthCallback(REDDIT_CALLBACK_PORT),
      navigateToUrl(authUrl),
    ]);

    if ("error" in callbackResult) {
      return { success: false, error: callbackResult.error };
    }

    // Exchange code for tokens using Basic auth
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const tokenRes = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "ATLAS-Marketing/1.0",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: callbackResult.code,
        redirect_uri: REDDIT_REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      return { success: false, error: `Reddit token exchange failed: ${err}` };
    }

    const tokenData = (await tokenRes.json()) as { refresh_token: string; access_token: string };
    setCredential(`REDDIT_CLIENT_ID_${brandId}`, clientId);
    setCredential(`REDDIT_CLIENT_SECRET_${brandId}`, clientSecret);
    setCredential(`REDDIT_REFRESH_TOKEN_${brandId}`, tokenData.refresh_token);

    await deliverToActiveChannel(
      `✅ Reddit connected for brand \`${brandId}\`! Subreddit posting is now enabled.`,
      ""
    );
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export function getRedditGuidedInstructions(brandId: string): string {
  return [
    "**Setting up Reddit:**",
    "",
    "1. Go to https://www.reddit.com/prefs/apps",
    "2. Click 'are you a developer? create an app'",
    `3. Name: \`ATLAS-${brandId}\`, Type: script`,
    "4. Redirect URI: `http://localhost:18844/callback`",
    "5. Copy Client ID and Client Secret",
    "6. Reply with: `client_id: YOUR_ID client_secret: YOUR_SECRET`",
  ].join("\n");
}
