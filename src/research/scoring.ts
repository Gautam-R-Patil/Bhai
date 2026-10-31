// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Deep Research v2 — Source ranking, finding dedup, cross-referencing

import type { RankedSource, RawFinding, StructuredFinding } from "./types.js";
import { scoreDomainQuality, getDomain } from "./fetcher.js";
import { getCredibility } from "./credibility-model.js";

// ── Source Ranking ───────────────────────────

export function rankSource(
    url: string,
    title: string,
    content: string,
    findings: string[],
    citationCount = 0,
    topic?: string,
): RankedSource {
    const domain = getDomain(url);
    const domainScore = scoreDomainQuality(url, topic);
    const contentDepth = Math.min(1, content.length / 30000); // normalized, 30KB = 1.0
    const findingDensity = content.length > 0
        ? Math.min(1, (findings.length / (content.length / 1000)) * 0.5)
        : 0;

    // Recency: the latest year the page mentions, ignoring future ones (plans, forecasts)
    let recencyScore = 0.3; // default: unknown date
    const currentYear = new Date().getFullYear();
    const years = [...content.matchAll(/\b(20\d\d)\b/g)].map((m) => Number(m[1])).filter((y) => y <= currentYear);
    if (years.length > 0) {
        const age = currentYear - Math.max(...years);
        recencyScore = age <= 0 ? 1.0 : age === 1 ? 0.8 : age === 2 ? 0.6 : 0.4;
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

// ── URL identity ─────────────────────────────

const TRACKING_PARAM = /^(utm_[a-z]+|fbclid|gclid|mc_[a-z]+|ref|ref_src)$/i;

/**
 * One key per page: http vs https, www., a trailing slash, a #fragment or tracking
 * parameters made the same page count as several independent sources (and so as
 * corroboration of its own findings).
 */
export function normalizeUrl(url: string): string {
    try {
        const u = new URL(url);
        const params = [...u.searchParams].filter(([k]) => !TRACKING_PARAM.test(k));
        params.sort(([a], [b]) => a.localeCompare(b));
        const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
        return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${query}`;
    } catch {
        return url;
    }
}

/** A Set of URLs keyed by normalizeUrl. */
export class UrlSet extends Set<string> {
    override add(url: string): this {
        return super.add(normalizeUrl(url));
    }
    override has(url: string): boolean {
        return super.has(normalizeUrl(url));
    }
}

// ── Finding Deduplication ────────────────────

// Letters, marks and digits of any script: an ASCII-only filter left Hindi, CJK, Arabic or
// Cyrillic findings with no words at all, and two empty sets counted as identical, so
// every such finding was a "duplicate" of the first.
function getWords(text: string): Set<string> {
    return new Set(
        text.toLowerCase()
            .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
            .split(/\s+/)
            .filter(w => w.length > 2)
    );
}

// Words that say nothing about the topic: a page that has only these didn't mention it.
const TOPIC_STOPWORDS = new Set(["what", "which", "with", "from", "about", "that", "this", "they", "have", "find", "best", "more", "most", "into", "your", "their", "there", "when", "where", "does", "should", "could", "would", "latest", "some", "than", "them", "were", "will", "also", "how", "the", "and", "for", "are", "why", "who"]);

/**
 * A page that never names the topic yields no findings, so it isn't worth a model call. Only
 * judged for a topic in plain ASCII: a Hindi or CJK topic is often researched from English pages.
 */
export function mentionsTopic(content: string, topic: string): boolean {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the full ASCII range
    if (!/^[\x00-\x7F]*$/.test(topic)) return true;
    const words = [...getWords(topic)].filter((w) => !TOPIC_STOPWORDS.has(w));
    if (words.length === 0) return true;
    const text = content.slice(0, 20000).toLowerCase();
    // Any one topic word, crudely stemmed, will do: requiring two dropped "lithium-ion battery"
    // for "lithium batteries", and every English page for a Hinglish topic.
    const stem = (w: string) => (w.length > 3 ? w.replace(/(ies|es|s)$/, "") : w);
    return words.some((w) => text.includes(stem(w)));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0; // nothing to compare is not "the same"
    let intersection = 0;
    for (const word of a) { if (b.has(word)) intersection++; }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

// Dedup items by their text, keeping ONE representative per near-duplicate
// cluster. Operates on indices, so exact-duplicate texts collapse to a single
// item — unlike re-filtering the originals by `dedupedTexts.includes(text)`,
// which re-admits every copy of a surviving text (the dedup becomes a no-op for
// exact dupes, duplicating findings in the report and memory).
export function dedupeByText<T>(items: T[], getText: (item: T) => string): T[] {
    if (items.length <= 1) return items;

    const wordSets = items.map(it => getWords(getText(it)));
    const keep = new Array(items.length).fill(true);

    for (let i = 0; i < items.length; i++) {
        if (!keep[i]) continue;
        for (let j = i + 1; j < items.length; j++) {
            if (!keep[j]) continue;
            if (jaccardSimilarity(wordSets[i], wordSets[j]) > 0.6) {
                // Keep the longer/more detailed one
                if (getText(items[i]).length >= getText(items[j]).length) {
                    keep[j] = false;
                } else {
                    keep[i] = false;
                    break;
                }
            }
        }
    }

    return items.filter((_, i) => keep[i]);
}

export function deduplicateFindings(findings: string[]): string[] {
    return dedupeByText(findings, f => f);
}

// ── Cross-Reference Findings ─────────────────

export function crossReferenceFindings(
    findings: RawFinding[],
    allSources: RankedSource[],
): StructuredFinding[] {
    const structured: StructuredFinding[] = [];

    for (const finding of findings) {
        const words = getWords(finding.text);
        const supportingSources: string[] = [];

        // Check how many other sources mention similar content
        for (const source of allSources) {
            if (normalizeUrl(source.url) === normalizeUrl(finding.sourceUrl)) continue;
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
