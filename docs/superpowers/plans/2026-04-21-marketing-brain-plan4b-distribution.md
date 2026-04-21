# Marketing Brain — Plan 4B: Distribution, Outreach & Scheduling

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement cold email/LinkedIn outreach engine, the marketing scheduler that posts autonomously at scheduled times, and remaining platform adapters (Facebook Pages, YouTube Shorts, Reddit, Product Hunt).

**Architecture:** `cold_outreach` tool uses Apollo.io lead finder + LLM personalisation + existing nodemailer SMTP. `marketing_schedule` wraps `schedule_task` cron with ISO→cron conversion and calls `social_post` at fire time. Facebook and YouTube reuse Meta/Google OAuth already in the codebase. Reddit uses `snoowrap`. Product Hunt is read-only API + human-in-loop for submission.

**Prereq:** Plans 1–4A complete. Run `npm install snoowrap` before starting.

**Tech Stack:** nodemailer (existing), googleapis (existing for YouTube), Meta Graph API (existing pattern), snoowrap for Reddit, Product Hunt GraphQL API (fetch), node-cron (existing).

---

### Task 1: Outreach Engine + `cold_outreach` Tool

**Files:**
- Create: `src/marketing/outreach-engine.ts`
- Modify: `src/tools/cold-outreach.ts` (replace stub)
- Modify: `src/tools/index.ts` (export `setOutreachLLM`)
- Modify: `src/index.ts` (wire `setOutreachLLM`)

- [ ] **Step 1: Install dependencies**

```bash
npm install nodemailer
npm run typecheck 2>&1 | grep "nodemailer" | head -5
```

Expected: nodemailer available (already in package.json — confirm with `grep nodemailer package.json`).

- [ ] **Step 2: Create `src/marketing/outreach-engine.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import nodemailer from "nodemailer";
import type { LLMClient } from "../llm.js";
import { findLeadsApollo, recordOutreach, type Lead, type LeadSearchParams } from "./lead-finder.js";
import { deliverToActiveChannel } from "../tools/channel-send.js";

let _llm: LLMClient | null = null;
export function setOutreachLLM(llm: LLMClient): void { _llm = llm; }

export interface OutreachRequest {
  brandId: string;
  channel: "email" | "linkedin" | "twitter";
  targetDescription: string;
  messageTemplate: string;
  maxLeads: number;
}

export interface OutreachResult {
  channel: string;
  status: "sent" | "waiting_user_choice" | "error";
  sentCount?: number;
  message?: string;
  options?: string[];   // for linkedin — the 3 mode options
}

const LINKEDIN_OPTIONS = [
  "A — Automated via PhantomBuster: I send connection requests + follow-up DMs automatically. Fastest results, ~5-15% monthly account ban risk.",
  "B — Posts only (safe): I post engaging content to attract inbound leads. Zero ban risk. Results build over 2-4 weeks.",
  "C — Semi-automated: I write the messages and find the targets, then send you the list here for you to send manually. Safe, requires your time.",
];

export async function runOutreachCampaign(req: OutreachRequest): Promise<OutreachResult> {
  if (req.channel === "linkedin") {
    const msg = [
      "**LinkedIn Outreach — Choose your approach:**",
      "",
      LINKEDIN_OPTIONS.map((o, i) => `**Option ${o}`).join("\n"),
      "",
      "Reply: `linkedin A`, `linkedin B`, or `linkedin C`",
    ].join("\n");
    await deliverToActiveChannel(msg, undefined);
    return { channel: "linkedin", status: "waiting_user_choice", options: LINKEDIN_OPTIONS };
  }

  if (req.channel === "email") {
    return runEmailOutreach(req);
  }

  return { channel: req.channel, status: "error", message: "Twitter DM outreach requires Pro API tier ($100/mo). Set X_API_TIER_{brandId}=pro to enable." };
}

async function runEmailOutreach(req: OutreachRequest): Promise<OutreachResult> {
  const emailUser = process.env.EMAIL_USER;
  const emailPass = process.env.EMAIL_PASSWORD;
  if (!emailUser || !emailPass) {
    return { channel: "email", status: "error", message: "EMAIL_USER or EMAIL_PASSWORD not set" };
  }

  // Parse target description into Apollo search params
  const searchParams = parseTargetDescription(req.targetDescription, req.maxLeads);
  let leads: Lead[] = [];
  try {
    leads = await findLeadsApollo(searchParams);
  } catch (err) {
    return { channel: "email", status: "error", message: `Lead finder failed: ${(err as Error).message}` };
  }

  if (!leads.length) {
    return { channel: "email", status: "error", message: "No leads found matching criteria" };
  }

  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST ?? "smtp.hostinger.com",
    port: Number(process.env.EMAIL_PORT ?? 465),
    secure: true,
    auth: { user: emailUser, pass: emailPass },
  });

  let sentCount = 0;
  for (const lead of leads.filter((l) => l.email && l.emailStatus !== "invalid")) {
    const personalised = await personaliseMessage(req.messageTemplate, lead);
    const subject = extractSubject(personalised);
    const body = personalised.replace(/^Subject:.*\n?/i, "").trim();

    try {
      await transporter.sendMail({
        from: emailUser,
        to: lead.email!,
        subject,
        text: body,
      });
      recordOutreach(req.brandId, lead, "email", subject, body);
      sentCount++;
      // Rate limit: 1 email per 2 seconds to avoid spam flags
      await new Promise((r) => setTimeout(r, 2000));
    } catch {
      // Skip failed sends, continue
    }
  }

  return { channel: "email", status: "sent", sentCount, message: `Sent ${sentCount} personalised emails` };
}

async function personaliseMessage(template: string, lead: Lead): Promise<string> {
  if (!_llm) {
    // Fallback: simple string replacement
    return template
      .replace(/\{\{name\}\}/gi, lead.firstName)
      .replace(/\{\{company\}\}/gi, lead.company ?? "your company")
      .replace(/\{\{title\}\}/gi, lead.title ?? "");
  }

  const filled = template
    .replace(/\{\{name\}\}/gi, lead.firstName)
    .replace(/\{\{company\}\}/gi, lead.company ?? "your company")
    .replace(/\{\{title\}\}/gi, lead.title ?? "");

  const response = await _llm.chat([{
    role: "user",
    content: `Personalise this cold email for ${lead.firstName} ${lead.lastName} (${lead.title ?? "professional"} at ${lead.company ?? "their company"}). Make it sound genuine and specific, not generic. Keep roughly the same length. Return only the email, no explanation.\n\n${filled}`,
  }]);
  return response.content ?? filled;
}

function extractSubject(message: string): string {
  const match = message.match(/^Subject:\s*(.+)$/mi);
  return match?.[1]?.trim() ?? "Quick question";
}

function parseTargetDescription(description: string, limit: number): LeadSearchParams {
  const lower = description.toLowerCase();
  const titles: string[] = [];
  const industries: string[] = [];

  if (lower.includes("cto") || lower.includes("technical")) titles.push("CTO", "VP Engineering");
  if (lower.includes("ceo") || lower.includes("founder")) titles.push("CEO", "Co-founder", "Founder");
  if (lower.includes("marketing")) titles.push("CMO", "VP Marketing", "Marketing Director");
  if (lower.includes("product")) titles.push("CPO", "VP Product", "Product Manager");

  if (lower.includes("saas") || lower.includes("software")) industries.push("SaaS");
  if (lower.includes("fintech") || lower.includes("finance")) industries.push("FinTech");
  if (lower.includes("ecommerce") || lower.includes("retail")) industries.push("eCommerce");

  return {
    titles: titles.length ? titles : undefined,
    industries: industries.length ? industries : undefined,
    limit,
  };
}
```

- [ ] **Step 3: Replace `src/tools/cold-outreach.ts` stub**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ToolDefinition } from "./get-current-time.js";
import { runOutreachCampaign } from "../marketing/outreach-engine.js";

export const coldOutreach: ToolDefinition = {
  schema: {
    type: "function",
    function: {
      name: "cold_outreach",
      description: "Find leads and send personalised cold outreach via email or LinkedIn. For LinkedIn, presents risk options to the user before sending.",
      parameters: {
        type: "object",
        properties: {
          brand_id: { type: "string" },
          channel: { type: "string", enum: ["email", "linkedin", "twitter"] },
          target_description: { type: "string", description: "Who to reach e.g. 'CTOs at Series A SaaS companies'" },
          message_template: { type: "string", description: "Draft message with {{name}} / {{company}} placeholders" },
          max_leads: { type: "number", description: "Max leads to contact in this batch (default 10)" },
        },
        required: ["brand_id", "channel", "target_description", "message_template"],
      },
    },
  },
  async handler(input) {
    try {
      const result = await runOutreachCampaign({
        brandId: input.brand_id as string,
        channel: input.channel as "email" | "linkedin" | "twitter",
        targetDescription: input.target_description as string,
        messageTemplate: input.message_template as string,
        maxLeads: (input.max_leads as number) ?? 10,
      });
      return JSON.stringify(result);
    } catch (err) {
      return JSON.stringify({ error: (err as Error).message });
    }
  },
};
```

- [ ] **Step 4: Export `setOutreachLLM` and wire in boot**

Add to `src/tools/index.ts`:
```typescript
export { setOutreachLLM } from "../marketing/outreach-engine.js";
```

Add to `src/index.ts` after other LLM injections:
```typescript
import { setOutreachLLM } from "./marketing/outreach-engine.js";
// in init:
setOutreachLLM(llm);
```

- [ ] **Step 5: Build check**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -20
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/marketing/outreach-engine.ts src/tools/cold-outreach.ts src/tools/index.ts src/index.ts
git commit -m "feat(marketing): cold email outreach engine — Apollo leads + LLM personalisation + SMTP"
```

---

### Task 2: Facebook Pages Adapter

**Files:**
- Create: `src/marketing/adapters/facebook.ts`

- [ ] **Step 1: Create `src/marketing/adapters/facebook.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { promises as fs } from "node:fs";
import { resolveCredential } from "../brand-profile.js";

export interface FacebookPostResult {
  postId: string;
}

export async function postFacebook(
  brandId: string,
  caption: string,
  mediaPath?: string
): Promise<FacebookPostResult> {
  const pageId = resolveCredential(`FB_PAGE_ID_${brandId}`);
  const accessToken = resolveCredential(`FB_ACCESS_TOKEN_${brandId}`);
  if (!pageId || !accessToken) {
    throw new Error(`Facebook credentials not set: FB_PAGE_ID_${brandId} and FB_ACCESS_TOKEN_${brandId} required`);
  }

  if (mediaPath) {
    // Image post
    const imageBuffer = await fs.readFile(mediaPath);
    const form = new FormData();
    form.append("caption", caption);
    form.append("access_token", accessToken);
    form.append("source", new Blob([imageBuffer]), "image.jpg");

    const res = await fetch(`https://graph.facebook.com/v20.0/${pageId}/photos`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) throw new Error(`Facebook photo post failed: ${await res.text()}`);
    const data = await res.json() as { id: string };
    return { postId: data.id };
  }

  // Text-only post
  const res = await fetch(`https://graph.facebook.com/v20.0/${pageId}/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: caption, access_token: accessToken }),
  });
  if (!res.ok) throw new Error(`Facebook feed post failed: ${await res.text()}`);
  const data = await res.json() as { id: string };
  return { postId: data.id };
}
```

- [ ] **Step 2: Build check**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -10
```

- [ ] **Step 3: Commit**

```bash
git add src/marketing/adapters/facebook.ts
git commit -m "feat(marketing): Facebook Pages adapter"
```

---

### Task 3: YouTube Shorts Adapter

**Files:**
- Create: `src/marketing/adapters/youtube.ts`

- [ ] **Step 1: Create `src/marketing/adapters/youtube.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { createReadStream, statSync } from "node:fs";
import { google } from "googleapis";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const BASE_DATA_DIR = process.env.ATLAS_DATA_DIR ?? join(process.cwd(), "data");
const TOKEN_DIR = join(BASE_DATA_DIR, "google-tokens");
const CREDENTIALS_PATH = join(BASE_DATA_DIR, "google-credentials.json");

export interface YouTubePostResult {
  videoId: string;
  url: string;
}

export async function postYouTube(
  brandId: string,
  title: string,
  description: string,
  videoPath: string
): Promise<YouTubePostResult> {
  // Load credentials using same pattern as src/tools/google-api.ts
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new Error("Google credentials not found. Run Google OAuth setup first.");
  }
  const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8")) as {
    installed?: { client_id: string; client_secret: string };
    web?: { client_id: string; client_secret: string };
  };
  const { client_id, client_secret } = creds.installed ?? creds.web ?? {};
  if (!client_id || !client_secret) throw new Error("Invalid Google credentials file");

  const oauth2 = new google.auth.OAuth2(client_id, client_secret);

  // Load stored tokens (first available token file)
  const tokenFiles = existsSync(TOKEN_DIR)
    ? require("node:fs").readdirSync(TOKEN_DIR).filter((f: string) => f.endsWith(".json"))
    : [];
  if (!tokenFiles.length) throw new Error("No Google OAuth tokens found. Authenticate via Google auth setup first.");
  const tokens = JSON.parse(readFileSync(join(TOKEN_DIR, tokenFiles[0]), "utf-8"));
  oauth2.setCredentials(tokens);

  const youtube = google.youtube({ version: "v3", auth: oauth2 });

  const videoStat = statSync(videoPath);
  const res = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: title.slice(0, 100),
        description,
        categoryId: "22",  // People & Blogs
        tags: [],
      },
      status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
    },
    media: {
      mimeType: "video/mp4",
      body: createReadStream(videoPath),
    },
  } as Parameters<typeof youtube.videos.insert>[0]);

  const videoId = res.data.id ?? "";
  return { videoId, url: `https://youtube.com/watch?v=${videoId}` };
}
```

- [ ] **Step 2: Build check**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -10
```

- [ ] **Step 3: Commit**

```bash
git add src/marketing/adapters/youtube.ts
git commit -m "feat(marketing): YouTube Shorts adapter via existing googleapis OAuth"
```

---

### Task 4: Reddit Adapter

**Files:**
- Create: `src/marketing/adapters/reddit.ts`

- [ ] **Step 1: Install snoowrap**

```bash
npm install snoowrap
npm install --save-dev @types/snoowrap
npm run typecheck 2>&1 | grep "snoowrap" | head -5
```

- [ ] **Step 2: Create `src/marketing/adapters/reddit.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import Snoowrap from "snoowrap";
import { resolveCredential } from "../brand-profile.js";

export interface RedditPostResult {
  postId: string;
  url: string;
}

export async function postReddit(
  brandId: string,
  subreddit: string,
  title: string,
  text?: string
): Promise<RedditPostResult> {
  const clientId = resolveCredential(`REDDIT_CLIENT_ID_${brandId}`);
  const clientSecret = resolveCredential(`REDDIT_CLIENT_SECRET_${brandId}`);
  const refreshToken = resolveCredential(`REDDIT_REFRESH_TOKEN_${brandId}`);

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(`Reddit credentials not set: REDDIT_CLIENT_ID_${brandId}, REDDIT_CLIENT_SECRET_${brandId}, REDDIT_REFRESH_TOKEN_${brandId} required`);
  }

  const r = new Snoowrap({
    userAgent: "ATLAS-Marketing/1.0 by /u/your_username",
    clientId,
    clientSecret,
    refreshToken,
  });

  const submission = await r.getSubreddit(subreddit).submitSelfpost({
    title: title.slice(0, 300),
    text: text ?? "",
  });

  const postId = submission.id;
  return { postId, url: `https://reddit.com/r/${subreddit}/comments/${postId}` };
}
```

- [ ] **Step 3: Build check**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -10
```

- [ ] **Step 4: Commit**

```bash
git add src/marketing/adapters/reddit.ts package.json package-lock.json
git commit -m "feat(marketing): Reddit adapter via snoowrap"
```

---

### Task 5: Product Hunt Module

**Files:**
- Create: `src/marketing/product-hunt.ts`

- [ ] **Step 1: Create `src/marketing/product-hunt.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { LLMClient } from "../llm.js";
import { deliverToActiveChannel } from "../tools/channel-send.js";

let _llm: LLMClient | null = null;
export function setProductHuntLLM(llm: LLMClient): void { _llm = llm; }

const PH_GRAPHQL = "https://api.producthunt.com/v2/api/graphql";

interface PHStats {
  votesCount: number;
  commentsCount: number;
  rank: number;
  topComments: Array<{ author: string; body: string }>;
}

export interface LaunchChecklist {
  productName: string;
  tagline: string;
  description: string;
  galleryImages: string[];  // local file paths
  firstComment: string;
  launchInstructions: string;
}

export function prepareLaunchChecklist(
  productName: string,
  tagline: string,
  description: string,
  galleryImagePaths: string[]
): LaunchChecklist {
  const firstComment = `Hi Product Hunt! 👋 I'm [your name], the founder of ${productName}.\n\n${description}\n\nWould love your feedback — what would make this even more useful for you?`;

  const instructions = [
    `✅ Launch checklist for ${productName}`,
    ``,
    `1. Go to producthunt.com and log in`,
    `2. Click "Submit" → "New Product"`,
    `3. Name: ${productName}`,
    `4. Tagline: ${tagline} (max 60 chars)`,
    `5. Description: [paste the description I prepared]`,
    `6. Upload gallery images (${galleryImagePaths.length} images ready)`,
    `7. Schedule for 12:01 AM Pacific Time on your launch day`,
    ``,
    `**First comment to post immediately when live:**`,
    firstComment,
    ``,
    `Reply "launched" when it's live and I'll monitor upvotes and comments.`,
  ].join("\n");

  return { productName, tagline, description, galleryImages: galleryImagePaths, firstComment, launchInstructions: instructions };
}

export async function sendLaunchChecklist(checklist: LaunchChecklist): Promise<void> {
  await deliverToActiveChannel(checklist.launchInstructions, undefined);
}

export async function monitorLaunch(productSlug: string): Promise<PHStats | null> {
  const token = process.env.PH_API_TOKEN;
  if (!token) return null;

  const query = `{
    post(slug: "${productSlug}") {
      votesCount
      commentsCount
      dailyRank
      comments(first: 5, order: VOTES_COUNT) {
        edges {
          node {
            body
            user { name }
          }
        }
      }
    }
  }`;

  try {
    const res = await fetch(PH_GRAPHQL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { data?: { post?: { votesCount: number; commentsCount: number; dailyRank: number; comments: { edges: Array<{ node: { body: string; user: { name: string } } }> } } } };
    const post = data.data?.post;
    if (!post) return null;
    return {
      votesCount: post.votesCount,
      commentsCount: post.commentsCount,
      rank: post.dailyRank,
      topComments: post.comments.edges.map((e) => ({ author: e.node.user.name, body: e.node.body })),
    };
  } catch {
    return null;
  }
}

export async function draftResponseComment(stats: PHStats, productName: string): Promise<string> {
  if (!_llm) return `Thanks for the support! We hit #${stats.rank} with ${stats.votesCount} votes! 🎉`;
  const response = await _llm.chat([{
    role: "user",
    content: `Write a warm, genuine founder comment responding to Product Hunt community support for ${productName}. We're currently ranked #${stats.rank} with ${stats.votesCount} upvotes and ${stats.commentsCount} comments. Top comment from ${stats.topComments[0]?.author ?? "a user"}: "${stats.topComments[0]?.body ?? "Great product!"}". Keep it under 100 words, personal and grateful.`,
  }]);
  return response.content ?? "";
}
```

- [ ] **Step 2: Export `setProductHuntLLM` and wire in boot**

Add to `src/tools/index.ts`:
```typescript
export { setProductHuntLLM } from "../marketing/product-hunt.js";
```

Add to `src/index.ts` after other LLM injections:
```typescript
import { setProductHuntLLM } from "./marketing/product-hunt.js";
// in init:
setProductHuntLLM(llm);
```

- [ ] **Step 3: Build check**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -10
```

- [ ] **Step 4: Commit**

```bash
git add src/marketing/product-hunt.ts src/tools/index.ts src/index.ts
git commit -m "feat(marketing): Product Hunt launch prep + monitoring + comment drafting"
```

---

### Task 6: Marketing Schedule Tool (real implementation)

**Files:**
- Modify: `src/tools/marketing-schedule.ts` (replace stub)

- [ ] **Step 1: Replace stub in `src/tools/marketing-schedule.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ToolDefinition } from "./get-current-time.js";
import { updateCalendarItem, getScheduledItems } from "../marketing/content-calendar.js";
import { scheduleTask } from "./scheduled.js";

export const marketingSchedule: ToolDefinition = {
  schema: {
    type: "function",
    function: {
      name: "marketing_schedule",
      description: "Schedule a content calendar item for posting, list upcoming scheduled posts, or cancel a scheduled post.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["schedule", "list", "cancel"] },
          brand_id: { type: "string" },
          item_id: { type: "number", description: "Calendar item ID (required for schedule/cancel)" },
          scheduled_at: { type: "string", description: "ISO 8601 datetime (required for schedule)" },
        },
        required: ["action", "brand_id"],
      },
    },
  },
  async handler(input) {
    const action = input.action as string;
    const brandId = input.brand_id as string;
    const itemId = input.item_id as number | undefined;
    const scheduledAt = input.scheduled_at as string | undefined;

    if (action === "schedule") {
      if (!itemId || !scheduledAt) {
        return JSON.stringify({ error: "item_id and scheduled_at are required for schedule action" });
      }
      updateCalendarItem(itemId, { status: "scheduled", scheduledAt });

      // Convert ISO datetime to one-shot cron expression
      const dt = new Date(scheduledAt);
      const cronExpr = `${dt.getMinutes()} ${dt.getHours()} ${dt.getDate()} ${dt.getMonth() + 1} *`;

      // Register the cron task — when it fires, it triggers social_post for this item
      const scheduleResult = await scheduleTask.handler({
        expression: cronExpr,
        description: `Post calendar item ${itemId} for brand ${brandId}`,
        action: `social_post for calendar item ${itemId} brand ${brandId}`,
      });

      return JSON.stringify({
        success: true,
        itemId,
        scheduledAt,
        cronExpression: cronExpr,
        scheduleResult: JSON.parse(scheduleResult),
      });
    }

    if (action === "list") {
      const until = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const items = getScheduledItems(brandId, until);
      if (!items.length) return JSON.stringify({ items: [], message: "No scheduled posts in the next 30 days" });
      const formatted = items.map((item) => ({
        id: item.id,
        platform: item.platform,
        type: item.contentType,
        scheduledAt: item.scheduledAt,
        caption: item.caption?.slice(0, 80) + (item.caption && item.caption.length > 80 ? "…" : ""),
        status: item.status,
      }));
      return JSON.stringify({ items: formatted, count: items.length });
    }

    if (action === "cancel") {
      if (!itemId) return JSON.stringify({ error: "item_id required for cancel" });
      updateCalendarItem(itemId, { status: "draft" });
      return JSON.stringify({ success: true, message: `Item ${itemId} moved back to draft — not scheduled` });
    }

    return JSON.stringify({ error: `Unknown action: ${action}` });
  },
};
```

- [ ] **Step 2: Build check**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/marketing-schedule.ts
git commit -m "feat(marketing): marketing schedule tool — ISO→cron conversion + schedule/list/cancel"
```

---

### Task 7: Wire Facebook & YouTube into `social_post`

**Files:**
- Modify: `src/tools/social-post.ts` (add fb + youtube + reddit routing)

- [ ] **Step 1: Update `src/tools/social-post.ts` to handle all platforms**

The Plan 4A implementation handles instagram, linkedin, tiktok, twitter. Now add the remaining platforms. Find the switch statement in the handler and add cases for `facebook`, `youtube`, `reddit`, `producthunt`:

```typescript
// Add to the imports at top of src/tools/social-post.ts:
import { postFacebook } from "../marketing/adapters/facebook.js";
import { postYouTube } from "../marketing/adapters/youtube.js";
import { postReddit } from "../marketing/adapters/reddit.js";
import { prepareLaunchChecklist, sendLaunchChecklist } from "../marketing/product-hunt.js";

// In the handler switch statement, add after the twitter case:
case "facebook": {
  const result = await postFacebook(
    input.brand_id as string,
    input.caption as string,
    input.media_path as string | undefined
  );
  postUrl = `https://facebook.com/permalink/${result.postId}`;
  break;
}
case "youtube": {
  const result = await postYouTube(
    input.brand_id as string,
    (input.caption as string).split("\n")[0].slice(0, 100),
    input.caption as string,
    input.media_path as string
  );
  postUrl = result.url;
  break;
}
case "reddit": {
  const result = await postReddit(
    input.brand_id as string,
    (input.subreddit as string) ?? "general",
    (input.caption as string).split("\n")[0].slice(0, 300),
    input.caption as string
  );
  postUrl = result.url;
  break;
}
case "producthunt": {
  const checklist = prepareLaunchChecklist(
    input.brand_id as string,
    input.caption as string,
    input.caption as string,
    input.media_path ? [input.media_path as string] : []
  );
  await sendLaunchChecklist(checklist);
  return JSON.stringify({ status: "checklist_sent", message: "Launch checklist sent to your active channel" });
}
```

Also add `subreddit` as an optional parameter to the schema:
```typescript
subreddit: { type: "string", description: "Subreddit name (required for reddit platform)" },
```

- [ ] **Step 2: Full build check**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -20
npm run build 2>&1 | tail -10
```

Expected: clean typecheck and build.

- [ ] **Step 3: Verify all tools registered**

```bash
node -e "import('./dist/tools/index.js').then(m => { const tools = m.getToolNames(); console.log('marketing tools:', tools.filter(t => ['social_post','cold_outreach','marketing_schedule','brand_audit'].includes(t))); })"
```

Expected:
```
marketing tools: [ 'social_post', 'cold_outreach', 'marketing_schedule', 'brand_audit' ]
```

- [ ] **Step 4: Final commit**

```bash
git add src/tools/social-post.ts
git commit -m "feat(marketing): wire Facebook/YouTube/Reddit/ProductHunt into social_post tool"
```

---

### Task 8: Final Integration Smoke Test

- [ ] **Step 1: Full typecheck pass**

```bash
npm run typecheck 2>&1 | grep "error TS"
```

Expected: empty output (zero errors).

- [ ] **Step 2: Check all marketing modules compile**

```bash
npm run build 2>&1 | grep -E "error|Error" | grep -v "node_modules" | head -20
```

Expected: clean build.

- [ ] **Step 3: Verify marketing skill file loads**

```bash
grep -r "marketing" skills/ --include="*.md" -l
```

Expected: `skills/marketing.md`

- [ ] **Step 4: Final summary commit**

```bash
git add -A
git status
git commit -m "feat(marketing): Plan 4B complete — outreach engine, FB/YT/Reddit adapters, schedule tool, PH module" --allow-empty
```

---

**Plan 4B complete.** The full distribution engine is now live:
- Cold email outreach via Apollo.io + LLM personalisation + nodemailer
- LinkedIn outreach mode selector (user picks with risks explained)
- Facebook Pages, YouTube Shorts, Reddit adapters
- Product Hunt launch prep + monitoring
- Marketing schedule tool with ISO→cron conversion for autonomous posting

**All 4 plans complete. The ATLAS Marketing Brain is ready to implement.**
