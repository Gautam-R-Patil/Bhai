// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Deep Research v2 — Research profiles and constants

import { join } from "node:path";
import { getDocumentsDir } from "../config/paths.js";
import type { ResearchProfile } from "./types.js";

// ── Constants ────────────────────────────────

export const RESEARCH_DIR = join(getDocumentsDir(), "Research");
export const MAX_CONTENT_PER_PAGE = 50000;  // 50KB per page (was 12KB)
export const CONCURRENT_FETCHES = 10;       // was 3
export const ENGINE_COOLDOWN_MS = 15000;
export const ENGINE_MAX_CONSECUTIVE_FAILURES = 3;
export const CITATION_CHAIN_MAX_PER_SOURCE = 5;

export const USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.6943.98 Safari/537.36 Edg/133.0.0.0",
];

// ── Profiles ─────────────────────────────────

export const PROFILES: Record<string, ResearchProfile> = {
    quick: {
        depth: 5,
        maxSources: 20,
        concurrentQueries: 2,
        citationDepth: 0,
        useAcademicEngines: false,
    },
    standard: {
        depth: 20,
        // The report draws on ~110 findings and a page gives several: 150 pages was mostly reading
        // nobody saw (and a model call each). 80 keeps the coverage at about half the calls.
        maxSources: 80,
        concurrentQueries: 4,
        citationDepth: 1,
        useAcademicEngines: false,
    },
    deep: {
        depth: 25,
        maxSources: 200,
        concurrentQueries: 5,
        citationDepth: 2,
        useAcademicEngines: true,
    },
    exhaustive: {
        depth: 50,
        maxSources: 500,
        concurrentQueries: 5,
        citationDepth: 3,
        useAcademicEngines: true,
    },
};

// ── Helpers ──────────────────────────────────

export function randomUA(): string {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

export function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms + Math.random() * ms * 0.3));
}

// ── Adaptive Rate Limiter ────────────────────

export class AdaptiveRateLimiter {
    private delay: number;
    private readonly min = 300;
    private readonly max = 3000;

    constructor(initial = 500) { this.delay = initial; }

    onSuccess(): void { this.delay = Math.max(this.min, this.delay * 0.8); }
    onRateLimit(): void { this.delay = Math.min(this.max, this.delay * 2); }
    async wait(): Promise<void> { await sleep(this.delay); }
    getDelay(): number { return this.delay; }
}
