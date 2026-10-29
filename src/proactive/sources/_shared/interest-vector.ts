// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDataDir } from "../../../config/paths.js";
import { embedText } from "../../../memory/embeddings.js";
import { recall } from "../../../memory/sqlite.js";

const WEEK_MS = 7 * 86_400_000;
const VECTOR_FILE = path.join(getDataDir(), "interest-vector.bin");
const KEYWORD_COUNT = 3;

const STOP = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "have",
    "are",
    "was",
    "were",
    "not",
    "but",
    "you",
    "can",
    "all",
    "has",
    "her",
    "his",
    "they",
    "their",
    "what",
    "will",
    "when",
    "how",
]);

type InterestResult = {
    vector: number[];
    keywords: string[];
    builtAt: number;
};

let cached: InterestResult | null = null;

async function buildVector(): Promise<InterestResult> {
    const results = await recall("interests topics learning technology", 20, undefined, undefined, undefined, undefined, { touch: false });
    const texts: string[] = results.map((r) => r.content ?? "").filter(Boolean);

    if (texts.length === 0) {
        return { vector: new Array(384).fill(0), keywords: [], builtAt: Date.now() };
    }

    const embeddings: number[][] = [];
    for (const t of texts) {
        try {
            const raw = await embedText(t, "document");
            embeddings.push(Array.from(raw));
        } catch {
            // skip failed embedding
        }
    }

    if (embeddings.length === 0) {
        return { vector: new Array(384).fill(0), keywords: [], builtAt: Date.now() };
    }

    const dim = embeddings[0].length;
    const vector = new Array(dim).fill(0);
    for (const e of embeddings) {
        for (let i = 0; i < dim; i++) vector[i] += e[i];
    }
    for (let i = 0; i < dim; i++) vector[i] /= embeddings.length;

    const wordCounts = new Map<string, number>();
    for (const t of texts) {
        const words = t.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
        for (const w of words) {
            wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
        }
    }
    const keywords = Array.from(wordCounts.entries())
        .filter(([w]) => !STOP.has(w))
        .sort((a, b) => b[1] - a[1])
        .slice(0, KEYWORD_COUNT)
        .map(([w]) => w);

    return { vector, keywords, builtAt: Date.now() };
}

async function readFromDisk(): Promise<InterestResult | null> {
    try {
        const stat = await fs.stat(VECTOR_FILE);
        if (Date.now() - stat.mtimeMs > WEEK_MS) return null;
        const buf = await fs.readFile(VECTOR_FILE);
        const parsed = JSON.parse(buf.toString());
        return parsed as InterestResult;
    } catch {
        return null;
    }
}

async function writeToDisk(result: InterestResult): Promise<void> {
    try {
        await fs.mkdir(path.dirname(VECTOR_FILE), { recursive: true });
        await fs.writeFile(VECTOR_FILE, JSON.stringify(result));
    } catch {
        // non-fatal
    }
}

export async function getInterestVector(): Promise<InterestResult> {
    if (cached && Date.now() - cached.builtAt < WEEK_MS) return cached;
    const onDisk = await readFromDisk();
    if (onDisk) {
        cached = onDisk;
        return onDisk;
    }
    const built = await buildVector();
    cached = built;
    await writeToDisk(built);
    return built;
}

export function _resetInterestVectorCache(): void {
    cached = null;
}
