// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { createReadStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BASE_DATA_DIR = process.env.ATLAS_DATA_DIR ?? join(process.cwd(), "data");
const TOKEN_DIR = join(BASE_DATA_DIR, "google-tokens");
const CREDENTIALS_PATH = join(BASE_DATA_DIR, "google-credentials.json");

export interface YouTubePostResult {
  videoId: string;
  url: string;
}

export async function postYouTube(
  _brandId: string,
  title: string,
  description: string,
  videoPath: string
): Promise<YouTubePostResult> {
  if (!existsSync(CREDENTIALS_PATH)) throw new Error("Google credentials not found. Run Google OAuth setup first.");

  const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8")) as {
    installed?: { client_id: string; client_secret: string };
    web?: { client_id: string; client_secret: string };
  };
  const { client_id, client_secret } = creds.installed ?? creds.web ?? {};
  if (!client_id || !client_secret) throw new Error("Invalid Google credentials file");

  const { google } = await import("googleapis"); // lazy: ~0.6-1s import, only needed to post
  const oauth2 = new google.auth.OAuth2(client_id, client_secret);
  const tokenFiles = existsSync(TOKEN_DIR)
    ? readdirSync(TOKEN_DIR).filter((f) => f.endsWith(".json"))
    : [];
  if (!tokenFiles.length) throw new Error("No Google OAuth tokens found. Authenticate first.");
  const tokens = JSON.parse(readFileSync(join(TOKEN_DIR, tokenFiles[0]), "utf-8"));
  oauth2.setCredentials(tokens);

  const youtube = google.youtube({ version: "v3", auth: oauth2 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await (youtube.videos.insert as (opts: unknown) => Promise<{ data: { id?: string } }>)({
    part: ["snippet", "status"],
    requestBody: {
      snippet: { title: title.slice(0, 100), description, categoryId: "22", tags: [] },
      status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
    },
    media: { mimeType: "video/mp4", body: createReadStream(videoPath) },
  });

  const videoId = res.data.id ?? "";
  return { videoId, url: `https://youtube.com/watch?v=${videoId}` };
}
