# Marketing Credential Setup — Plan 2: Platform OAuth Flows

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement per-platform credential acquisition flows (autonomous browser navigation + OAuth callback capture + guided step-by-step fallback) and wire the real credential_setup tool handler.

**Architecture:** Each platform has its own setup module in src/marketing/credential-setup/. A shared oauth-callback.ts handles the callback server pattern. browser-helper.ts tries Chrome extension first then headless. The credential_setup tool handler routes to the right module.

**Prereq:** Plan 1 complete (credential-manager.ts exists, credential_setup stub registered).

**Tech Stack:** Node.js http (built-in), fetch (built-in), existing executeTool pattern, deliverToActiveChannel from channel-send.ts, setCredential from credential-manager.ts.

---

### Task 1: OAuth Callback Server Helper + Browser Helper

**Files:**
- Create: `src/marketing/credential-setup/oauth-callback.ts`
- Create: `src/marketing/credential-setup/browser-helper.ts`

Port assignments:
- LinkedIn: 18842
- TikTok: 18843
- Reddit: 18844
- Instagram: 18845

- [ ] **Step 1: Create `src/marketing/credential-setup/oauth-callback.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── OAuth Callback Server Helper ─────────────────
// Reusable OAuth callback server (same pattern as src/tools/google-api.ts).
// Spins up a local HTTP server on a given port, waits for GET /?code=xxx
// or /?error=xxx, returns the result, and auto-closes. Shared by all
// platform credential-setup modules (LinkedIn, TikTok, Reddit, Instagram).

import { createServer, type Server } from "node:http";

let _activeServer: Server | null = null;

const successHTML = () => `
<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0">
<div style="text-align:center">
  <h1 style="font-size:3em;margin-bottom:0.2em">✅</h1>
  <h2>Authorization Complete!</h2>
  <p style="opacity:0.8">ATLAS captured the authorization code.</p>
  <p style="opacity:0.5;margin-top:2em">You can close this tab now.</p>
  <script>setTimeout(()=>window.close(),3000)</script>
</div></body></html>`;

const errorHTML = (msg: string) => `
<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0">
<div style="text-align:center">
  <h1 style="font-size:3em;margin-bottom:0.2em">❌</h1>
  <h2>Authorization Failed</h2>
  <p style="opacity:0.8">${msg}</p>
  <p style="opacity:0.5;margin-top:2em">You can close this tab.</p>
</div></body></html>`;

/**
 * Spins up a local HTTP server on `port`, waits for GET /?code=xxx or /?error=xxx.
 * Shows success/error HTML (same styled pages as google-api.ts).
 * Returns {code} on success or {error} on failure/timeout.
 * Auto-closes server after receiving the first valid request.
 * @param port       Port to listen on (18842 = LinkedIn, 18843 = TikTok, 18844 = Reddit, 18845 = Instagram)
 * @param timeoutMs  How long to wait before giving up (default 5 min)
 */
export async function startOAuthCallback(
    port: number,
    timeoutMs = 300_000,
): Promise<{ code: string } | { error: string }> {
    // Kill any previously active server (e.g. repeated call without cleanup)
    if (_activeServer) {
        try { _activeServer.close(); } catch { /* ignore */ }
        _activeServer = null;
    }

    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            cleanup();
            resolve({ error: `OAuth timed out after ${Math.round(timeoutMs / 60_000)} minutes.` });
        }, timeoutMs);

        const cleanup = () => {
            clearTimeout(timer);
            if (_activeServer) {
                _activeServer.close();
                _activeServer = null;
            }
        };

        const server = createServer((req, res) => {
            const url = new URL(req.url ?? "/", `http://localhost:${port}`);
            const code  = url.searchParams.get("code");
            const error = url.searchParams.get("error");

            if (error) {
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end(errorHTML(error));
                cleanup();
                resolve({ error: `OAuth denied: ${error}` });
                return;
            }

            if (!code) {
                // Root hit before redirect — show a waiting page; don't close yet
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end(
                    `<html><body style="font-family:system-ui;display:flex;justify-content:center;` +
                    `align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0">` +
                    `<div style="text-align:center"><h2>⏳ Waiting for authorization...</h2></div>` +
                    `</body></html>`,
                );
                return;
            }

            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(successHTML());
            cleanup();
            resolve({ code });
        });

        server.listen(port, () => {
            console.log(`🔐 OAuth callback server listening on http://localhost:${port}/callback`);
        });

        server.on("error", (err: NodeJS.ErrnoException) => {
            console.error(`🔐 OAuth callback server error on port ${port}:`, err.message);
            cleanup();
            resolve({ error: `Failed to start OAuth callback server: ${err.message}` });
        });

        _activeServer = server;
    });
}
```

- [ ] **Step 2: Create `src/marketing/credential-setup/browser-helper.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Browser Helper for Credential Setup ──────────
// Chrome extension first, headless Playwright fallback.
// Pattern mirrors src/marketing/brand-audit.ts::executeTool usage.

import { executeTool } from "../../tools/index.js";

/**
 * Navigate to a URL. Tries Chrome extension mode first; falls back to headless
 * Playwright if the Chrome backend returns an error or is unavailable.
 */
export async function navigateToUrl(url: string): Promise<void> {
    try {
        await executeTool("browser_navigate", { url, mode: "chrome" });
    } catch {
        // Chrome extension not available — fall back to headless
        await executeTool("browser_navigate", { url, mode: "fast" });
    }
}

/**
 * Extract content from the current browser page using natural-language instructions.
 * Returns the raw string result from browser_extract.
 */
export async function extractFromPage(instructions: string): Promise<string> {
    const raw = await executeTool("browser_extract", {
        type: "text",
        instructions,
    });
    if (typeof raw === "string") return raw;
    // browser_extract sometimes returns a JSON object with a text/content field
    if (raw && typeof raw === "object") {
        const r = raw as Record<string, unknown>;
        if (typeof r["text"] === "string") return r["text"];
        if (typeof r["content"] === "string") return r["content"];
        return JSON.stringify(raw);
    }
    return String(raw ?? "");
}
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck 2>&1 | grep -E "credential-setup|oauth-callback|browser-helper" || echo "No new errors"
```

- [ ] **Step 4: Commit**

```bash
git add src/marketing/credential-setup/oauth-callback.ts src/marketing/credential-setup/browser-helper.ts
git commit -m "feat(marketing/creds): OAuth callback server + browser helper"
```

---

### Task 2: Apify + Apollo Setup Modules

**Files:**
- Create: `src/marketing/credential-setup/apify.ts`
- Create: `src/marketing/credential-setup/apollo.ts`

Both are page-extract-and-save flows: navigate to the settings page, extract the key, call setCredential. No OAuth needed.

- [ ] **Step 1: Create `src/marketing/credential-setup/apify.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Apify Credential Setup ────────────────────────
// Navigates to the Apify console integration page and reads the
// Personal API Token autonomously. Falls back to guided instructions.

import { navigateToUrl, extractFromPage } from "./browser-helper.js";
import { setCredential } from "../credential-manager.js";

export async function setupApifyAutonomous(): Promise<{ success: boolean; token?: string; error?: string }> {
    try {
        await navigateToUrl("https://console.apify.com/account/integrations");

        const token = await extractFromPage(
            "Find the Personal API Token value on this page. Return only the token string, nothing else. " +
            "It typically starts with 'apify_api_' and is found in the 'Integrations' or 'API' section.",
        );

        if (!token || token.length < 10) {
            return {
                success: false,
                error: "Could not extract token from page. User may need to log in first.",
            };
        }

        const trimmed = token.trim().split(/\s+/)[0] ?? token.trim();
        await setCredential("APIFY_TOKEN", trimmed);
        return { success: true, token: trimmed };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

export function getApifyGuidedInstructions(): string {
    return [
        "📋 **Apify API Token — Manual Setup**",
        "",
        "1. Go to https://console.apify.com/account/integrations",
        "2. Sign in with your Apify account (or create one at https://apify.com)",
        "3. Scroll to **Personal API Token** section",
        "4. Click **Show** next to the token field",
        "5. Copy the full token (starts with `apify_api_`)",
        "6. Reply with: `set apify token <your-token>`",
        "",
        "_Token is required for web scraping tasks (LinkedIn profiles, company pages, etc.)_",
    ].join("\n");
}
```

- [ ] **Step 2: Create `src/marketing/credential-setup/apollo.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Apollo.io Credential Setup ───────────────────
// Navigates to the Apollo integrations API settings page and reads
// the API Key autonomously. Falls back to guided instructions.

import { navigateToUrl, extractFromPage } from "./browser-helper.js";
import { setCredential } from "../credential-manager.js";

export async function setupApolloAutonomous(): Promise<{ success: boolean; key?: string; error?: string }> {
    try {
        await navigateToUrl("https://app.apollo.io/#/settings/integrations/api");

        const key = await extractFromPage(
            "Find the API Key value on this page. Return only the key string, nothing else. " +
            "It is typically a long alphanumeric string found in the 'API Key' or 'API Access' section.",
        );

        if (!key || key.length < 10) {
            return {
                success: false,
                error: "Could not extract API key from page. User may need to log in first.",
            };
        }

        const trimmed = key.trim().split(/\s+/)[0] ?? key.trim();
        await setCredential("APOLLO_API_KEY", trimmed);
        return { success: true, key: trimmed };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

export function getApolloGuidedInstructions(): string {
    return [
        "📋 **Apollo.io API Key — Manual Setup**",
        "",
        "1. Go to https://app.apollo.io/#/settings/integrations/api",
        "2. Sign in with your Apollo.io account (or create one at https://apollo.io)",
        "3. Find the **API Key** section on the integrations page",
        "4. Click **Copy** to copy the API key",
        "5. Reply with: `set apollo key <your-key>`",
        "",
        "_API key is required for lead enrichment, company data, and contact finding._",
    ].join("\n");
}
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck 2>&1 | grep -E "apify|apollo" || echo "No new errors"
```

- [ ] **Step 4: Commit**

```bash
git add src/marketing/credential-setup/apify.ts src/marketing/credential-setup/apollo.ts
git commit -m "feat(marketing/creds): Apify + Apollo autonomous key extraction"
```

---

### Task 3: Instagram Setup Module

**Files:**
- Create: `src/marketing/credential-setup/instagram.ts`

Instagram uses the Meta Developer Portal. Full headless automation of the token generation wizard is not feasible due to interactive UI elements and CAPTCHA, so this module uses a hybrid: ATLAS opens the portal, sends step-by-step instructions, and waits for the user to paste the tokens back.

- [ ] **Step 1: Create `src/marketing/credential-setup/instagram.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Instagram Credential Setup ───────────────────
// Hybrid guided + browser navigation flow for Meta/Instagram credentials.
// Opens the Meta Developer Portal in the user's browser then walks them
// through creating a Business app and generating a Page Access Token.
// Required permissions: instagram_basic, instagram_content_publish,
// pages_manage_posts, pages_read_engagement.

import { navigateToUrl } from "./browser-helper.js";
import { setCredential, validateCredential } from "../credential-manager.js";
import { deliverToActiveChannel } from "../../tools/channel-send.js";

const CALLBACK_PORT = 18845; // reserved for Instagram (not used for OAuth here)

export async function setupInstagramAutonomous(brandId: string): Promise<{ success: boolean; error?: string }> {
    try {
        // Step 1: Open Meta Developer Portal
        await navigateToUrl("https://developers.facebook.com/apps");

        // Step 2: Guide user through app creation in the portal
        await deliverToActiveChannel(
            [
                "🔧 **Instagram Setup — Step 1 of 3: Create Meta App**",
                "",
                "The Meta Developer Portal is now open in your browser. Please:",
                "1. Click **Create App**",
                `2. Select **Business** as the app type`,
                `3. Name it **ATLAS-${brandId}**`,
                "4. Click **Next** until you reach the app dashboard",
                "5. In the left sidebar, find **Instagram** and click **Set Up**",
                "",
                "Reply **done** when you reach the Instagram Graph API screen.",
            ].join("\n"),
            "",
        );

        // Step 3: Open Graph API Explorer for token generation
        await navigateToUrl("https://developers.facebook.com/tools/explorer/");

        await deliverToActiveChannel(
            [
                "🔧 **Instagram Setup — Step 2 of 3: Generate Access Token**",
                "",
                "In the **Graph API Explorer**:",
                "1. Select your new **ATLAS-" + brandId + "** app from the dropdown",
                "2. Click **Generate Access Token**",
                "3. Grant ALL of these permissions when prompted:",
                "   - `instagram_basic`",
                "   - `instagram_content_publish`",
                "   - `pages_manage_posts`",
                "   - `pages_read_engagement`",
                "4. Copy the generated **Access Token**",
                "5. Also copy your **Instagram User ID** (shown next to the token)",
                "",
                "Reply with your tokens in this format:",
                "`ig token: <access_token>`",
                "`ig user: <instagram_user_id>`",
            ].join("\n"),
            "",
        );

        // Note: actual token receipt happens in the tool handler which receives the next user message.
        // This function returns success to indicate the guidance was delivered.
        return { success: true };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

/**
 * Called by the credential_setup handler when the user pastes their tokens
 * in response to the guided flow above.
 */
export async function saveInstagramCredentials(
    brandId: string,
    accessToken: string,
    userId: string,
): Promise<{ success: boolean; error?: string }> {
    try {
        await setCredential(`INSTAGRAM_ACCESS_TOKEN_${brandId}`, accessToken);
        await setCredential(`INSTAGRAM_USER_ID_${brandId}`, userId);

        const valid = await validateCredential("instagram", brandId);
        if (!valid.valid) {
            return { success: false, error: `Validation failed: ${valid.error}` };
        }
        return { success: true };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

export function getInstagramGuidedInstructions(brandId: string): string {
    return [
        "📋 **Instagram — Step-by-Step Credential Guide**",
        "",
        "**Step 1: Create a Meta Developer App**",
        "1. Go to https://developers.facebook.com/apps",
        "2. Click **Create App** → Select **Business**",
        `3. Name it **ATLAS-${brandId}**`,
        "4. Add the **Instagram Graph API** product in the app dashboard",
        "",
        "**Step 2: Add Instagram Account**",
        "1. Under Instagram Graph API → Roles → Add your Instagram Business/Creator account",
        "2. Make sure your IG account is connected to a Facebook Page",
        "",
        "**Step 3: Generate Access Token**",
        "1. Go to https://developers.facebook.com/tools/explorer/",
        "2. Select your **ATLAS app** from the Application dropdown",
        "3. Click **Generate Access Token**",
        "4. Grant these permissions:",
        "   - `instagram_basic`",
        "   - `instagram_content_publish`",
        "   - `pages_manage_posts`",
        "   - `pages_read_engagement`",
        "5. Copy the **Access Token** and your **Instagram User ID**",
        "",
        "**Step 4: Provide tokens to ATLAS**",
        "Reply with:",
        "`ig token: <your-access-token>`",
        "`ig user: <your-instagram-user-id>`",
        "",
        "_Note: Tokens expire. For long-term use, generate a long-lived token by_",
        "_exchanging the short-lived token at:_",
        "_`https://graph.facebook.com/oauth/access_token?grant_type=fb_exchange_token&...`_",
    ].join("\n");
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck 2>&1 | grep -E "instagram" || echo "No new errors"
```

- [ ] **Step 3: Commit**

```bash
git add src/marketing/credential-setup/instagram.ts
git commit -m "feat(marketing/creds): Instagram guided + browser navigation setup"
```

---
### Task 4: LinkedIn + Reddit OAuth Flows

**Files:**
- Create: `src/marketing/credential-setup/linkedin.ts`
- Create: `src/marketing/credential-setup/reddit.ts`

Both use the full OAuth Authorization Code flow: ATLAS opens the developer portal, the user creates the app and provides client credentials, then ATLAS opens the auth URL and captures the code via the local callback server.

- [ ] **Step 1: Create `src/marketing/credential-setup/linkedin.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── LinkedIn Credential Setup ────────────────────
// Full OAuth Authorization Code flow.
// 1. Opens developers.linkedin.com/apps/new in user's browser
// 2. Guides user through app creation + redirect URI registration
// 3. User pastes Client ID + Client Secret
// 4. ATLAS builds the auth URL and opens it; local callback server captures code
// 5. Code exchanged for access token; token stored
// 6. Optionally stores LinkedIn Org ID for organization posts

import { navigateToUrl } from "./browser-helper.js";
import { startOAuthCallback } from "./oauth-callback.js";
import { setCredential } from "../credential-manager.js";
import { deliverToActiveChannel } from "../../tools/channel-send.js";

const CALLBACK_PORT = 18842;
const REDIRECT_URI  = `http://localhost:${CALLBACK_PORT}/callback`;

export async function setupLinkedInAutonomous(brandId: string): Promise<{ success: boolean; error?: string }> {
    try {
        // Step 1: Open LinkedIn Developer Portal
        await navigateToUrl("https://www.linkedin.com/developers/apps/new");

        // Step 2: Guide app creation
        await deliverToActiveChannel(
            [
                "🔗 **LinkedIn Setup — Step 1 of 4: Create LinkedIn App**",
                "",
                "The LinkedIn Developer Portal is open in your browser. Please:",
                "1. Click **Create App**",
                `2. Name it **ATLAS-${brandId}**`,
                "3. Associate it with your LinkedIn Company Page (required)",
                "4. Fill in a description and upload a logo (optional)",
                "5. Check the box to agree to the terms",
                "6. Click **Create App**",
                "",
                "**After creating the app:**",
                "1. Go to the **Auth** tab",
                "2. Under **OAuth 2.0 Settings → Redirect URLs**, click **Add redirect URL**",
                `3. Add: \`${REDIRECT_URI}\``,
                "4. Click **Update**",
                "",
                "Then copy your **Client ID** and **Client Secret** from the Auth tab.",
                "Reply with:",
                "`li clientid: <your-client-id>`",
                "`li secret: <your-client-secret>`",
            ].join("\n"),
            "",
        );

        // The tool handler waits for the user to provide clientId + clientSecret
        // and then calls continueLinkedInOAuth below.
        return { success: true };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

/**
 * Second phase: called after user provides Client ID + Client Secret.
 * Builds the auth URL, opens it, waits for the callback, exchanges code for token.
 */
export async function continueLinkedInOAuth(
    brandId: string,
    clientId: string,
    clientSecret: string,
): Promise<{ success: boolean; error?: string }> {
    try {
        const scope   = "w_member_social%20w_organization_social";
        const state   = `atlas_${brandId}`;
        const authUrl = [
            "https://www.linkedin.com/oauth/v2/authorization",
            `?response_type=code`,
            `&client_id=${encodeURIComponent(clientId)}`,
            `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
            `&scope=${scope}`,
            `&state=${encodeURIComponent(state)}`,
        ].join("");

        await deliverToActiveChannel(
            [
                "🔗 **LinkedIn Setup — Step 2 of 4: Authorize ATLAS**",
                "",
                "Opening the LinkedIn authorization page in your browser now.",
                "Please log in (if needed) and click **Allow** to grant access.",
                "",
                "ATLAS is waiting for the authorization callback...",
            ].join("\n"),
            "",
        );

        // Open the auth URL in the user's browser and start the callback server simultaneously
        const [callbackResult] = await Promise.all([
            startOAuthCallback(CALLBACK_PORT, 300_000),
            navigateToUrl(authUrl),
        ]);

        if ("error" in callbackResult) {
            return { success: false, error: callbackResult.error };
        }

        const { code } = callbackResult;

        // Exchange code for access token
        const tokenResponse = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type:    "authorization_code",
                code,
                client_id:     clientId,
                client_secret: clientSecret,
                redirect_uri:  REDIRECT_URI,
            }).toString(),
        });

        if (!tokenResponse.ok) {
            const body = await tokenResponse.text();
            return { success: false, error: `Token exchange failed (${tokenResponse.status}): ${body}` };
        }

        const data = await tokenResponse.json() as {
            access_token?: string;
            expires_in?: number;
            error?: string;
            error_description?: string;
        };

        if (!data.access_token) {
            return {
                success: false,
                error: data.error_description ?? data.error ?? "No access_token in response",
            };
        }

        await setCredential(`LI_ACCESS_TOKEN_${brandId}`, data.access_token);

        // Step 3: Optionally store Org ID for organization posting
        await deliverToActiveChannel(
            [
                "✅ **LinkedIn — Token saved!**",
                "",
                "If you want ATLAS to post as your **LinkedIn Organization** (Company Page),",
                "please provide your LinkedIn Organization ID (numeric ID from your company page URL).",
                "Otherwise reply **skip** to continue with personal member posting only.",
                "",
                "Reply with:",
                "`li orgid: <your-org-id>`",
                "or",
                "`li orgid: skip`",
            ].join("\n"),
            "",
        );

        return { success: true };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

/**
 * Save the optional LinkedIn Org ID.
 */
export async function saveLinkedInOrgId(brandId: string, orgId: string): Promise<void> {
    if (orgId && orgId !== "skip") {
        await setCredential(`LI_ORG_ID_${brandId}`, orgId);
    }
}

export function getLinkedInGuidedInstructions(brandId: string): string {
    return [
        "📋 **LinkedIn — Step-by-Step Credential Guide**",
        "",
        "**Step 1: Create LinkedIn Developer App**",
        "1. Go to https://www.linkedin.com/developers/apps/new",
        "2. Sign in with your LinkedIn account",
        `3. App Name: **ATLAS-${brandId}**`,
        "4. Associate with your LinkedIn Company Page",
        "5. Click **Create App**",
        "",
        "**Step 2: Configure OAuth Redirect URI**",
        "1. Go to the **Auth** tab of your new app",
        `2. Under **OAuth 2.0 Settings**, add redirect URL: \`${REDIRECT_URI}\``,
        "3. Click **Update**",
        "",
        "**Step 3: Add OAuth Scopes**",
        "1. Go to the **Products** tab",
        "2. Request access to **Share on LinkedIn** and **Sign In with LinkedIn**",
        "   (these provide the w_member_social scope needed for posting)",
        "",
        "**Step 4: Run Setup**",
        "1. Copy your **Client ID** and **Client Secret** from the Auth tab",
        "2. Tell ATLAS: `setup linkedin <brandId>`",
        "3. Provide the client credentials when prompted",
        "4. Authorize in the browser popup",
        "",
        "_Note: LinkedIn access tokens expire after 60 days. ATLAS will notify you when refresh is needed._",
    ].join("\n");
}
```

- [ ] **Step 2: Create `src/marketing/credential-setup/reddit.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Reddit Credential Setup ──────────────────────
// Full OAuth Authorization Code flow (permanent token with refresh).
// 1. Opens reddit.com/prefs/apps in user's browser
// 2. Guides user through creating a "script" app
// 3. User pastes Client ID (under app name) + Client Secret
// 4. ATLAS builds auth URL, opens it; local callback captures code
// 5. Code exchanged for access_token + refresh_token
// 6. All three credentials stored

import { navigateToUrl } from "./browser-helper.js";
import { startOAuthCallback } from "./oauth-callback.js";
import { setCredential } from "../credential-manager.js";
import { deliverToActiveChannel } from "../../tools/channel-send.js";

const CALLBACK_PORT = 18844;
const REDIRECT_URI  = `http://localhost:${CALLBACK_PORT}/callback`;
const USER_AGENT    = "ATLAS/1.0 (marketing automation)";

export async function setupRedditAutonomous(brandId: string): Promise<{ success: boolean; error?: string }> {
    try {
        // Step 1: Open Reddit Apps prefs
        await navigateToUrl("https://www.reddit.com/prefs/apps");

        // Step 2: Guide app creation
        await deliverToActiveChannel(
            [
                "📱 **Reddit Setup — Step 1 of 3: Create Reddit App**",
                "",
                "The Reddit apps preferences page is open in your browser. Please:",
                "1. Scroll to the bottom and click **create another app...**",
                `2. Name: **ATLAS-${brandId}**`,
                "3. Select **web app** (not script — web app supports Authorization Code flow)",
                "4. Description: `ATLAS marketing automation`",
                `5. **Redirect URI**: \`${REDIRECT_URI}\``,
                "6. Click **create app**",
                "",
                "After creating the app:",
                "- **Client ID** = the string shown just below the app name and 'web app' label",
                "- **Client Secret** = shown next to 'secret'",
                "",
                "Reply with:",
                "`reddit clientid: <client-id>`",
                "`reddit secret: <client-secret>`",
            ].join("\n"),
            "",
        );

        return { success: true };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

/**
 * Second phase: called after user provides Client ID + Client Secret.
 * Builds the auth URL, opens it, waits for callback, exchanges code for tokens.
 */
export async function continueRedditOAuth(
    brandId: string,
    clientId: string,
    clientSecret: string,
): Promise<{ success: boolean; error?: string }> {
    try {
        const scope   = "submit,read,identity";
        const state   = `atlas_${brandId}`;
        const authUrl = [
            "https://www.reddit.com/api/v1/authorize",
            `?client_id=${encodeURIComponent(clientId)}`,
            `&response_type=code`,
            `&state=${encodeURIComponent(state)}`,
            `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
            `&duration=permanent`,
            `&scope=${encodeURIComponent(scope)}`,
        ].join("");

        await deliverToActiveChannel(
            [
                "📱 **Reddit Setup — Step 2 of 3: Authorize ATLAS**",
                "",
                "Opening the Reddit authorization page in your browser now.",
                "Please click **Allow** to grant ATLAS permission to post on Reddit.",
                "",
                "ATLAS is waiting for the authorization callback...",
            ].join("\n"),
            "",
        );

        const [callbackResult] = await Promise.all([
            startOAuthCallback(CALLBACK_PORT, 300_000),
            navigateToUrl(authUrl),
        ]);

        if ("error" in callbackResult) {
            return { success: false, error: callbackResult.error };
        }

        const { code } = callbackResult;

        // Exchange code for access_token + refresh_token using Basic auth
        const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
        const tokenResponse = await fetch("https://www.reddit.com/api/v1/access_token", {
            method: "POST",
            headers: {
                "Authorization": `Basic ${credentials}`,
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent":    USER_AGENT,
            },
            body: new URLSearchParams({
                grant_type:   "authorization_code",
                code,
                redirect_uri: REDIRECT_URI,
            }).toString(),
        });

        if (!tokenResponse.ok) {
            const body = await tokenResponse.text();
            return { success: false, error: `Token exchange failed (${tokenResponse.status}): ${body}` };
        }

        const data = await tokenResponse.json() as {
            access_token?: string;
            refresh_token?: string;
            token_type?: string;
            error?: string;
        };

        if (!data.access_token) {
            return {
                success: false,
                error: data.error ?? "No access_token in Reddit token response",
            };
        }

        await setCredential(`REDDIT_CLIENT_ID_${brandId}`, clientId);
        await setCredential(`REDDIT_CLIENT_SECRET_${brandId}`, clientSecret);
        if (data.access_token) {
            await setCredential(`REDDIT_ACCESS_TOKEN_${brandId}`, data.access_token);
        }
        if (data.refresh_token) {
            await setCredential(`REDDIT_REFRESH_TOKEN_${brandId}`, data.refresh_token);
        }

        await deliverToActiveChannel(
            [
                "✅ **Reddit credentials saved!**",
                "",
                `Client ID, Client Secret, Access Token, and Refresh Token stored for brand \`${brandId}\`.`,
                "ATLAS can now post to Reddit subreddits on your behalf.",
                "The refresh token means re-authorization is not needed unless you revoke app access.",
            ].join("\n"),
            "",
        );

        return { success: true };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

export function getRedditGuidedInstructions(brandId: string): string {
    return [
        "📋 **Reddit — Step-by-Step Credential Guide**",
        "",
        "**Step 1: Create a Reddit App**",
        "1. Go to https://www.reddit.com/prefs/apps",
        "2. Log in with your Reddit account",
        "3. Click **create another app...**",
        `4. Name: **ATLAS-${brandId}**`,
        "5. Type: **web app**",
        `6. Redirect URI: \`${REDIRECT_URI}\``,
        "7. Click **create app**",
        "",
        "**Step 2: Get Credentials**",
        "- **Client ID**: the 14-character string under the app name",
        "- **Client Secret**: shown next to 'secret'",
        "",
        "**Step 3: Run Setup**",
        "Tell ATLAS: `setup reddit " + brandId + "`",
        "Provide client ID and secret when prompted",
        "Authorize in the browser popup",
        "",
        "_Reddit refresh tokens are permanent until revoked. No re-auth needed._",
    ].join("\n");
}
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck 2>&1 | grep -E "linkedin|reddit" || echo "No new errors"
```

- [ ] **Step 4: Commit**

```bash
git add src/marketing/credential-setup/linkedin.ts src/marketing/credential-setup/reddit.ts
git commit -m "feat(marketing/creds): LinkedIn + Reddit OAuth authorization code flows"
```

---
### Task 5: TikTok + Twitter (Guided-Only) + Wire Real credential_setup Handler

**Files:**
- Create: `src/marketing/credential-setup/tiktok.ts`
- Create: `src/marketing/credential-setup/twitter.ts`
- Modify: `src/tools/credential-setup.ts` (replace stub with real handler)

TikTok requires app audit (1-3 days after submission) so posts are private until approved. Twitter blocks headless app creation with CAPTCHA, so it is guided-only.

- [ ] **Step 1: Create `src/marketing/credential-setup/tiktok.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── TikTok Credential Setup ──────────────────────
// Partial autonomous + guided flow.
// TikTok requires app audit before posts go public (1-3 business days).
// Until audit is approved, posts are saved as "private" in sandbox mode.
// OAuth flow:
// 1. Opens TikTok developers portal in browser
// 2. Guides user through app creation
// 3. User provides Client Key + Client Secret
// 4. ATLAS opens auth URL; local callback captures code
// 5. Code exchanged for access_token + open_id
// 6. User notified about audit requirement

import { navigateToUrl } from "./browser-helper.js";
import { startOAuthCallback } from "./oauth-callback.js";
import { setCredential } from "../credential-manager.js";
import { deliverToActiveChannel } from "../../tools/channel-send.js";

const CALLBACK_PORT = 18843;
const REDIRECT_URI  = `http://localhost:${CALLBACK_PORT}/callback`;

export async function setupTikTokAutonomous(brandId: string): Promise<{ success: boolean; error?: string }> {
    try {
        // Step 1: Open TikTok Developer Portal
        await navigateToUrl("https://developers.tiktok.com/apps");

        // Step 2: Guide app creation
        await deliverToActiveChannel(
            [
                "🎵 **TikTok Setup — Step 1 of 3: Create TikTok App**",
                "",
                "The TikTok Developer Portal is open in your browser. Please:",
                "1. Click **Create an App**",
                `2. App Name: **ATLAS-${brandId}**`,
                "3. Select **Web** as the platform",
                "4. In the **Login Kit** section, add redirect URI:",
                `   \`${REDIRECT_URI}\``,
                "5. Complete all required fields and submit for review",
                "",
                "**⚠️ Important:** TikTok requires a review (1-3 business days) before your",
                "app goes live. Until then, posts will be saved as **private drafts**.",
                "",
                "After creating the app, copy your **Client Key** and **Client Secret**.",
                "Reply with:",
                "`tiktok clientkey: <client-key>`",
                "`tiktok secret: <client-secret>`",
            ].join("\n"),
            "",
        );

        return { success: true };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

/**
 * Second phase: called after user provides Client Key + Client Secret.
 * Builds the auth URL, opens it, waits for callback, exchanges code for tokens.
 */
export async function continueTikTokOAuth(
    brandId: string,
    clientKey: string,
    clientSecret: string,
): Promise<{ success: boolean; error?: string }> {
    try {
        const state   = `atlas_${brandId}`;
        const authUrl = [
            "https://www.tiktok.com/v2/auth/authorize",
            `?client_key=${encodeURIComponent(clientKey)}`,
            `&scope=video.publish,video.upload,user.info.basic`,
            `&response_type=code`,
            `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
            `&state=${encodeURIComponent(state)}`,
        ].join("");

        await deliverToActiveChannel(
            [
                "🎵 **TikTok Setup — Step 2 of 3: Authorize ATLAS**",
                "",
                "Opening the TikTok authorization page in your browser now.",
                "Please log in with your TikTok account and click **Authorize**.",
                "",
                "ATLAS is waiting for the authorization callback...",
            ].join("\n"),
            "",
        );

        const [callbackResult] = await Promise.all([
            startOAuthCallback(CALLBACK_PORT, 300_000),
            navigateToUrl(authUrl),
        ]);

        if ("error" in callbackResult) {
            return { success: false, error: callbackResult.error };
        }

        const { code } = callbackResult;

        // Exchange code for access token using TikTok's v2 token endpoint
        const tokenResponse = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_key:    clientKey,
                client_secret: clientSecret,
                code,
                grant_type:    "authorization_code",
                redirect_uri:  REDIRECT_URI,
            }).toString(),
        });

        if (!tokenResponse.ok) {
            const body = await tokenResponse.text();
            return { success: false, error: `Token exchange failed (${tokenResponse.status}): ${body}` };
        }

        const data = await tokenResponse.json() as {
            data?: {
                access_token?: string;
                open_id?: string;
                refresh_token?: string;
                expires_in?: number;
            };
            error?: { code?: string; message?: string; log_id?: string };
        };

        if (data.error?.code && data.error.code !== "ok") {
            return { success: false, error: `TikTok error: ${data.error.message ?? data.error.code}` };
        }

        const token  = data.data?.access_token;
        const openId = data.data?.open_id;

        if (!token) {
            return { success: false, error: "No access_token in TikTok token response" };
        }

        await setCredential(`TIKTOK_CLIENT_KEY_${brandId}`, clientKey);
        await setCredential(`TIKTOK_CLIENT_SECRET_${brandId}`, clientSecret);
        await setCredential(`TIKTOK_ACCESS_TOKEN_${brandId}`, token);
        if (openId) await setCredential(`TIKTOK_OPEN_ID_${brandId}`, openId);
        if (data.data?.refresh_token) {
            await setCredential(`TIKTOK_REFRESH_TOKEN_${brandId}`, data.data.refresh_token);
        }

        await deliverToActiveChannel(
            [
                "✅ **TikTok credentials saved!**",
                "",
                `Access token and Open ID stored for brand \`${brandId}\`.`,
                "",
                "⚠️ **Reminder:** Your TikTok app is under review (1-3 business days).",
                "Until review is approved, all posts will be **private drafts**.",
                "ATLAS will automatically switch to public posting once your app is approved.",
                "Check status at: https://developers.tiktok.com/apps",
            ].join("\n"),
            "",
        );

        return { success: true };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

export function getTikTokGuidedInstructions(brandId: string): string {
    return [
        "📋 **TikTok — Step-by-Step Credential Guide**",
        "",
        "**Step 1: Create TikTok Developer App**",
        "1. Go to https://developers.tiktok.com/apps",
        "2. Sign in (or create a developer account)",
        "3. Click **Create an App**",
        `4. Name: **ATLAS-${brandId}** | Platform: **Web**`,
        `5. Add redirect URI: \`${REDIRECT_URI}\``,
        "6. Enable scopes: **video.publish**, **video.upload**, **user.info.basic**",
        "7. Submit for review (takes 1-3 business days)",
        "",
        "**Step 2: Get Credentials**",
        "- **Client Key**: shown on the app's basic settings page",
        "- **Client Secret**: shown next to Client Key",
        "",
        "**Step 3: Run Setup**",
        "Tell ATLAS: `setup tiktok " + brandId + "`",
        "",
        "**⚠️ Audit Note:** Posts are private until the TikTok app review is approved.",
        "_TikTok access tokens expire in 24 hours; refresh tokens valid for 365 days._",
    ].join("\n");
}
```

- [ ] **Step 2: Create `src/marketing/credential-setup/twitter.ts`**

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Twitter (X) Credential Setup ─────────────────
// Guided-only flow. Twitter blocks headless/automated app creation
// with CAPTCHA and phone verification requirements.
// ATLAS opens the developer portal, walks the user through all steps,
// and collects the four required credentials (OAuth 1.0a):
//   - API Key (Consumer Key)
//   - API Secret (Consumer Secret)
//   - Access Token
//   - Access Token Secret

import { navigateToUrl } from "./browser-helper.js";
import { setCredential } from "../credential-manager.js";
import { deliverToActiveChannel } from "../../tools/channel-send.js";

export async function setupTwitterGuided(brandId: string): Promise<{ success: boolean; error?: string }> {
    try {
        // Open the Twitter Developer Portal in the user's browser
        await navigateToUrl("https://developer.twitter.com/en/portal/projects-and-apps");

        await deliverToActiveChannel(
            [
                "🐦 **Twitter (X) Setup — Step 1 of 3: Create Developer App**",
                "",
                "The Twitter Developer Portal is open in your browser. Please:",
                "1. Sign in with the Twitter account that owns the brand",
                "2. If you don't have a developer account, apply at:",
                "   https://developer.twitter.com/en/portal/petition/essential/basic-info",
                "   (Instant approval for Essential access — no review needed)",
                "3. Once in the portal, click **Create Project**",
                `4. Project Name: **ATLAS-${brandId}**`,
                "5. Select **Making a bot** as the use case",
                "6. Create an **App** within the project",
                `7. App Name: **ATLAS-${brandId}-app**",
                "",
                "After app creation, you will see a **Keys and Tokens** screen.",
                "**Save all four values before clicking Done:**",
                "- API Key",
                "- API Key Secret",
                "- Access Token",
                "- Access Token Secret",
                "",
                "Reply with all four:",
                "`twitter apikey: <api-key>`",
                "`twitter apisecret: <api-key-secret>`",
                "`twitter token: <access-token>`",
                "`twitter tokensecret: <access-token-secret>`",
            ].join("\n"),
            "",
        );

        return { success: true };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

/**
 * Called after user provides all four credentials.
 */
export async function saveTwitterCredentials(
    brandId: string,
    apiKey: string,
    apiSecret: string,
    accessToken: string,
    accessTokenSecret: string,
): Promise<{ success: boolean; error?: string }> {
    try {
        await setCredential(`TWITTER_API_KEY_${brandId}`, apiKey);
        await setCredential(`TWITTER_API_SECRET_${brandId}`, apiSecret);
        await setCredential(`TWITTER_ACCESS_TOKEN_${brandId}`, accessToken);
        await setCredential(`TWITTER_ACCESS_TOKEN_SECRET_${brandId}`, accessTokenSecret);

        await deliverToActiveChannel(
            [
                "✅ **Twitter credentials saved!**",
                "",
                `All four Twitter credentials stored for brand \`${brandId}\`.`,
                "ATLAS can now post tweets, reply, and quote-tweet on your behalf.",
                "",
                "**Tip:** Make sure your app has **Read and Write** permissions enabled.",
                "Check at: https://developer.twitter.com/en/portal/projects-and-apps",
                "→ Select your app → Settings → User authentication settings",
            ].join("\n"),
            "",
        );

        return { success: true };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

export function getTwitterGuidedInstructions(brandId: string): string {
    return [
        "📋 **Twitter (X) — Step-by-Step Credential Guide**",
        "",
        "**Step 1: Create Developer Account**",
        "1. Go to https://developer.twitter.com/en/portal/petition/essential/basic-info",
        "2. Apply for Essential access (instant approval)",
        "",
        "**Step 2: Create a Project and App**",
        "1. In the portal, click **Create Project**",
        `2. Name: **ATLAS-${brandId}**`,
        "3. Use case: **Making a bot**",
        "4. Create an App within the project",
        "",
        "**Step 3: Enable Write Permissions**",
        "1. Go to your App settings",
        "2. Under **User authentication settings**, click **Set up**",
        "3. App permissions: **Read and Write**",
        "4. Type of App: **Web App, Automated App or Bot**",
        `5. Callback URI: \`http://localhost:18842/callback\` (not used for OAuth 1.0a, any valid URL works)`,
        "",
        "**Step 4: Get Keys and Tokens**",
        "1. Go to **Keys and Tokens** tab",
        "2. Under **Consumer Keys**: copy **API Key** and **API Key Secret**",
        "3. Under **Authentication Tokens**: generate and copy **Access Token** and **Access Token Secret**",
        "   (Make sure it says 'Created with Read and Write permissions')",
        "",
        "**Step 5: Provide to ATLAS**",
        "Reply with all four credentials (see format above).",
        "",
        "_Twitter's API free tier allows 1,500 tweet writes/month. Paid tiers allow more._",
    ].join("\n");
}
```

- [ ] **Step 3: Create `src/tools/credential-setup.ts`** (replace stub with real handler)

This replaces the stub created in Plan 1. The handler imports all platform modules and routes based on `platform` + `mode` parameters.

```typescript
// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── credential_setup Tool Handler ────────────────
// Routes credential acquisition requests to the appropriate platform
// setup module. Each platform has two modes:
//   "auto"   — Browser navigation + OAuth callback (where possible)
//   "guided" — Step-by-step instructions delivered to the user's channel
//
// Platform routing:
//   apify    → apify.ts   (auto only — no OAuth needed)
//   apollo   → apollo.ts  (auto only — no OAuth needed)
//   instagram → instagram.ts (hybrid: browser open + user pastes tokens)
//   linkedin  → linkedin.ts  (full OAuth: auto-open + callback capture)
//   reddit    → reddit.ts    (full OAuth: auto-open + callback capture)
//   tiktok    → tiktok.ts    (OAuth: auto-open + callback; private until audit)
//   twitter   → twitter.ts   (guided-only: CAPTCHA prevents headless creation)

import type { ToolDefinition } from "./get-current-time.js";
import { deliverToActiveChannel } from "./channel-send.js";

import { setupApifyAutonomous, getApifyGuidedInstructions } from "../marketing/credential-setup/apify.js";
import { setupApolloAutonomous, getApolloGuidedInstructions } from "../marketing/credential-setup/apollo.js";
import {
    setupInstagramAutonomous,
    saveInstagramCredentials,
    getInstagramGuidedInstructions,
} from "../marketing/credential-setup/instagram.js";
import {
    setupLinkedInAutonomous,
    continueLinkedInOAuth,
    saveLinkedInOrgId,
    getLinkedInGuidedInstructions,
} from "../marketing/credential-setup/linkedin.js";
import {
    setupRedditAutonomous,
    continueRedditOAuth,
    getRedditGuidedInstructions,
} from "../marketing/credential-setup/reddit.js";
import {
    setupTikTokAutonomous,
    continueTikTokOAuth,
    getTikTokGuidedInstructions,
} from "../marketing/credential-setup/tiktok.js";
import {
    setupTwitterGuided,
    saveTwitterCredentials,
    getTwitterGuidedInstructions,
} from "../marketing/credential-setup/twitter.js";

// ── Types ──────────────────────────────────────────

type Platform = "apify" | "apollo" | "instagram" | "linkedin" | "reddit" | "tiktok" | "twitter";
type Mode     = "auto" | "guided";

export interface CredentialSetupInput {
    platform:  Platform;
    brandId:   string;
    mode?:     Mode;
    // Optional — for multi-step flows where the user provides credentials in a follow-up call
    clientId?:          string;
    clientSecret?:      string;
    clientKey?:         string;         // TikTok uses clientKey, not clientId
    accessToken?:       string;
    accessTokenSecret?: string;
    apiKey?:            string;
    apiSecret?:         string;
    orgId?:             string;
    userId?:            string;
}

export interface CredentialSetupResult {
    success:   boolean;
    keysSet?:  string[];
    message?:  string;
    error?:    string;
    nextStep?: string;
}

// ── Tool Definition ────────────────────────────────

export const credentialSetupToolDef: ToolDefinition = {
    name: "credential_setup",
    description:
        "Set up API credentials for a marketing platform. Supports autonomous browser " +
        "navigation (auto mode) and step-by-step guided instructions (guided mode). " +
        "For multi-step OAuth flows, call this tool again with the credentials the user provides.",
    input_schema: {
        type: "object" as const,
        properties: {
            platform: {
                type: "string",
                enum: ["apify", "apollo", "instagram", "linkedin", "reddit", "tiktok", "twitter"],
                description: "The marketing platform to set up credentials for.",
            },
            brandId: {
                type: "string",
                description: "Brand identifier used to namespace per-brand credentials.",
            },
            mode: {
                type: "string",
                enum: ["auto", "guided"],
                description:
                    "auto: navigate browser + capture OAuth callback automatically. " +
                    "guided: deliver step-by-step instructions to the user. Defaults to 'auto'.",
            },
            clientId: {
                type: "string",
                description: "OAuth Client ID (LinkedIn, Reddit). Provided by user in follow-up.",
            },
            clientSecret: {
                type: "string",
                description: "OAuth Client Secret (LinkedIn, Reddit, TikTok). Provided by user.",
            },
            clientKey: {
                type: "string",
                description: "TikTok Client Key (equivalent to clientId for TikTok).",
            },
            accessToken: {
                type: "string",
                description: "Access token for Instagram or Twitter.",
            },
            accessTokenSecret: {
                type: "string",
                description: "Access token secret for Twitter OAuth 1.0a.",
            },
            apiKey: {
                type: "string",
                description: "API Key for Twitter (Consumer Key).",
            },
            apiSecret: {
                type: "string",
                description: "API Secret for Twitter (Consumer Secret).",
            },
            orgId: {
                type: "string",
                description: "LinkedIn Organization ID for company page posting (optional).",
            },
            userId: {
                type: "string",
                description: "Instagram User ID (provided by user in follow-up).",
            },
        },
        required: ["platform", "brandId"],
    },
};

// ── Handler ────────────────────────────────────────

export async function handleCredentialSetup(input: CredentialSetupInput): Promise<CredentialSetupResult> {
    const { platform, brandId, mode = "auto" } = input;

    try {
        // ── Guided-only platforms ──────────────────

        if (platform === "twitter") {
            if (input.apiKey && input.apiSecret && input.accessToken && input.accessTokenSecret) {
                // Follow-up call with all four credentials
                const result = await saveTwitterCredentials(
                    brandId,
                    input.apiKey,
                    input.apiSecret,
                    input.accessToken,
                    input.accessTokenSecret,
                );
                return result.success
                    ? {
                        success: true,
                        keysSet: [
                            `TWITTER_API_KEY_${brandId}`,
                            `TWITTER_API_SECRET_${brandId}`,
                            `TWITTER_ACCESS_TOKEN_${brandId}`,
                            `TWITTER_ACCESS_TOKEN_SECRET_${brandId}`,
                        ],
                        message: "Twitter credentials saved successfully.",
                      }
                    : { success: false, error: result.error, nextStep: "Verify credentials and try again." };
            }
            if (mode === "guided") {
                const instructions = getTwitterGuidedInstructions(brandId);
                await deliverToActiveChannel(instructions, "");
                return { success: true, message: "Twitter setup instructions delivered." };
            }
            // auto mode falls through to guided for Twitter (CAPTCHA)
            const result = await setupTwitterGuided(brandId);
            return result.success
                ? { success: true, message: "Twitter setup guidance delivered. Awaiting credentials." }
                : {
                    success: false,
                    error: result.error,
                    nextStep: `Try guided mode: credential_setup({ platform: 'twitter', brandId: '${brandId}', mode: 'guided' })`,
                  };
        }

        // ── Mode: guided ──────────────────────────

        if (mode === "guided") {
            let instructions: string;
            switch (platform) {
                case "apify":     instructions = getApifyGuidedInstructions(); break;
                case "apollo":    instructions = getApolloGuidedInstructions(); break;
                case "instagram": instructions = getInstagramGuidedInstructions(brandId); break;
                case "linkedin":  instructions = getLinkedInGuidedInstructions(brandId); break;
                case "reddit":    instructions = getRedditGuidedInstructions(brandId); break;
                case "tiktok":    instructions = getTikTokGuidedInstructions(brandId); break;
                default:          instructions = `No guided instructions available for platform: ${platform}`;
            }
            await deliverToActiveChannel(instructions, "");
            return { success: true, message: `${platform} setup instructions delivered.` };
        }

        // ── Mode: auto ────────────────────────────

        switch (platform) {
            // Simple extract flows
            case "apify": {
                const r = await setupApifyAutonomous();
                return r.success
                    ? { success: true, keysSet: ["APIFY_TOKEN"], message: "Apify token saved." }
                    : {
                        success: false,
                        error: r.error,
                        nextStep: `If not logged in, try guided mode or visit https://console.apify.com/account/integrations`,
                      };
            }

            case "apollo": {
                const r = await setupApolloAutonomous();
                return r.success
                    ? { success: true, keysSet: ["APOLLO_API_KEY"], message: "Apollo API key saved." }
                    : {
                        success: false,
                        error: r.error,
                        nextStep: `If not logged in, try guided mode or visit https://app.apollo.io/#/settings/integrations/api`,
                      };
            }

            // Hybrid: browser open + user provides tokens
            case "instagram": {
                if (input.accessToken && input.userId) {
                    // Follow-up: user provided tokens
                    const r = await saveInstagramCredentials(brandId, input.accessToken, input.userId);
                    return r.success
                        ? {
                            success: true,
                            keysSet: [`INSTAGRAM_ACCESS_TOKEN_${brandId}`, `INSTAGRAM_USER_ID_${brandId}`],
                            message: "Instagram credentials saved and validated.",
                          }
                        : { success: false, error: r.error, nextStep: "Check token permissions and try again." };
                }
                const r = await setupInstagramAutonomous(brandId);
                return r.success
                    ? {
                        success: true,
                        message: "Instagram setup guidance delivered. Awaiting access token and user ID.",
                      }
                    : { success: false, error: r.error, nextStep: `Try guided mode for Instagram.` };
            }

            // Full OAuth flows (two-phase)
            case "linkedin": {
                if (input.clientId && input.clientSecret) {
                    // Phase 2: user provided client credentials, proceed with OAuth
                    if (input.orgId !== undefined) {
                        // Phase 3: save optional org ID
                        await saveLinkedInOrgId(brandId, input.orgId);
                        return {
                            success: true,
                            keysSet: input.orgId !== "skip" ? [`LI_ORG_ID_${brandId}`] : [],
                            message: `LinkedIn org ID ${input.orgId === "skip" ? "skipped" : "saved"}.`,
                        };
                    }
                    const r = await continueLinkedInOAuth(brandId, input.clientId, input.clientSecret);
                    return r.success
                        ? {
                            success: true,
                            keysSet: [`LI_ACCESS_TOKEN_${brandId}`],
                            message: "LinkedIn access token saved. Awaiting org ID (reply 'skip' to omit).",
                          }
                        : {
                            success: false,
                            error: r.error,
                            nextStep: `Check that redirect URI http://localhost:18842/callback is registered in your LinkedIn app.`,
                          };
                }
                // Phase 1: open developer portal, guide app creation
                const r = await setupLinkedInAutonomous(brandId);
                return r.success
                    ? {
                        success: true,
                        message: "LinkedIn setup guidance delivered. Awaiting Client ID and Client Secret.",
                      }
                    : { success: false, error: r.error, nextStep: `Try guided mode for LinkedIn.` };
            }

            case "reddit": {
                if (input.clientId && input.clientSecret) {
                    const r = await continueRedditOAuth(brandId, input.clientId, input.clientSecret);
                    return r.success
                        ? {
                            success: true,
                            keysSet: [
                                `REDDIT_CLIENT_ID_${brandId}`,
                                `REDDIT_CLIENT_SECRET_${brandId}`,
                                `REDDIT_ACCESS_TOKEN_${brandId}`,
                                `REDDIT_REFRESH_TOKEN_${brandId}`,
                            ],
                            message: "Reddit credentials saved.",
                          }
                        : {
                            success: false,
                            error: r.error,
                            nextStep: `Check that redirect URI http://localhost:18844/callback is in your Reddit app settings.`,
                          };
                }
                const r = await setupRedditAutonomous(brandId);
                return r.success
                    ? {
                        success: true,
                        message: "Reddit setup guidance delivered. Awaiting Client ID and Client Secret.",
                      }
                    : { success: false, error: r.error, nextStep: `Try guided mode for Reddit.` };
            }

            case "tiktok": {
                const key    = input.clientKey ?? input.clientId;
                const secret = input.clientSecret;
                if (key && secret) {
                    const r = await continueTikTokOAuth(brandId, key, secret);
                    return r.success
                        ? {
                            success: true,
                            keysSet: [
                                `TIKTOK_CLIENT_KEY_${brandId}`,
                                `TIKTOK_CLIENT_SECRET_${brandId}`,
                                `TIKTOK_ACCESS_TOKEN_${brandId}`,
                                `TIKTOK_OPEN_ID_${brandId}`,
                                `TIKTOK_REFRESH_TOKEN_${brandId}`,
                            ],
                            message: "TikTok credentials saved. Note: posts are private until app audit is approved.",
                          }
                        : {
                            success: false,
                            error: r.error,
                            nextStep: `Check that redirect URI http://localhost:18843/callback is registered in your TikTok app.`,
                          };
                }
                const r = await setupTikTokAutonomous(brandId);
                return r.success
                    ? {
                        success: true,
                        message: "TikTok setup guidance delivered. Awaiting Client Key and Client Secret.",
                      }
                    : { success: false, error: r.error, nextStep: `Try guided mode for TikTok.` };
            }

            default:
                return {
                    success: false,
                    error: `Unknown platform: ${platform as string}`,
                    nextStep: "Supported platforms: apify, apollo, instagram, linkedin, reddit, tiktok, twitter",
                };
        }
    } catch (err) {
        const errorMsg = (err as Error).message;
        return {
            success: false,
            error: errorMsg,
            nextStep: `Try guided mode: credential_setup({ platform: '${platform}', brandId: '${brandId}', mode: 'guided' })`,
        };
    }
}
```

- [ ] **Step 4: Typecheck all new files**

```bash
npm run typecheck 2>&1 | grep -E "credential-setup|tiktok|twitter|marketing" || echo "No new errors"
```

- [ ] **Step 5: Commit**

```bash
git add \
  src/marketing/credential-setup/tiktok.ts \
  src/marketing/credential-setup/twitter.ts \
  src/tools/credential-setup.ts
git commit -m "feat(marketing/creds): TikTok OAuth + Twitter guided + wire real credential_setup handler"
```

---

### Final Integration Check

- [ ] **Verify all modules resolve** — ensure credential-manager.ts import path is correct for the credential-setup sub-modules (relative: `../credential-manager.js`)
- [ ] **Verify tool registration** — credential_setup tool must be in the `marketing` category in `src/tool-router.ts`; confirm `src/tools/index.ts` exports `handleCredentialSetup` and `credentialSetupToolDef`
- [ ] **Smoke test guided mode** — run `npm run dev`, ask ATLAS: `setup linkedin credentials for brand test123 (guided mode)` — verify instructions are delivered to the active channel
- [ ] **Run full typecheck**

```bash
npm run typecheck 2>&1 | tail -20
```

- [ ] **Final commit**

```bash
git add -A
git commit -m "feat(marketing/creds): Plan 2 complete — all platform credential flows + tool handler"
```

---

## Summary

| Platform  | Mode        | OAuth?    | Callback Port | Key Names stored                                                             |
|-----------|-------------|-----------|---------------|------------------------------------------------------------------------------|
| Apify     | Auto        | No        | —             | `APIFY_TOKEN`                                                                |
| Apollo    | Auto        | No        | —             | `APOLLO_API_KEY`                                                             |
| Instagram | Hybrid      | No (PAT)  | (18845 resv.) | `INSTAGRAM_ACCESS_TOKEN_{brandId}`, `INSTAGRAM_USER_ID_{brandId}`           |
| LinkedIn  | Auto+OAuth  | Yes       | 18842         | `LI_ACCESS_TOKEN_{brandId}`, `LI_ORG_ID_{brandId}` (optional)              |
| Reddit    | Auto+OAuth  | Yes       | 18844         | `REDDIT_CLIENT_ID/SECRET/ACCESS_TOKEN/REFRESH_TOKEN_{brandId}`              |
| TikTok    | Auto+OAuth  | Yes       | 18843         | `TIKTOK_CLIENT_KEY/SECRET/ACCESS_TOKEN/OPEN_ID/REFRESH_TOKEN_{brandId}`     |
| Twitter   | Guided-only | No (1.0a) | —             | `TWITTER_API_KEY/SECRET/ACCESS_TOKEN/ACCESS_TOKEN_SECRET_{brandId}`         |

All flows are two-phase for OAuth platforms: first call opens the developer portal and delivers guidance, second call (with client credentials) executes the OAuth handshake. The `handleCredentialSetup` function detects which phase it is in based on the presence of `clientId`/`clientSecret` fields in the input.
