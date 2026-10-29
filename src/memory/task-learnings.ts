// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Task Learnings Store ──────────────────────────────────────────
// Automatic strategy memory for browser AND OS-level tasks.
// The LLM populates this after each session via auto-extraction in reflection.ts.
// No manual save_strategy calls needed — the agent always learns on its own.

import fs from "node:fs";
import path from "node:path";

// ── Types ─────────────────────────────────────

export type LearningCategory = "browser" | "os" | "app" | "code";

export interface ClickStrategy {
    appName: string;          // e.g. "WhatsApp", "Finder"
    elementLabel: string;     // visible text that was clicked
    successOffsetX: number;   // x-offset from OCR center that worked
    successOffsetY: number;   // y-offset from OCR center that worked
    attemptsTaken: number;    // how many retries were needed (1 = first try)
    lastSuccessAt: string;    // ISO timestamp
}

export interface TaskLearning {
    id: string;
    category: LearningCategory;     // "browser" | "os" | "app"
    taskPattern: string;            // e.g. "create google account", "send whatsapp message"
    context: string;                // domain / app name / OS context
    whatWorked: string[];           // concrete steps that succeeded
    whatFailed: string[];           // approaches that failed and why
    tips: string[];                 // standalone takeaways
    successScore: number;           // 0.0 – 1.0 (was the overall task successful?)
    timesReinforced: number;
    lastSeen: string;
    clickStrategies?: ClickStrategy[];  // in-task learnt click offsets per (app, element) pair
    /** ISO time of the last verified win that (re)wrote whatWorked. */
    lastVerifiedAt?: string;
}

/** Recall skips playbooks scored below this (replays kept failing). Reflection's failure lessons stay visible. */
export const MIN_RECALL_SCORE = 0.4;
/** Verified-win playbooks share the 200-entry store but never hold more than this. */
const MAX_PLAYBOOKS = 80;

interface LearningsStore {
    learnings: TaskLearning[];
}

// ── Storage ───────────────────────────────────

const STORE_PATH = path.join(process.env.ATLAS_DATA_DIR || path.resolve("data"), "task-learnings.json");
let store: LearningsStore = { learnings: [] };
let counter = 0;

// ── Init ──────────────────────────────────────

export function initTaskLearnings(): void {
    try {
        if (fs.existsSync(STORE_PATH)) {
            store = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
            // Pruning leaves gaps, so start past the highest id, not the count: ids must stay unique.
            counter = Math.max(0, ...store.learnings.map((l) => Number(l.id.replace(/^learn_/, "")) || 0));
            console.log(`🧠 Task learnings loaded: ${store.learnings.length} entries`);
        }
    } catch {
        store = { learnings: [] };
    }
}

function save(): void {
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

// ── Upsert ────────────────────────────────────

export function upsertLearning(
    category: LearningCategory,
    taskPattern: string,
    context: string,
    whatWorked: string[],
    whatFailed: string[],
    tips: string[],
    successScore: number,
    // A verified win: its ordered steps replace whatWorked (a recipe, not a pile of hints).
    verifiedAt?: string,
): TaskLearning {
    const patternLower = taskPattern.toLowerCase();
    const contextLower = context.toLowerCase();

    // Try to merge into an existing entry for the same task + context. A playbook
    // also merges into one with the same recipe, however the owner worded the task.
    const sameSteps = (l: TaskLearning) =>
        !!verifiedAt && !!l.lastVerifiedAt && l.whatWorked.join("|") === whatWorked.slice(0, 12).join("|");
    const existing = store.learnings.find(
        (l) =>
            l.category === category &&
            l.context.toLowerCase() === contextLower &&
            (l.taskPattern.toLowerCase() === patternLower || sameSteps(l)),
    );

    if (existing) {
        // Accumulate — deduplicate tips/steps
        const merge = (old: string[], incoming: string[]) => {
            const combined = [...old];
            for (const item of incoming) {
                if (!combined.some((c) => c.toLowerCase() === item.toLowerCase())) {
                    combined.push(item);
                }
            }
            return combined.slice(-10); // cap at 10 per list
        };

        existing.whatWorked = verifiedAt ? whatWorked.slice(0, 12) : merge(existing.whatWorked, whatWorked);
        if (verifiedAt) existing.lastVerifiedAt = verifiedAt;
        existing.whatFailed = merge(existing.whatFailed, whatFailed);
        existing.tips = merge(existing.tips, tips);
        // Running average for success score; a fresh verified win resets it, so a demoted playbook can return.
        existing.successScore = verifiedAt
            ? successScore
            : (existing.successScore * existing.timesReinforced + successScore) / (existing.timesReinforced + 1);
        existing.timesReinforced++;
        existing.lastSeen = new Date().toISOString();

        save();
        console.log(`[LEARNINGS] Updated: "${taskPattern}" (${category}) x${existing.timesReinforced}`);
        return existing;
    }

    const entry: TaskLearning = {
        id: `learn_${++counter}`,
        category,
        taskPattern,
        context,
        whatWorked: verifiedAt ? whatWorked.slice(0, 12) : whatWorked.slice(-10),
        whatFailed: whatFailed.slice(-10),
        tips: tips.slice(-10),
        successScore,
        timesReinforced: 1,
        lastSeen: new Date().toISOString(),
        ...(verifiedAt ? { lastVerifiedAt: verifiedAt } : {}),
    };

    store.learnings.push(entry);
    // Playbooks evict only playbooks, so a busy week of GUI tasks can't push out reflection's lessons.
    const playbooks = store.learnings.filter((l) => l.lastVerifiedAt);
    if (verifiedAt && playbooks.length > MAX_PLAYBOOKS) {
        const oldest = playbooks.reduce((a, b) => (a.lastSeen <= b.lastSeen ? a : b));
        store.learnings = store.learnings.filter((l) => l !== oldest);
    }
    // Keep store bounded (newest wins if over cap)
    if (store.learnings.length > 200) {
        store.learnings.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
        store.learnings = store.learnings.slice(0, 200);
    }

    save();
    console.log(`[LEARNINGS] New learning: "${taskPattern}" (${category})`);
    return entry;
}

// ── Recall ────────────────────────────────────

export function recallLearnings(task: string, category?: LearningCategory): TaskLearning[] {
    const taskLower = task.toLowerCase();
    const keywords = taskLower.split(/\s+/).filter((w) => w.length > 3);

    const scored: Array<{ entry: TaskLearning; score: number }> = [];

    for (const entry of store.learnings) {
        if (category && entry.category !== category) continue;
        if (entry.lastVerifiedAt && entry.successScore < MIN_RECALL_SCORE) continue;

        let score = 0;
        const patternLower = entry.taskPattern.toLowerCase();
        const contextLower = entry.context.toLowerCase();

        for (const kw of keywords) {
            if (patternLower.includes(kw)) score += 2;
            if (contextLower.includes(kw)) score += 1;
        }
        const contextHead = contextLower.split(/\s+/)[0];
        if (contextHead.length > 2 && taskLower.includes(contextHead)) score += 1;
        // Relevance first: recency/reinforcement/success bonuses alone used to
        // clear the bar, so every recent learning (e.g. "couldn't read the
        // Calculator display") was injected into every unrelated task.
        if (score === 0) continue;

        // Recency bonus
        const daysSince = (Date.now() - new Date(entry.lastSeen).getTime()) / 86_400_000;
        if (daysSince < 7) score += 2;

        // Reinforcement bonus
        score += Math.min(entry.timesReinforced, 5);

        // Success score bonus
        score += entry.successScore * 2;

        if (score > 2) scored.push({ entry, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 3).map((s) => s.entry);
}

// ── Context Snippet for Agent ─────────────────

/** `injected` collects the ids shown, so a turn that then fails can demote them. */
export function getTaskLearningsContext(task: string, category?: LearningCategory, injected?: Set<string>): string {
    const matches = recallLearnings(task, category);
    if (matches.length === 0) return "";
    for (const m of matches) injected?.add(m.id);

    const lines: string[] = [];
    lines.push(
        "📚 PAST LEARNINGS for similar tasks (notes from earlier attempts — tools and fixes change, so a past failure is a hint, not a reason to skip trying):",
    );

    for (const m of matches) {
        lines.push(`\n[${m.category.toUpperCase()}] "${m.taskPattern}" (${m.context}) — success: ${(m.successScore * 100).toFixed(0)}%, used ${m.timesReinforced}x`);
        if (m.whatWorked.length > 0) lines.push(`  ✅ Worked: ${m.whatWorked.join(" | ")}`);
        if (m.whatFailed.length > 0) lines.push(`  ❌ Failed: ${m.whatFailed.join(" | ")}`);
        if (m.tips.length > 0) lines.push(`  💡 Tips: ${m.tips.join(" | ")}`);
    }

    return lines.join("\n");
}

// ── Demote ────────────────────────────────────

/**
 * A turn replayed these playbooks and still failed: record it and lower their score.
 * Only playbooks (entries with lastVerifiedAt) are replayed recipes; reflection lessons are left alone.
 */
export function demoteLearnings(ids: Iterable<string>, now = new Date()): void {
    const wanted = new Set(ids);
    let changed = false;
    for (const l of store.learnings) {
        if (!wanted.has(l.id) || !l.lastVerifiedAt) continue;
        l.whatFailed = [...l.whatFailed, `replay failed ${now.toISOString().slice(0, 10)}`].slice(-10);
        l.successScore = Math.max(0, Math.round((l.successScore - 0.3) * 100) / 100);
        changed = true;
        console.log(`[LEARNINGS] Demoted: "${l.taskPattern}" → ${l.successScore}`);
    }
    if (changed) save();
}

// ── All learnings (for introspection) ─────────

export function getAllLearnings(): TaskLearning[] {
    return store.learnings;
}

/** Remove these learnings for good (memory_forget). */
export function deleteLearnings(ids: Set<string>): number {
    const before = store.learnings.length;
    store.learnings = store.learnings.filter((l) => !ids.has(l.id));
    if (store.learnings.length !== before) save();
    return before - store.learnings.length;
}

// ── Immediate Click Strategy Learning ─────────
// Called right after os_ocr_click succeeds — no need to wait for post-session reflection.

export function recordClickStrategy(
    appName: string,
    elementLabel: string,
    offsetX: number,
    offsetY: number,
    attemptsTaken: number,
): void {
    const appLower = appName.toLowerCase();
    const labelLower = elementLabel.toLowerCase();

    // Find or create an OS learning entry for this app
    let entry = store.learnings.find(
        (l) => l.category === "os" && l.context.toLowerCase() === appLower
    );

    if (!entry) {
        entry = {
            id: `learn_${++counter}`,
            category: "os",
            taskPattern: `interact with ${appName}`,
            context: appName,
            whatWorked: [],
            whatFailed: [],
            tips: [],
            successScore: 1.0,
            timesReinforced: 1,
            lastSeen: new Date().toISOString(),
            clickStrategies: [],
        };
        store.learnings.push(entry);
    }

    if (!entry.clickStrategies) entry.clickStrategies = [];

    // Update existing strategy for this label or add new
    const existing = entry.clickStrategies.find(
        (s) => s.elementLabel.toLowerCase() === labelLower
    );

    if (existing) {
        // Running average of offsets (stabilizes over time)
        existing.successOffsetX = Math.round((existing.successOffsetX + offsetX) / 2);
        existing.successOffsetY = Math.round((existing.successOffsetY + offsetY) / 2);
        existing.attemptsTaken = Math.round((existing.attemptsTaken + attemptsTaken) / 2);
        existing.lastSuccessAt = new Date().toISOString();
    } else {
        entry.clickStrategies.push({
            appName,
            elementLabel,
            successOffsetX: offsetX,
            successOffsetY: offsetY,
            attemptsTaken,
            lastSuccessAt: new Date().toISOString(),
        });
        // Keep cap at 30 strategies per entry
        if (entry.clickStrategies.length > 30) {
            entry.clickStrategies.sort(
                (a, b) => new Date(b.lastSuccessAt).getTime() - new Date(a.lastSuccessAt).getTime()
            );
            entry.clickStrategies = entry.clickStrategies.slice(0, 30);
        }
    }

    entry.lastSeen = new Date().toISOString();
    entry.timesReinforced++;

    save();
    console.log(`[LEARNINGS] 🖱️  Click strategy stored: "${elementLabel}" in ${appName} (offset=${offsetX},${offsetY}, attempts=${attemptsTaken})`);
}

// ── Click Strategy Context for Agent ──────────

export function getClickStrategiesContext(appName: string): string {
    const appLower = appName.toLowerCase();
    const entry = store.learnings.find(
        (l) => l.category === "os" && l.context.toLowerCase() === appLower
    );
    if (!entry?.clickStrategies || entry.clickStrategies.length === 0) return "";

    const lines: string[] = [`🖱️ LEARNED CLICK OFFSETS for ${appName}:`];
    for (const s of entry.clickStrategies.slice(0, 10)) {
        const daysAgo = (Date.now() - new Date(s.lastSuccessAt).getTime()) / 86_400_000;
        lines.push(
            `  • "${s.elementLabel}" → offset(${s.successOffsetX}, ${s.successOffsetY}) — took ${s.attemptsTaken} attempt(s), ${daysAgo < 1 ? "today" : `${Math.round(daysAgo)}d ago`}`
        );
    }
    return lines.join("\n");
}
