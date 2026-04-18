// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Multimodal Embedding — Unified text + image vectors for cross-modal retrieval.
// "Remember that diagram I showed you" → find by image similarity.

import { embedText, cosineSimilarity, EMBEDDING_DIM } from "./embeddings.js";
import fs from "node:fs";

export interface MultimodalResult {
    id: string;
    similarity: number;
    modality: "text" | "image";
    content: string;
}

const imageEmbeddings = new Map<string, Float32Array>();
const imageDescriptions = new Map<string, string>();

export function storeImageEmbedding(id: string, embedding: Float32Array, description: string): void {
    imageEmbeddings.set(id, embedding);
    imageDescriptions.set(id, description);
}

export async function crossModalSearch(query: string, topK = 5): Promise<MultimodalResult[]> {
    if (imageEmbeddings.size === 0) return [];

    const queryEmb = await embedText(query, "query");
    const results: MultimodalResult[] = [];

    // Search images by comparing query embedding to image description embeddings
    for (const [id, emb] of imageEmbeddings) {
        const sim = cosineSimilarity(queryEmb, emb);
        results.push({ id, similarity: sim, modality: "image", content: imageDescriptions.get(id) || "" });
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
}

export function getStoredImageCount(): number { return imageEmbeddings.size; }
