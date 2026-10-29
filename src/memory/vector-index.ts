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
import { createRequire } from "node:module";
import path from "node:path";
import {
    EMBEDDING_DIM,
    getActiveDim,
    getEffectiveDimension,
    getEmbeddingVersion,
    LEGACY_EMBEDDING_DIM,
} from "./embeddings.js";

// Create a require function for loading CommonJS modules (like native addons)
const esmRequire = createRequire(import.meta.url);

// ── Native Module (Optional) ─────────────────────
// Try to load the native SIMD-accelerated module

interface NativeModule {
    cosineSimilarity: (a: Float32Array, b: Float32Array) => number;
    findTopKSimilar: (
        query: Float32Array,
        vectors: Float32Array[],
        k: number,
    ) => Array<{ index: number; score: number }>;
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
        const possiblePaths = [path.join(process.cwd(), "native", "index.js")];

        for (const modulePath of possiblePaths) {
            try {
                const exists = fs.existsSync(modulePath);
                if (!exists) {
                    continue;
                }
                // Use the module-level require to load CommonJS native module
                const native = esmRequire(modulePath);
                if (native && typeof native.cosineSimilarity === "function") {
                    console.log(
                        `[HNSW] Native SIMD module loaded (v${native.getVersion()}, SIMD: ${native.hasSimdSupport()})`,
                    );
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
const M = 16; // Max links per node per layer
const EF_CONSTRUCTION = 200; // Build-time search width (higher = better recall)
const EF_SEARCH = 50; // Query-time search width
const ML = 1 / Math.log(M); // Level generation factor

// ── Float16 Helpers ───────────────────────────
// Cuts storage in half with invisible precision loss for RAG.

const f16Buf = new ArrayBuffer(4);
const f16View = new DataView(f16Buf);

function f32ToF16(val: number): number {
    f16View.setFloat32(0, val);
    const f32 = f16View.getUint32(0);
    const sign = (f32 >> 16) & 0x8000;
    const exponent = ((f32 >> 23) & 0xff) - 127 + 15;
    const mantissa = (f32 >> 13) & 0x3ff;

    if (exponent <= 0) return sign; // Underflow → zero
    if (exponent >= 31) return sign | 0x7c00; // Overflow → infinity
    return sign | (exponent << 10) | mantissa;
}

function f16ToF32(h: number): number {
    const sign = (h & 0x8000) << 16;
    const exponent = (h >> 10) & 0x1f;
    const mantissa = h & 0x3ff;

    if (exponent === 0) {
        if (mantissa === 0) {
            f16View.setUint32(0, sign);
            return f16View.getFloat32(0);
        }
        // Denormalized
        let e = -1;
        let m = mantissa;
        do {
            e++;
            m <<= 1;
        } while (!(m & 0x400));
        f16View.setUint32(0, sign | ((e + 127 - 15 + 1) << 23) | ((m & 0x3ff) << 13));
        return f16View.getFloat32(0);
    }
    if (exponent === 31) {
        f16View.setUint32(0, sign | 0x7f800000 | (mantissa << 13));
        return f16View.getFloat32(0);
    }
    f16View.setUint32(0, sign | ((exponent - 15 + 127) << 23) | (mantissa << 13));
    return f16View.getFloat32(0);
}

function compressVec(vec: Float32Array): Uint16Array {
    const out = new Uint16Array(vec.length);
    for (let i = 0; i < vec.length; i++) out[i] = f32ToF16(vec[i]);
    return out;
}

function decompressVec(compressed: Uint16Array): Float32Array {
    const out = new Float32Array(compressed.length);
    for (let i = 0; i < compressed.length; i++) out[i] = f16ToF32(compressed[i]);
    return out;
}

// ── Types ─────────────────────────────────────

interface HNSWNode {
    id: number;
    vector: Uint16Array; // Float16 compressed
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
        vector: number[]; // Float16 values as numbers
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

    // ── Random level generation (geometric distribution) ──
    private randomLevel(): number {
        let level = 0;
        while (Math.random() < ML && level < 8) level++;
        return level;
    }

    // ── Distance (1 - cosine similarity, using dot product on normalized vecs) ──
    // Uses native SIMD when available for 10-50x speedup
    private distance(a: Uint16Array, b: Uint16Array): number {
        // Decompress to Float32 for SIMD operations
        const aF32 = decompressVec(a);
        const bF32 = decompressVec(b);

        if (nativeModule) {
            // Native SIMD-accelerated cosine similarity
            return 1 - nativeModule.cosineSimilarity(aF32, bF32);
        }

        // Pure JS fallback
        let dot = 0;
        for (let i = 0; i < aF32.length; i++) {
            dot += aF32[i] * bF32[i];
        }
        return 1 - dot; // cosine distance
    }

    private distanceFromF32(query: Float32Array, b: Uint16Array): number {
        // Decompress b to Float32 for native operations
        const bF32 = decompressVec(b);

        if (nativeModule) {
            // Native SIMD-accelerated cosine similarity
            return 1 - nativeModule.cosineSimilarity(query, bF32);
        }

        // Pure JS fallback
        let dot = 0;
        for (let i = 0; i < query.length; i++) {
            dot += query[i] * bF32[i];
        }
        return 1 - dot;
    }

    // ── Search layer (greedy BFS) ──
    private searchLayer(
        query: Float32Array,
        entryIds: number[],
        ef: number,
        layer: number,
    ): Array<{ id: number; dist: number }> {
        const visited = new Set<number>(entryIds);
        const candidates: Array<{ id: number; dist: number }> = [];
        const results: Array<{ id: number; dist: number }> = [];

        for (const id of entryIds) {
            const node = this.nodes.get(id);
            if (!node) continue;
            const dist = this.distanceFromF32(query, node.vector);
            candidates.push({ id, dist });
            results.push({ id, dist });
        }

        candidates.sort((a, b) => a.dist - b.dist);

        while (candidates.length > 0) {
            const nearest = candidates.shift()!;
            const farthestResult =
                results.length > 0
                    ? results.reduce((max, r) => (r.dist > max.dist ? r : max), results[0])
                    : { dist: Infinity };

            if (nearest.dist > farthestResult.dist && results.length >= ef) break;

            const node = this.nodes.get(nearest.id);
            if (!node || !node.neighbors[layer]) continue;

            for (const neighborId of node.neighbors[layer]) {
                if (visited.has(neighborId)) continue;
                visited.add(neighborId);

                const neighborNode = this.nodes.get(neighborId);
                if (!neighborNode) continue;

                const dist = this.distanceFromF32(query, neighborNode.vector);

                if (results.length < ef || dist < farthestResult.dist) {
                    candidates.push({ id: neighborId, dist });
                    candidates.sort((a, b) => a.dist - b.dist);
                    results.push({ id: neighborId, dist });
                    results.sort((a, b) => a.dist - b.dist);
                    if (results.length > ef) results.pop();
                }
            }
        }

        return results;
    }

    // ── Select neighbors (simple strategy: keep M closest) ──
    private selectNeighbors(candidates: Array<{ id: number; dist: number }>, maxNeighbors: number): number[] {
        return candidates
            .sort((a, b) => a.dist - b.dist)
            .slice(0, maxNeighbors)
            .map((c) => c.id);
    }

    // ── Public API ────────────────────────────────

    /** Add or update a vector in the index */
    addVector(id: number, embedding: Float32Array): void {
        const compressed = compressVec(embedding);
        const level = this.randomLevel();

        const newNode: HNSWNode = {
            id,
            vector: compressed,
            level,
            neighbors: Array.from({ length: level + 1 }, () => []),
        };

        // First node
        if (this.entryPoint === -1) {
            this.nodes.set(id, newNode);
            this.entryPoint = id;
            this.maxLevel = level;
            return;
        }

        // Remove old version if exists
        if (this.nodes.has(id)) {
            this.removeVector(id);
        }

        this.nodes.set(id, newNode);

        let currentEntryIds = [this.entryPoint];

        // Traverse from top to the node's level + 1, greedy search
        for (let l = this.maxLevel; l > level; l--) {
            const nearest = this.searchLayer(embedding, currentEntryIds, 1, l);
            if (nearest.length > 0) currentEntryIds = [nearest[0].id];
        }

        // From node's level down to 0, find neighbors and connect
        for (let l = Math.min(level, this.maxLevel); l >= 0; l--) {
            const candidates = this.searchLayer(embedding, currentEntryIds, EF_CONSTRUCTION, l);
            const neighbors = this.selectNeighbors(candidates, M);

            newNode.neighbors[l] = neighbors;

            // Bidirectional connections
            for (const neighborId of neighbors) {
                const neighbor = this.nodes.get(neighborId);
                if (!neighbor) continue;
                if (!neighbor.neighbors[l]) neighbor.neighbors[l] = [];
                neighbor.neighbors[l].push(id);

                // Trim if over capacity
                if (neighbor.neighbors[l].length > M * 2) {
                    const neighborCandidates = neighbor.neighbors[l].map((nid) => {
                        const n = this.nodes.get(nid);
                        return { id: nid, dist: n ? this.distance(neighbor.vector, n.vector) : Infinity };
                    });
                    neighbor.neighbors[l] = this.selectNeighbors(neighborCandidates, M);
                }
            }

            currentEntryIds = candidates.map((c) => c.id);
        }

        // Update entry point if new node has higher level
        if (level > this.maxLevel) {
            this.maxLevel = level;
            this.entryPoint = id;
        }
    }

    /** Remove a vector from the index */
    removeVector(id: number): void {
        const node = this.nodes.get(id);
        if (!node) return;

        // Remove from all neighbor lists
        for (let l = 0; l <= node.level; l++) {
            for (const neighborId of node.neighbors[l] || []) {
                const neighbor = this.nodes.get(neighborId);
                if (neighbor && neighbor.neighbors[l]) {
                    neighbor.neighbors[l] = neighbor.neighbors[l].filter((nid) => nid !== id);
                }
            }
        }

        this.nodes.delete(id);

        // If removed node was entry point, pick a new one
        if (this.entryPoint === id) {
            if (this.nodes.size === 0) {
                this.entryPoint = -1;
                this.maxLevel = 0;
            } else {
                // Pick the node with highest level
                let bestId = -1;
                let bestLevel = -1;
                for (const [nid, n] of this.nodes) {
                    if (n.level > bestLevel) {
                        bestId = nid;
                        bestLevel = n.level;
                    }
                }
                this.entryPoint = bestId;
                this.maxLevel = bestLevel;
            }
        }
    }

    /** Search for k nearest neighbors */
    search(query: Float32Array, k = 10): SearchResult[] {
        if (this.entryPoint === -1 || this.nodes.size === 0) return [];

        let currentEntryIds = [this.entryPoint];

        // Traverse from top to layer 1
        for (let l = this.maxLevel; l > 0; l--) {
            const nearest = this.searchLayer(query, currentEntryIds, 1, l);
            if (nearest.length > 0) currentEntryIds = [nearest[0].id];
        }

        // Search layer 0 with higher ef
        const results = this.searchLayer(query, currentEntryIds, Math.max(k, EF_SEARCH), 0);

        return results
            .sort((a, b) => a.dist - b.dist)
            .slice(0, k)
            .map((r) => ({ id: r.id, distance: r.dist }));
    }

    /** Number of vectors in the index */
    get size(): number {
        return this.nodes.size;
    }

    /** Check if a vector exists */
    has(id: number): boolean {
        return this.nodes.has(id);
    }

    /** Ids of every indexed vector */
    ids(): number[] {
        return [...this.nodes.keys()];
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

        // nativeModule is gated on cosineSimilarity existing, not findTopKSimilar;
        // guard the exact export so a partial build falls back instead of throwing.
        if (nativeModule?.findTopKSimilar) {
            // Use native parallel top-k search (10-50x faster)
            const results = nativeModule.findTopKSimilar(query, vectors, k);
            return results.map((r) => ({
                id: ids[r.index],
                distance: 1 - r.score, // Convert similarity to distance
            }));
        }

        // Pure JS fallback
        const scored = vectors.map((vec, i) => {
            let dot = 0;
            for (let j = 0; j < vec.length; j++) {
                dot += query[j] * vec[j];
            }
            return { id: ids[i], distance: 1 - dot };
        });

        return scored.sort((a, b) => a.distance - b.distance).slice(0, k);
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
                console.warn(
                    `[HNSW] Embedding version mismatch (index: v${storedEmbVer}, current: v${getEmbeddingVersion()}), will rebuild`,
                );
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
        rows = rawDb
            .prepare("SELECT memory_id, embedding FROM memory_embeddings WHERE embedding_version = ?")
            .all(currentVersion) as Array<{ memory_id: number; embedding: Buffer }>;
    } catch {
        // Column doesn't exist yet — load all (they're all v1)
        rows = rawDb.prepare("SELECT memory_id, embedding FROM memory_embeddings").all() as Array<{
            memory_id: number;
            embedding: Buffer;
        }>;
    }

    if (rows.length === 0) {
        console.log(`[HNSW] No v${currentVersion} embeddings to index`);
        return;
    }

    // Up to date only when the id sets match: a forget + store leaves the
    // count unchanged while the new memory is missing from the index.
    if (index.size === rows.length && rows.every((r) => index.has(r.memory_id))) {
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
            console.log(
                `[HNSW] Dimension mismatch: index=${index.getDimension()}, embeddings=${detectedDim}. Recreating index.`,
            );
            _index = new HNSWIndex(detectedDim);
        }
    }

    const activeIndex = _index || index;

    // Drop vectors whose memory is gone, so search can't return dead ids.
    const wanted = new Set(rows.map((r) => r.memory_id));
    for (const id of activeIndex.ids()) {
        if (!wanted.has(id)) activeIndex.removeVector(id);
    }

    let seen = 0;
    for (const row of rows) {
        // Boot runs this; don't hold the event loop for the whole store.
        if (++seen % 50 === 0) await new Promise((r) => setImmediate(r));
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
    batchSize = 50,
): Promise<{ migrated: number; remaining: number }> {
    const { embedText, embeddingToBuffer } = await import("./embeddings.js");
    const currentVersion = getEmbeddingVersion();

    // Find unmigrated memories
    let unmigrated: Array<{ memory_id: number; content: string }>;
    try {
        unmigrated = rawDb
            .prepare(`
            SELECT e.memory_id, m.content
            FROM memory_embeddings e
            JOIN memories m ON e.memory_id = m.id
            WHERE e.embedding_version < ?
            LIMIT ?
        `)
            .all(currentVersion, batchSize) as Array<{ memory_id: number; content: string }>;
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
            rawDb
                .prepare(
                    "UPDATE memory_embeddings SET embedding = ?, embedding_version = ?, created_at = datetime('now') WHERE memory_id = ?",
                )
                .run(embeddingToBuffer(newEmbedding), currentVersion, row.memory_id);

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
        const result = rawDb
            .prepare("SELECT COUNT(*) as cnt FROM memory_embeddings WHERE embedding_version < ?")
            .get(currentVersion) as { cnt: number } | undefined;
        remaining = result?.cnt ?? 0;
    } catch {
        /* */
    }

    console.log(`[HNSW-MIGRATE] Migrated ${migrated}/${unmigrated.length} embeddings (${remaining} remaining)`);

    // Update migration state
    try {
        rawDb
            .prepare(`
            INSERT OR REPLACE INTO embedding_migration_state
            (id, source_version, target_version, total_memories, migrated_memories, status, updated_at)
            VALUES (1, 1, ?,
                (SELECT COUNT(*) FROM memory_embeddings),
                (SELECT COUNT(*) FROM memory_embeddings WHERE embedding_version = ?),
                CASE WHEN ? = 0 THEN 'completed' ELSE 'in_progress' END,
                datetime('now'))
        `)
            .run(currentVersion, currentVersion, remaining);
    } catch {
        /* migration table might not exist */
    }

    return { migrated, remaining };
}
