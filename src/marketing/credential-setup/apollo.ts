// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { setCredential, validateCredential } from "../credential-manager.js";
import { navigateToUrl, extractFromPage } from "./browser-helper.js";
import { deliverToActiveChannel } from "../../tools/channel-send.js";

export async function setupApolloAutonomous(): Promise<{ success: boolean; key?: string; error?: string }> {
  try {
    await deliverToActiveChannel("Opening Apollo.io settings to get your API key…", "");
    await navigateToUrl("https://app.apollo.io/#/settings/integrations/api");

    const raw = await extractFromPage(
      "Find the API Key value on this page. Return only the key string itself, nothing else."
    );

    const key = raw.trim().split(/\s+/)[0];
    if (!key || key.length < 8) {
      return { success: false, error: "Could not extract Apollo API key from page. Try guided mode." };
    }

    setCredential("APOLLO_API_KEY", key);
    await deliverToActiveChannel(`✅ Apollo.io connected! API key saved (starts with: ${key.slice(0, 8)}…)`, "");
    return { success: true, key };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export function getApolloGuidedInstructions(): string {
  return [
    "**Setting up Apollo.io (lead finding):**",
    "",
    "1. Go to https://app.apollo.io/#/settings/integrations/api",
    "2. Copy your **API Key**",
    "3. Paste it here and I'll save it",
    "",
    "Reply with your API key.",
  ].join("\n");
}
