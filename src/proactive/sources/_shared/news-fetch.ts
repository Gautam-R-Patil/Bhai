// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { getLocation } from "../../../location/index.js";
import { embedText } from "../../../memory/embeddings.js";
import { getInterestVector } from "./interest-vector.js";
import * as native from "../../../../native/index.js";
import type { LLMClient } from "../../../llm.js";
import type { ScoredHeadline } from "../../../../native/index.js";

const TTL_MS = 6 * 3600_000;
const TOP_K = 3;

type NewsFetchResult = {
    headlines: ScoredHeadline[];
};

let cache: { result: NewsFetchResult; expires: number; key: string } | null = null;

function hashInterest(v: number[]): string {
    let h = 0;
    for (const x of v) { h = (h * 31 + Math.trunc(x * 1000)) | 0; }
    return String(h);
}

async function extractHeadlines(searchText: string, llm: LLMClient): Promise<string[]> {
    try {
        const resp = await llm.chat({
            messages: [
                {
                    role: "user" as const,
                    content: `Extract up to 5 distinct news headlines from this text. Return ONLY valid JSON: {"headlines": ["headline 1", ...]}\n\n${searchText.slice(0, 6000)}`,
                },
            ],
            systemPrompt: "You extract news headlines. Return only a JSON object with a headlines array (up to 5 strings). Each headline is one concise sentence.",
            responseFormat: "json_object",
            modelOverride: "openai/gpt-4.1-nano",
        });
        const content = resp.choices[0]?.message?.content ?? "";
        const parsed = JSON.parse(content);
        return Array.isArray(parsed.headlines) ? parsed.headlines.slice(0, 5) : [];
    } catch {
        return [];
    }
}

export type NewsFetchDeps = {
    llm: LLMClient | null;
    webSearch: (query: string) => Promise<string>;
};

export async function fetchNews(deps: NewsFetchDeps): Promise<NewsFetchResult> {
    const interest = await getInterestVector();
    const loc = getLocation();
    const locStr = loc?.city ?? "global";
    const key = `${locStr}:${hashInterest(interest.vector)}`;
    if (cache && cache.key === key && cache.expires > Date.now()) return cache.result;

    if (!deps.llm) return { headlines: [] };

    const interestQuery = process.env.BHAI_PROACTIVE_NEWS_QUERY
        ?? (interest.keywords.length > 0
            ? `${interest.keywords.join(" OR ")} news`
            : "tech news");
    const localQuery = loc?.city ? `news ${loc.city} today` : "news today";

    const [interestResult, localResult] = await Promise.all([
        deps.webSearch(interestQuery).catch(() => ""),
        deps.webSearch(localQuery).catch(() => ""),
    ]);

    const combined = `${interestResult}\n\n${localResult}`;
    const rawHeadlines = await extractHeadlines(combined, deps.llm);
    if (rawHeadlines.length === 0) {
        const result: NewsFetchResult = { headlines: [] };
        cache = { result, expires: Date.now() + TTL_MS, key };
        return result;
    }

    const interestDim = interest.vector;
    const embeddings: number[][] = [];
    for (const h of rawHeadlines) {
        try {
            const raw = await embedText(h, "document");
            const arr = Array.from(raw);
            // Trim to match interest vector dim
            embeddings.push(arr.slice(0, interestDim.length));
        } catch {
            embeddings.push(new Array(interestDim.length).fill(0));
        }
    }

    const scored = native.newsScoreHeadlines(rawHeadlines, interestDim, embeddings);
    const headlines = scored.slice(0, TOP_K);

    const result: NewsFetchResult = { headlines };
    cache = { result, expires: Date.now() + TTL_MS, key };
    return result;
}

export function _resetNewsCache(): void {
    cache = null;
}
