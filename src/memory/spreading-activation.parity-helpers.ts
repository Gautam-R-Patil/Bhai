// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Shared parity helpers used by both the vitest parity suite and the
// scripts/bench-native.ts --parity-check mode. Keeping this in one place
// prevents the bench's CI gate from drifting away from the test's tolerance.

import type { ActivationResult } from "./spreading-activation.js";

// On graphs with equal-weight competing paths, the BFS expansion order
// determines which path "wins" the energy race at deep convergence nodes.
// TS iterates JS object keys in insertion order; Rust iterates HashMap in
// hasher-randomized order. Tiny per-node energy deltas (bounded by
// DECAY_PER_HOP^MAX_HOPS × max_weight ≈ 0.7^3 × 0.95 ≈ 0.33) are expected
// and acceptable — the SAN_WEIGHT=0.3 blend smooths these out in final scores.
export const ENERGY_TOLERANCE = 0.5;

/**
 * Normalize result order before comparison: two BFS runs that produce the
 * same set of entries are equivalent regardless of iteration order. Equal-
 * score entries can land in any order because the underlying HashMap
 * iteration order is non-deterministic in Rust.
 */
export function normalize(results: ActivationResult[]): ActivationResult[] {
    return [...results].sort((a, b) => (a.memoryId !== b.memoryId ? a.memoryId - b.memoryId : a.hops - b.hops));
}

export interface ParityFailure {
    index: number;
    field: "length" | "memoryId" | "hops" | "activationScore";
    ts: unknown;
    native: unknown;
}

/**
 * Compare two BFS result arrays for semantic parity. Returns null when they
 * match within tolerance, or a list of mismatches. The vitest test layer
 * wraps this with `expect()` calls; the bench's --parity-check mode prints
 * the mismatch list to stderr and exits non-zero.
 *
 * Tolerated divergences:
 *   - Result iteration order (HashMap is non-deterministic in Rust)
 *   - `activationScore` within ENERGY_TOLERANCE
 *   - `via` string differences (multiple paths to same node may pick either —
 *     not validated here at all; production code does not depend on which
 *     path won the energy race, only that some valid path did)
 */
export function checkParity(ts: ActivationResult[], native: ActivationResult[]): ParityFailure[] | null {
    const tsN = normalize(ts);
    const nN = normalize(native);
    const failures: ParityFailure[] = [];

    if (nN.length !== tsN.length) {
        failures.push({ index: -1, field: "length", ts: tsN.length, native: nN.length });
        return failures;
    }

    for (let i = 0; i < tsN.length; i++) {
        if (nN[i].memoryId !== tsN[i].memoryId) {
            failures.push({ index: i, field: "memoryId", ts: tsN[i].memoryId, native: nN[i].memoryId });
        }
        if (nN[i].hops !== tsN[i].hops) {
            failures.push({ index: i, field: "hops", ts: tsN[i].hops, native: nN[i].hops });
        }
        if (Math.abs(nN[i].activationScore - tsN[i].activationScore) >= ENERGY_TOLERANCE) {
            failures.push({
                index: i,
                field: "activationScore",
                ts: tsN[i].activationScore,
                native: nN[i].activationScore,
            });
        }
    }

    return failures.length > 0 ? failures : null;
}
