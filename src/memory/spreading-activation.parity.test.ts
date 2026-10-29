// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Phase 0 parity test — Rust BFS vs TS BFS on identical synthetic graphs.

import { describe, expect, it } from "vitest";
import { isNativeAvailable } from "../native/index.js";
import { __testOnlyBfsWithAdjacency } from "./spreading-activation.js";
import { checkParity } from "./spreading-activation.parity-helpers.js";

interface Rel {
    entityId: number;
    entityName: string;
    weight: number;
}

function bfsBoth(seeds: Array<{ entityId: number; energy: number; via: string }>, adjacency: Record<number, Rel[]>) {
    const tsResult = __testOnlyBfsWithAdjacency(seeds, adjacency, "ts");
    const nativeResult = __testOnlyBfsWithAdjacency(seeds, adjacency, "native");
    const nativeTypedResult = __testOnlyBfsWithAdjacency(seeds, adjacency, "native-typed");
    return { tsResult, nativeResult, nativeTypedResult };
}

function assertParity(
    ts: ReturnType<typeof __testOnlyBfsWithAdjacency>,
    native: ReturnType<typeof __testOnlyBfsWithAdjacency>,
) {
    const failures = checkParity(ts, native);
    expect(failures, failures ? JSON.stringify(failures, null, 2) : undefined).toBeNull();
}

/**
 * Cross-check TS vs both native paths (JSON adjacency and typed napi). The
 * typed path is not used by production but is exercised here so it can't
 * silently rot. See `spread_activation_bfs_typed` in `native/src/spreading.rs`
 * for the rationale.
 */
function assertAllPathsParity(
    ts: ReturnType<typeof __testOnlyBfsWithAdjacency>,
    native: ReturnType<typeof __testOnlyBfsWithAdjacency>,
    nativeTyped: ReturnType<typeof __testOnlyBfsWithAdjacency>,
) {
    assertParity(ts, native);
    assertParity(ts, nativeTyped);
}

// Direct unit tests for the checkParity comparator. These do NOT exercise
// the BFS — they assert that the comparator itself catches every divergence
// type it claims to. Without these the --parity-check CI gate could silently
// false-negate on a comparator bug (off-by-one, wrong operator, missed field).
describe("checkParity comparator (unit)", () => {
    // The `via` field is intentionally not validated by the comparator (see
    // parity-helpers.ts docstring), so the helper sets a fixed via that the
    // comparator ignores; only the dedicated via-tolerance test below uses
    // distinct via strings.
    const seed = (memoryId: number, score: number, hops = 1) => ({
        memoryId,
        activationScore: score,
        hops,
        via: "via-irrelevant",
    });

    it("returns null when inputs are byte-identical", () => {
        const a = [seed(2, 0.5)];
        const b = [seed(2, 0.5)];
        expect(checkParity(a, b)).toBeNull();
    });

    it("catches length mismatch", () => {
        const failures = checkParity([seed(2, 0.5)], [seed(2, 0.5), seed(3, 0.4)]);
        expect(failures).toEqual([{ index: -1, field: "length", ts: 1, native: 2 }]);
    });

    it("catches memoryId mismatch (and reports exactly one failure)", () => {
        const failures = checkParity([seed(2, 0.5)], [seed(99, 0.5)]);
        expect(failures).toHaveLength(1);
        expect(failures?.[0]).toEqual({ index: 0, field: "memoryId", ts: 2, native: 99 });
    });

    it("catches hops mismatch (and reports exactly one failure)", () => {
        const failures = checkParity([seed(2, 0.5, 1)], [seed(2, 0.5, 3)]);
        expect(failures).toHaveLength(1);
        expect(failures?.[0]).toEqual({ index: 0, field: "hops", ts: 1, native: 3 });
    });

    // ENERGY_TOLERANCE boundary: comparator uses `>=`, so a delta of exactly
    // 0.5 must fail and 0.499 must pass. These two cases together pin the
    // operator so a >/>= mutation is caught.
    it("catches activationScore at exactly ENERGY_TOLERANCE (>=)", () => {
        const failures = checkParity([seed(2, 0.5)], [seed(2, 1.0)]); // delta exactly 0.5
        expect(failures).toHaveLength(1);
        expect(failures?.[0].field).toBe("activationScore");
    });

    it("tolerates activationScore just under ENERGY_TOLERANCE", () => {
        const failures = checkParity([seed(2, 0.5)], [seed(2, 0.999)]); // delta 0.499
        expect(failures).toBeNull();
    });

    it("catches activationScore well beyond ENERGY_TOLERANCE", () => {
        const failures = checkParity([seed(2, 0.5)], [seed(2, 1.5)]); // delta 1.0
        expect(failures).toHaveLength(1);
        expect(failures?.[0].field).toBe("activationScore");
    });

    it("does not flag `via` differences (intentionally tolerated)", () => {
        const failures = checkParity(
            [{ memoryId: 2, activationScore: 0.5, hops: 1, via: "via-a" }],
            [{ memoryId: 2, activationScore: 0.5, hops: 1, via: "via-b" }],
        );
        expect(failures).toBeNull();
    });

    it("normalizes order: same set in different order is parity", () => {
        const a = [seed(2, 0.5), seed(3, 0.4)];
        const b = [seed(3, 0.4), seed(2, 0.5)];
        expect(checkParity(a, b)).toBeNull();
    });

    // Pins the secondary sort key (hops) for tied memoryIds: same id, two
    // different hop counts, swapped order. A bug in normalize's tiebreaker
    // would mismatch them at the same array index and report a hops failure.
    it("normalizes ties on memoryId by hops as the secondary key", () => {
        const a = [seed(2, 0.5, 1), seed(2, 0.4, 2)];
        const b = [seed(2, 0.4, 2), seed(2, 0.5, 1)];
        expect(checkParity(a, b)).toBeNull();
    });
});

describe("Spreading-activation BFS parity (Phase 0)", () => {
    if (!isNativeAvailable()) {
        it.skip("native module unavailable — skipping parity tests", () => {});
        return;
    }

    it("empty adjacency returns no expanded results", () => {
        const { tsResult, nativeResult, nativeTypedResult } = bfsBoth([{ entityId: 1, energy: 0.9, via: "seed" }], {});
        assertAllPathsParity(tsResult, nativeResult, nativeTypedResult);
        expect(tsResult).toHaveLength(0);
    });

    it("single seed, single neighbor above threshold", () => {
        const adjacency: Record<number, Rel[]> = {
            1: [{ entityId: 2, entityName: "neighbor", weight: 0.8 }],
        };
        const { tsResult, nativeResult, nativeTypedResult } = bfsBoth([{ entityId: 1, energy: 1.0, via: "seed" }], adjacency);
        assertAllPathsParity(tsResult, nativeResult, nativeTypedResult);
        expect(tsResult).toHaveLength(1);
        expect(tsResult[0].memoryId).toBe(2);
        expect(tsResult[0].hops).toBe(1);
        expect(tsResult[0].via).toBe("neighbor");
    });

    it("threshold filtering: weak edges produce no result", () => {
        const adjacency: Record<number, Rel[]> = {
            1: [{ entityId: 2, entityName: "weak", weight: 0.1 }],
        };
        const { tsResult, nativeResult, nativeTypedResult } = bfsBoth([{ entityId: 1, energy: 0.5, via: "seed" }], adjacency);
        assertAllPathsParity(tsResult, nativeResult, nativeTypedResult);
        expect(tsResult).toHaveLength(0);
    });

    it("branching cap: only top-5 strongest edges per node", () => {
        const edges: Rel[] = [];
        for (let i = 0; i < 10; i++) {
            edges.push({ entityId: 100 + i, entityName: `edge${i}`, weight: 1.0 - i * 0.05 });
        }
        const adjacency: Record<number, Rel[]> = { 1: edges };
        const { tsResult, nativeResult, nativeTypedResult } = bfsBoth([{ entityId: 1, energy: 1.0, via: "seed" }], adjacency);
        assertAllPathsParity(tsResult, nativeResult, nativeTypedResult);
        expect(tsResult.length).toBeLessThanOrEqual(5);
    });

    it("multi-hop decay (3 hops max)", () => {
        const adjacency: Record<number, Rel[]> = {
            1: [{ entityId: 2, entityName: "hop1", weight: 1.0 }],
            2: [{ entityId: 3, entityName: "hop2", weight: 1.0 }],
            3: [{ entityId: 4, entityName: "hop3", weight: 1.0 }],
            4: [{ entityId: 5, entityName: "hop4-should-not-reach", weight: 1.0 }],
        };
        const { tsResult, nativeResult, nativeTypedResult } = bfsBoth([{ entityId: 1, energy: 1.0, via: "seed" }], adjacency);
        assertAllPathsParity(tsResult, nativeResult, nativeTypedResult);
        const ids = tsResult.map((r) => r.memoryId).sort();
        expect(ids).toContain(2);
        expect(ids).toContain(3);
        expect(ids).toContain(4);
        expect(ids).not.toContain(5);
    });

    it("max-energy convergence: multiple paths to same node", () => {
        const adjacency: Record<number, Rel[]> = {
            1: [
                { entityId: 2, entityName: "a", weight: 0.9 },
                { entityId: 3, entityName: "b", weight: 0.9 },
            ],
            2: [{ entityId: 4, entityName: "via-a", weight: 0.9 }],
            3: [{ entityId: 4, entityName: "via-b", weight: 0.9 }],
        };
        const { tsResult, nativeResult, nativeTypedResult } = bfsBoth([{ entityId: 1, energy: 1.0, via: "seed" }], adjacency);
        assertAllPathsParity(tsResult, nativeResult, nativeTypedResult);
        const node4 = tsResult.find((r) => r.memoryId === 4);
        expect(node4).toBeDefined();
    });

    it("medium graph (50 nodes, mixed structure)", () => {
        const adjacency: Record<number, Rel[]> = {};
        for (let i = 1; i <= 50; i++) {
            const edges: Rel[] = [];
            for (let j = 0; j < 4; j++) {
                const target = ((i + j * 7) % 50) + 1;
                if (target !== i) {
                    edges.push({
                        entityId: target,
                        entityName: `e${target}`,
                        weight: 0.6 + j * 0.1,
                    });
                }
            }
            adjacency[i] = edges;
        }
        const seeds = [
            { entityId: 1, energy: 1.0, via: "s1" },
            { entityId: 25, energy: 0.8, via: "s25" },
        ];
        const { tsResult, nativeResult, nativeTypedResult } = bfsBoth(seeds, adjacency);
        assertAllPathsParity(tsResult, nativeResult, nativeTypedResult);
    });

    it("large graph respects MAX_ACTIVATED_NODES=150", () => {
        const adjacency: Record<number, Rel[]> = {};
        for (let i = 1; i <= 500; i++) {
            const edges: Rel[] = [];
            for (let j = 0; j < 5; j++) {
                const target = ((i + j) % 500) + 1;
                if (target !== i) edges.push({ entityId: target, entityName: `n${target}`, weight: 0.95 });
            }
            adjacency[i] = edges;
        }
        const { tsResult, nativeResult, nativeTypedResult } = bfsBoth([{ entityId: 1, energy: 1.0, via: "s" }], adjacency);
        assertAllPathsParity(tsResult, nativeResult, nativeTypedResult);
        expect(tsResult.length).toBeLessThan(150);
    });
});
