// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// auto-skill-creator writes skill files to `skills/auto/*.md` after complex
// task completions. The server-side skill catalog doesn't know about these;
// this module reads them from disk at agent-runtime and merges them into the
// tool-router's category→slug lookup so the agent can surface its own
// procedures on future turns.

import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { SkillMetadata } from "./loader.js";

// Intentionally process.cwd()-rooted to match auto-skill-creator.ts's
// writer path. Both resolve against the same base so agent cwd changes
// (e.g. codebase-index indexing other repos under Phase 4L) affect reader
// and writer identically — they stay in sync.
const DEFAULT_AUTO_SKILLS_DIR = path.resolve("skills", "auto");
let _dirOverride: string | null = null;

const MAX_FILES = 500; // bound boot-time disk cost
const MAX_FILE_BYTES = 32 * 1024; // reject pathologically large dropped files
const MAX_DESCRIPTION_LEN = 500; // cap prompt bloat from hostile frontmatter
const SAFE_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function _setAutoSkillsDirForTests(p: string | null): void {
    _dirOverride = p;
}

function autoSkillsDir(): string {
    return _dirOverride ?? DEFAULT_AUTO_SKILLS_DIR;
}

function normalizeCategories(triggers: unknown): string[] {
    if (!Array.isArray(triggers)) return [];
    return triggers.filter((t): t is string => typeof t === "string" && t.length > 0);
}

export function loadAutoSkillsFromDisk(): SkillMetadata[] {
    const dir = autoSkillsDir();
    if (!fs.existsSync(dir)) return [];
    let entries: string[];
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return [];
    }
    // Keep only .md files, rank by mtime (newest first) so the cap retains
    // the most recently-authored skills.
    const ranked: Array<{ file: string; mtimeMs: number; size: number }> = [];
    for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const filePath = path.join(dir, entry);
        let stat: fs.Stats;
        try {
            stat = fs.statSync(filePath);
        } catch {
            continue;
        }
        if (!stat.isFile()) continue;
        if (stat.size > MAX_FILE_BYTES) continue;
        ranked.push({ file: entry, mtimeMs: stat.mtimeMs, size: stat.size });
    }
    ranked.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const capped = ranked.slice(0, MAX_FILES);

    const out: SkillMetadata[] = [];
    for (const { file } of capped) {
        const filePath = path.join(dir, file);
        const filenameSlug = file.slice(0, -3);
        let raw: string;
        try {
            raw = fs.readFileSync(filePath, "utf8");
        } catch {
            continue;
        }
        let fm: Record<string, unknown> = {};
        try {
            fm = matter(raw).data ?? {};
        } catch {
            fm = {};
        }
        // Slug safety: reject path separators / dotdot / fancy chars.
        // Falls back to the filename (which came from our own writer).
        const declaredSlug =
            typeof fm.slug === "string" ? fm.slug.trim() : "";
        const slug = SAFE_SLUG.test(declaredSlug) ? declaredSlug : filenameSlug;
        const name =
            typeof fm.name === "string" && fm.name.trim()
                ? fm.name.trim()
                : slug;
        const rawDesc = typeof fm.description === "string" ? fm.description : "";
        const description =
            rawDesc.length > MAX_DESCRIPTION_LEN
                ? rawDesc.slice(0, MAX_DESCRIPTION_LEN)
                : rawDesc;
        out.push({
            slug,
            name,
            description,
            categories: normalizeCategories(fm.triggers),
            source: "auto",
        });
    }
    return out;
}

/**
 * Return a deduplicated list of server-side metadata + disk auto-skills.
 * Server slugs win on collision so user-curated / store-installed skills
 * take precedence over local auto-generated copies.
 */
export function mergeAutoSkills(
    serverMetadata: SkillMetadata[],
): SkillMetadata[] {
    const auto = loadAutoSkillsFromDisk();
    if (auto.length === 0) return [...serverMetadata];
    const serverSlugs = new Set(serverMetadata.map((s) => s.slug));
    return [
        ...serverMetadata,
        ...auto.filter((s) => !serverSlugs.has(s.slug)),
    ];
}
