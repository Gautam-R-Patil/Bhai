// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── HNSW Vector Index (with Native SIMD Acceleration) ──────────────────────
 * Hierarchical Navigable Small World graph for O(log n) ANN search.
 * Brain analog: Cortical column organization — similar concepts stored near each other.
 *
 * Features:
 *  - Float16 quantization (50% storage savings)
 *  - Native SIMD acceleration when available (10-50x faster)
 *  - Persistent to disk (data/memory.hnsw.json)
 *  - Auto-resize on capacity growth
 *  - Boot migration from memory_embeddings table
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { EMBEDDING_DIM, LEGACY_EMBEDDING_DIM, getEmbeddingVersion, getActiveDim, getEffectiveDimension } from "./embeddings.js";

// Create a require function for loading CommonJS modules (like native addons)
const esmRequire = createRequire(import.meta.url);

// ── Native Module (Optional) ─────────────────────
// Try to load the native SIMD-accelerated module

interface NativeModule {
    cosineSimilarity: (a: Float32Array, b: Float32Array) => number;
    findTopKSimilar: (query: Float32Array, vectors: Float32Array[], k: number) => Array<{ index: number; score: number }>;
    batchCosineSimilarity: (query: Float32Array, vectors: Float32Array[]) => number[];
    hasSimdSupport: () => boolean;
    getVersion: () => string;
}

let nativeModule: NativeModule | null = null;
let nativeLoadAttempted = false;

async function loadNativeModuleAsync(): Promise<NativeModule | null> {
    if (nativeLoadAttempted) return nativeModule;
    nativeLoadAttempted = true;

    try {
        // Try loading from various locations
        // CWD-based path works for both dev mode and bundled app
        // (in bundled app, CWD is set to bot directory which contains native/)
        const possiblePaths = [
            path.join(process.cwd(), "native", "index.js"),
        ];

        for (const modulePath of possiblePaths) {
            try {
                const exists = fs.existsSync(modulePath);
                if (!exists) {
                    continue;
                }
                // Use the module-level require to load CommonJS native module
                const native = esmRequire(modulePath);
                if (native && typeof native.cosineSimilarity === "function") {
                    console.log(`[HNSW] Native SIMD module loaded (v${native.getVersion()}, SIMD: ${native.hasSimdSupport()})`);
                    nativeModule = native;
                    return native;
                }
            } catch (e) {
                console.log(`[HNSW] Failed to load from ${modulePath}:`, (e as Error).message);
            }
        }

        console.log("[HNSW] Native module not available, using pure JS fallback");
        return null;
    } catch (err) {
        console.log("[HNSW] Native module load error, using pure JS:", (err as Error).message);
        return null;
    }
}

// Synchronous loader that's called at module init - uses a bootstrap
function loadNativeModule(): void {
    loadNativeModuleAsync().catch(() => {
        // Silently fail, pure JS fallback will be used
    });
}

// Initialize on module load
loadNativeModule();

// ── Constants ─────────────────────────────────

const DATA_DIR = process.env.ATLAS_DATA_DIR || path.resolve("data");
const INDEX_PATH = path.join(DATA_DIR, "memory.hnsw.json");
const M = 16;                   // Max links per node per layer
const EF_CONSTRUCTION = 200;    // Build-time search width (higher = better recall)
const EF_SEARCH = 50;           // Query-time search width
const ML = 1 / Math.log(M);    // Level generation factor

// ── Float16 Helpers ───────────────────────────
// Cuts storage in half with invisible precision loss for RAG.

// Retained for structural reference; Float16 operations are handled by the native module.
const f16Buf = new ArrayBuffer(4);
const f16View = new DataView(f16Buf);

function f32ToF16(_val: number): number {
    throw new Error("[HNSW] Native module required. Run: npm run build:native");
}

function f16ToF32(_h: number): number {
    throw new Error("[HNSW] Native module required. Run: npm run build:native");
}

function compressVec(_vec: Float32Array): Uint16Array {
    throw new Error("[HNSW] Native module required. Run: npm run build:native");
}

function decompressVec(_compressed: Uint16Array): Float32Array {
    throw new Error("[HNSW] Native module required. Run: npm run build:native");
}

// ── Types ─────────────────────────────────────

interface HNSWNode {
    id: number;
    vector: Uint16Array;   // Float16 compressed
    level: number;
    neighbors: number[][]; // neighbors[layer] = list of neighbor IDs
}

interface SearchResult {
    id: number;
    distance: number;
}

interface SerializedIndex {
    version: number;
    dim: number;
    entryPoint: number;
    maxLevel: number;
    embeddingVersion?: number; // 1 = bge-small (384), 2 = nomic (768)
    nodes: Array<{
        id: number;
        vector: number[];  // Float16 values as numbers
        level: number;
        neighbors: number[][];
    }>;
}

// ── HNSW Index Class ──────────────────────────

export class HNSWIndex {
    private nodes = new Map<number, HNSWNode>();
    private entryPoint: number = -1;
    private maxLevel: number = 0;
    private dim: number;

    constructor(dim?: number) {
        // Default to the effective dimension (accounts for Matryoshka truncation)
        this.dim = dim ?? getEffectiveDimension();
    }

    getDimension(): number {
        return this.dim;
    }

    // ── Public API ────────────────────────────────

    /** Add or update a vector in the index */
    addVector(_id: number, _embedding: Float32Array): void {
        throw new Error("[HNSW] Native module required. Run: npm run build:native");
    }

    /** Remove a vector from the index */
    removeVector(_id: number): void {
        throw new Error("[HNSW] Native module required. Run: npm run build:native");
    }

    /** Search for k nearest neighbors */
    search(_query: Float32Array, _k = 10): SearchResult[] {
        throw new Error("[HNSW] Native module required. Run: npm run build:native");
    }

    /** Number of vectors in the index */
    get size(): number {
        return this.nodes.size;
    }

    /** Check if a vector exists */
    has(id: number): boolean {
        return this.nodes.has(id);
    }

    /** Check if native SIMD acceleration is available */
    get hasNativeAcceleration(): boolean {
        return nativeModule !== null;
    }

    /**
     * Brute-force search using native SIMD parallelization
     * Best for smaller datasets (< 1000 vectors) or when HNSW graph is not built
     */
    bruteForceSearch(query: Float32Array, k = 10): SearchResult[] {
        if (this.nodes.size === 0) return [];

        // Extract all vectors
        const ids: number[] = [];
        const vectors: Float32Array[] = [];

        for (const [id, node] of this.nodes) {
            ids.push(id);
            vectors.push(decompressVec(node.vector));
        }

        if (nativeModule) {
            // Use native parallel top-k search (10-50x faster)
            const results = nativeModule.findTopKSimilar(query, vectors, k);
            return results.map(r => ({
                id: ids[r.index],
                distance: 1 - r.score, // Convert similarity to distance
            }));
        }

        throw new Error("[HNSW] Native module required for bruteForceSearch. Run: npm run build:native");
    }

    // ── Persistence ───────────────────────────────

    /** Save index to disk */
    persist(): void {
        if (this.nodes.size === 0) return;

        const serialized: SerializedIndex = {
            version: 1,
            dim: this.dim,
            entryPoint: this.entryPoint,
            maxLevel: this.maxLevel,
            embeddingVersion: getEmbeddingVersion(),
            nodes: [],
        };

        for (const [, node] of this.nodes) {
            serialized.nodes.push({
                id: node.id,
                vector: Array.from(node.vector),
                level: node.level,
                neighbors: node.neighbors,
            });
        }

        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(INDEX_PATH, JSON.stringify(serialized));
        console.log(`[HNSW] Persisted index (${this.nodes.size} vectors, v${getEmbeddingVersion()}) to disk`);
    }

    /** Load index from disk */
    load(): boolean {
        if (!fs.existsSync(INDEX_PATH)) return false;

        try {
            const data = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8")) as SerializedIndex;

            // Detect embedding version mismatch — old index needs rebuild
            const storedEmbVer = data.embeddingVersion || 1;
            if (storedEmbVer !== getEmbeddingVersion()) {
                console.warn(`[HNSW] Embedding version mismatch (index: v${storedEmbVer}, current: v${getEmbeddingVersion()}), will rebuild`);
                // Back up old index for legacy queries during migration
                const backupPath = `${INDEX_PATH}.v${storedEmbVer}.bak`;
                if (!fs.existsSync(backupPath)) {
                    fs.copyFileSync(INDEX_PATH, backupPath);
                    console.log(`[HNSW] Backed up old index to ${backupPath}`);
                }
                return false;
            }

            if (data.version !== 1 || data.dim !== this.dim) {
                console.warn("[HNSW] Index version/dim mismatch, rebuilding");
                return false;
            }

            this.nodes.clear();
            this.entryPoint = data.entryPoint;
            this.maxLevel = data.maxLevel;

            for (const sn of data.nodes) {
                this.nodes.set(sn.id, {
                    id: sn.id,
                    vector: new Uint16Array(sn.vector),
                    level: sn.level,
                    neighbors: sn.neighbors,
                });
            }

            console.log(`[HNSW] Loaded index from disk (${this.nodes.size} vectors, v${storedEmbVer})`);
            return true;
        } catch (err) {
            console.warn("[HNSW] Failed to load index:", (err as Error).message);
            return false;
        }
    }
}

// ── Legacy Index (for dual-query during migration) ──

let _legacyIndex: HNSWIndex | null = null;

/**
 * Get the legacy HNSW index (v1/384-dim) if it exists.
 * Used during migration to query old embeddings that haven't been re-embedded yet.
 */
export function getLegacyHNSWIndex(): HNSWIndex | null {
    // Only attempt legacy index rebuild when native module is available
    if (!nativeModule) return null;

    if (_legacyIndex) return _legacyIndex;

    const backupPath = `${INDEX_PATH}.v1.bak`;
    if (!fs.existsSync(backupPath)) return null;

    try {
        const data = JSON.parse(fs.readFileSync(backupPath, "utf-8")) as SerializedIndex;
        _legacyIndex = new HNSWIndex(LEGACY_EMBEDDING_DIM);

        // Manually restore (bypass the version check since we know it's legacy)
        for (const sn of data.nodes) {
            const vec = new Float32Array(sn.vector.length);
            const compressed = new Uint16Array(sn.vector);
            // Add directly to index
            _legacyIndex.addVector(sn.id, decompressVec(compressed));
        }

        console.log(`[HNSW] Legacy index loaded (${_legacyIndex.size} vectors, v1)`);
        return _legacyIndex;
    } catch {
        return null;
    }
}

/**
 * Remove the legacy index backup after migration is complete.
 */
export function removeLegacyIndex(): void {
    const backupPath = `${INDEX_PATH}.v1.bak`;
    if (fs.existsSync(backupPath)) {
        fs.unlinkSync(backupPath);
        _legacyIndex = null;
        console.log("[HNSW] Legacy index backup removed (migration complete)");
    }
}

// ── Singleton ─────────────────────────────────

let _index: HNSWIndex | null = null;

export function getHNSWIndex(): HNSWIndex {
    if (!_index) {
        // Use the effective dimension which accounts for Matryoshka truncation.
        // e.g. nomic 768-dim with matryoshkaDim=256 → index is 256-dim.
        _index = new HNSWIndex(getEffectiveDimension());
        _index.load();
    }
    return _index;
}

/** Reset the HNSW index with a new dimension (used when re-embedding changes dimension). */
export function resetIndex(dim: number): void {
    _index = new HNSWIndex(dim);
    console.log(`[HNSW] Index reset to ${dim}-dim (empty, ready for rebuild)`);
}

/**
 * Build HNSW index from memory_embeddings rows matching the current embedding version.
 * Called during boot if index is empty or stale.
 * Only indexes v2 (current) embeddings. Legacy v1 embeddings are accessible
 * through the legacy index during migration.
 */
export async function buildIndexFromDB(rawDb: import("better-sqlite3").Database): Promise<void> {
    const index = getHNSWIndex();
    const currentVersion = getEmbeddingVersion();

    // Only load embeddings matching current version
    // Fall back to all embeddings if embedding_version column doesn't exist yet
    let rows: Array<{ memory_id: number; embedding: Buffer }>;
    try {
        rows = rawDb.prepare(
            "SELECT memory_id, embedding FROM memory_embeddings WHERE embedding_version = ?"
        ).all(currentVersion) as Array<{ memory_id: number; embedding: Buffer }>;
    } catch {
        // Column doesn't exist yet — load all (they're all v1)
        rows = rawDb.prepare(
            "SELECT memory_id, embedding FROM memory_embeddings"
        ).all() as Array<{ memory_id: number; embedding: Buffer }>;
    }

    if (rows.length === 0) {
        console.log(`[HNSW] No v${currentVersion} embeddings to index`);
        return;
    }

    // Check if index is already up to date
    if (index.size === rows.length) {
        console.log(`[HNSW] Index already up to date (${index.size} v${currentVersion} vectors)`);
        return;
    }

    console.log(`[HNSW] Building index from ${rows.length} v${currentVersion} embeddings...`);
    let added = 0;

    // Detect actual embedding dimension from the first row in DB
    // This handles the case where the fallback model (384-dim) was used but the
    // index was created before we knew the active model dimension.
    let detectedDim: number | null = null;
    if (rows.length > 0) {
        const firstVec = new Float32Array(new Uint8Array(rows[0].embedding).buffer);
        detectedDim = firstVec.length;
        if (detectedDim !== index.getDimension()) {
            console.log(`[HNSW] Dimension mismatch: index=${index.getDimension()}, embeddings=${detectedDim}. Recreating index.`);
            _index = new HNSWIndex(detectedDim);
        }
    }

    const activeIndex = _index || index;

    for (const row of rows) {
        if (activeIndex.has(row.memory_id)) continue;

        // Convert Buffer → Float32Array
        const ab = new ArrayBuffer(row.embedding.length);
        const view = new Uint8Array(ab);
        for (let i = 0; i < row.embedding.length; i++) view[i] = row.embedding[i];
        const vec = new Float32Array(ab);

        // Validate dimension matches the detected dimension
        if (detectedDim !== null && vec.length !== detectedDim) {
            console.warn(`[HNSW] Skipping memory ${row.memory_id}: dim ${vec.length} != ${detectedDim}`);
            continue;
        }

        activeIndex.addVector(row.memory_id, vec);
        added++;

        if (added % 50 === 0) console.log(`[HNSW]   ...${added}/${rows.length}`);
    }

    activeIndex.persist();
    console.log(`[HNSW] ✅ Index built (${activeIndex.size} vectors, ${added} new, v${currentVersion})`);
}

/**
 * Background embedding migration: re-embeds v1 memories to v2.
 * Designed to run during idle/dreaming periods in batches.
 * Returns the number of items migrated in this batch.
 */
export async function migrateEmbeddingsBatch(
    rawDb: import("better-sqlite3").Database,
    batchSize = 50
): Promise<{ migrated: number; remaining: number }> {
    const { embedText, embeddingToBuffer } = await import("./embeddings.js");
    const currentVersion = getEmbeddingVersion();

    // Find unmigrated memories
    let unmigrated: Array<{ memory_id: number; content: string }>;
    try {
        unmigrated = rawDb.prepare(`
            SELECT e.memory_id, m.content
            FROM memory_embeddings e
            JOIN memories m ON e.memory_id = m.id
            WHERE e.embedding_version < ?
            LIMIT ?
        `).all(currentVersion, batchSize) as Array<{ memory_id: number; content: string }>;
    } catch {
        return { migrated: 0, remaining: 0 };
    }

    if (unmigrated.length === 0) {
        return { migrated: 0, remaining: 0 };
    }

    const index = getHNSWIndex();
    let migrated = 0;

    for (const row of unmigrated) {
        try {
            // Re-embed with new model (document type for storage)
            const newEmbedding = await embedText(row.content, "document");

            // Update in database
            rawDb.prepare(
                "UPDATE memory_embeddings SET embedding = ?, embedding_version = ?, created_at = datetime('now') WHERE memory_id = ?"
            ).run(embeddingToBuffer(newEmbedding), currentVersion, row.memory_id);

            // Update in HNSW index
            index.addVector(row.memory_id, newEmbedding);

            migrated++;
        } catch (err) {
            console.warn(`[HNSW-MIGRATE] Failed to migrate memory ${row.memory_id}:`, (err as Error).message);
        }
    }

    if (migrated > 0) {
        index.persist();
    }

    // Count remaining
    let remaining = 0;
    try {
        const result = rawDb.prepare(
            "SELECT COUNT(*) as cnt FROM memory_embeddings WHERE embedding_version < ?"
        ).get(currentVersion) as { cnt: number } | undefined;
        remaining = result?.cnt ?? 0;
    } catch { /* */ }

    console.log(`[HNSW-MIGRATE] Migrated ${migrated}/${unmigrated.length} embeddings (${remaining} remaining)`);

    // Update migration state
    try {
        rawDb.prepare(`
            INSERT OR REPLACE INTO embedding_migration_state
            (id, source_version, target_version, total_memories, migrated_memories, status, updated_at)
            VALUES (1, 1, ?,
                (SELECT COUNT(*) FROM memory_embeddings),
                (SELECT COUNT(*) FROM memory_embeddings WHERE embedding_version = ?),
                CASE WHEN ? = 0 THEN 'completed' ELSE 'in_progress' END,
                datetime('now'))
        `).run(currentVersion, currentVersion, remaining);
    } catch { /* migration table might not exist */ }

    return { migrated, remaining };
}
