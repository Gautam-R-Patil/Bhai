// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Deep Research v2 — State persistence + memory integration

import { promises as fs } from "node:fs";
import { join } from "node:path";
import type {
    ResearchState,
    StructuredFinding,
    ResearchIndex,
    ResearchIndexEntry,
    ResearchStatus,
} from "./types.js";
import { RESEARCH_DIR } from "./profiles.js";
import { getDataDir } from "../config/paths.js";

// ── Research Index ───────────────────────────
// Survives process restarts. Lives under data/ (internal state, not user-facing).
// The per-research *.state.json files in RESEARCH_DIR are checkpoint blobs used
// to resume mid-flight; this index is the persistent ledger of every research
// the system has ever started, regardless of completion.

const INDEX_FILE = join(getDataDir(), "research-index.json");
const MAX_INDEX_ENTRIES = 500;
const INTERRUPTED_THRESHOLD_MS = 10 * 60 * 1000; // running but no update for 10 min → interrupted on boot
let _indexWriteSerializer: Promise<void> = Promise.resolve();

export async function loadIndex(): Promise<ResearchIndex> {
    try {
        const data = await fs.readFile(INDEX_FILE, "utf-8");
        const parsed = JSON.parse(data) as Partial<ResearchIndex>;
        if (parsed.version !== 1 || !Array.isArray(parsed.researches)) {
            return { version: 1, researches: [] };
        }
        return { version: 1, researches: parsed.researches };
    } catch {
        return { version: 1, researches: [] };
    }
}

async function saveIndexInner(index: ResearchIndex): Promise<void> {
    try {
        await fs.mkdir(getDataDir(), { recursive: true });
        const tmp = `${INDEX_FILE}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(index, null, 2));
        try {
            await fs.rename(tmp, INDEX_FILE);
        } catch (renameErr) {
            // Windows: rename over an open file throws EPERM. Unlink dest and retry.
            // Linux/macOS: rename is atomic; this branch is a no-op there.
            if ((renameErr as NodeJS.ErrnoException).code === "EPERM" ||
                (renameErr as NodeJS.ErrnoException).code === "EACCES") {
                await fs.unlink(INDEX_FILE).catch(() => {});
                await fs.rename(tmp, INDEX_FILE);
            } else {
                throw renameErr;
            }
        }
    } catch (err) {
        console.warn(`[RESEARCH] Failed to save index:`, (err as Error).message);
    }
}

// Serialize all writes to the index file so concurrent upserts can't lose
// updates. Pass `() => fn()` rather than `fn` directly so that a previous
// rejection in the chain doesn't get forwarded as an argument to the next
// callback (cosmetic; fn ignores its arg, but the intent is clearer this way).
function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = _indexWriteSerializer.then(() => fn(), () => fn());
    _indexWriteSerializer = next.then(
        () => undefined,
        () => undefined,
    );
    return next;
}

export async function upsertIndexEntry(entry: ResearchIndexEntry): Promise<void> {
    return withIndexLock(async () => {
        const index = await loadIndex();
        const i = index.researches.findIndex(r => r.id === entry.id);
        if (i >= 0) {
            index.researches[i] = { ...index.researches[i], ...entry };
        } else {
            index.researches.push(entry);
        }
        // Cap by recency to keep file bounded.
        if (index.researches.length > MAX_INDEX_ENTRIES) {
            index.researches.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
            index.researches = index.researches.slice(0, MAX_INDEX_ENTRIES);
        }
        await saveIndexInner(index);
    });
}

export async function getIndexEntry(id: string): Promise<ResearchIndexEntry | null> {
    const index = await loadIndex();
    return index.researches.find(r => r.id === id) ?? null;
}

export async function listIndex(filter?: {
    status?: ResearchStatus[];
    sinceMs?: number;
}): Promise<ResearchIndexEntry[]> {
    const index = await loadIndex();
    let entries = index.researches;
    if (filter?.status) entries = entries.filter(r => filter.status!.includes(r.status));
    if (filter?.sinceMs) {
        const cutoff = Date.now() - filter.sinceMs;
        entries = entries.filter(r => new Date(r.updatedAt).getTime() >= cutoff);
    }
    return entries.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

// Boot recovery: any entry still marked "running" whose updatedAt is older than
// INTERRUPTED_THRESHOLD_MS was killed mid-flight by a process restart. Mark it
// "interrupted" and clean its checkpoint state so it doesn't linger.
export async function recoverInterruptedResearches(): Promise<{
    interrupted: ResearchIndexEntry[];
}> {
    return withIndexLock(async () => {
        const index = await loadIndex();
        const now = Date.now();
        const interrupted: ResearchIndexEntry[] = [];
        for (const entry of index.researches) {
            if (entry.status !== "running") continue;
            const updatedMs = new Date(entry.updatedAt).getTime();
            if (now - updatedMs <= INTERRUPTED_THRESHOLD_MS) continue;
            entry.status = "interrupted";
            entry.updatedAt = new Date().toISOString();
            entry.error = entry.error ?? "Process restarted while research was running";
            interrupted.push(entry);
            try {
                await deleteResearchState(entry.id);
            } catch {
                /* state file may not exist */
            }
        }
        if (interrupted.length > 0) {
            await saveIndexInner(index);
            console.log(`[RESEARCH] Boot recovery: marked ${interrupted.length} stale research(es) as interrupted`);
        }
        return { interrupted };
    });
}

// ── State Persistence ────────────────────────

export async function saveResearchState(state: ResearchState): Promise<void> {
    try {
        await fs.mkdir(RESEARCH_DIR, { recursive: true });
        const filePath = join(RESEARCH_DIR, `${state.research.id}.state.json`);
        await fs.writeFile(filePath, JSON.stringify(state, null, 2));
    } catch (err) {
        console.warn(`[RESEARCH] Failed to save state:`, (err as Error).message);
    }
}

export async function loadResearchState(researchId: string): Promise<ResearchState | null> {
    try {
        const filePath = join(RESEARCH_DIR, `${researchId}.state.json`);
        const data = await fs.readFile(filePath, "utf-8");
        return JSON.parse(data);
    } catch { return null; }
}

export async function deleteResearchState(researchId: string): Promise<void> {
    try {
        const filePath = join(RESEARCH_DIR, `${researchId}.state.json`);
        await fs.unlink(filePath);
    } catch {}
}

// ── Memory Integration ───────────────────────
// Store research findings in the memory system so the agent can answer
// follow-up questions about the research in future conversations.

export async function storeResearchInMemory(
    topic: string,
    findings: StructuredFinding[],
    report: string,
): Promise<void> {
    try {
        const { remember } = await import("../memory/sqlite.js");

        // Store executive summary as high-importance memory
        const summaryMatch = report.match(/## Executive Summary\n([\s\S]*?)(?=\n## )/);
        if (summaryMatch) {
            remember(
                `Deep research completed on "${topic}": ${summaryMatch[1].trim().substring(0, 500)}`,
                "research",
                `research,${topic.substring(0, 50)}`,
                9,
            );
        }

        // Store strong findings (up to 15)
        const strongFindings = findings
            .filter(f => f.confidence === "strong")
            .slice(0, 15);

        for (const f of strongFindings) {
            remember(
                `[Research: ${topic}] ${f.text} (Source: ${f.sourceTitle})`,
                "research",
                `research,${topic.substring(0, 30)},${f.category}`,
                7,
            );
        }

        // Store moderate findings (up to 10)
        const moderateFindings = findings
            .filter(f => f.confidence === "moderate")
            .slice(0, 10);

        for (const f of moderateFindings) {
            remember(
                `[Research: ${topic}] ${f.text}`,
                "research",
                `research,${topic.substring(0, 30)},${f.category}`,
                5,
            );
        }

        // Store the report file path
        remember(
            `Research report on "${topic}" saved to ~/Documents/Research/. Use check_deep_research to read.`,
            "research",
            `research,${topic.substring(0, 50)},report`,
            8,
        );

        console.log(`[RESEARCH] Stored ${strongFindings.length + moderateFindings.length + 2} research memories for follow-up queries`);
    } catch (err) {
        console.warn(`[RESEARCH] Failed to store in memory:`, (err as Error).message);
    }
}
