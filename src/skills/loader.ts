// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
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
        const serverSkills = data.skills || [];
        // Merge in auto-generated skills written to skills/auto/ by the
        // auto-skill-creator after complex tasks. Without this, the tool
        // router never sees agent-authored procedures.
        const { mergeAutoSkills } = await import("./auto-skill-ingest.js");
        cachedMetadata = mergeAutoSkills(serverSkills);
        const autoCount = cachedMetadata.filter((s) => s.source === "auto").length;
        const storeCount = cachedMetadata.filter((s) => s.source === "store").length;
        console.log(
            `📚 ${cachedMetadata.length} skill(s) available (${storeCount} store, ${autoCount} auto)`,
        );
    } catch (err) {
        console.warn("⚠️  Skill metadata fetch failed (non-fatal):", (err as Error).message);
    }
}

// ── Get cached skill metadata ─────────────────

export function getLoadedSkills(): SkillMetadata[] {
    return [...cachedMetadata];
}

// ── Get skill slugs matching categories ───────

export function getRelevantSkillSlugs(selectedCategories: string[]): string[] {
    if (cachedMetadata.length === 0 || selectedCategories.length === 0) return [];

    const selectedSet = new Set(selectedCategories);
    const slugs: string[] = [];

    for (const skill of cachedMetadata) {
        const hasOverlap = skill.categories.some(cat => selectedSet.has(cat));
        if (hasOverlap) {
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
