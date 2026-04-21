# Marketing Brain — Plan 2: Research Engine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the brand audit tool, Apify-based trend researcher, and lead finder (Apollo.io + Hunter.io) so the agent can research a brand, find competitors, surface trending content, and discover cold-outreach leads.

**Architecture:** Three new modules in `src/marketing/`: `trend-researcher.ts` (Apify REST calls), `lead-finder.ts` (Apollo.io + Hunter.io REST calls), `brand-audit.ts` (orchestrates browser scraping + deep_research + trend-researcher). The `brand_audit` tool stub from Plan 1 gets its real implementation wired in.

**Prereq:** Plan 1 complete (brand-profile.ts, tool stubs registered).

**Tech Stack:** Node.js `fetch` (built-in), Apify REST API, Apollo.io REST API, Hunter.io REST API, existing `deep_research` tool, existing `browser_navigate`/`browser_extract` tools, `src/marketing/brand-profile.ts`

---

### Task 1: Apify Trend Researcher

**Files:**
- Create: `src/marketing/trend-researcher.ts`

- [ ] **Step 1: Install Apify client**

```bash
npm install apify-client
npm run typecheck 2>&1 | grep "apify" | head -5
```

Expected: apify-client installed, no type errors.

- [ ] **Step 2: Create `src/marketing/trend-researcher.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { ApifyClient } from "apify-client";

export interface TrendingPost {
  platform: "instagram" | "tiktok";
  caption: string;
  likesCount: number;
  viewCount?: number;
  commentsCount: number;
  audioName?: string;
  hashtags: string[];
  url?: string;
  timestamp?: string;
}

export interface TrendResearchResult {
  platform: string;
  niche: string;
  topPosts: TrendingPost[];
  trendingHashtags: string[];
  trendingSounds: string[];
  contentPatterns: string[];   // e.g. "hook: question", "hook: bold claim"
  recommendedPostingTime: string;
}

function getApifyClient(): ApifyClient {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error("APIFY_TOKEN not set in environment");
  return new ApifyClient({ token });
}

export async function researchInstagramTrends(
  hashtags: string[],
  resultsLimit = 50
): Promise<TrendResearchResult> {
  const client = getApifyClient();

  const run = await client.actor("apify/instagram-hashtag-scraper").call({
    hashtags: hashtags.slice(0, 5),
    resultsLimit,
    addParentData: false,
  });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  const posts = (items as Record<string, unknown>[]).map((item) => ({
    platform: "instagram" as const,
    caption: (item.caption as string) ?? "",
    likesCount: (item.likesCount as number) ?? 0,
    viewCount: (item.videoViewCount as number) ?? undefined,
    commentsCount: (item.commentsCount as number) ?? 0,
    audioName: (item.musicInfo as Record<string, unknown>)?.title as string | undefined,
    hashtags: extractHashtags((item.caption as string) ?? ""),
    url: (item.url as string) ?? undefined,
    timestamp: (item.timestamp as string) ?? undefined,
  }));

  // Sort by engagement (likes + comments) descending
  posts.sort((a, b) => (b.likesCount + b.commentsCount) - (a.likesCount + a.commentsCount));
  const topPosts = posts.slice(0, 10);

  const trendingHashtags = countTopHashtags(posts, 15);
  const trendingSounds = countTopSounds(posts, 5);
  const contentPatterns = analyseContentPatterns(topPosts);

  return {
    platform: "instagram",
    niche: hashtags[0] ?? "general",
    topPosts,
    trendingHashtags,
    trendingSounds,
    contentPatterns,
    recommendedPostingTime: "6:00 PM - 9:00 PM local time (Mon/Wed/Fri peak)",
  };
}

export async function researchTikTokTrends(
  hashtags: string[],
  resultsLimit = 30
): Promise<TrendResearchResult> {
  const client = getApifyClient();

  const run = await client.actor("clockworks/tiktok-scraper").call({
    hashtags: hashtags.slice(0, 3),
    resultsPerPage: resultsLimit,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
  });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  const posts = (items as Record<string, unknown>[]).map((item) => ({
    platform: "tiktok" as const,
    caption: (item.text as string) ?? "",
    likesCount: (item.diggCount as number) ?? 0,
    viewCount: (item.playCount as number) ?? undefined,
    commentsCount: (item.commentCount as number) ?? 0,
    audioName: (item.musicMeta as Record<string, unknown>)?.musicName as string | undefined,
    hashtags: ((item.hashtags as Record<string, unknown>[]) ?? []).map((h) => h.name as string),
    url: (item.webVideoUrl as string) ?? undefined,
    timestamp: (item.createTime as string) ?? undefined,
  }));

  posts.sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0));
  const topPosts = posts.slice(0, 10);

  return {
    platform: "tiktok",
    niche: hashtags[0] ?? "general",
    topPosts,
    trendingHashtags: countTopHashtags(posts, 15),
    trendingSounds: countTopSounds(posts, 5),
    contentPatterns: analyseContentPatterns(topPosts),
    recommendedPostingTime: "7:00 PM - 11:00 PM local time (Tue/Thu/Sat peak)",
  };
}

export async function scrapeCompetitorPosts(
  instagramHandle: string,
  limit = 20
): Promise<TrendingPost[]> {
  const client = getApifyClient();
  const run = await client.actor("apify/instagram-profile-scraper").call({
    usernames: [instagramHandle],
    resultsLimit: limit,
  });
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  return (items as Record<string, unknown>[]).flatMap((item) => {
    const posts = (item.latestPosts as Record<string, unknown>[]) ?? [];
    return posts.map((p) => ({
      platform: "instagram" as const,
      caption: (p.caption as string) ?? "",
      likesCount: (p.likesCount as number) ?? 0,
      viewCount: (p.videoViewCount as number) ?? undefined,
      commentsCount: (p.commentsCount as number) ?? 0,
      hashtags: extractHashtags((p.caption as string) ?? ""),
      url: (p.url as string) ?? undefined,
    }));
  });
}

function extractHashtags(text: string): string[] {
  return (text.match(/#\w+/g) ?? []).map((h) => h.slice(1).toLowerCase());
}

function countTopHashtags(posts: TrendingPost[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const p of posts) {
    for (const h of p.hashtags) {
      counts.set(h, (counts.get(h) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([h]) => h);
}

function countTopSounds(posts: TrendingPost[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const p of posts) {
    if (p.audioName) counts.set(p.audioName, (counts.get(p.audioName) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([s]) => s);
}

function analyseContentPatterns(posts: TrendingPost[]): string[] {
  const patterns: string[] = [];
  const questionHooks = posts.filter((p) => p.caption.trim().startsWith("?") || p.caption.includes("?")).length;
  const boldClaims = posts.filter((p) => /^(never|always|stop|you need|secret|truth|why)/i.test(p.caption)).length;
  const listPosts = posts.filter((p) => /^\d+\s|^#\d+/m.test(p.caption)).length;
  if (questionHooks >= 3) patterns.push("hook: question (popular in this niche)");
  if (boldClaims >= 3) patterns.push("hook: bold claim or counterintuitive statement");
  if (listPosts >= 3) patterns.push("format: numbered list / tips");
  if (patterns.length === 0) patterns.push("hook: storytelling / personal experience");
  return patterns;
}
```

- [ ] **Step 3: Build check**

```bash
npm run typecheck 2>&1 | grep -E "error TS|trend-researcher"
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/marketing/trend-researcher.ts package.json package-lock.json
git commit -m "feat(marketing): Apify-based trend researcher for Instagram and TikTok"
```

---

### Task 2: Lead Finder (Apollo.io + Hunter.io)

**Files:**
- Create: `src/marketing/lead-finder.ts`

- [ ] **Step 1: Create `src/marketing/lead-finder.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

export interface Lead {
  firstName: string;
  lastName: string;
  email?: string;
  emailStatus?: "valid" | "unverified" | "invalid";
  title?: string;
  company?: string;
  linkedinUrl?: string;
  phone?: string;
}

export interface LeadSearchParams {
  titles?: string[];          // e.g. ["CTO", "VP Engineering"]
  industries?: string[];      // e.g. ["SaaS", "FinTech"]
  companySizeMin?: number;
  companySizeMax?: number;
  domains?: string[];         // specific company domains
  limit?: number;
}

// ── Apollo.io ─────────────────────────────────

export async function findLeadsApollo(params: LeadSearchParams): Promise<Lead[]> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) throw new Error("APOLLO_API_KEY not set");

  const body: Record<string, unknown> = {
    api_key: apiKey,
    per_page: Math.min(params.limit ?? 25, 100),
    page: 1,
  };
  if (params.titles?.length) body.person_titles = params.titles;
  if (params.industries?.length) body.organization_industry_tag_ids = params.industries;
  if (params.companySizeMin) body.organization_num_employees_ranges = [`${params.companySizeMin},${params.companySizeMax ?? 10000}`];
  if (params.domains?.length) body.q_organization_domains = params.domains.join("\n");

  const res = await fetch("https://api.apollo.io/api/v1/mixed_people/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Apollo API error ${res.status}: ${text}`);
  }

  const data = await res.json() as { people?: Record<string, unknown>[] };
  return (data.people ?? []).map((p) => ({
    firstName: (p.first_name as string) ?? "",
    lastName: (p.last_name as string) ?? "",
    email: (p.email as string) ?? undefined,
    emailStatus: mapApolloEmailStatus(p.email_status as string),
    title: (p.title as string) ?? undefined,
    company: (p.organization?.name as string) ?? undefined,
    linkedinUrl: (p.linkedin_url as string) ?? undefined,
    phone: (p.sanitized_phone as string) ?? undefined,
  }));
}

function mapApolloEmailStatus(status: string): Lead["emailStatus"] {
  if (status === "verified") return "valid";
  if (status === "invalid" || status === "bounced") return "invalid";
  return "unverified";
}

// ── Hunter.io ─────────────────────────────────

export async function findEmailHunter(
  domain: string,
  firstName: string,
  lastName: string
): Promise<{ email: string; confidence: number } | null> {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) throw new Error("HUNTER_API_KEY not set");

  const url = new URL("https://api.hunter.io/v2/email-finder");
  url.searchParams.set("domain", domain);
  url.searchParams.set("first_name", firstName);
  url.searchParams.set("last_name", lastName);
  url.searchParams.set("api_key", apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) return null;

  const data = await res.json() as { data?: { email?: string; score?: number } };
  const email = data.data?.email;
  const confidence = data.data?.score ?? 0;
  if (!email) return null;
  return { email, confidence };
}

export async function verifyEmailHunter(email: string): Promise<"valid" | "invalid" | "unknown"> {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) throw new Error("HUNTER_API_KEY not set");

  const url = new URL("https://api.hunter.io/v2/email-verifier");
  url.searchParams.set("email", email);
  url.searchParams.set("api_key", apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) return "unknown";

  const data = await res.json() as { data?: { status?: string } };
  const status = data.data?.status;
  if (status === "valid") return "valid";
  if (status === "invalid") return "invalid";
  return "unknown";
}

// ── Outreach tracker ──────────────────────────

import { getMemoryDB } from "../memory/sqlite.js";

export function recordOutreach(brandId: string, lead: Lead, channel: string, subject: string, body: string): number {
  const db = getMemoryDB();
  db.run(
    `INSERT INTO marketing_outreach (brand_id, channel, target_name, target_contact, subject, body, status)
     VALUES (?, ?, ?, ?, ?, ?, 'sent')`,
    [brandId, channel, `${lead.firstName} ${lead.lastName}`, lead.email ?? lead.linkedinUrl ?? "", subject, body]
  );
  const rows = db.exec("SELECT last_insert_rowid() as id");
  return Number(rows[0]?.values[0]?.[0] ?? 0);
}
```

- [ ] **Step 2: Build check**

```bash
npm run typecheck 2>&1 | grep -E "error TS|lead-finder"
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/marketing/lead-finder.ts
git commit -m "feat(marketing): Apollo.io + Hunter.io lead finder"
```

---

### Task 3: Brand Audit Orchestrator + Real Tool Implementation

**Files:**
- Create: `src/marketing/brand-audit.ts` (orchestrator — not the tool file)
- Modify: `src/tools/brand-audit.ts` (wire in real implementation)

- [ ] **Step 1: Create `src/marketing/brand-audit.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { LLMClient } from "../llm.js";
import { saveBrandProfile, loadBrandProfile, type BrandProfile, type Platform } from "./brand-profile.js";
import { researchInstagramTrends, scrapeCompetitorPosts } from "./trend-researcher.js";
import { executeTool } from "../tools/index.js";

export interface BrandAuditInput {
  brandId: string;
  website: string;
  socialHandles?: Partial<Record<Platform, string>>;
  competitors?: string[];
  depth?: "quick" | "standard" | "deep";
}

export interface BrandAuditReport {
  brandId: string;
  websiteSummary: string;
  existingSocialSummary: string;
  competitorSummary: string;
  brandVoiceGuide: string;
  contentPillars: string[];
  trendingTopics: string[];
  trendingSounds: string[];
  opportunities: string[];
  warnings: string[];
  auditedAt: string;
}

export async function runBrandAudit(
  input: BrandAuditInput,
  llm: LLMClient
): Promise<BrandAuditReport> {
  const { brandId, website, socialHandles = {}, competitors = [], depth = "standard" } = input;

  // 1. Scrape website
  let websiteText = "";
  try {
    const navResult = await executeTool("browser_navigate", { url: website, mode: "fast" });
    const extractResult = await executeTool("browser_extract", {
      type: "text",
      instructions: "Extract: product description, target audience, unique value proposition, tone of voice, main features",
    });
    websiteText = typeof extractResult === "string" ? extractResult : JSON.stringify(extractResult);
  } catch (err) {
    websiteText = `Website scrape failed: ${(err as Error).message}`;
  }

  // 2. Research competitors
  let competitorSummary = "No competitors provided.";
  if (competitors.length > 0) {
    try {
      const researchResult = await executeTool("deep_research", {
        query: `Competitor analysis for ${competitors.join(", ")} — marketing strategy, content approach, target audience, strengths and weaknesses`,
        profile: depth === "deep" ? "deep" : "standard",
      });
      competitorSummary = typeof researchResult === "string" ? researchResult : JSON.stringify(researchResult);
    } catch (err) {
      competitorSummary = `Competitor research failed: ${(err as Error).message}`;
    }
  }

  // 3. Research social trends for the brand's niche
  const nicheKeywords = deriveNicheKeywords(websiteText);
  let trendingSounds: string[] = [];
  let trendingTopics: string[] = [];
  try {
    const instaTrends = await researchInstagramTrends(nicheKeywords, 30);
    trendingSounds = instaTrends.trendingSounds;
    trendingTopics = instaTrends.trendingHashtags.slice(0, 10);
  } catch {
    // Apify optional — continue without
  }

  // 4. Scrape competitor social profiles
  let existingSocialSummary = "No social handles provided.";
  const igHandle = socialHandles.instagram;
  if (igHandle) {
    try {
      const posts = await scrapeCompetitorPosts(igHandle, 10);
      const engagements = posts.map((p) => p.likesCount + p.commentsCount);
      const avgEng = engagements.length ? Math.round(engagements.reduce((a, b) => a + b, 0) / engagements.length) : 0;
      existingSocialSummary = `Instagram @${igHandle}: ${posts.length} recent posts, avg engagement ${avgEng}. Top hashtags: ${[...new Set(posts.flatMap((p) => p.hashtags))].slice(0, 8).join(", ")}`;
    } catch {
      existingSocialSummary = `Instagram @${igHandle} (scrape unavailable)`;
    }
  }

  // 5. LLM synthesizes brand voice + content pillars + opportunities
  const synthesis = await llm.chat([
    {
      role: "user",
      content: `You are a senior brand strategist. Based on the following data, extract:
1. Brand voice guide (3-5 sentences describing tone, vocabulary, style)
2. 5 content pillars (themes the brand should consistently post about)
3. 3-5 growth opportunities (specific, actionable)
4. 2-3 warnings (things to avoid)

Website analysis: ${websiteText.slice(0, 2000)}
Competitor analysis: ${competitorSummary.slice(0, 1500)}
Social analysis: ${existingSocialSummary}
Trending topics: ${trendingTopics.join(", ")}

Respond with valid JSON only:
{"brandVoiceGuide":"...","contentPillars":["..."],"opportunities":["..."],"warnings":["..."]}`,
    },
  ]);

  let brandVoiceGuide = "";
  let contentPillars: string[] = [];
  let opportunities: string[] = [];
  let warnings: string[] = [];

  try {
    const parsed = JSON.parse(synthesis.content ?? "{}") as {
      brandVoiceGuide?: string;
      contentPillars?: string[];
      opportunities?: string[];
      warnings?: string[];
    };
    brandVoiceGuide = parsed.brandVoiceGuide ?? "";
    contentPillars = parsed.contentPillars ?? [];
    opportunities = parsed.opportunities ?? [];
    warnings = parsed.warnings ?? [];
  } catch {
    brandVoiceGuide = synthesis.content ?? "";
  }

  // 6. Update brand profile in memory with audit findings
  const existing = loadBrandProfile(brandId);
  if (existing) {
    saveBrandProfile({
      ...existing,
      brandVoiceGuide,
      contentPillars,
      auditSummary: opportunities.join("; "),
      updatedAt: new Date().toISOString(),
    });
  }

  return {
    brandId,
    websiteSummary: websiteText.slice(0, 500),
    existingSocialSummary,
    competitorSummary: competitorSummary.slice(0, 800),
    brandVoiceGuide,
    contentPillars,
    trendingTopics,
    trendingSounds,
    opportunities,
    warnings,
    auditedAt: new Date().toISOString(),
  };
}

function deriveNicheKeywords(websiteText: string): string[] {
  // Simple extraction: look for industry keywords in the first 500 chars
  const text = websiteText.slice(0, 500).toLowerCase();
  const known = ["saas", "startup", "ecommerce", "fashion", "fitness", "food", "tech", "ai", "design", "marketing", "education", "health", "finance"];
  const found = known.filter((k) => text.includes(k));
  return found.length ? found.slice(0, 3) : ["business", "startup"];
}
```

- [ ] **Step 2: Inject LLM into brand audit tool + wire real implementation**

First, create a module-scoped LLM holder in `src/tools/brand-audit.ts` and expose a setter:

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ToolDefinition } from "./get-current-time.js";
import type { LLMClient } from "../llm.js";
import { runBrandAudit } from "../marketing/brand-audit.js";
import type { Platform } from "../marketing/brand-profile.js";

let _llm: LLMClient | null = null;
export function setBrandAuditLLM(llm: LLMClient): void { _llm = llm; }

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
    if (!_llm) return JSON.stringify({ error: "Brand audit LLM not initialised — call setBrandAuditLLM at boot" });
    try {
      const report = await runBrandAudit({
        brandId: input.brand_id as string,
        website: input.website as string,
        socialHandles: (input.social_handles as Partial<Record<Platform, string>>) ?? {},
        competitors: (input.competitors as string[]) ?? [],
        depth: (input.depth as "quick" | "standard" | "deep") ?? "standard",
      }, _llm);
      return JSON.stringify(report);
    } catch (err) {
      return JSON.stringify({ error: (err as Error).message });
    }
  },
};
```

- [ ] **Step 3: Wire `setBrandAuditLLM` in `src/index.ts`**

In `src/index.ts`, find where other LLM injections happen (e.g. `setVideoStudioLLMClient(llm)`, `setSwarmLLM(llm)`). Add after them:

```typescript
import { setBrandAuditLLM } from "./tools/brand-audit.js";
// ... in the init sequence after llm is created:
setBrandAuditLLM(llm);
```

- [ ] **Step 4: Export `setBrandAuditLLM` from `src/tools/index.ts`**

```typescript
export { setBrandAuditLLM } from "./brand-audit.js";
```

- [ ] **Step 5: Build check**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -20
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/marketing/brand-audit.ts src/tools/brand-audit.ts src/tools/index.ts src/index.ts
git commit -m "feat(marketing): brand audit orchestrator with website scraping + competitor research + LLM synthesis"
```

---

### Task 4: Self-Review Check

- [ ] **Verify all Plan 2 exports compile cleanly**

```bash
npm run build 2>&1 | grep -E "error|Error" | grep -v "node_modules" | head -20
```

Expected: clean build with no errors.

- [ ] **Verify Apify client is importable**

```bash
node -e "import('apify-client').then(m => console.log('apify-client ok:', typeof m.ApifyClient))"
```

Expected: `apify-client ok: function`

- [ ] **Final commit if any stray changes**

```bash
git status
git add -p  # review and stage only marketing-related changes
git commit -m "chore(marketing): plan 2 cleanup" --allow-empty
```

---

**Plan 2 complete.** Research engine is live: Apify trend scraper (Instagram + TikTok), Apollo.io + Hunter.io lead finder, and brand audit orchestrator. Proceed to Plan 3 (Content Factory).
