// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Boot-speed guard: the Google API clients, Baileys (~0.3s) and @slack/bolt (~0.2s)
// must not load just because their channel/tool modules are imported at boot.
// Each mock factory runs only if something actually imports the package.

import { describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => [] as string[]);
vi.mock("googleapis", () => { loaded.push("googleapis"); return {}; });
vi.mock("@googleapis/gmail", () => { loaded.push("@googleapis/gmail"); return {}; });
vi.mock("@googleapis/calendar", () => { loaded.push("@googleapis/calendar"); return {}; });
vi.mock("@googleapis/tasks", () => { loaded.push("@googleapis/tasks"); return {}; });
vi.mock("@googleapis/oauth2", () => { loaded.push("@googleapis/oauth2"); return {}; });
vi.mock("@googleapis/youtube", () => { loaded.push("@googleapis/youtube"); return {}; });
vi.mock("@whiskeysockets/baileys", () => { loaded.push("baileys"); return {}; });
vi.mock("@slack/bolt", () => { loaded.push("slack-bolt"); return {}; });
vi.mock("imapflow", () => { loaded.push("imapflow"); return {}; });
vi.mock("nodemailer", () => { loaded.push("nodemailer"); return {}; });
vi.mock("apify-client", () => { loaded.push("apify-client"); return {}; });
vi.mock("twitter-api-v2", () => { loaded.push("twitter-api-v2"); return {}; });
vi.mock("pptxgenjs", () => { loaded.push("pptxgenjs"); return {}; });
// Feature-only packages: each loads on first use of its feature, not at boot.
for (const pkg of [
    "discord.js",
    "@google/genai",
    "@supabase/supabase-js",
    "dockerode",
    "express",
    "@modelcontextprotocol/sdk/client/index.js",
    "@modelcontextprotocol/sdk/client/stdio.js",
    "pino",
    "qrcode-terminal",
    "tar",
    "markdown-it",
    "acorn",
    "google-auth-library",
    "sharp",
    "web-push",
    "playwright",
    "playwright-core",
]) {
    vi.doMock(pkg, () => { loaded.push(pkg); return {}; });
}

describe("heavy channel SDKs load lazily", () => {
    it("importing the channel/tool modules does not load their SDKs", async () => {
        // Registry first, as at boot (whatsapp.ts <-> tools/index.ts is circular).
        const { getToolNames } = await import("../index.js");
        await import("../google-api.js");
        const whatsapp = await import("../../whatsapp.js");
        const slack = await import("../../slack.js");
        await import("../../marketing/adapters/youtube.js");
        await import("../../email.js");
        await import("../../marketing/trend-researcher.js");
        await import("../../marketing/adapters/twitter.js");
        await import("../../marketing/outreach-engine.js");
        await import("../presentation/render-pptx.js");
        await import("../../discord.js");
        await import("../../voice/live/backends/gemini-live.js");
        await import("../../memory/supabase.js");
        await import("../../security/sandbox.js");
        await import("../webhook.js");
        await import("../../mcp/client.js");
        await import("../../store/installer.js");
        await import("../../documents/renderers/markdown.js");
        await import("../../forge/critics.js");
        await import("../../skills/site/mint/minter.js");
        await import("../../skills/site/mint/checks.js");
        await import("../presentation/assets.js");
        await import("../../notifications/push.js");
        const { getPlatformCapabilities } = await import("../../utils/platform-capabilities.js");
        // The availability check resolves Playwright without loading it.
        expect((await getPlatformCapabilities()).browser.playwright).toBe(true);

        expect(loaded).toEqual([]);
        // Tools stay registered and status getters work without the SDKs.
        expect(getToolNames()).toEqual(expect.arrayContaining(["gmail", "whatsapp_send"]));
        expect(whatsapp.getWhatsAppStatus()).toBe("disconnected");
        expect(slack.getSlackStatus()).toBe("disabled");
    }, 60_000);
});
