// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Deep Research v2 — 3-Phase multi-pass execution engine

import type { LLMClient } from "../llm.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type {
    ActiveResearch, ResearchProfile, RankedSource, RawFinding,
    ResearchRound, ResearchState, NotifyFn,
} from "./types.js";
import { RESEARCH_DIR, AdaptiveRateLimiter } from "./profiles.js";
import { multiEngineSearch } from "./engines.js";
import { fetchPages, rankOutboundLinks, scoreDomainQuality, getDomain } from "./fetcher.js";
import {
    generateSeedQueries, generateMoreQueries, analyzeAndExtract,
    detectContradictions, identifyGaps, synthesizeResearch,
    shouldExtractContacts, extractContactsSection,
} from "./analysis.js";
import { crossReferenceFindings, dedupeByText, mentionsTopic, rankSource, UrlSet } from "./scoring.js";
import { loadResearchState, saveResearchState, storeResearchInMemory } from "./persistence.js";
import { generateHypotheses, updateHypothesis, type Hypothesis, type ResearchPlan } from "./hypothesis-engine.js";
import { getCredibility, recordClaimVerification } from "./credibility-model.js";
import { getDimensionValue } from "../harness/registry.js";
import { pLimit } from "../utils/concurrency.js";

type Page = Awaited<ReturnType<typeof fetchPages>>[number];
type Analysis = Awaited<ReturnType<typeof analyzeAndExtract>>;

// ── Main Background Execution ────────────────

export async function executeDeepResearch(
    research: ActiveResearch,
    profile: ResearchProfile,
    llm: LLMClient,
    notify: NotifyFn,
    resume?: ResearchState,
): Promise<void> {
    const allFindings: RawFinding[] = resume ? [...resume.allFindings] : [];
    const allSources: RankedSource[] = resume ? [...resume.allSources] : [];
    const rounds: ResearchRound[] = resume ? [...resume.rounds] : [];
    const visitedUrls = new UrlSet(resume?.visitedUrls); // the same page under another URL spelling is visited once
    const usedQueries = new Set<string>(resume?.usedQueries);
    const signal = research.abortController.signal;
    const rateLimiter = new AdaptiveRateLimiter();

    // Memory leak prevention: cap findings array to avoid unbounded growth
    const MAX_FINDINGS = 1000;
    // A follow-up (builds_on) starts from a finished research's findings, often already at the cap:
    // keep the longest half so its own findings have room, and don't store the old ones to memory again.
    // A resumed follow-up starts from its own checkpoint, so the old findings come from the basis's.
    const basisTexts = research.buildsOn
        ? new Set((resume?.buildsOn ? resume : await loadResearchState(research.buildsOn))?.allFindings.map(f => f.text))
        : null;
    if (resume?.buildsOn && allFindings.length > MAX_FINDINGS / 2) {
        allFindings.sort((a, b) => b.text.length - a.text.length);
        allFindings.length = MAX_FINDINGS / 2;
    }
    /** Trim allFindings to MAX_FINDINGS, keeping longer (higher-confidence) findings */
    function trimFindings(): void {
        if (allFindings.length <= MAX_FINDINGS) return;
        // Sort by text length descending (longer findings = more detail = higher confidence proxy)
        allFindings.sort((a, b) => b.text.length - a.text.length);
        allFindings.length = MAX_FINDINGS;
    }
    // Shared with research so checkpoints and the status tool see live counts (a resume skipping Phase 1 never reassigns it).
    const engineBreakdown: Record<string, number> = { ...resume?.research.engineBreakdown };
    research.engineBreakdown = engineBreakdown;

    // Engine health isn't reset per research: one engine backing off is the same engine for
    // every research running at once, and a fresh start would just re-hit the dead ones.

    console.log(`[RESEARCH] 🔬 Starting: ${research.id} (${research.profile} profile)`);
    console.log(`[RESEARCH]   Topic: "${research.topic}"`);
    console.log(`[RESEARCH]   Depth: ${research.depth} rounds, max ${research.maxSources} sources`);
    console.log(`[RESEARCH]   Citation depth: ${profile.citationDepth}, Academic: ${profile.useAcademicEngines}`);

    // A fresh start was already announced by the agent's reply; a resume (often after a restart) wasn't.
    // A follow-up arrives here with a finished research's sources: that isn't a resume.
    const resuming = !!resume && !resume.buildsOn;
    if (resuming) await notify(`🔬 Picking up the research on "${research.topic.substring(0, 50)}" where it stopped (${allSources.length} sources so far)`, true);
    else await notify(`🔬 Deep research started: "${research.topic.substring(0, 50)}" (${research.profile} profile: ${research.depth} rounds, ${research.maxSources} sources)`);

    try {
        // ── Generate seed queries ──
        const pendingQueries = resume?.pendingQueries.length ? [...resume.pendingQueries] : await generateSeedQueries(llm, research.topic, profile);
        if (!resuming) console.log(`[RESEARCH] 🌱 Generated ${pendingQueries.length} seed queries`);

        // ── Hypothesis-driven research planning ──
        let researchPlan: ResearchPlan | null = null;
        let hypotheses: Hypothesis[] = [];
        if (!resuming) try {
            researchPlan = await generateHypotheses(llm, research.topic);
            hypotheses = researchPlan.hypotheses;
            // Add hypothesis-designed queries to the pending queue
            for (const q of researchPlan.queryOrder) {
                if (!pendingQueries.includes(q)) pendingQueries.push(q);
            }
            console.log(`[RESEARCH] 🧪 Generated ${hypotheses.length} hypotheses with ${researchPlan.queryOrder.length} designed queries`);
        } catch (hypErr) {
            console.warn(`[RESEARCH] Hypothesis generation failed (non-fatal):`, (hypErr as Error).message);
        }

        // ── Phase distribution (tunable via Meta-Harness registry) ──
        const p1Ratio = getDimensionValue<number>("research.discoveryPhaseRatio") ?? 0.4;
        const p2Ratio = getDimensionValue<number>("research.deepReadPhaseRatio") ?? 0.4;
        // A run resumed in Phase 2 or later skips discovery. ponytail: the resumed phase's
        // round count restarts (bounded by maxSources); save per-phase counters if that matters.
        const skipDiscovery = (resume?.research.currentPhase ?? 0) >= 2;
        const phase1Rounds = skipDiscovery ? 0 : Math.ceil(research.depth * p1Ratio);  // Discovery
        const phase2Rounds = Math.ceil(research.depth * p2Ratio);  // Deep Reading

        let globalRound = resume?.currentRound ?? 0;
        let consecutiveFailures = 0;
        // Pace is this run's time over this run's rounds: a resume's earlier rounds took no time here.
        const startRound = globalRound;
        const roundStartTime = Date.now();

        // Analyze fetched pages a few at a time (profile.concurrentQueries) instead of one
        // LLM call after another, never more pages than the source budget has room for.
        // Returns the pages that yielded findings, in page order.
        const analyzeBatch = async (pages: Page[]): Promise<Array<{ page: Page; analysis: Analysis }>> => {
            const usable = pages
                .filter(p => p.content && p.content.length >= 100 && mentionsTopic(p.content, research.topic))
                .slice(0, Math.max(0, research.maxSources - allSources.length));
            const analyses = await pLimit(usable.map(p => () => signal.aborted
                ? Promise.resolve<Analysis>({ findings: [], followUpQueries: [], categories: [] })
                : analyzeAndExtract(llm, research.topic, p.content, p.url)), profile.concurrentQueries);
            return usable.map((page, i) => ({ page, analysis: analyses[i] })).filter(a => a.analysis.findings.length > 0);
        };

        // Record one analyzed page: its findings, its ranked source and its follow-up queries.
        const ingest = (page: Page, analysis: Analysis, citationCount: number): void => {
            for (const f of analysis.findings) {
                allFindings.push({ text: f, sourceUrl: page.url, sourceTitle: page.title, categories: analysis.categories });
            }
            const ranked = rankSource(page.url, page.title, page.content, analysis.findings, citationCount, research.topic);
            ranked.outboundLinks = page.links;
            allSources.push(ranked);
            for (const fq of analysis.followUpQueries) {
                if (!usedQueries.has(fq) && !pendingQueries.includes(fq)) pendingQueries.push(fq);
            }
        };

        // Checkpoint for deep_research({resume_id}). Page content is dropped: rankSource
        // has already used it and nothing later reads it.
        const checkpoint = () => saveResearchState({
            research: Object.fromEntries(Object.entries(research).filter(([k]) => k !== "abortController")) as ResearchState["research"],
            allFindings,
            allSources: allSources.map(s => ({ ...s, content: "" })),
            visitedUrls: Array.from(visitedUrls),
            usedQueries: Array.from(usedQueries),
            pendingQueries,
            rounds,
            currentRound: globalRound,
        });

        // ══════════════════════════════════════
        // PHASE 1: DISCOVERY (broad search)
        // ══════════════════════════════════════

        if (!skipDiscovery) {
            research.currentPhase = 1;
            console.log(`[RESEARCH] ═══ PHASE 1: DISCOVERY (${phase1Rounds} rounds) ═══`);
            await notify(`🌐 Phase 1: Discovery — searching the web${profile.useAcademicEngines ? " and academic databases" : ""}...`);
        }

        let allEnginesOfflineCount = 0; // Track rounds where ALL engines return 0 results

        for (let round = 0; round < phase1Rounds && !signal.aborted; round++) {
            if (allSources.length >= research.maxSources) break;

            // Replenish queries if running low
            if (pendingQueries.length < profile.concurrentQueries && allFindings.length > 0) {
                const more = await generateMoreQueries(llm, research.topic, allFindings.map(f => f.text), Array.from(usedQueries));
                pendingQueries.push(...more.filter(q => !usedQueries.has(q)));
            }

            if (pendingQueries.length === 0) {
                pendingQueries.push(`${research.topic} latest`, `${research.topic} analysis`, `${research.topic} review`);
            }

            // Take batch of concurrent queries
            const queryBatch = pendingQueries.splice(0, profile.concurrentQueries).filter(q => !usedQueries.has(q));
            for (const q of queryBatch) usedQueries.add(q);

            if (queryBatch.length === 0) continue;

            research.currentQuery = queryBatch[0];

            // Fire all queries in parallel
            const searchResults = await Promise.all(
                queryBatch.map(q => multiEngineSearch(q, profile.useAcademicEngines))
            );

            // Merge all results
            const allResults = searchResults.flatMap(r => {
                for (const e of r.engines) engineBreakdown[e] = (engineBreakdown[e] || 0) + 1;
                return r.results;
            });

            // Deduplicate, adding as we go so two spellings of one page in this batch
            // collapse too (Set.add returns the set, which is truthy)
            const newResults = allResults.filter(r => !visitedUrls.has(r.url) && visitedUrls.add(r.url));

            if (newResults.length === 0) {
                consecutiveFailures++;
                allEnginesOfflineCount++;

                // If ALL engines returned 0 results for 3+ consecutive rounds, check if internet is down
                if (allEnginesOfflineCount >= 3) {
                    try {
                        const { isOffline, reportNetworkError } = await import("../network-health.js");
                        const netStatus = await reportNetworkError();
                        if (netStatus === "offline" || isOffline()) {
                            console.error(`[RESEARCH] ❌ Internet offline — aborting research after ${allEnginesOfflineCount} rounds with 0 results`);
                            research.status = "failed";
                            research.error = "The internet seemed to be down. It can be continued once back online.";
                            research.updatedAt = new Date().toISOString();
                            await notify(`⚠️ Research on "${research.topic.substring(0, 50)}" stopped: the internet seems to be down. Ask me to continue it once you're back online.`, true);
                            return;
                        }
                    } catch { /* network monitor not loaded */ }
                }

                // Retry with rephrased queries when all engines return nothing
                if (consecutiveFailures <= 3 && allSources.length < 10) {
                    const rephrasedQueries = [
                        `${research.topic} overview ${new Date().getFullYear()}`,
                        `${research.topic} guide explained`,
                        `"${research.topic.split(" ").slice(0, 4).join(" ")}" tips recommendations`,
                    ];
                    const rephrased = rephrasedQueries[consecutiveFailures - 1];
                    if (rephrased && !usedQueries.has(rephrased)) {
                        usedQueries.add(rephrased);
                        console.log(`[RESEARCH]   🔄 Retry ${consecutiveFailures}/3 with: "${rephrased.substring(0, 50)}..."`);
                        const retryResults = await multiEngineSearch(rephrased, profile.useAcademicEngines);
                        const retryNew = retryResults.results.filter(r => !visitedUrls.has(r.url) && visitedUrls.add(r.url));

                        if (retryNew.length > 0) {
                            for (const { page, analysis } of await analyzeBatch(await fetchPages(retryNew.slice(0, 10)))) {
                                if (signal.aborted || allSources.length >= research.maxSources) break;
                                ingest(page, analysis, retryNew.find(r => r.url === page.url)?.citationCount || 0);
                            }
                            consecutiveFailures = 0;
                            rateLimiter.onSuccess();
                        }
                    }
                }

                if (consecutiveFailures >= 5) { await rateLimiter.wait(); await rateLimiter.wait(); consecutiveFailures = 0; }
                continue;
            }
            consecutiveFailures = 0;
            allEnginesOfflineCount = 0; // Reset — we got results
            rateLimiter.onSuccess();

            // Fetch pages
            const toFetch = newResults.slice(0, Math.min(newResults.length, research.maxSources - allSources.length));
            const pages = await fetchPages(toFetch);

            // Analyze each page
            for (const { page, analysis } of await analyzeBatch(pages)) {
                if (signal.aborted || allSources.length >= research.maxSources) break;
                ingest(page, analysis, newResults.find(r => r.url === page.url)?.citationCount || 0);
            }

            globalRound++;
            trimFindings(); // Memory leak prevention: cap findings array
            rounds.push({ query: queryBatch.join(" | "), engine: "multi", sourcesFound: allResults.length, sourcesProcessed: pages.filter(p => p.content.length > 100).length, keyFindings: allFindings.slice(-5).map(f => f.text), phase: 1 });

            research.sourcesProcessed = allSources.length;
            research.roundsCompleted = globalRound;
            research.findingsCount = allFindings.length;
            research.engineBreakdown = engineBreakdown;
            research.updatedAt = new Date().toISOString();

            // Rounds still to go in Phases 1 and 2, at this run's pace, plus about a minute to write it up.
            const avgTimePerRound = (Date.now() - roundStartTime) / Math.max(1, globalRound - startRound);
            research.estimatedTimeRemaining = Math.round(((phase1Rounds - round - 1 + phase2Rounds) * avgTimePerRound) / 1000) + 60;

            if (round % 3 === 0) {
                await notify(`🔍 Phase 1 round ${round + 1}/${phase1Rounds}: ${allSources.length} sources, ${allFindings.length} findings`);
            }

            await checkpoint();
            await rateLimiter.wait();
        }

        if (signal.aborted) { research.status = "cancelled"; return; }

        // ── Dynamic Phase Adjustment ──
        // If Phase 1 found too few sources, steal rounds from Phase 2
        let adjustedPhase2Rounds = phase2Rounds;
        if (!skipDiscovery && allSources.length < 10 && !signal.aborted) {
            const extraRounds = Math.min(5, phase2Rounds);
            console.log(`[RESEARCH]   ⚠️ Phase 1 found only ${allSources.length} sources — running ${extraRounds} extra discovery rounds`);
            await notify(`🔄 Expanding discovery — only ${allSources.length} sources found, searching harder...`);

            const broadQueries = [
                `${research.topic} comprehensive guide`,
                `${research.topic} detailed review`,
                `${research.topic} recommendations tips`,
                `best ${research.topic}`,
                `${research.topic} reddit`,
            ];

            for (let i = 0; i < extraRounds && !signal.aborted; i++) {
                const bq = broadQueries[i % broadQueries.length];
                if (usedQueries.has(bq)) continue;
                usedQueries.add(bq);

                const { results, engines } = await multiEngineSearch(bq, profile.useAcademicEngines);
                for (const e of engines) engineBreakdown[e] = (engineBreakdown[e] || 0) + 1;
                const newR = results.filter(r => !visitedUrls.has(r.url) && visitedUrls.add(r.url));

                if (newR.length > 0) {
                    for (const { page, analysis } of await analyzeBatch(await fetchPages(newR.slice(0, 8)))) {
                        if (signal.aborted || allSources.length >= research.maxSources) break;
                        ingest(page, analysis, 0);
                    }
                }

                globalRound++;
                trimFindings(); // Memory leak prevention: cap findings array
                research.sourcesProcessed = allSources.length;
                research.roundsCompleted = globalRound;
                research.findingsCount = allFindings.length;
                research.updatedAt = new Date().toISOString();
                await checkpoint();
                await rateLimiter.wait();
            }

            adjustedPhase2Rounds = Math.max(1, phase2Rounds - extraRounds);
        }

        if (signal.aborted) { research.status = "cancelled"; return; }

        // ══════════════════════════════════════
        // PHASE 2: DEEP READING (follow citations)
        // ══════════════════════════════════════

        research.currentPhase = 2;
        console.log(`[RESEARCH] ═══ PHASE 2: DEEP READING (${adjustedPhase2Rounds} rounds, citation depth: ${profile.citationDepth}) ═══`);
        await notify(`📖 Phase 2: Deep Reading — ${profile.citationDepth > 0 ? `following citation chains (depth ${profile.citationDepth})` : "reading more sources from follow-up searches"}...`);

        // Sort sources by score, read top unread ones more deeply
        const sourcesToDeepRead = [...allSources].sort((a, b) => b.finalScore - a.finalScore);
        let citationQueue: Array<{ url: string; title: string; depth: number }> = [];

        // Add citation chain links from top sources
        if (profile.citationDepth > 0) {
            for (const source of sourcesToDeepRead.slice(0, 30)) {
                const links = rankOutboundLinks(source.outboundLinks, visitedUrls, 5, research.topic);
                for (const link of links) {
                    citationQueue.push({ url: link, title: `Citation from: ${source.title}`, depth: 1 });
                }
            }
        }

        for (let round = 0; round < adjustedPhase2Rounds && !signal.aborted; round++) {
            if (allSources.length >= research.maxSources) break;

            // Also generate more targeted queries based on findings
            if (round % 3 === 0 && pendingQueries.length < 3 && allFindings.length > 5) {
                const more = await generateMoreQueries(llm, research.topic, allFindings.map(f => f.text), Array.from(usedQueries));
                pendingQueries.push(...more.filter(q => !usedQueries.has(q)));
            }

            // Mix: some from citation chain, some from new queries
            const toFetchUrls: Array<{ url: string; title: string }> = [];

            // Take from citation queue
            while (citationQueue.length > 0 && toFetchUrls.length < 5) {
                const item = citationQueue.shift()!;
                if (!visitedUrls.has(item.url)) {
                    visitedUrls.add(item.url);
                    toFetchUrls.push(item);
                }
            }

            // Fill remaining with search results
            if (toFetchUrls.length < 8 && pendingQueries.length > 0) {
                const query = pendingQueries.shift()!;
                if (!usedQueries.has(query)) {
                    usedQueries.add(query);
                    research.currentQuery = query;
                    const { results, engines } = await multiEngineSearch(query, profile.useAcademicEngines);
                    for (const e of engines) engineBreakdown[e] = (engineBreakdown[e] || 0) + 1;
                    for (const r of results) {
                        if (toFetchUrls.length >= 8) break;
                        if (visitedUrls.has(r.url)) continue;
                        visitedUrls.add(r.url);
                        toFetchUrls.push(r);
                    }
                }
            }

            if (toFetchUrls.length === 0) continue;

            const pages = await fetchPages(toFetchUrls);

            for (const { page, analysis } of await analyzeBatch(pages)) {
                if (signal.aborted || allSources.length >= research.maxSources) break;
                ingest(page, analysis, 0);
                for (const f of analysis.findings) {
                    // ── Update hypotheses with new evidence ──
                    for (let hIdx = 0; hIdx < hypotheses.length; hIdx++) {
                        const h = hypotheses[hIdx];
                        if (h.status === "supported" || h.status === "refuted") continue;
                        const fLower = f.toLowerCase();
                        const hLower = h.statement.toLowerCase();
                        // Check if finding is relevant to this hypothesis
                        const hWords = hLower.split(/\s+/).filter(w => w.length > 4);
                        const matchCount = hWords.filter(w => fLower.includes(w)).length;
                        if (matchCount >= 2) {
                            // Simple heuristic: if finding mentions hypothesis keywords, treat as supporting
                            const supports = !fLower.includes("not ") && !fLower.includes("false") && !fLower.includes("incorrect");
                            hypotheses[hIdx] = updateHypothesis(h, f, supports, 0.5);
                        }
                    }
                }

                // Extract outbound links for citation chain
                if (profile.citationDepth > 1) {
                    const topLinks = rankOutboundLinks(page.links, visitedUrls, 3, research.topic);
                    for (const link of topLinks) {
                        citationQueue.push({ url: link, title: `Citation chain`, depth: 2 });
                    }
                }
            }

            globalRound++;
            trimFindings(); // Memory leak prevention: cap findings array
            rounds.push({ query: toFetchUrls.map(u => u.url).join(", "), engine: "phase2", sourcesFound: toFetchUrls.length, sourcesProcessed: pages.filter(p => p.content.length > 100).length, keyFindings: allFindings.slice(-3).map(f => f.text), phase: 2 });

            research.sourcesProcessed = allSources.length;
            research.roundsCompleted = globalRound;
            research.findingsCount = allFindings.length;
            research.updatedAt = new Date().toISOString();
            // Rounds still to go in this phase, at this run's pace, plus about a minute to write it up.
            const avgPerRound = (Date.now() - roundStartTime) / Math.max(1, globalRound - startRound);
            research.estimatedTimeRemaining = Math.round(((adjustedPhase2Rounds - round - 1) * avgPerRound) / 1000) + 60;

            if (round % 5 === 0) {
                await notify(`📖 Phase 2 round ${round + 1}/${adjustedPhase2Rounds}: ${allSources.length} sources, ${allFindings.length} findings, ${citationQueue.length} citations queued`);
            }

            await checkpoint();
            await rateLimiter.wait();
        }

        if (signal.aborted) { research.status = "cancelled"; return; }

        // ══════════════════════════════════════
        // PHASE 3: VERIFICATION & SYNTHESIS
        // ══════════════════════════════════════

        research.currentPhase = 3;
        research.estimatedTimeRemaining = 60;
        console.log(`[RESEARCH] ═══ PHASE 3: VERIFICATION & SYNTHESIS ═══`);
        await notify(`🔬 Phase 3: Verifying ${allFindings.length} findings, detecting contradictions, synthesizing report...`);

        // If we have almost nothing, produce a warning report instead of synthesizing air
        if (allSources.length < 3 && allFindings.length < 5) {
            const warningReport = `## Research: ${research.topic}\n\n**⚠️ Limited Results**\nOnly ${allSources.length} source(s) and ${allFindings.length} finding(s) could be gathered. Search engines may be experiencing issues or the topic may be very niche.\n\n### Findings\n${allFindings.map(f => `- ${f.text} _(source: ${f.sourceUrl})_`).join("\n") || "No findings."}\n\n### Sources\n${allSources.map(s => `- [${s.title}](${s.url})`).join("\n") || "None."}\n\n_Consider retrying with a "deep" or "exhaustive" profile for better results._`;

            await fs.mkdir(RESEARCH_DIR, { recursive: true });
            const filename = research.topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").substring(0, 50) + `-${research.id}.md`;
            const filePath = join(RESEARCH_DIR, filename);
            await fs.writeFile(filePath, warningReport);

            research.report = warningReport;
            research.reportFile = filePath;
            research.status = "completed";
            research.engineBreakdown = engineBreakdown;
            research.updatedAt = new Date().toISOString();

            const duration = Math.round((Date.now() - new Date(research.startedAt).getTime()) / 1000);
            console.log(`[RESEARCH] ⚠️ Completed with limited results: ${allSources.length} sources, ${allFindings.length} findings, ${duration}s`);
            await notify(`⚠️ Only ${allSources.length} source(s) found — writing up what there is…`);
            return;
        }

        // Deduplicate findings (by object, so exact-duplicate texts collapse to
        // one representative instead of all copies re-matching by value)
        const dedupedFindings = dedupeByText(allFindings, f => f.text);
        console.log(`[RESEARCH]   Deduplication: ${allFindings.length} → ${dedupedFindings.length} findings`);

        // Cross-reference for confidence levels
        const structuredFindings = crossReferenceFindings(dedupedFindings, allSources);
        console.log(`[RESEARCH]   Confidence: ${structuredFindings.filter(f => f.confidence === "strong").length} strong, ${structuredFindings.filter(f => f.confidence === "moderate").length} moderate, ${structuredFindings.filter(f => f.confidence === "weak").length} weak`);

        // Cancelled while Phase 3 runs: stop before each long model call and before saving
        // (it used to finish, mark itself "completed" and start the follow-up agent).
        const cancelled = () => {
            if (signal.aborted) research.status = "cancelled";
            return signal.aborted;
        };

        // Detect contradictions
        if (cancelled()) return;
        const contradictions = await detectContradictions(llm, structuredFindings.map(f => f.text));
        console.log(`[RESEARCH]   Contradictions found: ${contradictions.length}`);

        // Mark contradicted findings
        for (const c of contradictions) {
            const f1 = structuredFindings.find(f => f.text.includes(c.finding1.substring(0, 50)));
            const f2 = structuredFindings.find(f => f.text.includes(c.finding2.substring(0, 50)));
            if (f1 && f2 && f1 !== f2) {
                f1.contradictedBy.push(f2.sourceUrl);
                f2.contradictedBy.push(f1.sourceUrl);
            }
        }

        // ── Record claim verifications for credibility tracking ──
        try {
            for (const sf of structuredFindings) {
                const domain = getDomain(sf.sourceUrl);
                if (!domain) continue;
                if (sf.confidence === "strong") {
                    recordClaimVerification(domain, true, 0.7);
                } else if (sf.contradictedBy.length > 0) {
                    recordClaimVerification(domain, false, 0.5);
                } else if (sf.confidence === "moderate") {
                    recordClaimVerification(domain, true, 0.3);
                }
            }
            console.log(`[RESEARCH]   Credibility: Updated scores for ${new Set(structuredFindings.map(f => getDomain(f.sourceUrl))).size} domains`);
        } catch (credErr) {
            console.warn(`[RESEARCH]   Credibility update failed (non-fatal):`, (credErr as Error).message);
        }

        // ── Log hypothesis outcomes ──
        if (hypotheses.length > 0) {
            const supported = hypotheses.filter(h => h.status === "supported").length;
            const refuted = hypotheses.filter(h => h.status === "refuted").length;
            const inconclusive = hypotheses.filter(h => h.status === "inconclusive").length;
            console.log(`[RESEARCH]   Hypotheses: ${supported} supported, ${refuted} refuted, ${inconclusive} inconclusive`);
        }

        // Gap analysis
        if (cancelled()) return;
        const gaps = await identifyGaps(llm, research.topic, structuredFindings.slice(0, 40).map(f => f.text));
        console.log(`[RESEARCH]   Research gaps: ${gaps.length}`);

        // Final synthesis
        console.log(`[RESEARCH] 📝 Writing final report (router will select optimal model)...`);
        await notify(`📝 Synthesizing final report (${structuredFindings.length} findings, ${allSources.length} sources)...`);

        if (cancelled()) return;
        let report = await synthesizeResearch(
            llm, research.topic, structuredFindings, allSources.length,
            rounds.length, engineBreakdown, contradictions, gaps, profile,
            research.originalPrompt,
        );

        // Outreach-intent post-pass: if the user's prompt implies action
        // ("email them", "reach out to", "draft a pitch"), append a structured
        // Contacts table the agent continuation can act on. Source-backed only —
        // never invents emails or URLs.
        if (shouldExtractContacts(research.originalPrompt)) {
            await notify(`📇 Extracting contact paths for outreach...`);
            const contactsSection = await extractContactsSection(
                llm, research.topic, research.originalPrompt!, structuredFindings,
            );
            if (contactsSection) report += contactsSection;
        }

        // Save report to disk
        if (cancelled()) return;
        await fs.mkdir(RESEARCH_DIR, { recursive: true });
        const filename = research.topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").substring(0, 50) + `-${research.id}.md`;
        const filePath = join(RESEARCH_DIR, filename);
        await fs.writeFile(filePath, report);

        // Store findings in memory for follow-up questions
        await storeResearchInMemory(
            research.topic,
            basisTexts ? structuredFindings.filter(f => !basisTexts.has(f.text)) : structuredFindings,
            report, research.id, filePath,
        );

        research.report = report;
        research.reportFile = filePath;
        research.status = "completed";
        research.engineBreakdown = engineBreakdown;
        research.updatedAt = new Date().toISOString();

        const duration = Math.round((Date.now() - new Date(research.startedAt).getTime()) / 1000);
        console.log(`[RESEARCH] ✅ Complete: ${allSources.length} sources, ${structuredFindings.length} findings, ${duration}s`);
        // Progress only: the answer itself comes from the follow-up run in research/index.ts.
        await notify(`📝 Report written — reading it for you…`);

    } catch (err) {
        if (signal.aborted) {
            research.status = "cancelled"; // an abort surfacing as an error is still a cancel
            return;
        }
        research.status = "failed";
        research.error = (err as Error).message;
        research.updatedAt = new Date().toISOString();
        console.error(`[RESEARCH] ❌ Failed: ${(err as Error).message}`);
        await notify(`❌ Research on "${research.topic.substring(0, 50)}" failed: ${(err as Error).message}`, true);
    }
}
