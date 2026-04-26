// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// TypeScript wrapper for native SIMD module with automatic fallback

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// ── Types ────────────────────────────────────────

export interface SimilarityResult {
    index: number;
    score: number;
}

interface NativeModule {
    getVersion(): string;
    hasSimdSupport(): boolean;
    cosineSimilarity(a: Float32Array, b: Float32Array): number;
    dotProduct(a: Float32Array, b: Float32Array): number;
    euclideanDistance(a: Float32Array, b: Float32Array): number;
    magnitude(vec: Float32Array): number;
    normalize(vec: Float32Array): Float32Array;
    findTopKSimilar(query: Float32Array, vectors: Float32Array[], k: number): SimilarityResult[];
    batchCosineSimilarity(query: Float32Array, vectors: Float32Array[]): number[];
    batchPairwiseSimilarity(vectors: Float32Array[]): number[];
    quantizeToInt8(vec: Float32Array): Int8Array;
    dequantizeFromInt8(vec: Int8Array, minVal: number, maxVal: number): Float32Array;
    isNativeAvailable: boolean;
}

// ── Load native module ───────────────────────────

let nativeModule: NativeModule | null = null;
let useNative = false;

try {
    // process.cwd() = project root in dev, BOT_DIR in production build/bundle.
    const nativePath = path.join(process.cwd(), "native", "index.js");

    // Use synchronous createRequire (static import) — avoids top-level await in bundle
    const require = createRequire(import.meta.url);
    nativeModule = require(nativePath) as NativeModule;
    useNative = nativeModule?.isNativeAvailable ?? false;

    if (useNative) {
        console.log(`⚡ Native SIMD v${nativeModule!.getVersion()} loaded`);
    }
} catch {
    // Native module not available, will use fallbacks
}

// ── Fallback implementations ─────────────────────

function fallbackCosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA * normB);
    return denom === 0 ? 0 : dot / denom;
}

function fallbackDotProduct(a: Float32Array, b: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        sum += a[i] * b[i];
    }
    return sum;
}

function fallbackEuclideanDistance(a: Float32Array, b: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        const diff = a[i] - b[i];
        sum += diff * diff;
    }
    return Math.sqrt(sum);
}

function fallbackMagnitude(vec: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < vec.length; i++) {
        sum += vec[i] * vec[i];
    }
    return Math.sqrt(sum);
}

function fallbackNormalize(vec: Float32Array): Float32Array {
    const mag = fallbackMagnitude(vec);
    if (mag > 0) {
        for (let i = 0; i < vec.length; i++) {
            vec[i] /= mag;
        }
    }
    return vec;
}

function fallbackFindTopKSimilar(
    query: Float32Array,
    vectors: Float32Array[],
    k: number
): SimilarityResult[] {
    const scores = vectors.map((v, i) => ({
        index: i,
        score: fallbackCosineSimilarity(query, v)
    }));
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, k);
}

function fallbackBatchCosineSimilarity(
    query: Float32Array,
    vectors: Float32Array[]
): number[] {
    return vectors.map(v => fallbackCosineSimilarity(query, v));
}

// ── Exports ──────────────────────────────────────

/**
 * Check if native SIMD module is available
 */
export function isNativeAvailable(): boolean {
    return useNative;
}

/**
 * Get native module version (or "js-fallback" if not available)
 */
export function getVersion(): string {
    return useNative ? nativeModule!.getVersion() : "js-fallback";
}

/**
 * Check if SIMD is supported on this platform
 */
export function hasSimdSupport(): boolean {
    return useNative ? nativeModule!.hasSimdSupport() : false;
}

/**
 * Compute cosine similarity between two vectors
 * Uses SIMD when available, falls back to JS implementation
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    return useNative
        ? nativeModule!.cosineSimilarity(a, b)
        : fallbackCosineSimilarity(a, b);
}

/**
 * Compute dot product between two vectors
 */
export function dotProduct(a: Float32Array, b: Float32Array): number {
    return useNative
        ? nativeModule!.dotProduct(a, b)
        : fallbackDotProduct(a, b);
}

/**
 * Compute Euclidean distance between two vectors
 */
export function euclideanDistance(a: Float32Array, b: Float32Array): number {
    return useNative
        ? nativeModule!.euclideanDistance(a, b)
        : fallbackEuclideanDistance(a, b);
}

/**
 * Compute magnitude (L2 norm) of a vector
 */
export function magnitude(vec: Float32Array): number {
    return useNative
        ? nativeModule!.magnitude(vec)
        : fallbackMagnitude(vec);
}

/**
 * Normalize a vector to unit length (modifies in place)
 */
export function normalize(vec: Float32Array): Float32Array {
    return useNative
        ? nativeModule!.normalize(vec)
        : fallbackNormalize(vec);
}

/**
 * Find top-k most similar vectors to a query
 * Uses parallel processing when native module is available
 */
export function findTopKSimilar(
    query: Float32Array,
    vectors: Float32Array[],
    k: number
): SimilarityResult[] {
    return useNative
        ? nativeModule!.findTopKSimilar(query, vectors, k)
        : fallbackFindTopKSimilar(query, vectors, k);
}

/**
 * Compute cosine similarities between a query and multiple vectors
 * Uses parallel processing when native module is available
 */
export function batchCosineSimilarity(
    query: Float32Array,
    vectors: Float32Array[]
): number[] {
    return useNative
        ? nativeModule!.batchCosineSimilarity(query, vectors)
        : fallbackBatchCosineSimilarity(query, vectors);
}

/**
 * Quantize f32 vector to i8 for memory efficiency
 */
export function quantizeToInt8(vec: Float32Array): Int8Array {
    if (useNative) {
        return nativeModule!.quantizeToInt8(vec);
    }

    // JS fallback
    let min = Infinity, max = -Infinity;
    for (const v of vec) {
        if (v < min) min = v;
        if (v > max) max = v;
    }
    const range = max - min;
    const scale = range > 0 ? 254 / range : 1;
    const result = new Int8Array(vec.length);
    for (let i = 0; i < vec.length; i++) {
        result[i] = Math.max(-127, Math.min(127, Math.round((vec[i] - min) * scale - 127)));
    }
    return result;
}

/**
 * Dequantize i8 vector back to f32
 */
export function dequantizeFromInt8(
    vec: Int8Array,
    minVal: number,
    maxVal: number
): Float32Array {
    if (useNative) {
        return nativeModule!.dequantizeFromInt8(vec, minVal, maxVal);
    }

    // JS fallback
    const range = maxVal - minVal;
    const scale = range > 0 ? range / 254 : 1;
    const result = new Float32Array(vec.length);
    for (let i = 0; i < vec.length; i++) {
        result[i] = (vec[i] + 127) * scale + minVal;
    }
    return result;
}

/**
 * Cosine distance (1 - cosine similarity)
 * Commonly used in HNSW and other vector search algorithms
 */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
    return 1 - cosineSimilarity(a, b);
}
