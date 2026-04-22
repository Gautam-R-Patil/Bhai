# Marketing Credential Setup — Plan 1: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the credential management foundation — read/write .env at runtime, detect missing credentials, stub the credential_setup tool, and update the marketing skill to guide credential acquisition.

**Architecture:** credential-manager.ts writes to .env file and process.env simultaneously (no restart needed). social_post/cold_outreach/brand_audit catch blocks detect missing-credential errors and return action_required hints. The credential_setup tool stub gets registered so the agent can call it.

**Tech Stack:** TypeScript/ESM, Node.js fs (built-in), existing ToolDefinition pattern, existing better-sqlite3/sqlite patterns.

---

### Task 1: Credential Manager

**Files:**
- Create: `src/marketing/credential-manager.ts`

- [ ] **Step 1: Create `src/marketing/credential-manager.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import fs from "node:fs";
import path from "node:path";

// Resolve .env path relative to project root (two levels up from src/marketing/)
const ENV_PATH = path.resolve(process.cwd(), ".env");

// ── ENV KEY MAPPING ───────────────────────────────────────────────────────────

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

// ── CORE READ / WRITE ─────────────────────────────────────────────────────────

/**
 * Read a credential value from process.env.
 * Returns undefined if the key is not set or is an empty string.
 */
export function getCredential(key: string): string | undefined {
  const val = process.env[key];
  return val !== undefined && val !== "" ? val : undefined;
}

/**
 * Set a credential in .env (replacing or appending the KEY=value line)
 * and immediately update process.env so the change takes effect without a restart.
 */
export function setCredential(key: string, value: string): void {
  let contents = "";
  if (fs.existsSync(ENV_PATH)) {
    contents = fs.readFileSync(ENV_PATH, "utf-8");
  }

  const lines = contents.split("\n");
  const escapedValue = value.includes(" ") || value.includes("#") ? `"${value}"` : value;
  const newLine = `${key}=${escapedValue}`;

  // Check if the key already exists (exact or commented-out)
  const existingIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith(`${key}=`) || trimmed.startsWith(`# ${key}=`);
  });

  if (existingIndex !== -1) {
    lines[existingIndex] = newLine;
  } else {
    // Append; ensure there is a trailing newline separator
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
      lines.push("");
    }
    lines.push(newLine);
  }

  fs.writeFileSync(ENV_PATH, lines.join("\n"), "utf-8");
  process.env[key] = value;
}

/**
 * Remove a credential from .env and delete it from process.env.
 * Leaves a comment tombstone so the line position is preserved for clarity.
 */
export function removeCredential(key: string): void {
  if (!fs.existsSync(ENV_PATH)) return;

  const contents = fs.readFileSync(ENV_PATH, "utf-8");
  const lines = contents.split("\n");
  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${key}=`)) {
      return `# ${trimmed} (removed by ATLAS)`;
    }
    return line;
  });
  fs.writeFileSync(ENV_PATH, updated.join("\n"), "utf-8");
  delete process.env[key];
}

// ── VALIDATION ────────────────────────────────────────────────────────────────

/**
 * Make a cheap test API call to verify the credential is valid for the given platform.
 * Returns true if the credential appears valid, false otherwise.
 * For platforms where a live check is not feasible, returns true if the key merely exists.
 */
export async function validateCredential(platform: string, brandId: string): Promise<boolean> {
  const envKey = PLATFORM_ENV_KEYS[platform]?.(brandId);
  if (!envKey) return false;

  const token = getCredential(envKey);
  if (!token) return false;

  try {
    switch (platform) {
      case "instagram": {
        const res = await fetch(
          `https://graph.facebook.com/v19.0/me?fields=id&access_token=${encodeURIComponent(token)}`
        );
        return res.ok;
      }

      case "linkedin": {
        const res = await fetch("https://api.linkedin.com/v2/userinfo", {
          headers: { Authorization: `Bearer ${token}` },
        });
        return res.ok;
      }

      case "tiktok": {
        const res = await fetch(
          "https://open.tiktokapis.com/v2/user/info/?fields=display_name",
          { headers: { Authorization: `Bearer ${token}` } }
        );
        return res.ok;
      }

      case "twitter":
        // Twitter/X API v2 key validation requires a full OAuth flow; just check existence.
        return true;

      case "apify": {
        const res = await fetch(
          `https://api.apify.com/v2/users/me?token=${encodeURIComponent(token)}`
        );
        return res.ok;
      }

      case "apollo":
        // Apollo.io has no cheap unauthenticated ping; existence check is sufficient.
        return true;

      case "reddit":
        // Reddit requires PKCE / code exchange for refresh tokens; existence check is sufficient.
        return true;

      default:
        return false;
    }
  } catch {
    // Network error — treat as invalid rather than crashing the agent.
    return false;
  }
}

// ── MISSING CREDENTIAL DETECTION ─────────────────────────────────────────────

export interface MissingCredential {
  platform: string;
  envKey: string;
  description: string;
}

/**
 * Check which env vars are unset for each platform and return only the missing ones.
 * Call this before starting a content calendar run to surface gaps early.
 */
export function getMissingCredentials(
  platforms: string[],
  brandId: string
): MissingCredential[] {
  const missing: MissingCredential[] = [];

  for (const platform of platforms) {
    const keyFn = PLATFORM_ENV_KEYS[platform];
    if (!keyFn) continue; // unknown platform — skip silently

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
```

- [ ] **Step 2: Verify TypeScript compiles cleanly**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -20
```

Expected: no `error TS` lines for `src/marketing/credential-manager.ts`.

- [ ] **Step 3: Commit Task 1**

```bash
git add src/marketing/credential-manager.ts
git commit -m "feat(marketing): add credential-manager — getCredential/setCredential/removeCredential/validateCredential/getMissingCredentials"
```

---

### Task 2: `credential_setup` Tool Stub

**Files:**
- Create: `src/tools/credential-setup.ts`
- Modify: `src/tools/index.ts` (import + registry)
- Modify: `src/tool-router.ts` (marketing category)

- [ ] **Step 1: Create `src/tools/credential-setup.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { ToolDefinition } from "./get-current-time.js";

export const credentialSetup: ToolDefinition = {
  schema: {
    type: "function",
    function: {
      name: "credential_setup",
      description:
        "Set up API credentials for a social media platform. Call when a platform credential is missing. mode='autonomous' navigates the developer portal automatically; mode='guided' sends step-by-step instructions to the user's active channel.",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["instagram", "linkedin", "tiktok", "twitter", "apify", "apollo", "reddit"],
          },
          brand_id: { type: "string" },
          mode: {
            type: "string",
            enum: ["autonomous", "guided"],
          },
        },
        required: ["platform", "brand_id", "mode"],
      },
    },
  },
  async handler(_input) {
    // Stub — full implementation in Plan 2 (autonomous portal navigation) and Plan 3 (guided flow).
    return JSON.stringify({ status: "stub" });
  },
};
```

- [ ] **Step 2: Import `credentialSetup` in `src/tools/index.ts`**

Locate the existing marketing tool imports (around line 160–164):

```typescript
import { brandAudit } from "./brand-audit.js";
import { coldOutreach } from "./cold-outreach.js";
import { marketingSchedule } from "./marketing-schedule.js";
import { socialPost } from "./social-post.js";
```

Add the new import directly after the `socialPost` import line:

```typescript
import { credentialSetup } from "./credential-setup.js";
```

- [ ] **Step 3: Register `credentialSetup` in the tool registry in `src/tools/index.ts`**

Locate the marketing tools block in the registry (around line 478–482):

```typescript
// Marketing tools
registry.set(socialPost.schema.function.name, socialPost);
registry.set(coldOutreach.schema.function.name, coldOutreach);
registry.set(marketingSchedule.schema.function.name, marketingSchedule);
registry.set(brandAudit.schema.function.name, brandAudit);
```

Add the new registration line immediately after `brandAudit`:

```typescript
registry.set(credentialSetup.schema.function.name, credentialSetup);
```

- [ ] **Step 4: Add `credential_setup` to the `marketing` category in `src/tool-router.ts`**

Locate the `marketing` category tools array (around line 396–412). It currently ends with:

```typescript
            "schedule_task",
        ],
    },
```

Change that closing to add `credential_setup` before the closing bracket:

```typescript
            "schedule_task",
            "credential_setup",
        ],
    },
```

- [ ] **Step 5: Verify TypeScript compiles cleanly**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -20
```

Expected: no `error TS` lines related to the new files or the modified registry/router.

- [ ] **Step 6: Smoke-test the tool is discoverable at runtime**

```bash
node --input-type=module <<'EOF'
import { getToolNames } from "./dist/tools/index.js";
const names = getToolNames();
const found = names.includes("credential_setup");
console.log("credential_setup registered:", found);
EOF
```

Expected: `credential_setup registered: true`

- [ ] **Step 7: Commit Task 2**

```bash
git add src/tools/credential-setup.ts src/tools/index.ts src/tool-router.ts
git commit -m "feat(tools): register credential_setup stub — platform/brand_id/mode schema, marketing category"
```

---

### Task 3: Error Interception + Skill Update

**Files:**
- Modify: `src/tools/social-post.ts` (catch block, lines 113–115)
- Modify: `src/tools/cold-outreach.ts` (catch block, lines 37–39)
- Modify: `src/tools/brand-audit.ts` (catch block, lines 46–48)
- Modify: `skills/marketing.md` (append Credential Setup section before last line)

#### 3a — `src/tools/social-post.ts`

- [ ] **Step 1: Replace the catch block in `social-post.ts`**

The current catch block at lines 113–115 is:

```typescript
    } catch (err) {
      return JSON.stringify({ error: (err as Error).message });
    }
```

Replace it with the credential-aware version. Note that `platform` and `brandId` are already in scope as `const` declarations at lines 40–41:

```typescript
    } catch (err) {
      const msg = (err as Error).message;
      if (
        msg.toLowerCase().includes("credential") ||
        msg.toLowerCase().includes("not set") ||
        msg.toLowerCase().includes("missing")
      ) {
        return JSON.stringify({
          error: msg,
          action_required: "credential_setup",
          hint: `Call credential_setup with platform="${platform}" and brand_id="${brandId}" to set up the missing credentials, then retry social_post.`,
        });
      }
      return JSON.stringify({ error: msg });
    }
```

#### 3b — `src/tools/cold-outreach.ts`

- [ ] **Step 2: Replace the catch block in `cold-outreach.ts`**

The current catch block at lines 37–39 is:

```typescript
    } catch (err) {
      return JSON.stringify({ error: (err as Error).message });
    }
```

The handler already has `brandId` and `channel` in scope (lines 30–31). Replace with:

```typescript
    } catch (err) {
      const msg = (err as Error).message;
      if (
        msg.toLowerCase().includes("credential") ||
        msg.toLowerCase().includes("not set") ||
        msg.toLowerCase().includes("missing")
      ) {
        return JSON.stringify({
          error: msg,
          action_required: "credential_setup",
          hint: `Call credential_setup with platform="${input.channel as string}" and brand_id="${input.brand_id as string}" to set up the missing credentials, then retry cold_outreach.`,
        });
      }
      return JSON.stringify({ error: msg });
    }
```

#### 3c — `src/tools/brand-audit.ts`

- [ ] **Step 3: Replace the catch block in `brand-audit.ts`**

The current catch block at lines 46–48 is:

```typescript
    } catch (err) {
      return JSON.stringify({ error: (err as Error).message });
    }
```

`brand-audit.ts` has no single `platform` variable (it audits multiple platforms). The hint should guide the agent to run `getMissingCredentials`. Replace with:

```typescript
    } catch (err) {
      const msg = (err as Error).message;
      if (
        msg.toLowerCase().includes("credential") ||
        msg.toLowerCase().includes("not set") ||
        msg.toLowerCase().includes("missing")
      ) {
        return JSON.stringify({
          error: msg,
          action_required: "credential_setup",
          hint: `A platform credential is missing for brand "${input.brand_id as string}". Call credential_setup with the appropriate platform and brand_id to set up the missing credentials, then retry brand_audit.`,
        });
      }
      return JSON.stringify({ error: msg });
    }
```

#### 3d — `skills/marketing.md`

- [ ] **Step 4: Append the Credential Setup section to `skills/marketing.md`**

The current last line of `skills/marketing.md` is line 95 (`- \`web_search\` — quick trend and hashtag lookups`). Append the following block after line 95 (before any trailing newline):

```markdown

## Credential Setup

Before running brand_audit, social_post, or cold_outreach for a brand, check if required credentials exist. If a platform credential is missing AND you get an error with `action_required: "credential_setup"`:

1. Ask the user: "Do you want me to set this up for you automatically (I'll open the developer portal and handle it), or would you prefer I walk you through it step by step?"
2. Call `credential_setup` with `mode="autonomous"` or `mode="guided"` accordingly.
3. After successful credential setup, automatically retry the original action — don't ask the user to repeat themselves.

For first-time setup: proactively call `getMissingCredentials` equivalent logic — check which platforms are missing credentials and offer to set them all up before starting the content calendar.

**Minimum to start:**
- `APIFY_TOKEN` — trend research (easiest, start here)
- `IG_ACCESS_TOKEN_{brand}` + `IG_USER_ID_{brand}` — Instagram posting (recommended first platform)
```

- [ ] **Step 5: Verify TypeScript compiles cleanly across all three modified tool files**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -20
```

Expected: no `error TS` lines.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/tools/social-post.ts src/tools/cold-outreach.ts src/tools/brand-audit.ts skills/marketing.md
git commit -m "feat(marketing): credential-aware catch blocks in social_post/cold_outreach/brand_audit + Credential Setup skill section"
```

---

### Final Verification

- [ ] **Full typecheck pass**

```bash
npm run typecheck 2>&1 | grep "error TS" | head -20
```

Expected: zero `error TS` lines.

- [ ] **Confirm all three new/modified files are present**

```bash
ls src/marketing/credential-manager.ts src/tools/credential-setup.ts
grep -n "credential_setup" src/tools/index.ts src/tool-router.ts
grep -n "action_required" src/tools/social-post.ts src/tools/cold-outreach.ts src/tools/brand-audit.ts
grep -n "Credential Setup" skills/marketing.md
```

Expected: all files exist, `credential_setup` appears in both index and router, `action_required` appears in all three catch blocks, `Credential Setup` heading appears in the skill file.

- [ ] **Confirm `credential_setup` is in the marketing category tool list**

```bash
node --input-type=module <<'EOF'
import { CATEGORIES } from "./dist/tool-router.js";
const tools = CATEGORIES.marketing?.tools ?? [];
console.log("credential_setup in marketing:", tools.includes("credential_setup"));
EOF
```

Expected: `credential_setup in marketing: true`
