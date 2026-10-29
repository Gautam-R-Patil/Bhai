// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Deep Research v2 — 3-Phase multi-pass execution engine

import type { LLMClient } from "../llm.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type {
    ActiveResearch, ResearchProfile, RankedSource, StructuredFinding,
    ResearchRound, NotifyFn,
} from "./types.js";
import { RESEARCH_DIR, AdaptiveRateLimiter } from "./profiles.js";
import { multiEngineSearch, resetEngineHealth } from "./engines.js";
import { fetchPages, rankOutboundLinks, scoreDomainQuality, getDomain } from "./fetcher.js";
import {
    generateSeedQueries, generateMoreQueries, analyzeAndExtract,
    detectContradictions, identifyGaps, synthesizeResearch,
    shouldExtractContacts, extractContactsSection,
} from "./analysis.js";
import { crossReferenceFindings, dedupeByText, rankSource, UrlSet } from "./scoring.js";
import { saveResearchState, deleteResearchState, storeResearchInMemory } from "./persistence.js";
import { generateHypotheses, updateHypothesis, type Hypothesis, type ResearchPlan } from "./hypothesis-engine.js";
import { getCredibility, recordClaimVerification } from "./credibility-model.js";
import { getDimensionValue } from "../harness/registry.js";

// ── Main Background Execution ────────────────

export async function executeDeepResearch(
    research: ActiveResearch,
    profile: ResearchProfile,
    llm: LLMClient,
    notify: NotifyFn,
): Promise<void> {
    const allFindings: Array<{ text: string; sourceUrl: string; sourceTitle: string; categories: string[] }> = [];
    const allSources: RankedSource[] = [];
    const rounds: ResearchRound[] = [];
    const visitedUrls = new UrlSet(); // the same page under another URL spelling is visited once
    const usedQueries = new Set<string>();
    const signal = research.abortController.signal;
    const rateLimiter = new AdaptiveRateLimiter();

    // Memory leak prevention: cap findings array to avoid unbounded growth
    const MAX_FINDINGS = 1000;
    /** Trim allFindings to MAX_FINDINGS, keeping longer (higher-confidence) findings */
    function trimFindings(): void {
        if (allFindings.length <= MAX_FINDINGS) return;
        // Sort by text length descending (longer findings = more detail = higher confidence proxy)
        allFindings.sort((a, b) => b.text.length - a.text.length);
        allFindings.length = MAX_FINDINGS;
    }
    const engineBreakdown: Record<string, number> = {};

    // Reset engine health at the start of each research session
    resetEngineHealth();

    console.log(`[RESEARCH] 🔬 Starting: ${research.id} (${research.profile} profile)`);
    console.log(`[RESEARCH]   Topic: "${research.topic}"`);
    console.log(`[RESEARCH]   Depth: ${research.depth} rounds, max ${research.maxSources} sources`);
    console.log(`[RESEARCH]   Citation depth: ${profile.citationDepth}, Academic: ${profile.useAcademicEngines}`);

    await notify(`🔬 Deep research started: "${research.topic.substring(0, 50)}" (${research.profile} profile: ${research.depth} rounds, ${research.maxSources} sources)`);

    try {
        // ── Generate seed queries ──
        const seedQueries = await generateSeedQueries(llm, research.topic, profile);
        const pendingQueries = [...seedQueries];
        console.log(`[RESEARCH] 🌱 Generated ${seedQueries.length} seed queries`);

        // ── Hypothesis-driven research planning ──
        let researchPlan: ResearchPlan | null = null;
        let hypotheses: Hypothesis[] = [];
        try {
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
        const phase1Rounds = Math.ceil(research.depth * p1Ratio);  // Discovery
        const phase2Rounds = Math.ceil(research.depth * p2Ratio);  // Deep Reading
        const phase3Rounds = research.depth - phase1Rounds - phase2Rounds; // Verification

        let globalRound = 0;
        let consecutiveFailures = 0;
        const roundStartTime = Date.now();

        // ══════════════════════════════════════
        // PHASE 1: DISCOVERY (broad search)
        // ══════════════════════════════════════

        research.currentPhase = 1;
        console.log(`[RESEARCH] ═══ PHASE 1: DISCOVERY (${phase1Rounds} rounds) ═══`);
        await notify(`🌐 Phase 1: Discovery — casting a wide net across 6+ search engines...`);

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

            // Deduplicate
            const newResults = allResults.filter(r => !visitedUrls.has(r.url));
            for (const r of newResults) visitedUrls.add(r.url);

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
                            await notify(`Research aborted — internet connection appears to be down. Will resume when connectivity returns.`);
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
                        const retryNew = retryResults.results.filter(r => !visitedUrls.has(r.url));
                        for (const r of retryNew) visitedUrls.add(r.url);

                        if (retryNew.length > 0) {
                            const pages = await fetchPages(retryNew.slice(0, 10));
                            for (const page of pages) {
                                if (signal.aborted || allSources.length >= research.maxSources) break;
                                if (!page.content || page.content.length < 100) continue;
                                const analysis = await analyzeAndExtract(llm, research.topic, page.content, page.url);
                                if (analysis.findings.length > 0) {
                                    for (const f of analysis.findings) {
                                        allFindings.push({ text: f, sourceUrl: page.url, sourceTitle: page.title, categories: analysis.categories });
                                    }
                                    allSources.push({ ...rankSource(page.url, page.title, page.content, analysis.findings,
                                        retryNew.find(r => r.url === page.url)?.citationCount || 0, research.topic), outboundLinks: page.links });
                                    for (const fq of analysis.followUpQueries) {
                                        if (!usedQueries.has(fq) && !pendingQueries.includes(fq)) pendingQueries.push(fq);
                                    }
                                }
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
            for (const page of pages) {
                if (signal.aborted || allSources.length >= research.maxSources) break;
                if (!page.content || page.content.length < 100) continue;

                const analysis = await analyzeAndExtract(llm, research.topic, page.content, page.url);
                if (analysis.findings.length > 0) {
                    for (const f of analysis.findings) {
                        allFindings.push({ text: f, sourceUrl: page.url, sourceTitle: page.title, categories: analysis.categories });
                    }

                    const ranked = rankSource(page.url, page.title, page.content, analysis.findings,
                        newResults.find(r => r.url === page.url)?.citationCount || 0, research.topic);
                    ranked.outboundLinks = page.links;
                    allSources.push(ranked);

                    for (const fq of analysis.followUpQueries) {
                        if (!usedQueries.has(fq) && !pendingQueries.includes(fq)) pendingQueries.push(fq);
                    }
                }
            }

            globalRound++;
            trimFindings(); // Memory leak prevention: cap findings array
            rounds.push({ query: queryBatch.join(" | "), engine: "multi", sourcesFound: allResults.length, sourcesProcessed: pages.filter(p => p.content.length > 100).length, keyFindings: allFindings.slice(-5).map(f => f.text), phase: 1 });

            research.sourcesProcessed = allSources.length;
            research.roundsCompleted = globalRound;
            research.findingsCount = allFindings.length;
            research.engineBreakdown = engineBreakdown;
            research.updatedAt = new Date().toISOString();

            // Estimate time remaining
            const avgTimePerRound = (Date.now() - roundStartTime) / globalRound;
            research.estimatedTimeRemaining = Math.round(((research.depth - globalRound) * avgTimePerRound) / 1000);

            if (round % 3 === 0) {
                await notify(`🔍 Phase 1 round ${round + 1}/${phase1Rounds}: ${allSources.length} sources, ${allFindings.length} findings`);
            }

            // Save state periodically
            if (globalRound % 5 === 0) {
                await saveResearchState({
                    research: Object.fromEntries(Object.entries(research).filter(([k]) => k !== "abortController")) as any,
                    allFindings: allFindings.map(f => f.text),
                    structuredFindings: [],
                    allSources,
                    visitedUrls: Array.from(visitedUrls),
                    usedQueries: Array.from(usedQueries),
                    pendingQueries,
                    rounds,
                    currentRound: globalRound,
                });
            }

            await rateLimiter.wait();
        }

        if (signal.aborted) { research.status = "cancelled"; return; }

        // ── Dynamic Phase Adjustment ──
        // If Phase 1 found too few sources, steal rounds from Phase 2
        let adjustedPhase2Rounds = phase2Rounds;
        if (allSources.length < 10 && !signal.aborted) {
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
                const newR = results.filter(r => !visitedUrls.has(r.url));
                for (const r of newR) visitedUrls.add(r.url);

                if (newR.length > 0) {
                    const pages = await fetchPages(newR.slice(0, 8));
                    for (const page of pages) {
                        if (signal.aborted || allSources.length >= research.maxSources) break;
                        if (!page.content || page.content.length < 100) continue;
                        const analysis = await analyzeAndExtract(llm, research.topic, page.content, page.url);
                        if (analysis.findings.length > 0) {
                            for (const f of analysis.findings) {
                                allFindings.push({ text: f, sourceUrl: page.url, sourceTitle: page.title, categories: analysis.categories });
                            }
                            allSources.push({ ...rankSource(page.url, page.title, page.content, analysis.findings, 0, research.topic), outboundLinks: page.links });
                            for (const fq of analysis.followUpQueries) {
                                if (!usedQueries.has(fq) && !pendingQueries.includes(fq)) pendingQueries.push(fq);
                            }
                        }
                    }
                }

                globalRound++;
                trimFindings(); // Memory leak prevention: cap findings array
                research.sourcesProcessed = allSources.length;
                research.roundsCompleted = globalRound;
                research.findingsCount = allFindings.length;
                research.updatedAt = new Date().toISOString();
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
        await notify(`📖 Phase 2: Deep Reading — following citation chains (depth ${profile.citationDepth})...`);

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
                    const newResults = results.filter(r => !visitedUrls.has(r.url));
                    for (const r of newResults.slice(0, 8 - toFetchUrls.length)) {
                        visitedUrls.add(r.url);
                        toFetchUrls.push(r);
                    }
                }
            }

            if (toFetchUrls.length === 0) continue;

            const pages = await fetchPages(toFetchUrls);

            for (const page of pages) {
                if (signal.aborted || allSources.length >= research.maxSources) break;
                if (!page.content || page.content.length < 100) continue;

                const analysis = await analyzeAndExtract(llm, research.topic, page.content, page.url);
                if (analysis.findings.length > 0) {
                    for (const f of analysis.findings) {
                        allFindings.push({ text: f, sourceUrl: page.url, sourceTitle: page.title, categories: analysis.categories });

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

                    const ranked = rankSource(page.url, page.title, page.content, analysis.findings, 0, research.topic);

                    // Extract outbound links for citation chain
                    if (profile.citationDepth > 1) {
                        const links = page.links;
                        ranked.outboundLinks = links;
                        const topLinks = rankOutboundLinks(links, visitedUrls, 3, research.topic);
                        for (const link of topLinks) {
                            citationQueue.push({ url: link, title: `Citation chain`, depth: 2 });
                        }
                    }

                    allSources.push(ranked);
                    for (const fq of analysis.followUpQueries) {
                        if (!usedQueries.has(fq) && !pendingQueries.includes(fq)) pendingQueries.push(fq);
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

            if (round % 5 === 0) {
                await notify(`📖 Phase 2 round ${round + 1}/${adjustedPhase2Rounds}: ${allSources.length} sources, ${allFindings.length} findings, ${citationQueue.length} citations queued`);
            }

            if (globalRound % 5 === 0) {
                await saveResearchState({
                    research: Object.fromEntries(Object.entries(research).filter(([k]) => k !== "abortController")) as any,
                    allFindings: allFindings.map(f => f.text),
                    structuredFindings: [],
                    allSources,
                    visitedUrls: Array.from(visitedUrls),
                    usedQueries: Array.from(usedQueries),
                    pendingQueries,
                    rounds,
                    currentRound: globalRound,
                });
            }

            await rateLimiter.wait();
        }

        if (signal.aborted) { research.status = "cancelled"; return; }

        // ══════════════════════════════════════
        // PHASE 3: VERIFICATION & SYNTHESIS
        // ══════════════════════════════════════

        research.currentPhase = 3;
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
            await notify(`⚠️ Research complete with limited results (${allSources.length} sources). Search engines may be having issues. Report saved.`);
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
        await storeResearchInMemory(research.topic, structuredFindings, report);

        // Clean up state file
        await deleteResearchState(research.id);

        research.report = report;
        research.reportFile = filePath;
        research.status = "completed";
        research.engineBreakdown = engineBreakdown;
        research.updatedAt = new Date().toISOString();

        const duration = Math.round((Date.now() - new Date(research.startedAt).getTime()) / 1000);
        console.log(`[RESEARCH] ✅ Complete: ${allSources.length} sources, ${structuredFindings.length} findings, ${duration}s`);
        // Brief status notify — the actual user-facing message is produced by the
        // agent continuation in research/index.ts (which reads the report and
        // either summarizes or executes follow-up actions). The "✅" + "Research
        // complete" tokens here are what overlay-chat.ts matches to fire the
        // research_complete UI signal.
        await notify(`✅ Research complete — analyzing findings...`);

    } catch (err) {
        if (signal.aborted) {
            research.status = "cancelled"; // an abort surfacing as an error is still a cancel
            return;
        }
        research.status = "failed";
        research.error = (err as Error).message;
        research.updatedAt = new Date().toISOString();
        console.error(`[RESEARCH] ❌ Failed: ${(err as Error).message}`);
        await notify(`❌ Deep research failed: ${(err as Error).message}`);
    }
}
