// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── ReadRegistry ──────────────────────────────
// Tracks which files the agent has read in the current process, keyed by
// absolute path. The `edit` and `write` tools require a prior read so that
// the model has seen the file content before mutating it — this is the
// "read-before-edit" cache-coherence barrier.
//
// If a file's on-disk content changes between the read and the edit (another
// process modified it), `wasRead` returns false because the stored hash will
// not match the current content — forcing a fresh read. That catches stale
// content drift loudly instead of silently applying edits to the wrong state.
//
// Bhai runs a single user's session per process, so the registry is
// process-global rather than session-scoped. An LRU cap keeps memory bounded.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

// ── Types ─────────────────────────────────────

interface ReadEntry {
    /** sha256 of the exact bytes read */
    contentHash: string;
    /** Unix ms — used for LRU eviction and freshness checks */
    readAt: number;
}

// ── State ─────────────────────────────────────

const MAX_ENTRIES = 500;
const registry: Map<string, ReadEntry> = new Map();

// ── Helpers ───────────────────────────────────

function canonicalize(filePath: string): string {
    return resolvePath(filePath);
}

/** Hash a Buffer or string to hex sha256. */
export function hashContent(content: Buffer | string): string {
    return createHash("sha256").update(content).digest("hex");
}

/**
 * Compute the hash of the file as it currently exists on disk.
 * Returns null if the file is missing or unreadable.
 */
export function hashFileOnDisk(filePath: string): string | null {
    try {
        const abs = canonicalize(filePath);
        const stats = statSync(abs);
        if (!stats.isFile()) return null;
        const content = readFileSync(abs);
        return hashContent(content);
    } catch {
        return null;
    }
}

function evictOldestIfNeeded(): void {
    if (registry.size <= MAX_ENTRIES) return;
    // Find and drop the oldest entry by readAt
    let oldestPath: string | null = null;
    let oldestTime = Infinity;
    for (const [p, entry] of registry) {
        if (entry.readAt < oldestTime) {
            oldestTime = entry.readAt;
            oldestPath = p;
        }
    }
    if (oldestPath !== null) registry.delete(oldestPath);
}

// ── Public API ────────────────────────────────

/**
 * Record that the agent has read a file with the given content hash.
 * Called by the `read` tool after successful read, and by `edit`/`write`
 * after successful mutation so subsequent edits see the updated hash.
 */
export function recordRead(filePath: string, contentHash: string): void {
    const abs = canonicalize(filePath);
    registry.set(abs, { contentHash, readAt: Date.now() });
    evictOldestIfNeeded();
}

/**
 * Was this file read, and does the on-disk content still match what we saw?
 * Returns true only if the file is in the registry AND the current file hash
 * equals the recorded hash. If the file changed externally, returns false.
 */
export function wasRead(filePath: string): boolean {
    const abs = canonicalize(filePath);
    const entry = registry.get(abs);
    if (!entry) return false;
    const currentHash = hashFileOnDisk(abs);
    if (currentHash === null) return false;
    return currentHash === entry.contentHash;
}

/**
 * True if we have a registry entry at all (ignoring whether the on-disk
 * content is still current). Useful for distinguishing "never read" from
 * "read but file changed on disk".
 */
export function hasRegistryEntry(filePath: string): boolean {
    return registry.has(canonicalize(filePath));
}

/** Remove a single entry (e.g., after the file was deleted). */
export function forget(filePath: string): void {
    registry.delete(canonicalize(filePath));
}

/** Clear all entries (used when switching user sessions or resetting). */
export function clearRegistry(): void {
    registry.clear();
}

/** Current number of tracked files. For diagnostics/tests. */
export function size(): number {
    return registry.size;
}
