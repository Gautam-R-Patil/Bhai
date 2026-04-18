// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Deep Research v2 — LLM analysis helpers

import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";
import { selectForResearch, selectForSynthesis } from "../model-router.js";
import type { StructuredFinding, Contradiction, ResearchProfile } from "./types.js";
import { extractJSON } from "../utils/json-extract.js";

// ── Safe JSON Parsing ────────────────────────

export function parseJsonSafe(text: string): any | null {
    const jsonStr = extractJSON(text);
    if (!jsonStr) return null;
    try { return JSON.parse(jsonStr); } catch { return null; }
}

// ── Generate Seed Queries ────────────────────

export async function generateSeedQueries(
    llm: LLMClient,
    topic: string,
    profile: ResearchProfile,
): Promise<string[]> {
    const academicInstructions = profile.useAcademicEngines
        ? `\n- Academic papers (include "arxiv", "paper", "survey", "review" in some queries)
- Semantic Scholar / Google Scholar queries
- Specific researchers or research groups in this field`
        : "";

    const prompt = `You are a research query strategist. Generate 15-20 diverse search queries to thoroughly research this topic from multiple angles.

Research topic: "${topic}"

Generate queries targeting:
- Overview and fundamentals
- Recent developments and breakthroughs (2024-2026)
- Technical details and implementations
- Real-world applications and case studies
- Comparisons and alternatives
- Challenges and limitations
- Future directions and predictions
- Different terminology and synonyms${academicInstructions}
- Industry reports and expert opinions
- Specific sub-topics and niche areas

Output JSON only:
{ "queries": ["query 1", "query 2", ...] }`;

    try {
        const response = await llm.chat({
            messages: [{ role: "user", content: prompt }] as ChatCompletionMessageParam[],
            systemPrompt: "You are a research strategist. Output valid JSON only. No markdown fences.",
            modelOverride: selectForResearch(topic).modelId,
        });
        const text = response.choices?.[0]?.message?.content || "";
        const parsed = parseJsonSafe(text);
        const queries = Array.isArray(parsed?.queries) ? parsed.queries : [];
        return queries.length > 0 ? queries : [topic];
    } catch {
        return [topic, `${topic} overview`, `${topic} recent advances`, `${topic} examples`];
    }
}

// ── Generate More Queries ────────────────────

export async function generateMoreQueries(
    llm: LLMClient,
    topic: string,
    existingFindings: string[],
    usedQueries: string[],
): Promise<string[]> {
    const prompt = `Research topic: "${topic}"

Already searched:
${usedQueries.slice(-10).map(q => `- "${q}"`).join("\n")}

Key findings so far:
${existingFindings.slice(-15).map(f => `- ${f.substring(0, 100)}`).join("\n")}

Generate 8-10 NEW search queries that:
1. Explore angles not yet covered
2. Dig deeper into the most promising findings
3. Use different terminology/synonyms
4. Target specific technical details
5. Look for contradicting evidence or alternative viewpoints

Output JSON only: { "queries": ["query 1", ...] }`;

    try {
        const response = await llm.chat({
            messages: [{ role: "user", content: prompt }] as ChatCompletionMessageParam[],
            systemPrompt: "Output valid JSON only.",
            modelOverride: selectForResearch(topic).modelId,
        });
        const parsed = parseJsonSafe(response.choices?.[0]?.message?.content || "");
        return Array.isArray(parsed?.queries) ? parsed.queries : [];
    } catch { return []; }
}

// ── Analyze Page Content ─────────────────────

export async function analyzeAndExtract(
    llm: LLMClient,
    topic: string,
    pageContent: string,
    pageUrl: string,
): Promise<{ findings: string[]; followUpQueries: string[]; categories: string[] }> {
    const prompt = `Analyzing page for research on: "${topic}"

URL: ${pageUrl}
Content (first 10KB):
${pageContent.substring(0, 10000)}

Tasks:
1. Extract the 5-10 most important findings related to the topic. Be specific — include numbers, dates, names, technical details.
2. Suggest 3-5 follow-up search queries to deepen the investigation.
3. Categorize the findings into 1-3 theme categories.

Output JSON only:
{
  "findings": ["finding 1 with specific details", ...],
  "follow_up_queries": ["query 1", ...],
  "categories": ["category 1", ...]
}`;

    try {
        const response = await llm.chat({
            messages: [{ role: "user", content: prompt }] as ChatCompletionMessageParam[],
            systemPrompt: "You are a thorough research analyst. Extract specific, detailed findings. Output valid JSON only.",
            modelOverride: selectForResearch(topic).modelId,
        });
        const parsed = parseJsonSafe(response.choices?.[0]?.message?.content || "");
        return {
            findings: Array.isArray(parsed?.findings) ? parsed.findings : [],
            followUpQueries: Array.isArray(parsed?.follow_up_queries) ? parsed.follow_up_queries : [],
            categories: Array.isArray(parsed?.categories) ? parsed.categories : [],
        };
    } catch { return { findings: [], followUpQueries: [], categories: [] }; }
}

// ── Detect Contradictions ────────────────────

export async function detectContradictions(
    llm: LLMClient,
    findings: string[],
): Promise<Contradiction[]> {
    if (findings.length < 5) return [];

    const prompt = `Here are research findings from multiple sources. Identify any CONTRADICTIONS — findings that directly conflict with each other.

Findings:
${findings.slice(0, 60).map((f, i) => `${i + 1}. ${f}`).join("\n")}

Find pairs of findings that contradict each other. Output JSON:
{ "contradictions": [{ "finding1": "text of finding 1", "finding2": "text of finding 2", "explanation": "why they contradict" }] }

If no contradictions found, return: { "contradictions": [] }`;

    try {
        const response = await llm.chat({
            messages: [{ role: "user", content: prompt }] as ChatCompletionMessageParam[],
            systemPrompt: "Identify factual contradictions only. Output valid JSON.",
            modelOverride: selectForResearch(findings.slice(0, 5).join("; ")).modelId,
        });
        const parsed = parseJsonSafe(response.choices?.[0]?.message?.content || "");
        return Array.isArray(parsed?.contradictions) ? parsed.contradictions : [];
    } catch { return []; }
}

// ── Gap Analysis ─────────────────────────────

export async function identifyGaps(
    llm: LLMClient,
    topic: string,
    findings: string[],
): Promise<string[]> {
    const prompt = `Research topic: "${topic}"

Key findings collected:
${findings.slice(0, 40).map((f, i) => `${i + 1}. ${f}`).join("\n")}

What important questions about "${topic}" are NOT answered by these findings? What gaps remain? List 5-8 unanswered questions or areas needing more research.

Output JSON: { "gaps": ["gap 1", "gap 2", ...] }`;

    try {
        const response = await llm.chat({
            messages: [{ role: "user", content: prompt }] as ChatCompletionMessageParam[],
            systemPrompt: "Output valid JSON only.",
            modelOverride: selectForResearch(topic).modelId,
        });
        const parsed = parseJsonSafe(response.choices?.[0]?.message?.content || "");
        return Array.isArray(parsed?.gaps) ? parsed.gaps : [];
    } catch { return []; }
}

// ── Synthesis ────────────────────────────────

export async function synthesizeResearch(
    llm: LLMClient,
    topic: string,
    findings: StructuredFinding[],
    sourceCount: number,
    roundCount: number,
    engineBreakdown: Record<string, number>,
    contradictions: Contradiction[],
    gaps: string[],
    profile: ResearchProfile,
): Promise<string> {
    const strongFindings = findings.filter(f => f.confidence === "strong");
    const moderateFindings = findings.filter(f => f.confidence === "moderate");
    const weakFindings = findings.filter(f => f.confidence === "weak");

    const categories = [...new Set(findings.map(f => f.category))];

    const enginesStr = Object.entries(engineBreakdown).map(([e, c]) => `${e}: ${c}`).join(", ");
    const contStr = contradictions.length > 0
        ? contradictions.map(c => `- "${c.finding1}" vs "${c.finding2}" — ${c.explanation}`).join("\n")
        : "None identified.";
    const gapsStr = gaps.length > 0 ? gaps.map(g => `- ${g}`).join("\n") : "None identified.";

    const prompt = `Write a comprehensive, publication-quality research report on: "${topic}"

RESEARCH STATISTICS:
- Rounds completed: ${roundCount}
- Sources analyzed: ${sourceCount}
- Total findings: ${findings.length} (${strongFindings.length} strong, ${moderateFindings.length} moderate, ${weakFindings.length} weak confidence)
- Engines used: ${enginesStr}
- Themes discovered: ${categories.join(", ")}

STRONG-CONFIDENCE FINDINGS (supported by 3+ independent sources):
${strongFindings.slice(0, 50).map((f, i) => `${i + 1}. ${f.text} [Source: ${f.sourceTitle}] [Also supported by: ${f.supportingSources.length} other sources]`).join("\n")}

MODERATE-CONFIDENCE FINDINGS (2 sources):
${moderateFindings.slice(0, 30).map((f, i) => `${i + 1}. ${f.text} [Source: ${f.sourceTitle}]`).join("\n")}

WEAK-CONFIDENCE FINDINGS (single source):
${weakFindings.slice(0, 20).map((f, i) => `${i + 1}. ${f.text} [Source: ${f.sourceTitle}]`).join("\n")}

CONTRADICTIONS FOUND:
${contStr}

RESEARCH GAPS:
${gapsStr}

Write the report with this EXACT structure:
# Research Report: ${topic}

## Executive Summary
(2-3 sentences summarizing the key takeaways)

## Key Findings
(Organized by theme. For each finding, indicate confidence level [Strong/Moderate/Weak] and number of supporting sources)

## Detailed Analysis
(Deep dive into each theme with cross-references between sources)

## Contradictions & Open Debates
(Areas where sources disagree, with explanation of each position)

## Methodology
(Search engines used, number of queries, sources read, citation depth, research profile used)

## Gaps & Future Research Directions
(What questions remain unanswered)

## Sources
(Full bibliography, organized by relevance)

Be thorough, specific, and analytical. Include numbers, dates, and technical details. This is deep research, not a summary.`;

    try {
        const response = await llm.chat({
            messages: [{ role: "user", content: prompt }] as ChatCompletionMessageParam[],
            systemPrompt: "You are an expert research analyst writing a comprehensive, publication-quality report. Be thorough and detailed.",
            modelOverride: selectForSynthesis(topic).modelId,
        });
        return response.choices?.[0]?.message?.content || "(synthesis failed)";
    } catch {
        // Fallback: concatenate findings
        return `# Research: ${topic}\n\n## Key Findings\n${findings.slice(0, 100).map(f => `- [${f.confidence}] ${f.text}`).join("\n")}`;
    }
}
