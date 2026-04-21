# Marketing Brain — Plan 1: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the data layer, memory schema, tool registration scaffolding, and skill file that all other marketing plans depend on.

**Architecture:** New `src/marketing/` module with brand profile CRUD backed by the existing `memories` SQLite table (new `brand` category). New `marketing_calendar` and `marketing_outreach` tables added via `initMarketingDB()` called from `initMemoryDB()`. Four new tool stubs registered in `src/tools/index.ts`. New `marketing` category added to `CATEGORIES` in `src/tool-router.ts`. Channel-agnostic approval workflow using existing `deliverToActiveChannel`.

**Tech Stack:** TypeScript/ESM, better-sqlite3, existing `src/memory/sqlite.ts` patterns, `src/tools/channel-send.ts`, `src/tools/get-current-time.ts` (ToolDefinition type)

---

### Task 1: Brand Profile Types & SQLite Schema

**Files:**
- Create: `src/marketing/brand-profile.ts`
- Modify: `src/memory/sqlite.ts` (add `initMarketingDB` call inside `initMemoryDB`)

- [ ] **Step 1: Create `src/marketing/brand-profile.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import path from "node:path";
import { getDataDir } from "../config/paths.js";
import { remember, recall } from "../memory/sqlite.js";

export type Platform = "instagram" | "linkedin" | "tiktok" | "twitter" | "facebook" | "youtube" | "reddit";
export type AutonomyMode = "hands_on" | "review_and_forget" | "hybrid";
export type OutreachMode = "phantombuster" | "posts_only" | "semi_automated";

export interface BrandProfile {
  id: string;               // slug: lowercase, hyphens
  name: string;
  website: string;
  logoPath: string;         // absolute path under getImagesDir()
  socialHandles: Partial<Record<Platform, string>>;
  description: string;
  targetAudience: string;
  toneOfVoice: string;
  competitors: string[];
  contentPillars: string[];     // set by brand audit
  brandVoiceGuide: string;      // set by brand audit
  auditSummary: string;         // set by brand audit
  autonomyMode: AutonomyMode;
  linkedinOutreachMode: OutreachMode;
  activePlatforms: Platform[];
  credentialKeys: Partial<Record<string, string>>; // env-var name → env-var name mapping
  createdAt: string;
  updatedAt: string;
}

const BRAND_CATEGORY = "brand";

function brandKey(id: string): string {
  return `brand_profile:${id}`;
}

export function saveBrandProfile(profile: BrandProfile): void {
  remember(JSON.stringify(profile), BRAND_CATEGORY, `brand:${profile.id}`, 10);
}

export function loadBrandProfile(id: string): BrandProfile | null {
  const results = recall(brandKey(id), 1, BRAND_CATEGORY);
  if (!results.length) return null;
  try {
    return JSON.parse(results[0].content) as BrandProfile;
  } catch {
    return null;
  }
}

export function listBrandProfiles(): BrandProfile[] {
  const results = recall("brand_profile:", 20, BRAND_CATEGORY);
  return results.flatMap((r) => {
    try { return [JSON.parse(r.content) as BrandProfile]; } catch { return []; }
  });
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function resolveCredential(envKey: string): string | undefined {
  return process.env[envKey];
}
```

- [ ] **Step 2: Add `initMarketingDB` to `src/memory/sqlite.ts`**

Find the line `export async function initMemoryDB()` in `src/memory/sqlite.ts`. At the very end of `initMemoryDB`, just before the `return db` statement, add a call to `initMarketingDB(db)`. Also add the `initMarketingDB` function itself anywhere before `initMemoryDB`:

```typescript
// ── Marketing tables ──────────────────────────
export function initMarketingDB(db: CompatDatabase): void {
  db.run(`CREATE TABLE IF NOT EXISTS marketing_calendar (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    content_type TEXT NOT NULL,
    content_pillar TEXT,
    caption TEXT,
    media_path TEXT,
    hashtags TEXT,
    scheduled_at TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    post_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_mktcal_brand ON marketing_calendar(brand_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_mktcal_status ON marketing_calendar(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_mktcal_scheduled ON marketing_calendar(scheduled_at)`);

  db.run(`CREATE TABLE IF NOT EXISTS marketing_outreach (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    target_name TEXT,
    target_contact TEXT NOT NULL,
    subject TEXT,
    body TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    sent_at TEXT,
    opened_at TEXT,
    replied_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_mktout_brand ON marketing_outreach(brand_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_mktout_status ON marketing_outreach(status)`);
}
```

- [ ] **Step 3: Verify the DB tables get created**

```bash
npm run build 2>&1 | tail -20
```

Expected: no TypeScript errors. Then run:

```bash
node -e "
import('./dist/memory/sqlite.js').then(m => m.initMemoryDB()).then(db => {
  console.log('marketing_calendar exists:', db.exec(\"SELECT name FROM sqlite_master WHERE type='table' AND name='marketing_calendar'\").length > 0);
  console.log('marketing_outreach exists:', db.exec(\"SELECT name FROM sqlite_master WHERE type='table' AND name='marketing_outreach'\").length > 0);
  db.close();
});
"
```

Expected output:
```
marketing_calendar exists: true
marketing_outreach exists: true
```

- [ ] **Step 4: Commit**

```bash
git add src/marketing/brand-profile.ts src/memory/sqlite.ts
git commit -m "feat(marketing): brand profile schema + marketing SQLite tables"
```

---

### Task 2: Content Calendar CRUD

**Files:**
- Create: `src/marketing/content-calendar.ts`

- [ ] **Step 1: Create `src/marketing/content-calendar.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { getMemoryDB } from "../memory/sqlite.js";

export type CalendarStatus = "draft" | "pending_approval" | "approved" | "scheduled" | "posted" | "failed";
export type ContentType = "reel" | "post" | "story" | "carousel" | "thread" | "article" | "video" | "text";

export interface CalendarItem {
  id?: number;
  brandId: string;
  platform: string;
  contentType: ContentType;
  contentPillar?: string;
  caption?: string;
  mediaPath?: string;
  hashtags?: string[];
  scheduledAt?: string;
  status: CalendarStatus;
  postUrl?: string;
}

export function addCalendarItem(item: CalendarItem): number {
  const db = getMemoryDB();
  db.run(
    `INSERT INTO marketing_calendar (brand_id, platform, content_type, content_pillar, caption, media_path, hashtags, scheduled_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [item.brandId, item.platform, item.contentType, item.contentPillar ?? null,
     item.caption ?? null, item.mediaPath ?? null,
     item.hashtags ? JSON.stringify(item.hashtags) : null,
     item.scheduledAt ?? null, item.status]
  );
  const rows = db.exec("SELECT last_insert_rowid() as id");
  return Number(rows[0]?.values[0]?.[0] ?? 0);
}

export function updateCalendarItem(id: number, updates: Partial<CalendarItem>): void {
  const db = getMemoryDB();
  const fields: string[] = [];
  const vals: unknown[] = [];
  if (updates.status !== undefined) { fields.push("status = ?"); vals.push(updates.status); }
  if (updates.caption !== undefined) { fields.push("caption = ?"); vals.push(updates.caption); }
  if (updates.mediaPath !== undefined) { fields.push("media_path = ?"); vals.push(updates.mediaPath); }
  if (updates.scheduledAt !== undefined) { fields.push("scheduled_at = ?"); vals.push(updates.scheduledAt); }
  if (updates.postUrl !== undefined) { fields.push("post_url = ?"); vals.push(updates.postUrl); }
  if (updates.hashtags !== undefined) { fields.push("hashtags = ?"); vals.push(JSON.stringify(updates.hashtags)); }
  if (!fields.length) return;
  fields.push("updated_at = datetime('now')");
  vals.push(id);
  db.run(`UPDATE marketing_calendar SET ${fields.join(", ")} WHERE id = ?`, vals);
}

export function getCalendarItem(id: number): CalendarItem | null {
  const db = getMemoryDB();
  const rows = db.exec("SELECT * FROM marketing_calendar WHERE id = ?", [id]);
  if (!rows.length || !rows[0].values.length) return null;
  return rowToItem(rows[0].columns, rows[0].values[0]);
}

export function getScheduledItems(brandId: string, beforeIso: string): CalendarItem[] {
  const db = getMemoryDB();
  const rows = db.exec(
    `SELECT * FROM marketing_calendar WHERE brand_id = ? AND status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at ASC`,
    [brandId, beforeIso]
  );
  if (!rows.length) return [];
  return rows[0].values.map((v) => rowToItem(rows[0].columns, v));
}

export function getPendingApprovals(brandId: string): CalendarItem[] {
  const db = getMemoryDB();
  const rows = db.exec(
    `SELECT * FROM marketing_calendar WHERE brand_id = ? AND status = 'pending_approval' ORDER BY created_at ASC`,
    [brandId]
  );
  if (!rows.length) return [];
  return rows[0].values.map((v) => rowToItem(rows[0].columns, v));
}

function rowToItem(cols: string[], vals: unknown[]): CalendarItem {
  const obj = Object.fromEntries(cols.map((c, i) => [c, vals[i]])) as Record<string, unknown>;
  return {
    id: obj.id as number,
    brandId: obj.brand_id as string,
    platform: obj.platform as string,
    contentType: obj.content_type as ContentType,
    contentPillar: obj.content_pillar as string | undefined,
    caption: obj.caption as string | undefined,
    mediaPath: obj.media_path as string | undefined,
    hashtags: obj.hashtags ? JSON.parse(obj.hashtags as string) as string[] : undefined,
    scheduledAt: obj.scheduled_at as string | undefined,
    status: obj.status as CalendarStatus,
    postUrl: obj.post_url as string | undefined,
  };
}
```

- [ ] **Step 2: Add `getMemoryDB` accessor to `src/memory/sqlite.ts`**

This step is **required** — `getMemoryDB` does not exist yet and all subsequent marketing tasks depend on it.

Add a module-level `_db` variable and `getMemoryDB()` export to `src/memory/sqlite.ts`. Find the line `export async function initMemoryDB()` and add the `_db` variable just before the function, then assign `_db = db` just before `return db` inside the function body:

```typescript
// Add just before the initMemoryDB function declaration:
let _db: CompatDatabase | null = null;

// Inside initMemoryDB, add this line just before "return db":
_db = db;

// Add after initMemoryDB:
export function getMemoryDB(): CompatDatabase {
  if (!_db) throw new Error("Memory DB not initialized — call initMemoryDB first");
  return _db;
}
```

- [ ] **Step 3: Build and verify**

```bash
npm run typecheck 2>&1 | grep -E "error TS|marketing"
```

Expected: no errors related to marketing files.

- [ ] **Step 4: Commit**

```bash
git add src/marketing/content-calendar.ts src/memory/sqlite.ts
git commit -m "feat(marketing): content calendar CRUD + getMemoryDB accessor"
```

---

### Task 3: Approval Workflow (Channel-Agnostic)

**Files:**
- Create: `src/marketing/approval-workflow.ts`

- [ ] **Step 1: Create `src/marketing/approval-workflow.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { deliverToActiveChannel, getActiveChannel } from "../tools/channel-send.js";
import { updateCalendarItem, type CalendarItem } from "./content-calendar.js";

export interface ApprovalRequest {
  itemId: number;
  brandId: string;
  platform: string;
  contentType: string;
  caption: string;
  mediaPath?: string;
  scheduledAt?: string;
}

// In-memory map of pending approvals (itemId → request)
const pendingApprovals = new Map<number, ApprovalRequest>();

export function queueApproval(req: ApprovalRequest): void {
  pendingApprovals.set(req.itemId, req);
  updateCalendarItem(req.itemId, { status: "pending_approval" });
}

export async function sendApprovalRequest(req: ApprovalRequest): Promise<void> {
  const channel = getActiveChannel() ?? "telegram";
  const msg = buildApprovalMessage(req, channel);
  await deliverToActiveChannel(msg, req.mediaPath);
}

export function resolveApproval(itemId: number, approved: boolean, feedback?: string): void {
  const req = pendingApprovals.get(itemId);
  if (!req) return;
  pendingApprovals.delete(itemId);
  if (approved) {
    updateCalendarItem(itemId, { status: "approved" });
  } else {
    updateCalendarItem(itemId, { status: "draft" });
  }
}

export function getPendingApprovalByItemId(itemId: number): ApprovalRequest | undefined {
  return pendingApprovals.get(itemId);
}

function buildApprovalMessage(req: ApprovalRequest, channel: string): string {
  const when = req.scheduledAt
    ? `Scheduled for ${new Date(req.scheduledAt).toLocaleString()}`
    : "Ready to post";

  // WhatsApp: plain text, emoji bullets
  if (channel === "whatsapp") {
    return [
      `📱 *Content Ready for Approval* (ID: ${req.itemId})`,
      `Platform: ${req.platform}`,
      `Type: ${req.contentType}`,
      `${when}`,
      ``,
      `Caption: ${req.caption}`,
      ``,
      `Reply with: *approve ${req.itemId}* or *reject ${req.itemId}: your feedback*`,
    ].join("\n");
  }

  // Slack: plain text (Block Kit handled separately if needed)
  if (channel === "slack") {
    return [
      `*Content Ready for Approval* (ID: \`${req.itemId}\`)`,
      `*Platform:* ${req.platform} | *Type:* ${req.contentType} | ${when}`,
      `*Caption:* ${req.caption}`,
      `Reply: \`approve ${req.itemId}\` or \`reject ${req.itemId}: feedback\``,
    ].join("\n");
  }

  // Telegram / overlay / Discord: Markdown
  return [
    `**Content Ready for Approval** (ID: \`${req.itemId}\`)`,
    `**Platform:** ${req.platform} | **Type:** ${req.contentType}`,
    `**${when}**`,
    ``,
    `**Caption:** ${req.caption}`,
    ``,
    `Reply: \`approve ${req.itemId}\` or \`reject ${req.itemId}: your feedback\``,
  ].join("\n");
}
```

- [ ] **Step 2: Build check**

```bash
npm run typecheck 2>&1 | grep -E "error TS|approval"
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/marketing/approval-workflow.ts
git commit -m "feat(marketing): channel-agnostic approval workflow"
```

---

### Task 4: Four Tool Stubs + Tool Router Category

**Files:**
- Create: `src/tools/social-post.ts`
- Create: `src/tools/cold-outreach.ts`
- Create: `src/tools/marketing-schedule.ts`
- Create: `src/tools/brand-audit.ts`
- Modify: `src/tools/index.ts` (import + register 4 tools)
- Modify: `src/tool-router.ts` (add `marketing` category)

- [ ] **Step 1: Create `src/tools/social-post.ts` stub**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ToolDefinition } from "./get-current-time.js";

export const socialPost: ToolDefinition = {
  schema: {
    type: "function",
    function: {
      name: "social_post",
      description: "Post or schedule content to a social media platform (Instagram, LinkedIn, TikTok, Twitter/X, Facebook, YouTube, Reddit). Handles media upload, caption, hashtags, and optional scheduling.",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["instagram", "linkedin", "tiktok", "twitter", "facebook", "youtube", "reddit"],
            description: "Target platform",
          },
          brand_id: { type: "string", description: "Brand slug from brand profile" },
          content_type: {
            type: "string",
            enum: ["reel", "post", "story", "carousel", "thread", "article", "video", "text"],
          },
          caption: { type: "string", description: "Post caption / body text" },
          media_path: { type: "string", description: "Absolute local path to video or image file" },
          hashtags: { type: "array", items: { type: "string" }, description: "Hashtags without # prefix" },
          scheduled_at: { type: "string", description: "ISO 8601 datetime to schedule. Omit to post immediately." },
        },
        required: ["platform", "brand_id", "content_type", "caption"],
      },
    },
  },
  async handler(input) {
    // Stub — full implementation in Plan 4
    return JSON.stringify({ status: "stub", message: "social_post not yet implemented — Plan 4" });
  },
};
```

- [ ] **Step 2: Create `src/tools/cold-outreach.ts` stub**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ToolDefinition } from "./get-current-time.js";

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
    return JSON.stringify({ status: "stub", message: "cold_outreach not yet implemented — Plan 4" });
  },
};
```

- [ ] **Step 3: Create `src/tools/marketing-schedule.ts` stub**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ToolDefinition } from "./get-current-time.js";

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
    return JSON.stringify({ status: "stub", message: "marketing_schedule not yet implemented — Plan 4" });
  },
};
```

- [ ] **Step 4: Create `src/tools/brand-audit.ts` stub**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ToolDefinition } from "./get-current-time.js";

export const brandAudit: ToolDefinition = {
  schema: {
    type: "function",
    function: {
      name: "brand_audit",
      description: "Audit a brand's online presence: scrape website, analyse existing social profiles, research competitors, extract brand voice. Returns a structured report.",
      parameters: {
        type: "object",
        properties: {
          brand_id: { type: "string" },
          website: { type: "string" },
          social_handles: {
            type: "object",
            description: "Map of platform → handle e.g. {instagram: 'myco', linkedin: 'my-co'}",
          },
          competitors: { type: "array", items: { type: "string" } },
          depth: { type: "string", enum: ["quick", "standard", "deep"], description: "Research depth (default: standard)" },
        },
        required: ["brand_id", "website"],
      },
    },
  },
  async handler(input) {
    return JSON.stringify({ status: "stub", message: "brand_audit not yet implemented — Plan 2" });
  },
};
```

- [ ] **Step 5: Register all 4 tools in `src/tools/index.ts`**

Add imports near the other tool imports (e.g. after the `scheduled.ts` import):
```typescript
import { socialPost } from "./social-post.js";
import { coldOutreach } from "./cold-outreach.js";
import { marketingSchedule } from "./marketing-schedule.js";
import { brandAudit } from "./brand-audit.js";
```

Add registrations in the registry section (e.g. after `scheduleTask`):
```typescript
// Marketing tools
registry.set(socialPost.schema.function.name, socialPost);
registry.set(coldOutreach.schema.function.name, coldOutreach);
registry.set(marketingSchedule.schema.function.name, marketingSchedule);
registry.set(brandAudit.schema.function.name, brandAudit);
```

- [ ] **Step 6: Add `marketing` category to `src/tool-router.ts`**

In the `CATEGORIES` object (after the last existing category), add:
```typescript
marketing: {
  description:
    "Marketing a business or product: posting to social media (Instagram Reels, LinkedIn, TikTok, Twitter/X, Facebook, YouTube, Reddit), scheduling content, cold email outreach, LinkedIn outreach, finding leads, auditing a brand's online presence, researching competitors, analysing trends, managing a content calendar, promoting a product on Product Hunt. Use when user wants to grow their audience, get more customers, run a campaign, or post content.",
  tools: [
    "social_post",
    "cold_outreach",
    "marketing_schedule",
    "brand_audit",
    "deep_research",
    "web_search",
    "browser_navigate",
    "browser_extract",
    "generate_image",
    "video_create_project",
    "video_analyze",
    "video_plan_edit",
    "video_render",
    "send_file",
    "schedule_task",
  ],
},
```

- [ ] **Step 7: Build and verify all 4 tools are registered**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -20
```

Expected: no errors.

```bash
npm run build 2>&1 | tail -5
```

Expected: `Build complete` or similar success.

```bash
node -e "import('./dist/tools/index.js').then(m => console.log('tools:', m.getToolNames().filter(t => ['social_post','cold_outreach','marketing_schedule','brand_audit'].includes(t))))"
```

Expected:
```
tools: [ 'social_post', 'cold_outreach', 'marketing_schedule', 'brand_audit' ]
```

- [ ] **Step 8: Commit**

```bash
git add src/tools/social-post.ts src/tools/cold-outreach.ts src/tools/marketing-schedule.ts src/tools/brand-audit.ts src/tools/index.ts src/tool-router.ts
git commit -m "feat(marketing): register 4 marketing tool stubs + marketing tool category"
```

---

### Task 5: Marketing Skill File

**Files:**
- Create: `skills/marketing.md`

- [ ] **Step 1: Create `skills/marketing.md`**

```markdown
---
role: marketing
triggers:
  - marketing
  - social media
  - grow my business
  - get more customers
  - get more clients
  - instagram
  - reels
  - linkedin
  - tiktok
  - twitter
  - post content
  - content calendar
  - cold outreach
  - cold email
  - brand audit
  - competitor analysis
  - product hunt
  - advertise
  - promote
  - campaign
  - brand
  - audience
  - followers
description: AI marketing team — brand audit, campaign planning, content creation, social posting, cold outreach
---

# Marketing Brain

You are ATLAS acting as a complete AI marketing team. When the user asks anything related to growing their business, getting customers, or marketing, follow this workflow:

## Step 1: Brand Intake (first time only)

If no brand profile exists for this user yet, collect:
1. Business name and website URL
2. What they sell / who they help
3. Social media handles (Instagram, LinkedIn, TikTok, etc.) — say "skip" to skip any
4. Main competitors (up to 3)
5. Tone of voice (casual / professional / playful / authoritative)

Then call `brand_audit` immediately to research the brand, competitors, and existing social presence. Tell the user: "Give me a few minutes to research your brand and competitors."

## Step 2: Strategy Presentation

After the brand audit, present a strategy covering:
- Recommended platforms with simple reasoning (e.g. "Instagram Reels are performing 3x better than static posts for SaaS tools right now")
- 3-5 content pillars (topics you'll post about)
- Posting cadence
- Outreach options with clear risk explanations (especially LinkedIn)

**Always explain risks in plain English before asking the user to choose outreach modes.**

## Step 3: Autonomy Mode

Explain the three modes and ask the user to pick one:

- **Hands-on**: "I'll send you every piece of content for your approval before anything goes live. Nothing posts without your OK."
- **Review & forget**: "You approve the full content calendar once. I handle everything after — posting on schedule and adjusting based on what performs."
- **Hybrid** (recommended): "You review each piece of content when it's ready. Once you approve it, I pick the best time and post automatically."

## Step 4: Content Calendar

Generate a 4-week content calendar and send it to the user. Once approved, start executing.

## Content Creation Rules

- **Always research trends first** — use `web_search` or `deep_research` before writing scripts or captions
- **Video first** — for Instagram and TikTok, prioritise Reels over static posts
- **Ask before generating video** — "Should I generate the video or will you film it?"
- **Send preview before posting** — always send the content to the user's active channel for approval (unless autonomy_mode = review_and_forget and the calendar was already approved)
- **Brand voice** — always write captions and scripts in the brand's tone of voice from the brand profile

## Outreach Rules

- **Email**: Use `cold_outreach` with channel=email. Always personalise — generic bulk emails are refused.
- **LinkedIn**: Present all three options (automated/posts-only/semi-automated) with risks before acting.
- **Never send outreach without user approval** regardless of autonomy mode.

## Approval Handling

When the user replies "approve [ID]" or "reject [ID]: feedback" — resolve the pending approval via the content calendar.

## Tool Usage

- `brand_audit` — run on intake and weekly for competitor/trend monitoring
- `social_post` — for all social publishing
- `cold_outreach` — for email and LinkedIn outreach
- `marketing_schedule` — for scheduling and viewing the content calendar
- `video_create_project`, `video_plan_edit`, `video_render` — for Reel/TikTok production
- `generate_image` — for static post visuals
- `deep_research` — for trend research, competitor deep-dives
- `web_search` — quick trend and hashtag lookups
```

- [ ] **Step 2: Verify skill loads**

```bash
grep -r "marketing" skills/ --include="*.md" -l
```

Expected: `skills/marketing.md`

- [ ] **Step 3: Commit**

```bash
git add skills/marketing.md
git commit -m "feat(marketing): marketing skill file with brand intake workflow"
```

---

### Task 6: `.env.example` Documentation

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add marketing credential keys to `.env.example`**

Append to `.env.example`:
```bash
# ── Marketing Brain ───────────────────────────
# Replace {brand} with your brand slug (lowercase, hyphens)
# Example: IG_USER_ID_acme-io=123456789

# Instagram (Meta Graph API)
IG_USER_ID_{brand}=
IG_ACCESS_TOKEN_{brand}=          # Meta Page Access Token (60-day, refreshes automatically)

# LinkedIn
LI_ACCESS_TOKEN_{brand}=
LI_ORG_ID_{brand}=                # Company Page numeric ID (optional — for org posts)

# TikTok
TIKTOK_ACCESS_TOKEN_{brand}=

# Twitter / X
X_API_KEY_{brand}=
X_API_SECRET_{brand}=
X_ACCESS_TOKEN_{brand}=
X_ACCESS_SECRET_{brand}=

# Facebook Pages
FB_PAGE_ID_{brand}=
FB_ACCESS_TOKEN_{brand}=

# YouTube (reuses GOOGLE_* credentials if same account)
# No extra vars needed if Google OAuth already configured

# Reddit
REDDIT_CLIENT_ID_{brand}=
REDDIT_CLIENT_SECRET_{brand}=
REDDIT_REFRESH_TOKEN_{brand}=

# Product Hunt
PH_API_TOKEN=

# Shared marketing service keys
APIFY_TOKEN=                       # Trend research + competitor scraping (apify.com)
APOLLO_API_KEY=                    # Lead finding (apollo.io)
HUNTER_API_KEY=                    # Email verification (hunter.io)
RUNWAY_API_KEY=                    # AI video generation (runwayml.com)
PHANTOMBUSTER_API_KEY=             # LinkedIn automation — optional, ToS risk (phantombuster.com)
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: add marketing brain credential keys to .env.example"
```

---

**Plan 1 complete.** The foundation is in place: brand profile schema, marketing SQLite tables, content calendar CRUD, channel-agnostic approval workflow, 4 tool stubs registered, marketing tool router category, and skill file. Proceed to Plan 2 (Research Engine).
