// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { setCredential, validateCredential } from "../credential-manager.js";
import { navigateToUrl, extractFromPage } from "./browser-helper.js";
import { deliverToActiveChannel } from "../../tools/channel-send.js";

export async function setupApifyAutonomous(): Promise<{ success: boolean; token?: string; error?: string }> {
  try {
    await deliverToActiveChannel("Opening Apify console to get your API token…", "");
    await navigateToUrl("https://console.apify.com/account/integrations");

    const raw = await extractFromPage(
      "Find the Personal API Token value on this page. Return only the token string itself, nothing else. It looks like 'apify_api_...' or a long alphanumeric string."
    );

    const token = raw.trim().split(/\s+/)[0]; // take first word in case extra text is returned
    if (!token || token.length < 10) {
      return { success: false, error: "Could not extract Apify token from page. Try guided mode." };
    }

    setCredential("APIFY_TOKEN", token);
    const valid = await validateCredential("apify", "");
    if (!valid) {
      return { success: false, error: "Extracted token failed validation. Please check and try again." };
    }

    await deliverToActiveChannel(`✅ Apify connected! Token saved (starts with: ${token.slice(0, 8)}…)`, "");
    return { success: true, token };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export function getApifyGuidedInstructions(): string {
  return [
    "**Setting up Apify (trend research):**",
    "",
    "1. Go to https://console.apify.com/account/integrations",
    "2. Find the **Personal API Token** section",
    "3. Click 'Copy' next to your token",
    "4. Paste it here and I'll save it",
    "",
    "Reply with your token and I'll connect Apify immediately.",
  ].join("\n");
}
