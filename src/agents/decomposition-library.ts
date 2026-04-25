// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Decomposition Template Library ───────────
// Saves successful task decompositions as reusable templates.
// Matches future tasks by keyword similarity to reduce planning overhead
// and improve plan quality by learning from past successes.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { MeshStep } from "./mesh.js";
import { getDimensionValue } from "../harness/registry.js";

// ── Types ────────────────────────────────────

export interface DecompositionTemplate {
    id: string;
    /** Generalized pattern (nouns replaced with placeholders) */
    pattern: string;
    /** Keywords extracted for matching */
    keywords: string[];
    /** The template steps */
    steps: MeshStep[];
    /** How many times this template has been used */
    timesUsed: number;
    /** Average success rate across uses */
    averageSuccessRate: number;
    /** ISO timestamp of last use */
    lastUsedAt: string;
    /** ISO timestamp of creation */
    createdAt: string;
}

export interface TemplateMatch {
    template: DecompositionTemplate;
    similarity: number;
}

// ── Constants ────────────────────────────────

const LIBRARY_PATH = "data/decomposition-templates.json";
const MAX_TEMPLATES = 100;
const MATCH_THRESHOLD = 0.4;
const DECAY_DAYS = 30;
const MIN_SUCCESS_RATE = 0.5;

// ── Stopwords ────────────────────────────────

const STOPWORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "shall", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "out", "off", "over",
    "under", "again", "further", "then", "once", "here", "there", "when",
    "where", "why", "how", "all", "each", "every", "both", "few", "more",
    "most", "other", "some", "such", "no", "not", "only", "own", "same",
    "so", "than", "too", "very", "just", "about", "it", "its", "this",
    "that", "these", "those", "i", "me", "my", "we", "our", "you", "your",
    "he", "him", "his", "she", "her", "they", "them", "their", "what",
    "which", "who", "whom", "and", "but", "or", "if",
]);

// ── Keyword Extraction ───────────────────────

function extractKeywords(text: string): string[] {
    return text.toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

// ── Similarity ───────────────────────────────

function keywordSimilarity(keywords1: string[], keywords2: string[]): number {
    if (keywords1.length === 0 || keywords2.length === 0) return 0;
    const set1 = new Set(keywords1);
    const set2 = new Set(keywords2);
    let intersection = 0;
    for (const w of set1) {
        if (set2.has(w)) intersection++;
    }
    const union = set1.size + set2.size - intersection;
    return union > 0 ? intersection / union : 0;
}

// ── Library Operations ───────────────────────

/** Load the template library from disk. */
function loadLibrary(): DecompositionTemplate[] {
    try {
        if (!existsSync(LIBRARY_PATH)) return [];
        const data = readFileSync(LIBRARY_PATH, "utf-8");
        return JSON.parse(data);
    } catch {
        return [];
    }
}

/** Save the template library to disk. */
function saveLibrary(templates: DecompositionTemplate[]): void {
    try {
        const dir = dirname(LIBRARY_PATH);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(LIBRARY_PATH, JSON.stringify(templates, null, 2));
    } catch (err) {
        console.error("[DECOMP-LIB] Failed to save:", (err as Error).message);
    }
}

// ── Public API ───────────────────────────────

/**
 * Find matching templates for a task description.
 * Returns matches sorted by similarity (highest first).
 */
export function findTemplates(taskDescription: string): TemplateMatch[] {
    const templates = loadLibrary();
    const taskKeywords = extractKeywords(taskDescription);

    const matches: TemplateMatch[] = [];
    const now = Date.now();

    for (const template of templates) {
        // Skip decayed or low-success templates
        const daysSinceUse = (now - new Date(template.lastUsedAt).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceUse > DECAY_DAYS && template.averageSuccessRate < MIN_SUCCESS_RATE) continue;

        const similarity = keywordSimilarity(taskKeywords, template.keywords);
        if (similarity >= (getDimensionValue<number>("decomposition.matchThreshold") ?? MATCH_THRESHOLD)) {
            matches.push({ template, similarity });
        }
    }

    return matches.sort((a, b) => b.similarity - a.similarity);
}

/**
 * Save a successful decomposition as a template.
 */
export function saveTemplate(
    taskDescription: string,
    steps: MeshStep[],
    successRate: number,
): void {
    const templates = loadLibrary();
    const keywords = extractKeywords(taskDescription);

    // Check for existing similar template
    const existingIdx = templates.findIndex(t =>
        keywordSimilarity(keywords, t.keywords) >= 0.7
    );

    const now = new Date().toISOString();

    if (existingIdx >= 0) {
        // Update existing template
        const existing = templates[existingIdx];
        existing.timesUsed++;
        existing.averageSuccessRate = (existing.averageSuccessRate * (existing.timesUsed - 1) + successRate) / existing.timesUsed;
        existing.lastUsedAt = now;
        // Update steps if this execution was more successful
        if (successRate > existing.averageSuccessRate) {
            existing.steps = steps;
        }
    } else {
        // Create new template
        templates.push({
            id: `tmpl_${Date.now()}`,
            pattern: taskDescription.substring(0, 200),
            keywords,
            steps,
            timesUsed: 1,
            averageSuccessRate: successRate,
            lastUsedAt: now,
            createdAt: now,
        });
    }

    // Evict old templates if over limit
    if (templates.length > MAX_TEMPLATES) {
        templates.sort((a, b) => {
            // Score = successRate * recency * usage
            const aScore = a.averageSuccessRate * a.timesUsed;
            const bScore = b.averageSuccessRate * b.timesUsed;
            return bScore - aScore;
        });
        templates.length = MAX_TEMPLATES;
    }

    saveLibrary(templates);
}

/**
 * Format a template match as a hint for the decomposition LLM prompt.
 */
export function formatTemplateHint(match: TemplateMatch): string {
    const t = match.template;
    const stepsStr = t.steps
        .map(s => `  - ${s.id} [${s.role}]: ${s.description} (deps: ${s.depends_on.join(", ") || "none"})`)
        .join("\n");

    return `\nSUGGESTED STRUCTURE (from a similar past task with ${(t.averageSuccessRate * 100).toFixed(0)}% success rate, used ${t.timesUsed}x):
${stepsStr}
You may adapt this structure to fit the current request.\n`;
}
