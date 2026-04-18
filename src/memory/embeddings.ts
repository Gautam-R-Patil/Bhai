// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * Local Embedding Engine using Xenova/transformers (ONNX Runtime)
 * Model v2: nomic-ai/nomic-embed-text-v1.5 (768 dimensions, ~274MB, fast CPU inference)
 *   - MoE architecture, ~43% better retrieval accuracy over bge-small (MTEB)
 *   - Matryoshka support: can truncate to 384/512/768 dims
 * Model v1 (legacy): bge-small-en-v1.5 (384 dimensions, ~33MB)
 *
 * Dual-model support during migration: v1 embeddings still queryable,
 * background re-embedding job upgrades them to v2 over time.
 *
 * Provides:
 *  - embedText(text) → Float32Array (768-dim vector)
 *  - embedTextLegacy(text) → Float32Array (384-dim vector) [migration only]
 *  - cosineSimilarity(a, b) → number (-1 to 1)
 *  - isReady() → boolean
 *  - getEmbeddingVersion() → 1 | 2
 */

import { join, sep } from "node:path";
import { existsSync } from "node:fs";

// ── Embedding Model Configuration ───────────────
// Configurable model registry — switch models via ATLAS_EMBEDDING_MODEL env var.
// The active model is resolved at runtime; no code changes needed to switch.

export interface EmbeddingModelConfig {
    modelName: string;
    dimension: number;
    /** If set, truncate embeddings to this dimension after generation (Matryoshka representation learning). */
    matryoshkaDim?: number;
    fallbackModelName?: string;
    fallbackDimension?: number;
    /** Max input character length for this model (~tokens * 4). */
    maxInputChars?: number;
    /** Whether this model uses task-specific prefixes (e.g. Nomic "search_query:" / "search_document:"). */
    usesTaskPrefix?: boolean;
}

export const EMBEDDING_MODELS: Record<string, EmbeddingModelConfig> = {
    MINILM: {
        modelName: "Xenova/all-MiniLM-L6-v2",
        dimension: 384,
        maxInputChars: 2000,
        usesTaskPrefix: false,
    },
    NOMIC: {
        modelName: "nomic-ai/nomic-embed-text-v1.5",
        dimension: 768,
        matryoshkaDim: 256,
        fallbackModelName: "Xenova/all-MiniLM-L6-v2",
        fallbackDimension: 384,
        maxInputChars: 8000,
        usesTaskPrefix: true,
    },
};

/**
 * Resolve the active embedding model from the ATLAS_EMBEDDING_MODEL env var.
 * Returns EMBEDDING_MODELS.NOMIC for "nomic", EMBEDDING_MODELS.MINILM otherwise.
 */
export function getActiveEmbeddingModel(): EmbeddingModelConfig {
    const envModel = (process.env.ATLAS_EMBEDDING_MODEL || "").toLowerCase().trim();
    if (envModel === "nomic") return EMBEDDING_MODELS.NOMIC;
    return EMBEDDING_MODELS.MINILM; // Default — safe, no auth required
}

// ── Resolved active model (set once at module load, immutable after) ──
let activeModel: EmbeddingModelConfig = getActiveEmbeddingModel();

// Backwards-compatible constants derived from active model config
const MODEL_NAME = activeModel.modelName;
const EMBEDDING_DIM = activeModel.dimension;

const FALLBACK_MODEL_NAME = activeModel.fallbackModelName || "Xenova/all-MiniLM-L6-v2";
const FALLBACK_EMBEDDING_DIM = activeModel.fallbackDimension || 384;

const LEGACY_MODEL_NAME = "Xenova/bge-small-en-v1.5";
const LEGACY_EMBEDDING_DIM = 384;

// Cache directory — must be writable (not inside .app bundle on macOS)
const DATA_DIR = process.env.ATLAS_DATA_DIR || join(process.cwd(), "data");
const MODELS_CACHE_DIR = join(DATA_DIR, "models");

// Dynamic import to avoid top-level await issues
let pipeline: any = null;
let extractor: any = null;
let legacyExtractor: any = null;
let _ready = false;
let _legacyReady = false;
let _initPromise: Promise<void> | null = null;
let _legacyInitPromise: Promise<void> | null = null;
let _activeDim = EMBEDDING_DIM; // Tracks which model actually loaded
let _envConfigured = false;

/**
 * Configure @xenova/transformers env before any pipeline calls.
 * Sets cacheDir and fetches HF_TOKEN from the Convex backend (never stored on client).
 */
async function configureTransformersEnv(): Promise<void> {
    if (_envConfigured) return;
    const { env } = await import("@xenova/transformers");
    env.cacheDir = MODELS_CACHE_DIR;

    // Fetch HF_TOKEN from Convex backend if not already in environment.
    // Token is stored as a server-side Convex env var — never persisted on client.
    if (!process.env.HF_TOKEN) {
        try {
            const { getConvexSiteUrl } = await import("../config/keys.js");
            const { getSessionTokenSync } = await import("../session.js");
            const convexUrl = getConvexSiteUrl();
            const sessionToken = getSessionTokenSync();
            if (convexUrl && sessionToken) {
                const secretsUrl = `${convexUrl}/api/config/secrets`;
                const resp = await fetch(secretsUrl, {
                    headers: { Authorization: `Bearer ${sessionToken}` },
                });
                if (resp.ok) {
                    const secrets = await resp.json() as Record<string, string>;
                    if (secrets.HF_TOKEN) {
                        process.env.HF_TOKEN = secrets.HF_TOKEN;
                        console.log("[EMBED] HF_TOKEN fetched from server");
                    } else {
                        console.log("[EMBED] Server returned no HF_TOKEN — set it with: npx convex env set HF_TOKEN <token>");
                    }
                } else {
                    console.warn(`[EMBED] Failed to fetch secrets: ${resp.status} ${resp.statusText}`);
                }
            } else {
                console.log(`[EMBED] Cannot fetch HF_TOKEN: convexUrl=${!!convexUrl}, sessionToken=${!!sessionToken}`);
            }
        } catch (err) {
            console.warn("[EMBED] HF_TOKEN fetch failed:", (err as Error).message);
        }
    }

    _envConfigured = true;
}

/** Current embedding version (2 = nomic-embed-text-v1.5, 1 = bge-small) */
const CURRENT_EMBEDDING_VERSION = 2;

export { EMBEDDING_DIM, LEGACY_EMBEDDING_DIM };

/**
 * Get the actual dimension of the loaded model (may differ from EMBEDDING_DIM if using fallback).
 */
export function getActiveDim(): number {
    return _activeDim;
}

/**
 * Get the current embedding version.
 * Used by migration logic to detect version mismatch.
 */
export function getEmbeddingVersion(): 1 | 2 {
    return CURRENT_EMBEDDING_VERSION as 1 | 2;
}

/**
 * Get the legacy embedding dimension (for dual-index queries).
 */
export function getLegacyDim(): number {
    return LEGACY_EMBEDDING_DIM;
}

/**
 * Get the effective output dimension for the active model, accounting for
 * Matryoshka truncation. This is the dimension that will actually be stored
 * and used for similarity search.
 */
export function getEffectiveDimension(): number {
    if (activeModel.matryoshkaDim && activeModel.matryoshkaDim < _activeDim) {
        return activeModel.matryoshkaDim;
    }
    return _activeDim;
}

/**
 * Check whether stored embeddings need migration to the current model's dimensions.
 * Compares the expected byte length in the DB against the effective dimension.
 * Callers can use this at boot to decide whether to trigger re-embedding.
 */
export function needsEmbeddingMigration(rawDb: import("better-sqlite3").Database): boolean {
    const effectiveDim = getEffectiveDimension();
    const expectedBytes = effectiveDim * 4; // Float32 = 4 bytes per dimension

    try {
        // Sample a stored embedding to check its dimension
        const row = rawDb.prepare(
            "SELECT LENGTH(embedding) as embed_bytes FROM memory_embeddings LIMIT 1"
        ).get() as { embed_bytes: number } | undefined;

        if (!row) return false; // No embeddings stored yet — nothing to migrate

        if (row.embed_bytes !== expectedBytes) {
            console.log(
                `[EMBED] Migration needed: stored=${row.embed_bytes / 4}-dim, ` +
                `active=${effectiveDim}-dim (model=${activeModel.modelName}` +
                `${activeModel.matryoshkaDim ? `, matryoshka=${activeModel.matryoshkaDim}` : ""})`
            );
            return true;
        }

        return false;
    } catch {
        // Table may not exist yet
        return false;
    }
}

/**
 * Lazily initialize the primary embedding model on first use.
 * Downloads the ONNX model (~274MB) on first run, cached after that.
 */
async function ensureModel(): Promise<void> {
    if (_ready) return;
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
        await configureTransformersEnv();

        // Import transformers — may fail on Windows if sharp isn't available.
        // sharp is a top-level import in @xenova/transformers/src/utils/image.js.
        let transformers: any;
        try {
            transformers = await import("@xenova/transformers");
        } catch (importErr) {
            const msg = (importErr as Error).message || "";
            if (msg.includes("sharp")) {
                console.warn("[EMBED] ⚠️ sharp module not available — trying to install...");
                // Attempt to install sharp for this platform at runtime
                try {
                    const { execSync } = await import("node:child_process");
                    execSync("npm install --no-save sharp", { cwd: process.cwd(), timeout: 60000, stdio: "pipe" });
                    console.log("[EMBED] sharp installed — retrying import...");
                    transformers = await import("@xenova/transformers");
                } catch {
                    console.error("[EMBED] ❌ Cannot load @xenova/transformers: sharp unavailable and auto-install failed.");
                    console.error("[EMBED] Fix: run 'npm install --os=win32 --cpu=x64 sharp' in the bot directory.");
                    _initPromise = null;
                    throw new Error("Embedding model requires sharp. Install with: npm install sharp");
                }
            } else {
                _initPromise = null;
                throw importErr;
            }
        }
        pipeline = transformers.pipeline;

        // Try primary model (nomic-embed-text-v1.5, 768-dim)
        try {
            console.log(`[EMBED] Loading model: ${MODEL_NAME}...`);
            extractor = await pipeline("feature-extraction", MODEL_NAME, {
                quantized: true,
            });
            _activeDim = EMBEDDING_DIM;
            _ready = true;
            console.log(`[EMBED] ✅ Model loaded: ${MODEL_NAME} (${EMBEDDING_DIM}-dim)`);
            return;
        } catch (primaryErr) {
            console.warn(`[EMBED] ⚠️ Primary model failed: ${(primaryErr as Error).message}`);
        }

        // Fallback to all-MiniLM-L6-v2 (384-dim, always public, no auth needed)
        try {
            console.log(`[EMBED] Trying fallback model: ${FALLBACK_MODEL_NAME}...`);
            extractor = await pipeline("feature-extraction", FALLBACK_MODEL_NAME, {
                quantized: true,
            });
            _activeDim = FALLBACK_EMBEDDING_DIM;
            _ready = true;
            console.warn(`[EMBED] ✅ Fallback model loaded: ${FALLBACK_MODEL_NAME} (${FALLBACK_EMBEDDING_DIM}-dim)`);
            console.warn(`[EMBED] ⚠️ Existing ${EMBEDDING_DIM}-dim embeddings will not match — set HF_TOKEN in .env for the primary model`);
        } catch (fallbackErr) {
            console.error("[EMBED] ❌ All models failed:", (fallbackErr as Error).message);
            _initPromise = null; // Allow retry
            throw fallbackErr;
        }
    })();

    return _initPromise;
}

/**
 * Lazily initialize the legacy model (bge-small) for migration queries.
 * Only loads if legacy embeddings still exist in the database.
 */
async function ensureLegacyModel(): Promise<void> {
    if (_legacyReady) return;
    if (_legacyInitPromise) return _legacyInitPromise;

    _legacyInitPromise = (async () => {
        try {
            console.log("[EMBED] Loading legacy model for migration...");
            const transformers = await import("@xenova/transformers");
            if (!pipeline) pipeline = transformers.pipeline;

            legacyExtractor = await pipeline("feature-extraction", LEGACY_MODEL_NAME, {
                quantized: true,
            });

            _legacyReady = true;
            console.log(`[EMBED] ✅ Legacy model loaded: ${LEGACY_MODEL_NAME} (${LEGACY_EMBEDDING_DIM}-dim)`);
        } catch (err) {
            console.error("[EMBED] ❌ Failed to load legacy model:", (err as Error).message);
            _legacyInitPromise = null;
            throw err;
        }
    })();

    return _legacyInitPromise;
}

/**
 * Check if the embedding model is loaded and ready.
 */
export function isReady(): boolean {
    return _ready;
}

/**
 * Warm up the model (call during boot to pre-load).
 */
export async function warmup(): Promise<void> {
    await ensureModel();
}

/**
 * Apply Matryoshka truncation if the active model config has matryoshkaDim set.
 * Matryoshka Representation Learning encodes the most important semantic
 * information in the first N dimensions, so truncating preserves quality while
 * halving (or more) storage and search cost.
 *
 * After truncation the vector is re-normalized to unit length so that
 * cosine similarity (= dot product on unit vectors) remains correct.
 */
function applyMatryoshkaTruncation(embedding: Float32Array): Float32Array {
    const targetDim = activeModel.matryoshkaDim;
    if (!targetDim || embedding.length <= targetDim) return embedding;

    // Slice to the first targetDim dimensions
    const truncated = new Float32Array(embedding.buffer, embedding.byteOffset, targetDim);

    // Re-normalize after truncation so cosine similarity = dot product
    const result = new Float32Array(targetDim);
    let sumSq = 0;
    for (let i = 0; i < targetDim; i++) sumSq += truncated[i] * truncated[i];
    const norm = Math.sqrt(sumSq);
    if (norm > 0) {
        const inv = 1 / norm;
        for (let i = 0; i < targetDim; i++) result[i] = truncated[i] * inv;
    } else {
        result.set(truncated);
    }

    return result;
}

/**
 * Embed a single text string into a float32 vector.
 * Dimension depends on the active model and Matryoshka config:
 *  - nomic-embed-text-v1.5: 768 raw → matryoshkaDim (e.g. 256) if configured
 *  - MiniLM: 384 (no truncation)
 * Nomic models require a "search_query: " or "search_document: " prefix
 * for best results. We default to "search_query: " for queries and
 * "search_document: " for storage.
 */
export async function embedText(text: string, type: "query" | "document" = "query"): Promise<Float32Array> {
    await ensureModel();

    // Truncate very long strings to model's max token window
    const maxLen = activeModel.maxInputChars ?? (_activeDim === EMBEDDING_DIM ? 8000 : 2000);
    const truncated = text.length > maxLen ? text.substring(0, maxLen) : text;

    // Models with task-specific prefixes (e.g. Nomic) — not applicable to fallback models
    const useTaskPrefix = activeModel.usesTaskPrefix && _activeDim === EMBEDDING_DIM;
    const prefixed = useTaskPrefix
        ? (type === "query" ? `search_query: ${truncated}` : `search_document: ${truncated}`)
        : truncated;

    const output = await extractor(prefixed, {
        pooling: "mean",
        normalize: true,
    });

    let embedding: Float32Array = new Float32Array(output.data);

    // ── Matryoshka truncation ──
    // Models trained with Matryoshka Representation Learning (MRL) encode the most
    // important information in the first N dimensions. Truncating + re-normalizing
    // gives a smaller vector with minimal quality loss.
    embedding = applyMatryoshkaTruncation(embedding);

    return embedding;
}

/**
 * Embed text with the legacy model (bge-small, 384-dim).
 * Used only during migration for re-querying old embeddings.
 */
export async function embedTextLegacy(text: string): Promise<Float32Array> {
    await ensureLegacyModel();

    const truncated = text.length > 2000 ? text.substring(0, 2000) : text;

    const output = await legacyExtractor(truncated, {
        pooling: "mean",
        normalize: true,
    });

    return new Float32Array(output.data);
}

/**
 * Embed multiple texts in one batch (more efficient than individual calls).
 */
export async function embedBatch(texts: string[], type: "query" | "document" = "document"): Promise<Float32Array[]> {
    await ensureModel();

    const results: Float32Array[] = [];
    // Process in small batches to avoid memory issues
    const BATCH_SIZE = 8;

    const useTaskPrefix = activeModel.usesTaskPrefix && _activeDim === EMBEDDING_DIM;
    const prefix = useTaskPrefix
        ? (type === "query" ? "search_query: " : "search_document: ")
        : "";
    const maxLen = activeModel.maxInputChars ?? (_activeDim === EMBEDDING_DIM ? 8000 : 2000);

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE).map(t => {
            const truncated = t.length > maxLen ? t.substring(0, maxLen) : t;
            return `${prefix}${truncated}`;
        });

        // Pass the entire batch array to the pipeline at once (native batching)
        const output = await extractor(batch, {
            pooling: "mean",
            normalize: true,
        });

        // For a single text, output.data is a flat Float32Array of _activeDim length.
        // For multiple texts, output.data is a flat Float32Array of (N * _activeDim) length.
        const flatData = new Float32Array(output.data);
        for (let j = 0; j < batch.length; j++) {
            const start = j * _activeDim;
            const raw = new Float32Array(flatData.buffer, flatData.byteOffset + start * 4, _activeDim);
            results.push(applyMatryoshkaTruncation(raw));
        }
    }

    return results;
}

/**
 * Compute cosine similarity between two vectors.
 * Vectors are assumed to be normalized (which they are from the model),
 * so cosine similarity = dot product.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) return 0;

    let dot = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
    }
    return dot;
}

/**
 * Convert Float32Array to Buffer for SQLite BLOB storage.
 */
export function embeddingToBuffer(embedding: Float32Array): Buffer {
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/**
 * Convert Buffer from SQLite BLOB back to Float32Array.
 */
export function bufferToEmbedding(buffer: Buffer): Float32Array {
    // Create a copy to ensure proper alignment
    const ab = new ArrayBuffer(buffer.length);
    const view = new Uint8Array(ab);
    for (let i = 0; i < buffer.length; i++) {
        view[i] = buffer[i];
    }
    return new Float32Array(ab);
}
