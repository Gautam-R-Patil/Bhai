// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Playwright Passthrough Backend ───────────
// This backend signals "playwright" mode to the backend manager.
// The actual Playwright logic lives in core.ts — getActivePage(),
// getInteractiveElements(), getBrowser() — which is the default
// code path when getCurrentMode() !== "chrome".
//
// This class exists so the backend manager has a concrete object to
// hold for the Playwright mode, matching the BrowserBackend interface.
// Most methods here are empty stubs because the real tool handlers
// call core.ts functions directly (they always have, before this
// abstraction layer existed).

import type { BrowserBackend, BrowserPageInfo } from "./browser-backend.js";
import type { InteractiveElement, TabInfo, ClickOptions } from "./types.js";

export class PlaywrightPassthroughBackend implements BrowserBackend {
    readonly mode = "playwright" as const;

    // ── These methods are NOT called in practice ──
    // The tool handlers in navigation.ts, interaction.ts, extraction.ts
    // call core.ts functions (getBrowser, getActivePage, getInteractiveElements)
    // directly, which check getCurrentMode() and only route to the Chrome
    // backend. For Playwright mode, they execute the original Playwright code.
    //
    // These stubs exist solely to satisfy the BrowserBackend interface contract.

    async navigate(): Promise<{ title: string; url: string }> {
        return { title: "", url: "" };
    }

    async goBack(): Promise<void> {}
    async waitForReady(): Promise<void> {}

    async getActivePage(): Promise<BrowserPageInfo> {
        return { url: "", title: "" };
    }

    async getAllTabs(): Promise<TabInfo[]> {
        return [];
    }

    async switchTab(): Promise<void> {}
    async newTab(): Promise<void> {}
    async closeTab(): Promise<void> {}

    async scanElements(): Promise<InteractiveElement[]> {
        return [];
    }

    async clickAt(): Promise<void> {}
    async typeText(): Promise<void> {}
    async pressKey(): Promise<void> {}
    async scroll(): Promise<void> {}
    async hover(): Promise<void> {}
    async selectOption(): Promise<void> {}

    async executeJS(): Promise<unknown> {
        return null;
    }

    async screenshot(): Promise<Buffer> {
        return Buffer.alloc(0);
    }

    async waitForSelector(): Promise<boolean> {
        return false;
    }

    async getPlaywrightPage(): Promise<unknown | null> {
        // Return the actual Playwright page via core.ts
        const { getActivePage } = await import("./core.js");
        return getActivePage();
    }

    async getPlaywrightContext(): Promise<unknown | null> {
        const { getBrowser } = await import("./core.js");
        return getBrowser();
    }
}
