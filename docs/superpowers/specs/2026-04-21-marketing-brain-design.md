# ATLAS Marketing Brain — Design Spec
**Date:** 2026-04-21  
**Status:** Approved for implementation  
**Approach:** Plan B — Direct API integration

---

## 1. Overview

ATLAS Marketing Brain turns ATLAS into a complete AI marketing team. A user provides their brand details (website, logo, social handles, product description) and ATLAS autonomously researches the brand, proposes a marketing strategy, generates content, schedules and posts it across platforms, and runs cold outreach campaigns — all while keeping the human in the loop via their preferred channel (Telegram, WhatsApp, Slack, Discord, or overlay).

### Core value proposition
- **Brand owner talks to ATLAS on any channel** — Telegram, WhatsApp, Slack, Discord, overlay
- **ATLAS acts like a full marketing team** — strategist, content creator, video editor, copywriter, growth hacker, community manager
- **Human stays in control** — approval gates at every decision point, configurable autonomy level
- **Everything autonomous after approval** — scheduling, posting, outreach, trend monitoring run without further input

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  BRAND OWNER (any channel: Telegram / WhatsApp / Slack / Discord)  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ channel-send.ts (already channel-agnostic)
┌──────────────────────────────▼──────────────────────────────────────┐
│  MARKETING BRAIN ORCHESTRATOR  (src/marketing/orchestrator.ts)      │
│  ┌─────────────┐ ┌──────────────┐ ┌────────────────┐               │
│  │Brand Intake │ │Campaign Plan │ │Approval Engine │               │
│  └─────────────┘ └──────────────┘ └────────────────┘               │
└──────┬──────────────────┬──────────────────┬───────────────────────┘
       │                  │                  │
┌──────▼──────┐  ┌────────▼────────┐  ┌──────▼──────────────────────┐
│  RESEARCH   │  │ CONTENT FACTORY │  │  DISTRIBUTION ENGINE        │
│  ENGINE     │  │                 │  │                              │
│ ·brand audit│  │ ·video pipeline │  │ ·social-post.ts (Instagram  │
│ ·competitor │  │ ·image gen      │  │   LinkedIn TikTok X FB      │
│ ·trend scan │  │ ·caption writer │  │   YouTube Reddit)           │
│ ·lead finder│  │ ·script writer  │  │ ·cold-outreach.ts           │
└─────────────┘  └─────────────────┘  │ ·marketing-schedule.ts      │
                                       └─────────────────────────────┘
```

All user-facing messages flow through the existing `channel-send.ts` registry (`deliverToActiveChannel` / `getChannelSender`). The marketing brain never hard-codes a channel.

---

## 3. Brand Intake & Memory

### 3.1 What the user provides
The brand owner sends one message (or fills a guided conversation):

```
Brand name, website URL, logo (image file), social handles (IG/LI/TikTok/X),
product/service description, target audience, tone of voice (casual/professional/etc),
main competitors, monthly budget range (optional).
```

ATLAS guides this as a natural conversation, not a form.

### 3.2 Automatic brand audit (runs after intake)
1. **Website scrape** — `browser_navigate` + `browser_extract` to pull copy, tone, product pages
2. **Social profile analysis** — Apify `instagram-scraper` + `tiktok-scraper` on their own profiles (post frequency, engagement rate, content pillars)
3. **Competitor analysis** — `deep_research` on each listed competitor; Apify scrapers on competitor socials
4. **Brand voice extraction** — LLM analyzes website + existing posts → extracts tone, vocabulary, style guide

### 3.3 Storage
New memory category `brand` in `src/memory/sqlite.ts`. Brand profile stored as a JSON blob under key `brand_profile:{brand_name}`. Recalled at the start of every marketing-related agent call.

```typescript
// src/marketing/brand-profile.ts
interface BrandProfile {
  id: string;
  name: string;
  website: string;
  logoPath: string;           // saved to getImagesDir()
  socialHandles: Record<Platform, string>;
  description: string;
  targetAudience: string;
  toneOfVoice: string;
  competitors: string[];
  contentPillars: string[];   // derived by audit
  brandVoiceGuide: string;    // derived by audit
  auditSummary: string;       // competitor gaps, opportunities
  createdAt: string;
  updatedAt: string;
}
```

---

## 4. Campaign Planner

### 4.1 Strategy generation
After brand audit completes, ATLAS sends a **Marketing Strategy Report** to the user's active channel:
- Recommended platform mix (with rationale per platform)
- 3-5 content pillars
- Suggested posting cadence per platform
- Outreach strategy options (with risks explained)
- Autonomy mode selection

The report is also saved as `A.T.L.A.S Files/Documents/marketing/{brand}/strategy.md`.

### 4.2 Outreach options presented to user
ATLAS explains all options in plain language before the user picks:

**LinkedIn outreach:**
- **Option A — PhantomBuster automation**: "ATLAS sends connection requests and follow-up DMs automatically using PhantomBuster. Risk: LinkedIn may suspend the account (~5-15% monthly risk). Best for fast results."
- **Option B — Official posts only**: "ATLAS posts engaging content to attract inbound leads. Zero ban risk. Results take longer (weeks not days)."
- **Option C — Semi-automated drafts**: "ATLAS writes the messages and finds the targets, then sends you a list via [channel] for you to copy-paste and send. Safe, but requires your time."

**Twitter/X DMs:** Only viable at Pro API tier ($100/mo). ATLAS explains cost before enabling.

### 4.3 Autonomy mode (user picks once at setup, can change anytime)
ATLAS explains each mode in plain language:

- **Hands-on**: "I'll send you every piece of content before it goes live. Nothing posts without your OK."
- **Review & forget**: "You approve the full content calendar once. I handle everything after that — posting on schedule, adjusting timing based on performance."
- **Hybrid**: "You review each content draft when it's ready. Once you say yes, I pick the best time to post and handle it."

Stored in `brand_profile.autonomyMode`.

### 4.4 Content calendar
Generated as a structured schedule: `[date, platform, contentType, contentPillar, status]`.
- Stored in SQLite table `marketing_calendar`
- Status values: `draft → pending_approval → approved → scheduled → posted → failed`
- Surfaced to user via natural language queries: "show me this week's content"

---

## 5. Content Factory

### 5.1 Video content (Reels / TikToks / YouTube Shorts)

**Step 1 — Trend research**
Apify actors:
- `clockworks/tiktok-hashtag-analysis` — trending sounds, formats, hashtag performance
- `apify/instagram-hashtag-scraper` — top performing Reels in the niche
Agent identifies: trending audio, hook patterns, optimal video length, caption style

**Step 2 — Script writing** (`src/marketing/script-writer.ts`)
LLM generates:
- Hook (first 3 seconds — based on trending patterns)
- Storyboard (scene-by-scene shot list)
- On-screen text / captions
- Suggested audio track (trending sound name)
- Call-to-action

Sent to user as a formatted message. User responds: "looks good" / edits inline / "I'll film this myself".

**Step 3a — User films it**
If user says they'll film: ATLAS sends the script + shot list and sets a scheduled reminder. When user sends the video file back (on any channel), ATLAS receives it as a `MediaAttachment` and proceeds to Step 4.

**Step 3b — Agent generates video autonomously**
Two sub-options (agent decides based on content type):
- **AI video** (`src/video-studio/assets/ai-video-gen.ts`): Runway ML Gen-3 Alpha or Kling AI API — text-to-video clips, stitched by FFmpeg
- **Stock footage**: Pexels Video API (free) → download clips → FFmpeg assembly

**Step 4 — Video studio pipeline** (existing `video_studio` tools)
- `video_create_project` → `video_analyze` → `video_plan_edit` → `video_render`
- Applies: aspect ratio (9:16 for Reels/TikTok), captions (reel_karaoke style), beat sync, brand colors overlay

**Step 5 — Preview & approval**
ATLAS sends the rendered video to the user's active channel with message:
> "Here's your Instagram Reel for Tuesday 6 PM. Caption: [caption]. Hashtags: [hashtags]. Approve to schedule, or tell me what to change."

On approval → status = `approved` → handed to Distribution Engine.

### 5.2 Image / carousel content
- LLM writes caption + selects hashtags (hashtag research via Apify)
- `generate_image` tool creates visual (DALL-E / GPT-5 Image)
- `sharp` for resizing to platform specs
- Preview sent to user for approval (same flow as video)

### 5.3 Text content (LinkedIn posts, Twitter threads, Reddit)
- LLM writes in brand voice (injected from `brand_profile.brandVoiceGuide`)
- No media needed
- Still goes through approval gate per user's autonomy mode

---

## 6. Distribution Engine

### 6.1 `social-post` tool (`src/tools/social-post.ts`)

Single unified tool the agent calls to publish content. Internally routes to platform-specific adapters.

**Tool schema:**
```typescript
{
  name: "social_post",
  parameters: {
    platform: "instagram" | "linkedin" | "tiktok" | "twitter" | "facebook" | "youtube" | "reddit" | "producthunt",
    contentType: "reel" | "post" | "story" | "carousel" | "thread" | "article" | "video",
    caption: string,
    mediaPath?: string,       // local file path
    mediaUrl?: string,        // CDN URL (preferred for Instagram/TikTok)
    hashtags?: string[],
    scheduledAt?: string,     // ISO8601 — if set, queues for later
    brandId: string,
  }
}
```

**Platform adapters** (`src/marketing/adapters/`):
- `instagram.ts` — Meta Graph API: container create → poll until FINISHED → publish
- `linkedin.ts` — LinkedIn Posts API v2 (`/v2/posts`)
- `tiktok.ts` — TikTok Content Posting API
- `twitter.ts` — `twitter-api-v2` npm package (v2 API)
- `facebook.ts` — Meta Graph API (Pages)
- `youtube.ts` — YouTube Data API v3 (reuses existing `googleapis` credentials)
- `reddit.ts` — Reddit API via `snoowrap` npm
- `producthunt.ts` — GraphQL read + comment; launch prep + human-in-the-loop notification for actual submission

**Credential storage:** Per-brand credentials stored in `.env` with brand-namespaced keys (`IG_USER_ID_brandname`, `IG_ACCESS_TOKEN_brandname`). `brand-profile.ts` resolves correct keys from brand ID.

**Rate limit awareness:** Each adapter tracks posts-per-day in SQLite and refuses to post when platform limits are approached (Instagram: 25/day, TikTok: 15/day).

### 6.2 `cold-outreach` tool (`src/tools/cold-outreach.ts`)

**Email outreach:**
1. `lead-finder.ts` calls Apollo.io API to find prospects (by industry, title, company size)
2. LLM writes personalized cold email using brand voice + prospect data
3. Sent via existing SMTP channel (`nodemailer`)
4. Tracked in `marketing_outreach` SQLite table (sent, opened, replied)

**LinkedIn outreach (user's chosen mode):**
- PhantomBuster: HTTP POST to PhantomBuster webhook with target profile + message template
- Official posts: queued to `social_post` tool
- Semi-automated: drafts sent to user's active channel as a formatted list

**Product Hunt:**
- Agent prepares all assets: name, tagline, description, gallery images, first comment
- Sends complete launch checklist to user via channel
- Notifies user to manually submit at 12:01 AM PT on launch day
- After launch: monitors upvotes/comments via PH GraphQL API, drafts responses

### 6.3 `marketing-schedule` tool (`src/tools/marketing-schedule.ts`)

Extends existing `scheduled.ts` cron system for marketing-specific scheduling:
- Wraps `schedule_task` with platform-optimal posting time logic (per-platform best-time-to-post heuristics, later ML-driven)
- Queue management: handles multiple brands, multiple platforms, rate limits
- On execution: calls `social_post` → on success updates calendar status to `posted` → sends confirmation to user's active channel
- On failure: retries with exponential backoff, notifies user if 3 retries exhausted

---

## 7. Channel-Agnostic Delivery

All user-facing marketing messages (approvals, previews, reports, confirmations) use:

```typescript
import { deliverToActiveChannel, getChannelSender } from "../tools/channel-send.js";

// Send approval request (works on Telegram, WhatsApp, Slack, Discord, overlay)
await deliverToActiveChannel(approvalMessage, mediaFilePath);
```

When the user replies with approval/feedback, it arrives as a normal agent message on whatever channel they're using. The marketing orchestrator checks `brand_profile.pendingApprovals` to match the reply to the pending item.

**Platform-specific formatting:**
- Telegram: Markdown, inline keyboard buttons (Approve / Request changes)
- WhatsApp: Plain text with emoji, no buttons
- Slack: Block Kit with approve/reject actions
- Discord: Embeds + reaction-based approval
- Overlay: Full rendered preview with HTML approval UI

The `approval-workflow.ts` module handles this formatting per-channel using `getActiveChannel()`.

---

## 8. New Files

```
src/marketing/
  orchestrator.ts          # Top-level marketing brain: routes "help me market" intent
  brand-profile.ts         # BrandProfile CRUD, memory integration, credential resolver
  campaign-planner.ts      # Strategy generation, content calendar creation
  content-calendar.ts      # SQLite table: marketing_calendar + marketing_outreach
  approval-workflow.ts     # Per-channel approval message formatting + reply matching
  trend-researcher.ts      # Apify wrapper: trending sounds, hashtags, competitor posts
  script-writer.ts         # Video script + shot list generation
  video-pipeline.ts        # Orchestrates video_studio tools for marketing content
  outreach-engine.ts       # LinkedIn/email/X outreach orchestration
  lead-finder.ts           # Apollo.io + Hunter.io API wrappers
  product-hunt.ts          # PH prep checklist + GraphQL monitoring

  adapters/
    instagram.ts           # Meta Graph API: feed posts + Reels
    linkedin.ts            # LinkedIn Posts API v2
    tiktok.ts              # TikTok Content Posting API
    twitter.ts             # twitter-api-v2 npm
    facebook.ts            # Meta Graph API: Pages
    youtube.ts             # YouTube Data API v3 (reuses googleapis)
    reddit.ts              # Reddit API via snoowrap
    producthunt.ts         # PH GraphQL + human-in-loop launch

src/tools/
  social-post.ts           # Unified posting tool (ToolDefinition)
  cold-outreach.ts         # Cold DM/email tool (ToolDefinition)
  marketing-schedule.ts    # Campaign scheduling tool (ToolDefinition)
  brand-audit.ts           # Brand + competitor analysis tool (ToolDefinition)

src/video-studio/assets/
  ai-video-gen.ts          # Runway ML + Kling AI for AI-generated video clips

skills/
  marketing.md             # Marketing skill file (triggers, workflow instructions)
```

**Files modified:**
- `src/memory/sqlite.ts` — add `brand` category + `marketing_calendar` + `marketing_outreach` tables
- `src/index.ts` — boot the marketing orchestrator, register `social_post`/`cold_outreach`/`marketing-schedule`/`brand-audit` tools
- `src/tools/tool-categories.ts` (or equivalent) — add `marketing` tool category
- `.env.example` — document all new credential keys

---

## 9. New Environment Variables

```bash
# Per-brand social credentials (replace {brand} with brand slug)
IG_USER_ID_{brand}=
IG_ACCESS_TOKEN_{brand}=          # Meta Page Access Token (60-day, auto-refresh)
LI_ACCESS_TOKEN_{brand}=          # LinkedIn OAuth token
LI_ORG_ID_{brand}=                # LinkedIn Company Page URN
TIKTOK_ACCESS_TOKEN_{brand}=
X_API_KEY_{brand}=
X_API_SECRET_{brand}=
X_ACCESS_TOKEN_{brand}=
X_ACCESS_SECRET_{brand}=
FB_PAGE_ID_{brand}=
FB_ACCESS_TOKEN_{brand}=
REDDIT_CLIENT_ID_{brand}=
REDDIT_TOKEN_{brand}=
PH_TOKEN_{brand}=

# Shared service keys
APIFY_TOKEN=                       # Apify scraping (trend research, competitor analysis)
APOLLO_API_KEY=                    # Lead finding
HUNTER_API_KEY=                    # Email verification
RUNWAY_API_KEY=                    # AI video generation
PHANTOMBUSTER_API_KEY=             # LinkedIn automation (optional, ToS risk)
```

---

## 10. Example End-to-End Flow

**User:** "Help me get more customers for my SaaS — here's our website: acme.io"

1. ATLAS runs brand audit (scrapes acme.io, analyzes competitors via deep_research, scrapes their IG/TikTok)
2. ATLAS sends strategy report to WhatsApp (user's active channel): recommended platforms, content pillars, outreach options with risks
3. User: "Focus on Instagram Reels and LinkedIn posts. For LinkedIn outreach, use the safe posts-only option."
4. User picks autonomy mode: "Hybrid — I'll review content before it posts"
5. ATLAS generates 4-week content calendar, sends it for approval
6. User: "Looks good, start"
7. **Week 1, Monday:** Trend researcher finds "founder story" Reels performing 3x in SaaS niche. Script writer drafts a 30-second script. Sends to user: "Here's your script for Tuesday's Reel. Want to film it or should I generate it?"
8. User: "Generate it" → AI video + FFmpeg pipeline → renders 30s Reel → sends preview via WhatsApp
9. User: "Nice, post it" → `social_post` queues for Tuesday 6 PM (optimal Instagram time)
10. **Tuesday 6 PM:** `marketing-schedule` fires → `social_post` calls Instagram Graph API → Reel published → sends confirmation: "Posted! [link]"
11. **Ongoing:** ATLAS monitors engagement, updates world model, adjusts next week's content strategy based on what performed best

---

## 11. Out of Scope (Phase 1)

- Paid ad campaign management (Facebook Ads API, Google Ads) — Phase 2
- Analytics dashboard / reporting UI — Phase 2
- Influencer outreach database — Phase 2
- A/B testing framework — Phase 2
- Multi-brand management UI — Phase 2

---

## 12. Dependencies to Install

```bash
npm install twitter-api-v2 snoowrap apify-client
# Runway ML: REST API calls via fetch (no SDK needed)
# TikTok: REST API via fetch
# LinkedIn: REST API via fetch
# Instagram: REST API via fetch (Meta Graph API)
```

---

## 13. Risk Register

| Risk | Mitigation |
|------|-----------|
| Instagram token expiry (60-day) | Auto-refresh via Meta token exchange endpoint on each boot |
| TikTok audit required for public posts | Start with draft/inbox mode; walk user through audit process |
| LinkedIn PhantomBuster bans | Default off; explicit user consent + risk acknowledgement stored |
| Apollo.io API credit exhaustion | Track credits, warn user when <20% remaining |
| Video rendering time (Runway ~2-5 min/clip) | Run async in Long-Task, notify user when ready |
| Rate limit violations | Per-platform counters in SQLite, hard-refuse at 80% of limit |
