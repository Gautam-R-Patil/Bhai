// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Deep Research v2 — Tool definitions + public API
// 3-phase multi-pass engine: Discovery → Deep Reading → Verification & Synthesis

import type { ToolDefinition } from "../tools/get-current-time.js";
import type { LLMClient } from "../llm.js";
import type { ActiveResearch, NotifyFn } from "./types.js";
import { PROFILES } from "./profiles.js";
import { executeDeepResearch } from "./executor.js";
import { multiEngineSearch } from "./engines.js";
import type { SearchResult } from "./types.js";

// ── State ────────────────────────────────────

let _llm: LLMClient | null = null;
let _onProgress: ((msg: string) => Promise<void>) | null = null;
let _telegramNotifier: ((msg: string) => Promise<void>) | null = null;
let _overlayProgress: ((msg: string) => Promise<void>) | null = null;

const activeResearches = new Map<string, ActiveResearch>();
const pendingFollowUps = new Map<string, { originalPrompt: string; remainingTasks: string }>();
let researchCounter = 0;

// ── Memory Leak Prevention: periodic cleanup of completed/failed research entries ──
const RESEARCH_CLEANUP_AGE_MS = 30 * 60 * 1000; // 30 minutes

function cleanupStaleResearches(): void {
    const now = Date.now();
    for (const [id, research] of activeResearches) {
        if (research.status === "completed" || research.status === "failed" || research.status === "cancelled") {
            const updatedAt = new Date(research.updatedAt).getTime();
            if (now - updatedAt > RESEARCH_CLEANUP_AGE_MS) {
                activeResearches.delete(id);
                pendingFollowUps.delete(id);
                console.log(`[RESEARCH] 🧹 Cleaned up stale research: ${id} (${research.status})`);
            }
        }
    }
}

// Run cleanup every 30 minutes
const _researchCleanupInterval = setInterval(cleanupStaleResearches, 30 * 60 * 1000);
_researchCleanupInterval.unref(); // Don't prevent process exit

// ── Public API (keep backward-compatible) ────

export function setDeepResearchLLM(llm: LLMClient): void { _llm = llm; }
export function setDeepResearchProgress(fn: (msg: string) => Promise<void>): void { _onProgress = fn; }
export function clearDeepResearchProgress(): void { _onProgress = null; }
export function setDeepResearchNotifier(fn: (msg: string) => Promise<void>): void { _telegramNotifier = fn; }
export function setOverlayResearchProgress(fn: (msg: string) => Promise<void>): void { _overlayProgress = fn; }
export function clearOverlayResearchProgress(): void { _overlayProgress = null; }

// Re-export for web-search.ts compatibility
export { multiEngineSearch, type SearchResult };

// ── Notify Helper ────────────────────────────

function createNotify(): NotifyFn {
    return async (msg: string) => {
        if (_telegramNotifier) await _telegramNotifier(msg).catch(() => {});
        if (_onProgress) await _onProgress(msg).catch(() => {});
        if (_overlayProgress) await _overlayProgress(msg).catch(() => {});
    };
}

// ── Tool: Start Deep Research ────────────────

export const deepResearch: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "deep_research",
            description: `Start a comprehensive, multi-phase background research investigation. Returns IMMEDIATELY with a research_id — research continues in the background.

Unlike web_search (for quick lookups), this tool performs TRUE deep research:
- Phase 1 (Discovery): Searches 3-5+ engines IN PARALLEL including Google, Brave, DuckDuckGo, Semantic Scholar, and arXiv
- Phase 2 (Deep Reading): Reads FULL content of sources (50KB each), follows CITATION CHAINS 2-3 levels deep
- Phase 3 (Verification): Cross-references findings, detects CONTRADICTIONS, assigns CONFIDENCE levels, writes synthesis

Research profiles:
- "quick": ~2 min, 20 sources — fast overview
- "standard": ~5 min, 100 sources — solid coverage (default)
- "deep": ~15 min, 200 sources, academic DBs, citation chains, multi-pass
- "exhaustive": ~30+ min, 500 sources, full depth, Opus synthesis

Findings are stored in memory — you can answer follow-up questions about the research.
Use check_deep_research to get status and the full report.`,
            parameters: {
                type: "object",
                properties: {
                    topic: {
                        type: "string",
                        description: "The topic to research thoroughly",
                    },
                    profile: {
                        type: "string",
                        enum: ["quick", "standard", "deep", "exhaustive"],
                        description: 'Research depth: "quick" (~2min), "standard" (~5min, default), "deep" (~15min, academic DBs + citation chains), "exhaustive" (~30min+, maximum depth)',
                    },
                    depth: {
                        type: "number",
                        description: "Override: research rounds (1-50). Leave blank to use profile default.",
                    },
                    max_sources: {
                        type: "number",
                        description: "Override: max pages to read (5-500). Leave blank to use profile default.",
                    },
                },
                required: ["topic"],
            },
        },
    },

    async handler(input) {
        if (!_llm) return JSON.stringify({ error: "Deep research not initialized — LLM client not set" });

        const topic = input.topic as string;
        if (!topic) return JSON.stringify({ error: "Missing 'topic' parameter" });

        const profileName = (input.profile as string) || "standard";
        const profile = PROFILES[profileName] || PROFILES.standard;

        const depth = Math.min(Math.max((input.depth as number) || profile.depth, 1), 50);
        const maxSources = Math.min(Math.max((input.max_sources as number) || profile.maxSources, 5), 500);

        const id = `research_${++researchCounter}_${Date.now()}`;

        const research: ActiveResearch = {
            id,
            topic,
            profile: profileName,
            status: "running",
            depth,
            maxSources,
            sourcesProcessed: 0,
            roundsCompleted: 0,
            findingsCount: 0,
            currentPhase: 1,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            report: "",
            reportFile: "",
            abortController: new AbortController(),
        };

        activeResearches.set(id, research);

        // Detect multi-part requests (e.g. "research X and make a PDF and show it to me")
        const originalPrompt = (input._originalPrompt as string) || "";
        if (originalPrompt) {
            const continuationPatterns = [
                /(?:then|after that|also|and)\s+(make|create|generate|build|show|send|email|present)\s+/i,
                /(?:make|create|generate)\s+(?:a\s+)?(?:pdf|document|report|summary|presentation)/i,
                /show\s+(?:it|the|results?|report|pdf)\s+(?:to\s+me)?/i,
            ];
            for (const pat of continuationPatterns) {
                const match = originalPrompt.match(pat);
                if (match) {
                    const remainingTasks = originalPrompt.substring(originalPrompt.indexOf(match[0]));
                    pendingFollowUps.set(id, { originalPrompt, remainingTasks });
                    console.log(`[RESEARCH] 📋 Follow-up task detected: "${remainingTasks.substring(0, 80)}..."`);
                    break;
                }
            }
        }

        // Capture references at start time (they may be cleared before research completes)
        const capturedNotify = createNotify();
        const capturedLLM = _llm!;

        // Fire and forget — runs in background
        executeDeepResearch(research, { ...profile, depth, maxSources }, capturedLLM, capturedNotify).then(async () => {
            // Check for pending follow-up tasks
            const followUp = pendingFollowUps.get(id);
            if (followUp && research.status === "completed") {
                pendingFollowUps.delete(id);
                console.log(`[RESEARCH] 🔄 Executing follow-up: "${followUp.remainingTasks.substring(0, 80)}..."`);

                const continuationPrompt = `The deep research on "${topic}" is now complete with ${research.sourcesProcessed} sources and a full report. The report is saved at: ${research.reportFile}\n\nThe user's original request also included: "${followUp.remainingTasks}"\n\nPlease continue and fulfill that part of the request now. Use check_deep_research("${id}") to get the full report content, then proceed with the remaining tasks.`;

                try {
                    const { runAgent } = await import("../agent.js");
                    const result = await runAgent(capturedLLM, continuationPrompt);
                    await capturedNotify(result.text);
                } catch (err) {
                    console.error(`[RESEARCH] Follow-up execution failed:`, err);
                    await capturedNotify(`⚠️ Research completed but follow-up task failed: ${(err as Error).message}`);
                }
            }
        }).catch(err => {
            console.error(`[RESEARCH] Fatal error in ${id}:`, err);
            research.status = "failed";
            research.error = (err as Error).message;
        }).finally(() => {
            // Trigger cleanup of stale research entries after each completion
            cleanupStaleResearches();
        });

        return JSON.stringify({
            success: true,
            research_id: id,
            topic,
            profile: profileName,
            depth,
            max_sources: maxSources,
            status: "running",
            phases: "Discovery → Deep Reading → Verification & Synthesis",
            message: `Deep research started (${profileName} profile). Use check_deep_research("${id}") for status and results.`,
        });
    },
};

// ── Tool: Check Deep Research ────────────────

export const checkDeepResearch: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "check_deep_research",
            description: "Check status and results of background deep research. Returns full report when complete, progress stats when running. Omit research_id to list all.",
            parameters: {
                type: "object",
                properties: {
                    research_id: {
                        type: "string",
                        description: "Research ID. Omit to list all active researches.",
                    },
                },
                required: [],
            },
        },
    },

    async handler(input) {
        const researchId = input.research_id as string | undefined;

        if (!researchId) {
            const list = Array.from(activeResearches.values()).map(r => ({
                id: r.id,
                topic: r.topic.substring(0, 80),
                profile: r.profile,
                status: r.status,
                phase: `${r.currentPhase}/3`,
                sources: r.sourcesProcessed,
                rounds: `${r.roundsCompleted}/${r.depth}`,
                findings: r.findingsCount,
                current_query: r.currentQuery?.substring(0, 50),
                engines: r.engineBreakdown,
                eta_seconds: r.estimatedTimeRemaining,
                started_at: r.startedAt,
            }));
            return JSON.stringify({ researches: list, count: list.length });
        }

        const research = activeResearches.get(researchId);
        if (!research) return JSON.stringify({ error: `Research "${researchId}" not found` });

        const result: Record<string, unknown> = {
            id: research.id,
            topic: research.topic,
            profile: research.profile,
            status: research.status,
            current_phase: research.currentPhase,
            total_phases: 3,
            phase_names: ["Discovery", "Deep Reading", "Verification & Synthesis"],
            rounds_completed: research.roundsCompleted,
            rounds_total: research.depth,
            sources_processed: research.sourcesProcessed,
            max_sources: research.maxSources,
            findings_count: research.findingsCount,
            current_query: research.currentQuery,
            engines_used: research.engineBreakdown,
            estimated_time_remaining_seconds: research.estimatedTimeRemaining,
            started_at: research.startedAt,
            updated_at: research.updatedAt,
        };

        if (research.status === "completed") {
            result.report = research.report;
            result.report_file = research.reportFile;
        } else if (research.status === "failed") {
            result.error = research.error;
        }

        return JSON.stringify(result);
    },
};

// ── Tool: Cancel Deep Research ───────────────

export const cancelDeepResearch: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "cancel_deep_research",
            description: "Cancel a running deep research by its ID.",
            parameters: {
                type: "object",
                properties: {
                    research_id: { type: "string", description: "Research ID to cancel" },
                },
                required: ["research_id"],
            },
        },
    },

    async handler(input) {
        const research = activeResearches.get(input.research_id as string);
        if (!research) return JSON.stringify({ error: `Research "${input.research_id}" not found` });
        if (research.status !== "running") return JSON.stringify({ message: `Research already ${research.status}.` });

        research.abortController.abort();
        research.status = "cancelled";
        research.updatedAt = new Date().toISOString();

        return JSON.stringify({
            success: true,
            message: `Cancelled. ${research.sourcesProcessed} sources processed, ${research.findingsCount} findings collected before cancellation.`,
        });
    },
};
