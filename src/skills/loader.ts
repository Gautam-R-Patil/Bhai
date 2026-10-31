// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Skills are stored server-side and injected by the LLM proxy.
// This module only caches lightweight metadata (slug + categories)
// for the tool-router to decide which skill slugs to request per-turn.
// No skill instructions are stored or accessible on the client.

import { getConvexSiteUrl } from "../config/keys.js";
import { getSessionToken, handleAuthError } from "../session.js";
import { encryptedFetch } from "../crypto-transport.js";

// ── Types ─────────────────────────────────────

export interface SkillMetadata {
    slug: string;
    name: string;
    description: string;
    categories: string[];
    source: "system" | "store" | "auto";
    permissions?: string[]; // e.g. ["filesystem", "network", "shell"]
    riskLevel?: "low" | "medium" | "high" | "critical";
}

// ── State ─────────────────────────────────────

let cachedMetadata: SkillMetadata[] = [];

// ── Init: Fetch skill metadata from server ────

export async function initSkillMetadata(): Promise<void> {
    try {
        const convexUrl = getConvexSiteUrl();
        let token = await getSessionToken();
        if (!token) {
            console.warn("⚠️  No session token — skipping skill metadata fetch");
            return;
        }

        let response = await encryptedFetch(`${convexUrl}/api/system/skill-metadata`, {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${token}`,
            },
        });

        // Handle auth expiry
        if (response.status === 401) {
            token = await handleAuthError();
            if (!token) {
                console.warn("⚠️  Auth failed — skipping skill metadata fetch");
                return;
            }
            response = await encryptedFetch(`${convexUrl}/api/system/skill-metadata`, {
                method: "GET",
                headers: {
                    "Authorization": `Bearer ${token}`,
                },
            });
        }

        if (!response.ok) {
            console.warn(`⚠️  Skill metadata fetch failed: HTTP ${response.status}`);
            return;
        }

        const data = await response.json() as { skills: SkillMetadata[] };
        cachedMetadata = data.skills || [];
        const storeCount = cachedMetadata.filter((s) => s.source === "store").length;
        console.log(`📚 ${cachedMetadata.length} skill(s) available (${storeCount} store)`);
    } catch (err) {
        console.warn("⚠️  Skill metadata fetch failed (non-fatal):", (err as Error).message);
    }
}

// ── Get cached skill metadata ─────────────────

export function getLoadedSkills(): SkillMetadata[] {
    return [...cachedMetadata];
}

// ── Get skill slugs matching categories ───────

// The skill that speaks for a category on its own. Others need two of their categories in
// play: "browser" alone pulled six skills (UI/UX design, marketing, security, full-stack…)
// and, through two of them, the whole coding prompt into a Wikipedia lookup (~25K tokens).
const PRIMARY_SKILL: Record<string, string> = {
    browser: "web_browsing",
    web_search: "research_analyst",
    os_control: "os_automation",
    shell: "coding_best_practices",
};

// Skills for one kind of work whose categories are generic (any desktop task is
// os_control + app_management): they also need the task to say so.
const NICHE: Record<string, RegExp> = {
    gaming: /\b(game|gaming|steam|minecraft|valorant|fortnite|play(ing)? (a|the) game)\b/i,
    video_editing: /\b(video|clip|footage|edit(ing)? (a|the|my) (video|clip)|davinci|premiere|final cut|capcut|imovie)\b/i,
    ui_ux_designer: /\b(design|ui|ux|figma|canva|mockup|wireframe|layout|landing page|prototype)\b/i,
    marketing: /\b(market(ing)?|campaign|seo|social media|post(ing)? on|ads?|brand|audience|launch)\b/i,
};

export function getRelevantSkillSlugs(selectedCategories: string[], task = ""): string[] {
    if (cachedMetadata.length === 0 || selectedCategories.length === 0) return [];

    const selectedSet = new Set(selectedCategories);
    const primaries = new Set(selectedCategories.map((c) => PRIMARY_SKILL[c]).filter(Boolean));
    const slugs: string[] = [];

    for (const skill of cachedMetadata) {
        const overlap = skill.categories.filter((cat) => selectedSet.has(cat)).length;
        if (NICHE[skill.slug] && !NICHE[skill.slug].test(task)) continue;
        if (overlap >= 2 || (overlap >= 1 && primaries.has(skill.slug))) {
            slugs.push(skill.slug);
        }
    }

    return slugs;
}

// ── Compatibility: getSkillsPrompt returns empty ──
// System prompt skills are now injected server-side.

export function getSkillsPrompt(): string {
    return "";
}
