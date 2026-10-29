// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { setCredential } from "../credential-manager.js";
import { navigateToUrl } from "./browser-helper.js";
import { newOAuthState } from "../../security/oauth-state.js";
import { startOAuthCallback } from "./oauth-callback.js";
import { deliverToActiveChannel } from "../../tools/channel-send.js";

const TIKTOK_CALLBACK_PORT = 18843;
const TIKTOK_REDIRECT_URI = `http://localhost:${TIKTOK_CALLBACK_PORT}/callback`;

export async function setupTikTokAutonomous(
  brandId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await navigateToUrl("https://developers.tiktok.com/apps");

    await deliverToActiveChannel(
      [
        "🎵 **TikTok Setup — Step 1 of 2**",
        "",
        "I've opened the TikTok Developer Portal. Please:",
        "1. Click **Create App** → Fill in app name `ATLAS-" + brandId + "`",
        "2. Select category → Submit",
        "3. On the app page, go to **Content Posting API** → Enable it",
        `4. Add redirect URI: \`${TIKTOK_REDIRECT_URI}\``,
        "5. Copy **Client Key** and **Client Secret**",
        "",
        "⚠️ **Note:** TikTok requires app audit (1-3 days) before public posts go live.",
        "Until then, posts will be saved as private drafts.",
        "",
        "Reply with: `client_key: YOUR_KEY client_secret: YOUR_SECRET`",
      ].join("\n"),
      ""
    );

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function completeTikTokOAuth(
  brandId: string,
  clientKey: string,
  clientSecret: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const state = newOAuthState();
    const authUrl =
      `https://www.tiktok.com/v2/auth/authorize/` +
      `?client_key=${encodeURIComponent(clientKey)}` +
      `&response_type=code` +
      `&scope=user.info.basic,video.publish,video.upload` +
      `&redirect_uri=${encodeURIComponent(TIKTOK_REDIRECT_URI)}` +
      `&state=${state}`;

    await deliverToActiveChannel(
      "Opening TikTok authorization page — please click **Authorize** when prompted.",
      ""
    );

    const [callbackResult] = await Promise.all([
      startOAuthCallback(TIKTOK_CALLBACK_PORT, state),
      navigateToUrl(authUrl),
    ]);

    if ("error" in callbackResult) {
      return { success: false, error: callbackResult.error };
    }

    // Exchange code for access token
    const tokenRes = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        code: callbackResult.code,
        grant_type: "authorization_code",
        redirect_uri: TIKTOK_REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      return { success: false, error: `TikTok token exchange failed: ${err}` };
    }

    const tokenData = (await tokenRes.json()) as { data?: { access_token: string } };
    const accessToken = tokenData.data?.access_token;
    if (!accessToken) {
      return { success: false, error: "TikTok did not return an access token" };
    }

    setCredential(`TIKTOK_ACCESS_TOKEN_${brandId}`, accessToken);
    setCredential(`TIKTOK_CLIENT_KEY_${brandId}`, clientKey);

    await deliverToActiveChannel(
      [
        `✅ TikTok connected for brand \`${brandId}\`!`,
        "⚠️ Remember: posts will be private until your app passes TikTok's audit review (1-3 days).",
      ].join("\n"),
      ""
    );
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export function getTikTokGuidedInstructions(brandId: string): string {
  return [
    "**Setting up TikTok:**",
    "",
    "1. Go to https://developers.tiktok.com/apps → Create App",
    `2. Name: \`ATLAS-${brandId}\``,
    "3. Enable Content Posting API",
    "4. Add redirect URI: `http://localhost:18843/callback`",
    "5. Copy Client Key and Client Secret",
    "6. Reply with: `client_key: YOUR_KEY client_secret: YOUR_SECRET`",
    "",
    "⚠️ Posts will be private until TikTok approves your app (1-3 days).",
  ].join("\n");
}
