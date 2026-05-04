// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { sweepStaleWhatsAppMaps, type WhatsAppSweepConfig } from "./whatsapp-sweep.js";

// Values chosen to match the production module; sweep logic doesn't
// actually care about specific values — the invariants are all
// "(now - timestamp) > threshold".
const config: WhatsAppSweepConfig = {
    rateLimitWindowMs: 60 * 60 * 1000,
    ownerConvoTtlMs: 7 * 24 * 60 * 60 * 1000,
    activeTaskAbandonedMs: 60 * 60 * 1000,
};

// Arbitrary fixed clock so tests are deterministic.
const NOW = 1_700_000_000_000;

// Helper: fresh empty maps.
function newMaps() {
    return {
        mc: new Map<string, { count: number; windowStart: number }>(),
        oc: new Map<string, unknown>(),
        lca: new Map<string, number>(),
        at: new Map<string, Array<{ startedAt: number; taskId: string }>>(),
    };
}

describe("sweepStaleWhatsAppMaps", () => {
    describe("messageCounts", () => {
        it("drops entries with windowStart older than the rate-limit window", () => {
            const { mc, oc, lca, at } = newMaps();
            mc.set("fresh@s.whatsapp.net", { count: 5, windowStart: NOW - 1000 });
            mc.set("stale@s.whatsapp.net", {
                count: 5,
                windowStart: NOW - config.rateLimitWindowMs - 1,
            });

            sweepStaleWhatsAppMaps(NOW, config, mc, oc, lca, at);

            expect(mc.has("fresh@s.whatsapp.net")).toBe(true);
            expect(mc.has("stale@s.whatsapp.net")).toBe(false);
        });

        it("keeps entries exactly at the TTL boundary (strict > comparison)", () => {
            const { mc, oc, lca, at } = newMaps();
            mc.set("boundary@jid", {
                count: 1,
                windowStart: NOW - config.rateLimitWindowMs,
            });
            sweepStaleWhatsAppMaps(NOW, config, mc, oc, lca, at);
            expect(mc.has("boundary@jid")).toBe(true);
        });

        it("drops entries one tick past the boundary", () => {
            const { mc, oc, lca, at } = newMaps();
            mc.set("past@jid", {
                count: 1,
                windowStart: NOW - config.rateLimitWindowMs - 1,
            });
            sweepStaleWhatsAppMaps(NOW, config, mc, oc, lca, at);
            expect(mc.has("past@jid")).toBe(false);
        });

        it("does not touch other maps when only messageCounts has stale entries", () => {
            const { mc, oc, lca, at } = newMaps();
            mc.set("old@jid", { count: 1, windowStart: NOW - config.rateLimitWindowMs - 100 });
            oc.set("other@jid", ["hi"]);
            lca.set("other@jid", NOW);
            at.set("other@jid", [{ startedAt: NOW, taskId: "t" }]);

            sweepStaleWhatsAppMaps(NOW, config, mc, oc, lca, at);

            expect(mc.has("old@jid")).toBe(false);
            expect(oc.has("other@jid")).toBe(true);
            expect(lca.has("other@jid")).toBe(true);
            expect(at.has("other@jid")).toBe(true);
        });
    });

    describe("ownerConversations / lastConvoActivity", () => {
        it("drops both maps together when activity is older than TTL", () => {
            const { mc, oc, lca, at } = newMaps();
            oc.set("user@jid", ["turn1", "turn2"]);
            lca.set("user@jid", NOW - config.ownerConvoTtlMs - 1);

            sweepStaleWhatsAppMaps(NOW, config, mc, oc, lca, at);

            expect(oc.has("user@jid")).toBe(false);
            expect(lca.has("user@jid")).toBe(false);
        });

        it("keeps entries with recent activity", () => {
            const { mc, oc, lca, at } = newMaps();
            oc.set("user@jid", ["turn1"]);
            lca.set("user@jid", NOW - 60_000); // 1 minute ago

            sweepStaleWhatsAppMaps(NOW, config, mc, oc, lca, at);

            expect(oc.has("user@jid")).toBe(true);
            expect(lca.has("user@jid")).toBe(true);
        });

        it("only removes the stale JID, not others", () => {
            const { mc, oc, lca, at } = newMaps();
            oc.set("stale@jid", ["x"]);
            lca.set("stale@jid", NOW - config.ownerConvoTtlMs - 1);
            oc.set("fresh@jid", ["y"]);
            lca.set("fresh@jid", NOW - 1000);

            sweepStaleWhatsAppMaps(NOW, config, mc, oc, lca, at);

            expect(oc.has("stale@jid")).toBe(false);
            expect(lca.has("stale@jid")).toBe(false);
            expect(oc.has("fresh@jid")).toBe(true);
            expect(lca.has("fresh@jid")).toBe(true);
        });

        it("leaves ownerConversations untouched when lastConvoActivity has no entry for that JID", () => {
            // Defensive: the two maps *should* stay paired in production,
            // but if they drift the sweep shouldn't corrupt state.
            const { mc, oc, lca, at } = newMaps();
            oc.set("orphan@jid", ["stuff"]);
            // no matching lastConvoActivity entry

            sweepStaleWhatsAppMaps(NOW, config, mc, oc, lca, at);

            // No cleanup possible — the entry survives until it gets
            // a lastConvoActivity marker on next write.
            expect(oc.has("orphan@jid")).toBe(true);
        });
    });

    describe("activeTasks", () => {
        it("drops a JID whose tasks are all older than the abandoned threshold", () => {
            const { mc, oc, lca, at } = newMaps();
            at.set("user@jid", [
                { startedAt: NOW - config.activeTaskAbandonedMs - 1, taskId: "t1" },
                { startedAt: NOW - config.activeTaskAbandonedMs - 100, taskId: "t2" },
            ]);

            sweepStaleWhatsAppMaps(NOW, config, mc, oc, lca, at);

            expect(at.has("user@jid")).toBe(false);
        });

        it("filters stale tasks out of a JID that still has fresh ones", () => {
            const { mc, oc, lca, at } = newMaps();
            at.set("user@jid", [
                { startedAt: NOW - config.activeTaskAbandonedMs - 1, taskId: "abandoned" },
                { startedAt: NOW - 1000, taskId: "fresh" },
            ]);

            sweepStaleWhatsAppMaps(NOW, config, mc, oc, lca, at);

            const remaining = at.get("user@jid");
            expect(remaining).toBeDefined();
            expect(remaining!.length).toBe(1);
            expect(remaining![0].taskId).toBe("fresh");
        });

        it("leaves a JID unchanged when every task is fresh", () => {
            const { mc, oc, lca, at } = newMaps();
            const tasks = [
                { startedAt: NOW - 1000, taskId: "t1" },
                { startedAt: NOW - 5000, taskId: "t2" },
                { startedAt: NOW - 100, taskId: "t3" },
            ];
            at.set("user@jid", [...tasks]);

            sweepStaleWhatsAppMaps(NOW, config, mc, oc, lca, at);

            const remaining = at.get("user@jid")!;
            expect(remaining.length).toBe(3);
            // Order preserved
            expect(remaining.map((t) => t.taskId)).toEqual(["t1", "t2", "t3"]);
        });

        it("the boundary task (startedAt == now - TTL) is treated as stale (strict < check)", () => {
            // The sweep uses `now - startedAt < TTL` to decide "alive".
            // At the boundary that's TTL < TTL → false → task is dropped.
            const { mc, oc, lca, at } = newMaps();
            at.set("jid", [
                { startedAt: NOW - config.activeTaskAbandonedMs, taskId: "boundary" },
            ]);
            sweepStaleWhatsAppMaps(NOW, config, mc, oc, lca, at);
            expect(at.has("jid")).toBe(false);
        });

        it("handles an empty task array by deleting the JID entry", () => {
            const { mc, oc, lca, at } = newMaps();
            at.set("empty@jid", []);
            sweepStaleWhatsAppMaps(NOW, config, mc, oc, lca, at);
            expect(at.has("empty@jid")).toBe(false);
        });

        it("doesn't allocate a new array when nothing was filtered", () => {
            // Performance invariant: the else-if branch means we only
            // .set(jid, stillAlive) when the length changed. If every
            // task is fresh, the original array reference stays in place.
            const { mc, oc, lca, at } = newMaps();
            const original = [
                { startedAt: NOW - 100, taskId: "t1" },
                { startedAt: NOW - 200, taskId: "t2" },
            ];
            at.set("user@jid", original);

            sweepStaleWhatsAppMaps(NOW, config, mc, oc, lca, at);

            expect(at.get("user@jid")).toBe(original);
        });
    });

    describe("end-to-end", () => {
        it("handles fully empty maps without throwing", () => {
            const { mc, oc, lca, at } = newMaps();
            expect(() => sweepStaleWhatsAppMaps(NOW, config, mc, oc, lca, at)).not.toThrow();
        });

        it("sweeps all three map types in a single call", () => {
            const { mc, oc, lca, at } = newMaps();
            // Fresh
            mc.set("fresh@jid", { count: 1, windowStart: NOW - 100 });
            oc.set("fresh@jid", ["x"]);
            lca.set("fresh@jid", NOW - 100);
            at.set("fresh@jid", [{ startedAt: NOW - 100, taskId: "a" }]);
            // Stale
            mc.set("stale@jid", { count: 1, windowStart: NOW - config.rateLimitWindowMs - 1 });
            oc.set("stale@jid", ["x"]);
            lca.set("stale@jid", NOW - config.ownerConvoTtlMs - 1);
            at.set("stale@jid", [
                { startedAt: NOW - config.activeTaskAbandonedMs - 1, taskId: "a" },
            ]);

            sweepStaleWhatsAppMaps(NOW, config, mc, oc, lca, at);

            // All stale entries gone
            expect(mc.has("stale@jid")).toBe(false);
            expect(oc.has("stale@jid")).toBe(false);
            expect(lca.has("stale@jid")).toBe(false);
            expect(at.has("stale@jid")).toBe(false);
            // All fresh entries preserved
            expect(mc.has("fresh@jid")).toBe(true);
            expect(oc.has("fresh@jid")).toBe(true);
            expect(lca.has("fresh@jid")).toBe(true);
            expect(at.has("fresh@jid")).toBe(true);
        });
    });
});
