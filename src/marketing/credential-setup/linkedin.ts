// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { setCredential, validateCredential } from "../credential-manager.js";
import { navigateToUrl } from "./browser-helper.js";
import { startOAuthCallback } from "./oauth-callback.js";
import { deliverToActiveChannel } from "../../tools/channel-send.js";

const LINKEDIN_CALLBACK_PORT = 18842;
const LINKEDIN_REDIRECT_URI = `http://localhost:${LINKEDIN_CALLBACK_PORT}/callback`;
const LINKEDIN_SCOPES = "w_member_social w_organization_social";

export async function setupLinkedInAutonomous(
  brandId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Step 1: Open LinkedIn Developer Portal
    await navigateToUrl("https://www.linkedin.com/developers/apps/new");

    await deliverToActiveChannel(
      [
        "🔗 **LinkedIn Setup — Step 1 of 3**",
        "",
        "I've opened the LinkedIn Developer Portal. Please:",
        "1. Fill in: **App name** = `ATLAS-" + brandId + "`, select your **LinkedIn Page**, upload a logo",
        "2. Check the legal agreement → Click **Create App**",
        "3. Go to the **Auth** tab",
        `4. Under 'Authorized redirect URLs', add: \`${LINKEDIN_REDIRECT_URI}\``,
        "5. Copy your **Client ID** and **Client Secret**",
        "",
        "Reply with: `client_id: YOUR_ID client_secret: YOUR_SECRET`",
      ].join("\n"),
      ""
    );

    // Return — agent waits for user to provide credentials, then calls completeLinkedInOAuth
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function completeLinkedInOAuth(
  brandId: string,
  clientId: string,
  clientSecret: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const authUrl =
      `https://www.linkedin.com/oauth/v2/authorization` +
      `?response_type=code` +
      `&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(LINKEDIN_REDIRECT_URI)}` +
      `&scope=${encodeURIComponent(LINKEDIN_SCOPES)}` +
      `&state=atlas-${brandId}`;

    await deliverToActiveChannel(
      "Opening LinkedIn authorization page — please click **Allow** when prompted.",
      ""
    );

    // Race callback server against browser navigation
    const [callbackResult] = await Promise.all([
      startOAuthCallback(LINKEDIN_CALLBACK_PORT),
      navigateToUrl(authUrl),
    ]);

    if ("error" in callbackResult) {
      return { success: false, error: callbackResult.error };
    }

    // Exchange code for access token
    const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: callbackResult.code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: LINKEDIN_REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      return { success: false, error: `Token exchange failed: ${err}` };
    }

    const tokenData = (await tokenRes.json()) as { access_token: string; expires_in?: number };
    setCredential(`LI_ACCESS_TOKEN_${brandId}`, tokenData.access_token);
    setCredential(`LI_CLIENT_ID_${brandId}`, clientId);
    setCredential(`LI_CLIENT_SECRET_${brandId}`, clientSecret);

    const valid = await validateCredential("linkedin", brandId);
    if (!valid) {
      return { success: false, error: "LinkedIn token validation failed" };
    }

    await deliverToActiveChannel(
      `✅ LinkedIn connected for brand \`${brandId}\`! Posts and outreach are now enabled.`,
      ""
    );
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export function getLinkedInGuidedInstructions(brandId: string): string {
  return [
    "**Setting up LinkedIn:**",
    "",
    "1. Go to https://www.linkedin.com/developers/apps/new",
    `2. Create app named \`ATLAS-${brandId}\``,
    "3. On the Auth tab, add redirect URI: `http://localhost:18842/callback`",
    "4. Copy Client ID and Client Secret",
    "5. Reply with: `client_id: YOUR_ID client_secret: YOUR_SECRET`",
    "6. I'll open the OAuth consent page — click Allow",
  ].join("\n");
}
