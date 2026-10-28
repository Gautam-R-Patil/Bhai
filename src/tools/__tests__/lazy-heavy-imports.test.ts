// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Boot-speed guard: googleapis (~0.6-1s), Baileys (~0.3s) and @slack/bolt (~0.2s)
// must not load just because their channel/tool modules are imported at boot.
// Each mock factory runs only if something actually imports the package.

import { describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => [] as string[]);
vi.mock("googleapis", () => { loaded.push("googleapis"); return {}; });
vi.mock("@whiskeysockets/baileys", () => { loaded.push("baileys"); return {}; });
vi.mock("@slack/bolt", () => { loaded.push("slack-bolt"); return {}; });

describe("heavy channel SDKs load lazily", () => {
    it("importing the channel/tool modules does not load their SDKs", async () => {
        // Registry first, as at boot (whatsapp.ts <-> tools/index.ts is circular).
        const { getToolNames } = await import("../index.js");
        await import("../google-api.js");
        const whatsapp = await import("../../whatsapp.js");
        const slack = await import("../../slack.js");
        await import("../../marketing/adapters/youtube.js");

        expect(loaded).toEqual([]);
        // Tools stay registered and status getters work without the SDKs.
        expect(getToolNames()).toEqual(expect.arrayContaining(["gmail", "whatsapp_send"]));
        expect(whatsapp.getWhatsAppStatus()).toBe("disconnected");
        expect(slack.getSlackStatus()).toBe("disabled");
    }, 60_000);
});
