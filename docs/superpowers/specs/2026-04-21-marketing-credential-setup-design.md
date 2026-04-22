# Marketing Credential Setup System — Design Spec
**Date:** 2026-04-21  
**Status:** Approved for implementation

---

## 1. Overview

When ATLAS runs a marketing action and a required credential is missing, instead of throwing an error it pauses, explains what it needs, and either (A) walks the user through getting it step-by-step or (B) navigates to the developer portal autonomously and captures the token — then immediately retries the original action.

Users can also proactively say "set up Instagram for me" and ATLAS handles the full setup flow.

---

## 2. Architecture

```
social_post / cold_outreach / brand_audit (any marketing tool)
    │
    └──► adapter throws "credential not set"
              │
              ▼
    credential_setup tool (new ToolDefinition)
              │
         ┌────┴────┐
         │         │
    guided mode  autonomous mode
    (instructions)  (browser automation)
              │
              ▼
    credential-manager.ts
      setCredential(key, value)
      → writes .env file
      → sets process.env[key] immediately
              │
              ▼
    retry original action
```

**New files:**
```
src/marketing/credential-manager.ts
src/marketing/credential-setup/instagram.ts
src/marketing/credential-setup/linkedin.ts
src/marketing/credential-setup/tiktok.ts
src/marketing/credential-setup/twitter.ts
src/marketing/credential-setup/apify.ts
src/marketing/credential-setup/apollo.ts
src/marketing/credential-setup/reddit.ts
src/tools/credential-setup.ts          (ToolDefinition)
```

**Modified files:**
```
src/marketing/brand-profile.ts          (resolveCredential uses credential-manager)
src/tools/social-post.ts                (catch missing-credential errors, call credential_setup)
src/tools/index.ts                      (register credential_setup tool)
src/tool-router.ts                      (add to marketing category)
skills/marketing.md                     (add credential setup instructions)
```

---

## 3. Credential Manager

**`src/marketing/credential-manager.ts`**

```typescript
getCredential(key: string): string | undefined
setCredential(key: string, value: string): void   // writes .env + sets process.env
removeCredential(key: string): void
validateCredential(platform: Platform, brandId: string): Promise<boolean>
getMissingCredentials(platforms: Platform[], brandId: string): MissingCredential[]
```

`setCredential` flow:
1. Read existing `.env` file (or create if absent)
2. Replace existing `KEY=value` line or append a new one
3. Set `process.env[key] = value` immediately — no restart needed
4. Store key name in `brand_profile.credentialKeys` for tracking

`getMissingCredentials` returns a list of `{ platform, envKey, description }` for every env var that is currently unset.

`validateCredential` makes a cheap test call per platform:
- Instagram: `GET /me?fields=id&access_token=...`
- LinkedIn: `GET /v2/userinfo` with Bearer header
- TikTok: `GET /v2/user/info/` with Bearer header
- Twitter: client.v2.me()
- Apify: `GET /v2/users/me?token=...`
- Apollo: `POST /api/v1/auth/health`
- Reddit: `GET /api/v1/me` via snoowrap

---

## 4. Per-Platform Setup Flows

### 4.1 Instagram (Meta Graph API)

**Autonomous flow:**
1. `browser_navigate` → `https://developers.facebook.com/apps` (Chrome ext first, headless fallback)
2. Click "Create App" → select "Business" type → fill app name: `ATLAS-{brandSlug}`
3. Add "Instagram" product → "Set up" → copy Instagram User ID
4. Navigate to Access Token tool → generate a Page Access Token
5. Make token long-lived via `GET /oauth/access_token?grant_type=fb_exchange_token&...`
6. Extract and call `setCredential("IG_USER_ID_{brandId}", userId)` and `setCredential("IG_ACCESS_TOKEN_{brandId}", token)`

**Guided fallback (if autonomous fails):**
Send to user's active channel:
> "To connect Instagram, I need your Meta Page Access Token. Here's how to get it:
> 1. Go to developers.facebook.com/apps → Create App → Business
> 2. Add Instagram product → Set Up
> 3. Go to Tools → Graph API Explorer → Generate User Token
> 4. Click 'Generate Access Token' with permissions: instagram_basic, instagram_content_publish, pages_manage_posts
> 5. Paste the token here"

### 4.2 LinkedIn

**Autonomous flow:**
1. `browser_navigate` → `https://www.linkedin.com/developers/apps/new`
2. Fill app name, LinkedIn Page, logo, agree terms → Create
3. On Products tab, request "Share on LinkedIn" + "Marketing Developer Platform"
4. On Auth tab, add redirect URI `http://localhost:18842/callback`
5. Copy Client ID and Client Secret
6. Start local OAuth callback server on port 18842
7. Open OAuth URL → user clicks Allow in their Chrome
8. Callback captures `code` → exchange for access token
9. `setCredential("LI_ACCESS_TOKEN_{brandId}", token)` and optionally `LI_ORG_ID_{brandId}`

### 4.3 TikTok

**Autonomous flow:**
1. `browser_navigate` → `https://developers.tiktok.com/apps`
2. Create app → fill details → submit (trigger audit request — notify user this takes 1-3 days)
3. Copy Client Key and Client Secret
4. Start OAuth callback server on port 18843
5. Open TikTok OAuth URL → user clicks Allow
6. Exchange code for access token
7. `setCredential("TIKTOK_ACCESS_TOKEN_{brandId}", token)`

**Note:** App audit is required for public posts. Until audit passes, posts go to drafts. Inform user of this limitation.

### 4.4 Twitter/X

Twitter has aggressive CAPTCHA on app creation — fully guided mode only.

**Guided flow:**
Send step-by-step with `browser_navigate` to open the right pages:
1. Open `https://developer.twitter.com/en/portal/projects-and-apps` (ATLAS opens this)
2. Click "Add App" → fill details → get `API Key` and `API Secret`
3. Go to app Settings → User authentication settings → enable OAuth 1.0a
4. Go to Keys and Tokens → generate Access Token and Secret
5. Paste all 4 values (ATLAS extracts them via guided prompts)

### 4.5 Apify

**Autonomous flow:**
1. `browser_navigate` → `https://console.apify.com/account/integrations`
2. `browser_extract` to find the Personal API Token
3. `setCredential("APIFY_TOKEN", token)`

Simplest flow — user just needs to be logged in.

### 4.6 Apollo.io

**Autonomous flow:**
1. `browser_navigate` → `https://app.apollo.io/#/settings/integrations/api`
2. `browser_extract` to find the API Key
3. `setCredential("APOLLO_API_KEY", key)`

### 4.7 Reddit

**Autonomous flow:**
1. `browser_navigate` → `https://www.reddit.com/prefs/apps`
2. Click "are you a developer? create an app"
3. Fill: name=`ATLAS-{brandSlug}`, type=`script`, redirect=`http://localhost:18844/callback`
4. Click Create app → extract `client_id` (shown under app name) and `client_secret`
5. Start OAuth callback server on port 18844
6. Open Reddit OAuth URL → user clicks Allow
7. Exchange for refresh token
8. `setCredential("REDDIT_CLIENT_ID_{brandId}", clientId)` etc.

---

## 5. `credential_setup` Tool

**`src/tools/credential-setup.ts`** — new `ToolDefinition`:

```typescript
{
  name: "credential_setup",
  description: "Set up API credentials for a social media platform. Use when a platform credential is missing before posting or auditing. mode='autonomous' navigates the developer portal automatically; mode='guided' sends step-by-step instructions to the user.",
  parameters: {
    platform: "instagram"|"linkedin"|"tiktok"|"twitter"|"apify"|"apollo"|"reddit",
    brand_id: string,
    mode: "autonomous" | "guided",
  }
}
```

Handler:
1. Checks if credential already exists (`getCredential`) — returns success immediately if so
2. If `mode === "autonomous"`: calls the platform-specific setup module
3. If `mode === "guided"`: calls the platform's `getGuidedInstructions()` function and delivers to active channel
4. After successful autonomous setup: calls `validateCredential` to confirm it works
5. Returns `{ success: true, platform, keysSet: string[] }` or `{ success: false, error, nextStep }`

---

## 6. Error Interception in `social_post`

In `src/tools/social-post.ts`, the existing try/catch around each adapter call is extended:

```typescript
catch (err) {
  const msg = (err as Error).message;
  if (msg.includes("credentials not set") || msg.includes("credential") || msg.includes("not set")) {
    return JSON.stringify({
      error: msg,
      action_required: "credential_setup",
      hint: `Call credential_setup with platform="${platform}" and brand_id="${brandId}" to set up the missing credentials, then retry social_post.`
    });
  }
  return JSON.stringify({ error: msg });
}
```

The agent sees the `action_required` field and knows to call `credential_setup` automatically.

---

## 7. Skill File Update (`skills/marketing.md`)

New section added after "Approval Handling":

```markdown
## Credential Setup

Before running brand_audit, social_post, or cold_outreach for a brand, check if the required
credentials exist. If a platform credential is missing:

1. Ask the user: "Do you want me to set this up for you automatically (I'll open the developer
   portal and handle it), or walk you through it step by step?"
2. Call `credential_setup` with mode="autonomous" or mode="guided" accordingly.
3. After successful setup, automatically retry the original action — don't ask the user to repeat themselves.

For first-time marketing setup, proactively check which platforms are missing credentials
and offer to set them all up in one go before starting the content calendar.

**Minimum credentials to start:**
- `APIFY_TOKEN` — needed for trend research (easiest to get, start here)
- At least one platform token (Instagram recommended for most brands)
```

---

## 8. Browser Mode Selection

Both Chrome Extension mode and headless Playwright mode must be tried in order:

```typescript
// In each credential-setup module:
async function navigateToPortal(url: string): Promise<void> {
  // Try Chrome extension first (user already logged in)
  try {
    await executeTool("browser_navigate", { url, mode: "chrome" });
    return;
  } catch { /* chrome extension not connected */ }
  
  // Fall back to headless Playwright
  await executeTool("browser_navigate", { url, mode: "fast" });
}
```

---

## 9. OAuth Callback Server

Reuse the same pattern as `src/tools/google-api.ts::startOAuthCallbackServer()`:
- Spin up a temporary Express server on a specific port per platform
- Platform redirects back after user consent
- Server captures `?code=...`, exchanges for token, shuts down
- Max wait: 5 minutes, then timeout with clear error message

Port assignments:
- LinkedIn: 18842
- TikTok: 18843
- Reddit: 18844
- Instagram: 18845 (for token exchange flows)

---

## 10. Out of Scope

- Facebook Ads / Google Ads credential setup (Phase 2)
- Credential rotation / token refresh automation (tokens are long-lived enough for now)
- Multi-user credential vaults (single-user ATLAS only)
