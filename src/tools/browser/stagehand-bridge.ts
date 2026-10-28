// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Stagehand Self-Healing Browser Bridge ────────
 * Inspired by Stagehand (19K+ GitHub stars).
 * Hybrid automation: AI for unfamiliar pages, cached code for known pages.
 * Three primitives: act, extract, observe.
 * Auto-caching: successful actions cached and replayed without LLM next time.
 * Self-healing: when DOM changes, falls back to AI and updates cache.
 */

import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "../../config/paths.js";
import type { Page } from "./types.js";

// ── Types ─────────────────────────────────────

interface CachedAction {
    urlPattern: string; // Regex pattern matching the URL
    actionDescription: string; // Human-readable description
    selector: string; // CSS/XPath selector used
    actionType: "click" | "type" | "select" | "scroll" | "navigate";
    value?: string; // For type/select actions
    successCount: number;
    failureCount: number;
    lastUsed: number; // Timestamp
}

interface ActionResult {
    success: boolean;
    usedCache: boolean;
    action: string;
    error?: string;
}

// ── State ─────────────────────────────────────

const CACHE_DIR = path.join(getDataDir(), "browser-cache");
let actionCache: Map<string, CachedAction[]> = new Map();
let cacheLoaded = false;

// ── Init ──────────────────────────────────────

function ensureCacheLoaded(): void {
    if (cacheLoaded) return;
    cacheLoaded = true;

    const cachePath = path.join(CACHE_DIR, "action-cache.json");
    if (fs.existsSync(cachePath)) {
        try {
            const data = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
            actionCache = new Map(Object.entries(data));
            console.log(`[STAGEHAND] Loaded ${actionCache.size} cached URL patterns`);
        } catch {
            actionCache = new Map();
        }
    }
}

function saveCache(): void {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const data: Record<string, CachedAction[]> = {};
    for (const [key, actions] of actionCache) {
        data[key] = actions;
    }
    fs.writeFileSync(path.join(CACHE_DIR, "action-cache.json"), JSON.stringify(data, null, 2));
}

// ── Core Primitives ───────────────────────────

/**
 * ACT: Perform an action on the page.
 * First checks cache for a known action. If found and still works, use it (zero LLM cost).
 * If cache miss or stale, falls back to AI-based action selection.
 */
export async function act(
    page: Page,
    actionDescription: string,
    aiSelector?: (
        page: Page,
        description: string,
    ) => Promise<{ selector: string; actionType: string; value?: string } | null>,
): Promise<ActionResult> {
    ensureCacheLoaded();

    const url = await page.url();
    const cacheKey = urlToPattern(url);

    // Check cache
    const cached = findCachedAction(cacheKey, actionDescription);
    if (cached && cached.successCount > cached.failureCount * 2) {
        try {
            await executeAction(page, cached);
            updateCacheSuccess(cacheKey, actionDescription);
            return { success: true, usedCache: true, action: `[CACHED] ${cached.selector}` };
        } catch {
            // Cache stale — self-heal by falling through to AI
            updateCacheFailure(cacheKey, actionDescription);
            console.log(`[STAGEHAND] Cache miss for "${actionDescription}" — self-healing`);
        }
    }

    // AI fallback
    if (aiSelector) {
        try {
            const selection = await aiSelector(page, actionDescription);
            if (selection) {
                const action: CachedAction = {
                    urlPattern: cacheKey,
                    actionDescription,
                    selector: selection.selector,
                    actionType: selection.actionType as CachedAction["actionType"],
                    value: selection.value,
                    successCount: 1,
                    failureCount: 0,
                    lastUsed: Date.now(),
                };

                await executeAction(page, action);

                // Cache the successful action
                addToCache(cacheKey, action);
                return { success: true, usedCache: false, action: `[AI] ${selection.selector}` };
            }
        } catch (err) {
            return { success: false, usedCache: false, action: "AI selection failed", error: (err as Error).message };
        }
    }

    return { success: false, usedCache: false, action: "No selector available" };
}

/**
 * EXTRACT: Extract structured data from the page.
 * Uses cached extraction patterns when available.
 */
export async function extract(
    page: Page,
    description: string,
    fallbackExtractor?: (page: Page, desc: string) => Promise<string>,
): Promise<string> {
    // Try simple extraction first
    try {
        const title = await page.title();
        const url = await page.url();
        const text = await page.evaluate(
            /* javascript-obfuscator:disable */ () => document.body?.innerText?.substring(0, 5000) || "",
            /* javascript-obfuscator:enable */ undefined,
        );

        if (text.length > 100) {
            return `Page: ${title}\nURL: ${url}\n\n${text}`;
        }
    } catch {
        /* */
    }

    // Fallback to AI extraction
    if (fallbackExtractor) {
        return fallbackExtractor(page, description);
    }

    return "";
}

/**
 * OBSERVE: Get a structured snapshot of the current page state.
 * Returns interactive elements, page title, URL, and visible text.
 */
export async function observe(page: Page): Promise<{
    url: string;
    title: string;
    interactiveElements: Array<{ selector: string; text: string; type: string }>;
    visibleText: string;
}> {
    try {
        const [url, title] = await Promise.all([page.url(), page.title()]);

        const elements = await page.evaluate(
            /* javascript-obfuscator:disable */ () => {
                const els: Array<{ selector: string; text: string; type: string }> = [];
                const interactive = document.querySelectorAll(
                    "a, button, input, select, textarea, [role='button'], [onclick], [tabindex]",
                );
                for (const el of Array.from(interactive).slice(0, 50)) {
                    const text =
                        (el as HTMLElement).innerText?.substring(0, 100) || (el as HTMLInputElement).placeholder || "";
                    const tag = el.tagName.toLowerCase();
                    const id = el.id ? `#${el.id}` : "";
                    const cls = el.className ? `.${String(el.className).split(" ")[0]}` : "";
                    els.push({
                        selector: `${tag}${id}${cls}`,
                        text: text.trim(),
                        type: (el as HTMLInputElement).type || tag,
                    });
                }
                return els;
            },
            /* javascript-obfuscator:enable */ undefined,
        );

        const visibleText = await page.evaluate(
            /* javascript-obfuscator:disable */ () => document.body?.innerText?.substring(0, 3000) || "",
            /* javascript-obfuscator:enable */ undefined,
        );

        return { url, title, interactiveElements: elements, visibleText };
    } catch {
        return { url: "", title: "", interactiveElements: [], visibleText: "" };
    }
}

// ── Action Execution ──────────────────────────

async function executeAction(page: Page, action: CachedAction): Promise<void> {
    const element = await page.$(action.selector);
    if (!element) throw new Error(`Element not found: ${action.selector}`);

    switch (action.actionType) {
        case "click":
            await element.click();
            break;
        case "type":
            await element.fill(action.value || "");
            break;
        case "select":
            await page.selectOption(action.selector, action.value || "");
            break;
        case "scroll":
            await page.mouse.wheel(0, 500); // native CDP — no eval ReferenceErrors
            break;
        case "navigate":
            if (action.value) await page.goto(action.value);
            break;
    }
}

// ── Cache Management ──────────────────────────

function urlToPattern(url: string): string {
    try {
        const u = new URL(url);
        return `${u.hostname}${u.pathname.replace(/\/[a-f0-9-]{20,}|\d+/g, "/*")}`;
    } catch {
        return url;
    }
}

function findCachedAction(cacheKey: string, description: string): CachedAction | null {
    const actions = actionCache.get(cacheKey);
    if (!actions) return null;

    const descLower = description.toLowerCase();
    return (
        actions.find(
            (a) =>
                a.actionDescription.toLowerCase() === descLower ||
                descLower.includes(a.actionDescription.toLowerCase()),
        ) || null
    );
}

function addToCache(cacheKey: string, action: CachedAction): void {
    const existing = actionCache.get(cacheKey) || [];
    const idx = existing.findIndex((a) => a.actionDescription === action.actionDescription);
    if (idx >= 0) {
        existing[idx] = action;
    } else {
        existing.push(action);
    }
    actionCache.set(cacheKey, existing);
    saveCache();
}

function updateCacheSuccess(cacheKey: string, description: string): void {
    const actions = actionCache.get(cacheKey);
    const action = actions?.find((a) => a.actionDescription === description);
    if (action) {
        action.successCount++;
        action.lastUsed = Date.now();
        saveCache();
    }
}

function updateCacheFailure(cacheKey: string, description: string): void {
    const actions = actionCache.get(cacheKey);
    const action = actions?.find((a) => a.actionDescription === description);
    if (action) {
        action.failureCount++;
        saveCache();
    }
}

// ── Stats ─────────────────────────────────────

export function getCacheStats(): { totalPatterns: number; totalActions: number; hitRate: number } {
    ensureCacheLoaded();
    let totalActions = 0;
    let totalSuccesses = 0;
    let totalAttempts = 0;

    for (const actions of actionCache.values()) {
        totalActions += actions.length;
        for (const a of actions) {
            totalSuccesses += a.successCount;
            totalAttempts += a.successCount + a.failureCount;
        }
    }

    return {
        totalPatterns: actionCache.size,
        totalActions,
        hitRate: totalAttempts > 0 ? totalSuccesses / totalAttempts : 0,
    };
}
