// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Deep Research v2 — Type definitions

import type { LLMClient } from "../llm.js";

// ── Search ───────────────────────────────────

export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
    source?: string;         // engine name
    citationCount?: number;  // for academic papers
}

// ── Findings ─────────────────────────────────

/** A finding as extracted from one page, before cross-referencing. */
export interface RawFinding {
    text: string;
    sourceUrl: string;
    sourceTitle: string;
    categories: string[];
}

export interface StructuredFinding {
    text: string;
    sourceUrl: string;
    sourceTitle: string;
    confidence: "strong" | "moderate" | "weak";
    supportingSources: string[];
    contradictedBy: string[];
    category: string;
}

export interface Contradiction {
    finding1: string;
    finding2: string;
    explanation: string;
}

// ── Sources ──────────────────────────────────

export interface RankedSource {
    url: string;
    title: string;
    content: string;
    domain: string;
    domainScore: number;
    contentDepth: number;
    findingDensity: number;
    recencyScore: number;
    citationCount: number;
    finalScore: number;
    findings: string[];
    outboundLinks: string[];
}

// ── Research State ───────────────────────────

export interface ResearchRound {
    query: string;
    engine: string;
    sourcesFound: number;
    sourcesProcessed: number;
    keyFindings: string[];
    phase: number;
}

export type ResearchStatus =
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";

export interface ActiveResearch {
    id: string;
    topic: string;
    profile: string;
    status: ResearchStatus;
    depth: number;
    maxSources: number;
    sourcesProcessed: number;
    roundsCompleted: number;
    findingsCount: number;
    currentPhase: number;
    startedAt: string;
    updatedAt: string;
    report: string;
    reportFile: string;
    error?: string;
    abortController: AbortController;
    currentQuery?: string;
    engineBreakdown?: Record<string, number>;
    estimatedTimeRemaining?: number;
    originalPrompt?: string;
}

export interface ResearchIndexEntry {
    id: string;
    topic: string;
    profile: string;
    status: ResearchStatus;
    startedAt: string;
    updatedAt: string;
    completedAt?: string;
    sourcesProcessed: number;
    findingsCount: number;
    reportFile?: string;
    originalPrompt?: string;
    durationSec?: number;
    error?: string;
}

export interface ResearchIndex {
    version: 1;
    researches: ResearchIndexEntry[];
}

export interface ResearchProfile {
    depth: number;
    maxSources: number;
    concurrentQueries: number;
    citationDepth: number;
    useAcademicEngines: boolean;
    multiPass: boolean;
    synthesisModel: string;
}

// ── Persistence ──────────────────────────────

export interface ResearchState {
    research: Omit<ActiveResearch, "abortController">;
    allFindings: RawFinding[];
    allSources: RankedSource[];
    visitedUrls: string[];
    usedQueries: string[];
    pendingQueries: string[];
    rounds: ResearchRound[];
    currentRound: number;
}

// ── Callbacks ────────────────────────────────

export type NotifyFn = (msg: string) => Promise<void>;
export type ProgressFn = (msg: string) => Promise<void>;
