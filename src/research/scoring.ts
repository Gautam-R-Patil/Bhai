// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Deep Research v2 — Source ranking, finding dedup, cross-referencing

import type { RankedSource, StructuredFinding } from "./types.js";
import { scoreDomainQuality, getDomain } from "./fetcher.js";
import { getCredibility } from "./credibility-model.js";

// ── Source Ranking ───────────────────────────

export function rankSource(
    url: string,
    title: string,
    content: string,
    findings: string[],
    citationCount = 0,
): RankedSource {
    const domain = getDomain(url);
    const domainScore = scoreDomainQuality(url);
    const contentDepth = Math.min(1, content.length / 30000); // normalized, 30KB = 1.0
    const findingDensity = content.length > 0
        ? Math.min(1, (findings.length / (content.length / 1000)) * 0.5)
        : 0;

    // Recency: detect year in content
    let recencyScore = 0.3; // default: unknown date
    const yearMatch = content.match(/\b(202[4-6])\b/);
    if (yearMatch) {
        const year = parseInt(yearMatch[1]);
        recencyScore = year >= 2026 ? 1.0 : year >= 2025 ? 0.8 : 0.6;
    }

    // Citation score (academic papers)
    const citScore = Math.min(1, citationCount / 100);

    // Credibility score from Bayesian tracking (defaults to 0.5 for unknown domains)
    const credibilityScore = getCredibility(domain);

    // Weighted combination (credibility adds signal from past research sessions)
    const finalScore =
        domainScore * 0.25 +
        contentDepth * 0.18 +
        findingDensity * 0.22 +
        recencyScore * 0.13 +
        citScore * 0.10 +
        credibilityScore * 0.12;

    return {
        url, title, content, domain, domainScore, contentDepth,
        findingDensity, recencyScore, citationCount, finalScore,
        findings, outboundLinks: [],
    };
}

// ── Finding Deduplication ────────────────────

function getWords(text: string): Set<string> {
    return new Set(
        text.toLowerCase()
            .replace(/[^a-z0-9\s]/g, "")
            .split(/\s+/)
            .filter(w => w.length > 2)
    );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    let intersection = 0;
    for (const word of a) { if (b.has(word)) intersection++; }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

export function deduplicateFindings(findings: string[]): string[] {
    if (findings.length <= 1) return findings;

    const wordSets = findings.map(f => getWords(f));
    const keep = new Array(findings.length).fill(true);

    for (let i = 0; i < findings.length; i++) {
        if (!keep[i]) continue;
        for (let j = i + 1; j < findings.length; j++) {
            if (!keep[j]) continue;
            if (jaccardSimilarity(wordSets[i], wordSets[j]) > 0.6) {
                // Keep the longer/more detailed one
                if (findings[i].length >= findings[j].length) {
                    keep[j] = false;
                } else {
                    keep[i] = false;
                    break;
                }
            }
        }
    }

    return findings.filter((_, i) => keep[i]);
}

// ── Cross-Reference Findings ─────────────────

export function crossReferenceFindings(
    findings: Array<{ text: string; sourceUrl: string; sourceTitle: string; categories: string[] }>,
    allSources: RankedSource[],
): StructuredFinding[] {
    const structured: StructuredFinding[] = [];

    for (const finding of findings) {
        const words = getWords(finding.text);
        const supportingSources: string[] = [];

        // Check how many other sources mention similar content
        for (const source of allSources) {
            if (source.url === finding.sourceUrl) continue;
            const sourceWords = getWords(source.findings.join(" "));
            if (jaccardSimilarity(words, sourceWords) > 0.15) {
                supportingSources.push(source.url);
            }
        }

        // Confidence based on independent source count
        let confidence: "strong" | "moderate" | "weak";
        if (supportingSources.length >= 2) confidence = "strong";
        else if (supportingSources.length === 1) confidence = "moderate";
        else confidence = "weak";

        structured.push({
            text: finding.text,
            sourceUrl: finding.sourceUrl,
            sourceTitle: finding.sourceTitle,
            confidence,
            supportingSources,
            contradictedBy: [],
            category: finding.categories[0] || "general",
        });
    }

    return structured;
}
