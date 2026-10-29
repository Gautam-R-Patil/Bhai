// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import path from "node:path";

const ENV_PATH = path.resolve(process.cwd(), ".env");

const PLATFORM_ENV_KEYS: Record<string, (brandId: string) => string> = {
  instagram: (brandId) => `IG_ACCESS_TOKEN_${brandId}`,
  linkedin:  (brandId) => `LI_ACCESS_TOKEN_${brandId}`,
  tiktok:    (brandId) => `TIKTOK_ACCESS_TOKEN_${brandId}`,
  twitter:   (brandId) => `X_API_KEY_${brandId}`,
  apify:     (_brandId) => `APIFY_TOKEN`,
  apollo:    (_brandId) => `APOLLO_API_KEY`,
  reddit:    (brandId) => `REDDIT_REFRESH_TOKEN_${brandId}`,
};

const PLATFORM_DESCRIPTIONS: Record<string, string> = {
  instagram: "Instagram Graph API access token (required for posting Reels and images)",
  linkedin:  "LinkedIn OAuth 2.0 access token (required for posting and outreach)",
  tiktok:    "TikTok for Developers access token (required for TikTok video uploads)",
  twitter:   "Twitter/X API key (required for posting tweets and threads)",
  apify:     "Apify API token (required for trend research and lead scraping)",
  apollo:    "Apollo.io API key (required for lead enrichment in cold outreach)",
  reddit:    "Reddit OAuth refresh token (required for posting to subreddits)",
};

export function getCredential(key: string): string | undefined {
  const val = process.env[key];
  return val !== undefined && val !== "" ? val : undefined;
}

export function setCredential(key: string, value: string): void {
  let contents = "";
  if (fs.existsSync(ENV_PATH)) {
    contents = fs.readFileSync(ENV_PATH, "utf-8");
  }
  const lines = contents.split("\n");
  const escapedValue = value.includes(" ") || value.includes("#") ? `"${value}"` : value;
  const newLine = `${key}=${escapedValue}`;
  const existingIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith(`${key}=`) || trimmed.startsWith(`# ${key}=`);
  });
  if (existingIndex !== -1) {
    lines[existingIndex] = newLine;
  } else {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
      lines.push("");
    }
    lines.push(newLine);
  }
  fs.writeFileSync(ENV_PATH, lines.join("\n"), "utf-8");
  process.env[key] = value;
}

export function removeCredential(key: string): void {
  if (!fs.existsSync(ENV_PATH)) return;
  const contents = fs.readFileSync(ENV_PATH, "utf-8");
  const lines = contents.split("\n");
  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${key}=`)) {
      return `# ${trimmed} (removed by Bhai)`;
    }
    return line;
  });
  fs.writeFileSync(ENV_PATH, updated.join("\n"), "utf-8");
  delete process.env[key];
}

export async function validateCredential(platform: string, brandId: string): Promise<boolean> {
  const envKey = PLATFORM_ENV_KEYS[platform]?.(brandId);
  if (!envKey) return false;
  const token = getCredential(envKey);
  if (!token) return false;
  try {
    switch (platform) {
      case "instagram": {
        // Use Authorization header to avoid token in URL (which appears in server logs)
        const res = await fetch("https://graph.facebook.com/v19.0/me?fields=id", {
          headers: { Authorization: `Bearer ${token}` },
        });
        return res.ok;
      }
      case "linkedin": {
        const res = await fetch("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${token}` } });
        return res.ok;
      }
      case "tiktok": {
        const res = await fetch("https://open.tiktokapis.com/v2/user/info/?fields=display_name", { headers: { Authorization: `Bearer ${token}` } });
        return res.ok;
      }
      case "twitter": {
        // All 4 keys are required — check existence of all
        const allSet = [
          `X_API_KEY_${brandId}`,
          `X_API_SECRET_${brandId}`,
          `X_ACCESS_TOKEN_${brandId}`,
          `X_ACCESS_SECRET_${brandId}`,
        ].every((k) => !!getCredential(k));
        return allSet;
      }
      case "apify": {
        const res = await fetch(`https://api.apify.com/v2/users/me?token=${encodeURIComponent(token)}`);
        return res.ok;
      }
      case "apollo": return true;
      case "reddit": return true;
      default: return false;
    }
  } catch {
    return false;
  }
}

export interface MissingCredential {
  platform: string;
  envKey: string;
  description: string;
}

export function getMissingCredentials(platforms: string[], brandId: string): MissingCredential[] {
  const missing: MissingCredential[] = [];
  for (const platform of platforms) {
    // Twitter requires 4 keys — check all of them
    if (platform === "twitter") {
      const twitterKeys = [
        `X_API_KEY_${brandId}`,
        `X_API_SECRET_${brandId}`,
        `X_ACCESS_TOKEN_${brandId}`,
        `X_ACCESS_SECRET_${brandId}`,
      ];
      const missingKey = twitterKeys.find((k) => !getCredential(k));
      if (missingKey) {
        missing.push({
          platform,
          envKey: twitterKeys.join(", "),
          description: PLATFORM_DESCRIPTIONS["twitter"] ?? "Twitter/X API credentials (4 keys required)",
        });
      }
      continue;
    }

    const keyFn = PLATFORM_ENV_KEYS[platform];
    if (!keyFn) continue;
    const envKey = keyFn(brandId);
    const val = getCredential(envKey);
    if (!val) {
      missing.push({
        platform,
        envKey,
        description: PLATFORM_DESCRIPTIONS[platform] ?? `API credential for ${platform}`,
      });
    }
  }
  return missing;
}
