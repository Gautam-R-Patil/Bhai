// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Browser Backend Abstraction ──────────────
// Provides a unified interface for Playwright and Chrome Extension backends.
// All browser tools call through this layer so the agent can seamlessly
// switch between headless Playwright and the user's real Chrome.

import type { InteractiveElement, TabInfo, ClickOptions, BrowserMode } from "./types.js";
import { isExtensionConnected } from "./chrome-bridge.js";

// ── BrowserBackend Interface ─────────────────

export interface BrowserBackend {
    readonly mode: BrowserMode;

    // ── Navigation ──
    navigate(url: string, opts?: { newTab?: boolean; waitFor?: string; timeout?: number }): Promise<{ title: string; url: string }>;
    goBack(): Promise<void>;
    waitForReady(timeoutMs?: number): Promise<void>;

    // ── Page / Tab Access ──
    getActivePage(): Promise<BrowserPageInfo>;
    getAllTabs(): Promise<TabInfo[]>;
    switchTab(index: number): Promise<void>;
    newTab(url?: string): Promise<void>;
    closeTab(index?: number): Promise<void>;

    // ── Element Scanning ──
    scanElements(forceRefresh?: boolean): Promise<InteractiveElement[]>;

    // ── Interaction ──
    clickAt(x: number, y: number, opts?: ClickOptions): Promise<void>;
    typeText(text: string): Promise<void>;
    pressKey(key: string, modifiers?: string[]): Promise<void>;
    scroll(direction: "up" | "down" | "left" | "right", amount: number, elementSelector?: string): Promise<void>;
    hover(x: number, y: number): Promise<void>;
    selectOption(selector: string, values: string[]): Promise<void>;

    // ── Extraction ──
    executeJS(code: string): Promise<unknown>;
    screenshot(opts?: { quality?: number; fullPage?: boolean }): Promise<Buffer>;
    waitForSelector(selector: string, timeoutMs?: number): Promise<boolean>;

    // ── Playwright-only (returns null for Chrome backend) ──
    getPlaywrightPage(): Promise<unknown | null>;
    getPlaywrightContext(): Promise<unknown | null>;
}

/**
 * Lightweight page info returned by getActivePage()
 */
export interface BrowserPageInfo {
    url: string;
    title: string;
}

// ── Backend Manager ──────────────────────────

let activeBackend: BrowserBackend | null = null;
let preferredMode: "auto" | "playwright" | "chrome" = "auto";
let playwrightBackendFactory: (() => BrowserBackend) | null = null;
let chromeBackendFactory: (() => BrowserBackend) | null = null;

/**
 * Register backend factories. Called at boot by each backend module.
 */
export function registerPlaywrightBackend(factory: () => BrowserBackend): void {
    playwrightBackendFactory = factory;
}

export function registerChromeBackend(factory: () => BrowserBackend): void {
    chromeBackendFactory = factory;
}

/**
 * Set the preferred browser mode.
 * - "auto": Use Chrome extension if connected + context suggests it, else Playwright
 * - "playwright": Always use headless Playwright
 * - "chrome": Always use Chrome extension (fails if not connected)
 */
export function setPreferredMode(mode: "auto" | "playwright" | "chrome"): void {
    preferredMode = mode;
    // Reset active backend so next call resolves fresh
    activeBackend = null;
}

/**
 * Get the currently active backend. Lazily resolves based on preferred mode.
 * In "auto" mode, re-checks extension status every time so switches are instant.
 */
export function getActiveBackend(): BrowserBackend {
    // In "auto" mode, always re-check extension status.
    // This ensures the backend switches when the extension connects/disconnects
    // without needing an explicit call to browser_set_mode.
    if (preferredMode === "auto") {
        const extensionUp = isExtensionConnected();
        const currentIsChrome = activeBackend?.mode === "chrome";

        // Switch to Chrome if extension just connected
        if (extensionUp && !currentIsChrome && chromeBackendFactory) {
            console.log("🔌 Auto-switching to Chrome extension backend");
            activeBackend = createChromeBackend();
        }
        // Switch to Playwright if extension just disconnected
        else if (!extensionUp && currentIsChrome) {
            console.log("🔌 Chrome extension disconnected — auto-switching to Playwright");
            activeBackend = createPlaywrightBackend();
        }
        // First call — resolve fresh
        else if (!activeBackend) {
            activeBackend = extensionUp ? createChromeBackend() : createPlaywrightBackend();
        }

        return activeBackend;
    }

    // In explicit mode (chrome/playwright), cache as before
    if (activeBackend) return activeBackend;
    return resolveBackend();
}

/**
 * Resolve which backend to use, optionally forcing a specific mode.
 */
export function resolveBackend(forceMode?: "playwright" | "chrome"): BrowserBackend {
    const mode = forceMode || preferredMode;

    if (mode === "chrome") {
        if (!isExtensionConnected()) {
            console.warn("⚠️  Chrome extension not connected — falling back to Playwright");
            activeBackend = createPlaywrightBackend();
        } else {
            activeBackend = createChromeBackend();
        }
    } else if (mode === "playwright") {
        activeBackend = createPlaywrightBackend();
    } else {
        // "auto" — use Chrome if connected, otherwise Playwright
        if (isExtensionConnected()) {
            activeBackend = createChromeBackend();
        } else {
            activeBackend = createPlaywrightBackend();
        }
    }

    return activeBackend;
}

/**
 * Get the current browser mode.
 * Resolves the backend if not yet initialized (prevents returning "none").
 */
export function getCurrentMode(): BrowserMode | "none" {
    if (!activeBackend) {
        // Force resolution so we never return "none" when factories are registered
        if (playwrightBackendFactory || chromeBackendFactory) {
            getActiveBackend();
        }
    }
    return activeBackend?.mode || "none";
}

/**
 * Force switch to Playwright (e.g., when extension disconnects mid-task).
 */
export function switchToPlaywright(): void {
    activeBackend = createPlaywrightBackend();
}

/**
 * Force switch to Chrome extension.
 */
export function switchToChromeExtension(): void {
    if (!isExtensionConnected()) {
        throw new Error("Chrome extension not connected");
    }
    activeBackend = createChromeBackend();
}

/**
 * Reset the active backend (forces re-resolution on next call).
 */
export function resetBackend(): void {
    activeBackend = null;
}

// ── Factory helpers ──────────────────────────

function createPlaywrightBackend(): BrowserBackend {
    if (!playwrightBackendFactory) {
        throw new Error("Playwright backend not registered. Call registerPlaywrightBackend() at boot.");
    }
    return playwrightBackendFactory();
}

function createChromeBackend(): BrowserBackend {
    if (!chromeBackendFactory) {
        throw new Error("Chrome backend not registered. Call registerChromeBackend() at boot.");
    }
    return chromeBackendFactory();
}
