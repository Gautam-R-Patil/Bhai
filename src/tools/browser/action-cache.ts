// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Browser Action Cache with Self-Healing ──────
// Caches successful browser action sequences keyed by URL pattern.
// On revisit, replays cached actions (skipping LLM analysis) for major cost savings.
// Self-healing: if a replay fails, the cache entry is degraded and eventually purged,
// forcing the agent back to LLM-based page analysis.

import fs from "node:fs";
import path from "node:path";
import type { Page } from "./types.js";

// ── Types ────────────────────────────────────

export interface CachedActionStep {
    selector: string;   // CSS selector or atlas label ref (e.g. "[data-atlas-id='...']")
    action: string;     // "click" | "type" | "select" | "scroll" | "hover" | "press_key"
    value?: string;     // Text to type, option to select, key to press, etc.
}

export interface CachedAction {
    url: string;        // URL pattern: domain + pathname (no query params / hash)
    actions: CachedActionStep[];
    lastUsed: number;   // epoch ms
    successCount: number;
    failCount: number;
    createdAt: number;  // epoch ms
}

interface ActionCacheStore {
    version: number;
    entries: CachedAction[];
}

// ── Constants ────────────────────────────────

const STORE_PATH = path.join(
    process.env.ATLAS_DATA_DIR || path.resolve("data"),
    "browser-action-cache.json"
);
const MAX_ENTRIES = 200;
const FAIL_THRESHOLD = 3;          // Delete entry after this many consecutive failures
const MIN_SUCCESS_RATE = 0.70;     // 70% success rate required to attempt replay
const STALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let store: ActionCacheStore = { version: 1, entries: [] };

// ── Persistence ──────────────────────────────

export function initActionCache(): void {
    try {
        if (fs.existsSync(STORE_PATH)) {
            const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
            if (raw && Array.isArray(raw.entries)) {
                store = raw as ActionCacheStore;
            }
            // Prune stale entries on load
            pruneStaleEntries();
            console.log(`  🗂️ Action cache loaded: ${store.entries.length} cached action sequences`);
        }
    } catch {
        store = { version: 1, entries: [] };
    }
}

function saveStore(): void {
    try {
        const dir = path.dirname(STORE_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
    } catch {
        // Non-fatal — cache is an optimization, not critical
    }
}

function pruneStaleEntries(): void {
    const now = Date.now();
    const before = store.entries.length;
    store.entries = store.entries.filter(e => {
        // Remove entries older than STALE_MS with low success
        if (now - e.lastUsed > STALE_MS && getSuccessRate(e) < MIN_SUCCESS_RATE) return false;
        // Remove entries that have exceeded the fail threshold
        if (e.failCount >= FAIL_THRESHOLD) return false;
        return true;
    });
    if (store.entries.length < before) {
        saveStore();
    }
}

// ── URL Pattern Normalization ────────────────

/**
 * Normalize a URL to domain + pathname (strip query params, hash, trailing slash).
 * This groups cache entries by "what page it is" rather than exact URL state.
 */
function normalizeUrl(rawUrl: string): string {
    try {
        const parsed = new URL(rawUrl);
        // Strip query params and hash — same page structure regardless of ?query=foo
        let pathname = parsed.pathname;
        // Remove trailing slash for consistency (except root)
        if (pathname.length > 1 && pathname.endsWith("/")) {
            pathname = pathname.slice(0, -1);
        }
        return `${parsed.hostname}${pathname}`;
    } catch {
        return rawUrl;
    }
}

// ── Helper ───────────────────────────────────

function getSuccessRate(entry: CachedAction): number {
    const total = entry.successCount + entry.failCount;
    if (total === 0) return 0;
    return entry.successCount / total;
}

// ── Public API ───────────────────────────────

/**
 * Look up cached actions for a URL pattern.
 * Returns null if no cache entry exists.
 */
export function getCachedActions(url: string): CachedAction | null {
    const pattern = normalizeUrl(url);
    const entry = store.entries.find(e => e.url === pattern);
    if (!entry) return null;

    // Don't return entries that have exceeded the fail threshold
    if (entry.failCount >= FAIL_THRESHOLD) return null;

    return entry;
}

/**
 * Check if cached actions should be attempted (success rate > 70%).
 */
export function shouldReplayActions(cached: CachedAction): boolean {
    return getSuccessRate(cached) >= MIN_SUCCESS_RATE;
}

/**
 * Save a successful action sequence for a URL.
 * If an entry already exists for this URL pattern, it is updated.
 */
export function cacheActions(url: string, actions: CachedActionStep[]): void {
    if (!actions || actions.length === 0) return;

    const pattern = normalizeUrl(url);
    const now = Date.now();

    const existing = store.entries.find(e => e.url === pattern);
    if (existing) {
        existing.actions = actions;
        existing.lastUsed = now;
        existing.successCount++;
        // Successful cache update partially heals previous failures
        if (existing.failCount > 0) existing.failCount = Math.max(0, existing.failCount - 1);
    } else {
        store.entries.push({
            url: pattern,
            actions,
            lastUsed: now,
            successCount: 1,
            failCount: 0,
            createdAt: now,
        });
    }

    // Bound the store size — evict least-recently-used entries
    if (store.entries.length > MAX_ENTRIES) {
        store.entries.sort((a, b) => b.lastUsed - a.lastUsed);
        store.entries = store.entries.slice(0, MAX_ENTRIES);
    }

    saveStore();
}

/**
 * Mark a cached action sequence as failed.
 * If failCount exceeds threshold, the entry is deleted (self-healing).
 * This forces the agent back to LLM-based analysis on the next visit.
 */
export function markActionFailed(url: string): void {
    const pattern = normalizeUrl(url);
    const entry = store.entries.find(e => e.url === pattern);
    if (!entry) return;

    entry.failCount++;

    // Self-healing: if failures exceed threshold, purge the entry entirely
    if (entry.failCount >= FAIL_THRESHOLD) {
        store.entries = store.entries.filter(e => e.url !== pattern);
        console.log(`  🔄 [action-cache] Purged stale cache for ${pattern} (${FAIL_THRESHOLD}+ failures — self-healing)`);
    }

    saveStore();
}

/**
 * Attempt to replay cached actions on a page.
 * Returns true if ALL actions succeeded, false if any step failed.
 *
 * On failure, automatically calls markActionFailed so the self-healing
 * counter increments — callers should fall back to LLM-based analysis.
 */
export async function replayActions(page: Page, cached: CachedAction): Promise<boolean> {
    const url = typeof page.url === "function" ? page.url() : "";

    for (const step of cached.actions) {
        try {
            switch (step.action) {
                case "click": {
                    const el = await page.$(step.selector);
                    if (!el) {
                        console.log(`  ⚠️ [action-cache] Replay failed: selector "${step.selector}" not found`);
                        markActionFailed(url || cached.url);
                        return false;
                    }
                    await el.click();
                    // Brief wait for page to react
                    await page.waitForTimeout(300).catch(() => {});
                    break;
                }

                case "type": {
                    const el = await page.$(step.selector);
                    if (!el) {
                        markActionFailed(url || cached.url);
                        return false;
                    }
                    // Clear existing text before typing
                    await el.click({ clickCount: 3 }).catch(() => {});
                    await el.type(step.value || "");
                    await page.waitForTimeout(200).catch(() => {});
                    break;
                }

                case "select": {
                    await page.selectOption(step.selector, step.value || "");
                    await page.waitForTimeout(200).catch(() => {});
                    break;
                }

                case "scroll": {
                    const amount = parseInt(step.value || "300", 10);
                    await page.mouse.wheel(0, amount); // native CDP — no eval ReferenceErrors
                    await page.waitForTimeout(200).catch(() => {});
                    break;
                }

                case "hover": {
                    const el = await page.$(step.selector);
                    if (!el) {
                        markActionFailed(url || cached.url);
                        return false;
                    }
                    await el.hover();
                    await page.waitForTimeout(200).catch(() => {});
                    break;
                }

                case "press_key": {
                    await page.keyboard.press(step.value || "Enter");
                    await page.waitForTimeout(200).catch(() => {});
                    break;
                }

                default: {
                    // Unknown action type — skip gracefully
                    console.log(`  ⚠️ [action-cache] Unknown action type "${step.action}", skipping`);
                    break;
                }
            }
        } catch (err) {
            console.log(`  ⚠️ [action-cache] Replay step failed: ${step.action} on "${step.selector}" — ${(err as Error).message}`);
            markActionFailed(url || cached.url);
            return false;
        }
    }

    // All steps succeeded — update the cache entry
    const pattern = normalizeUrl(url || cached.url);
    const entry = store.entries.find(e => e.url === pattern);
    if (entry) {
        entry.lastUsed = Date.now();
        entry.successCount++;
        saveStore();
    }

    console.log(`  ✅ [action-cache] Replayed ${cached.actions.length} cached actions successfully`);
    return true;
}

/**
 * Get stats about the action cache (for diagnostics).
 */
export function getActionCacheStats(): { total: number; healthyCount: number; degradedCount: number } {
    const healthy = store.entries.filter(e => getSuccessRate(e) >= MIN_SUCCESS_RATE);
    const degraded = store.entries.filter(e => getSuccessRate(e) < MIN_SUCCESS_RATE && e.failCount < FAIL_THRESHOLD);
    return {
        total: store.entries.length,
        healthyCount: healthy.length,
        degradedCount: degraded.length,
    };
}
