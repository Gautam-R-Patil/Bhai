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
import { getDataDir } from "../config/paths.js";
import { atomicJsonWrite } from "../utils/atomic-io.js";

// ── Research Index ───────────────────────────
// Survives process restarts. Lives under data/ (internal state, not user-facing).
// The per-research *.state.json files in STATE_DIR are checkpoint blobs used
// to resume mid-flight; this index is the persistent ledger of every research
// the system has ever started, regardless of completion.

const INDEX_FILE = join(getDataDir(), "research-index.json");
const STATE_DIR = join(getDataDir(), "research");
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
// "interrupted"; its checkpoint stays so deep_research({resume_id}) can continue it.
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
        }
        if (interrupted.length > 0) {
            await saveIndexInner(index);
            console.log(`[RESEARCH] Boot recovery: marked ${interrupted.length} stale research(es) as interrupted`);
        }
        return { interrupted };
    });
}

// ── State Persistence ────────────────────────

/** Research ids are minted as `research_<counter>_<epochMs>` (index.ts); anything else is refused before it reaches a path. */
export function isResearchId(id: unknown): id is string {
    return typeof id === "string" && /^research_\d+_\d+$/.test(id);
}

export async function saveResearchState(state: ResearchState): Promise<void> {
    try {
        await fs.mkdir(STATE_DIR, { recursive: true });
        const filePath = join(STATE_DIR, `${state.research.id}.state.json`);
        // Atomic: resume reads this checkpoint, and a kill mid-write must not leave truncated JSON.
        await atomicJsonWrite(filePath, state);
    } catch (err) {
        console.warn(`[RESEARCH] Failed to save state:`, (err as Error).message);
    }
}

export async function loadResearchState(researchId: string): Promise<ResearchState | null> {
    if (!isResearchId(researchId)) return null;
    try {
        const filePath = join(STATE_DIR, `${researchId}.state.json`);
        const data = await fs.readFile(filePath, "utf-8");
        const state = JSON.parse(data) as ResearchState;
        return state?.research?.id === researchId ? state : null;
    } catch { return null; }
}

export async function deleteResearchState(researchId: string): Promise<void> {
    try {
        const filePath = join(STATE_DIR, `${researchId}.state.json`);
        await fs.unlink(filePath);
    } catch {}
}

// ── Memory Integration ───────────────────────

const words = (t: string) => new Set(t.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);

/** Strong then moderate findings, skipping any that mostly repeat one already picked. */
export function pickMemorableFindings(findings: StructuredFinding[], max: number): StructuredFinding[] {
    const picked: StructuredFinding[] = [];
    const seen: Set<string>[] = [];
    for (const level of ["strong", "moderate"]) {
        for (const f of findings) {
            if (picked.length >= max) return picked;
            if (f.confidence !== level) continue;
            const w = words(f.text);
            const repeats = seen.some((s) => {
                let shared = 0;
                for (const x of w) if (s.has(x)) shared++;
                return shared / Math.max(1, Math.min(w.size, s.size)) >= 0.6;
            });
            if (repeats) continue;
            picked.push(f);
            seen.push(w);
        }
    }
    return picked;
}
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

        // The best findings, strongest first, without near-repeats: one run stored up to
        // 25, half of them the same fact from different articles.
        const picked = pickMemorableFindings(findings, 8);
        for (const f of picked) {
            remember(
                `[Research: ${topic}] ${f.text}${f.confidence === "strong" ? ` (Source: ${f.sourceTitle})` : ""}`,
                "research",
                `research,${topic.substring(0, 30)},${f.category}`,
                f.confidence === "strong" ? 7 : 5,
            );
        }

        // Store the report file path
        remember(
            `Research report on "${topic}" saved to ~/Documents/Research/. Use check_deep_research to read.`,
            "research",
            `research,${topic.substring(0, 50)},report`,
            8,
        );

        console.log(`[RESEARCH] Stored ${picked.length + 2} research memories for follow-up queries`);
    } catch (err) {
        console.warn(`[RESEARCH] Failed to store in memory:`, (err as Error).message);
    }
}
