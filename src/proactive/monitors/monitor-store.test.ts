// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { wrapDatabase, initProactiveSchema } from "../../memory/sqlite.js";
import { MonitorStore, type MonitorRule } from "./monitor-store.js";

function mkStore() {
    const raw = new BetterSqlite3(":memory:");
    const db = wrapDatabase(raw);
    initProactiveSchema(db);
    return { raw, store: new MonitorStore(raw) };
}

function mkInput(overrides: Partial<Omit<MonitorRule, "id" | "createdAt" | "active" | "lastFiredAt">> = {}) {
    return {
        userPhrase: "ping me if anyone mentions X",
        topic: "mentions of X",
        topicEmbedding: new Array(384).fill(0).map((_, i) => Math.sin(i * 0.1)),
        scope: {
            channels: ["*"] as ["*"],
            excludeSelf: true,
        },
        urgency: "normal" as const,
        action: {
            defaultMode: "question" as const,
        },
        threshold: 0.82,
        cooldownMinutes: 60,
        ...overrides,
    };
}

describe("MonitorStore", () => {
    it("insert returns a rule with id, createdAt, active=true, lastFiredAt=0", () => {
        const { store } = mkStore();
        const r = store.insert(mkInput());
        expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(r.createdAt).toBeGreaterThan(0);
        expect(r.active).toBe(true);
        expect(r.lastFiredAt).toBe(0);
    });

    it("get returns the inserted rule", () => {
        const { store } = mkStore();
        const inserted = store.insert(mkInput());
        const loaded = store.get(inserted.id);
        expect(loaded).not.toBeNull();
        expect(loaded?.id).toBe(inserted.id);
        expect(loaded?.topic).toBe("mentions of X");
    });

    it("get returns null for unknown id", () => {
        const { store } = mkStore();
        expect(store.get("nonexistent")).toBeNull();
    });

    it("embedding round-trips exactly (with Float32 precision)", () => {
        const { store } = mkStore();
        const inserted = store.insert(mkInput());
        const loaded = store.get(inserted.id)!;
        expect(loaded.topicEmbedding.length).toBe(384);
        // Float32 precision — compare with tolerance
        for (let i = 0; i < 384; i++) {
            expect(loaded.topicEmbedding[i]).toBeCloseTo(inserted.topicEmbedding[i], 5);
        }
    });

    it("scope JSON round-trips with all fields", () => {
        const { store } = mkStore();
        const inserted = store.insert(mkInput({
            scope: {
                channels: ["whatsapp", "telegram"],
                groups: ["build3@g.us"],
                senders: ["alice", "bob"],
                excludeSelf: false,
            },
        }));
        const loaded = store.get(inserted.id)!;
        expect(loaded.scope.channels).toEqual(["whatsapp", "telegram"]);
        expect(loaded.scope.groups).toEqual(["build3@g.us"]);
        expect(loaded.scope.senders).toEqual(["alice", "bob"]);
        expect(loaded.scope.excludeSelf).toBe(false);
    });

    it("action JSON round-trips including suggestedFollowup", () => {
        const { store } = mkStore();
        const inserted = store.insert(mkInput({
            action: {
                defaultMode: "review",
                suggestedFollowup: "draft a reply",
            },
        }));
        const loaded = store.get(inserted.id)!;
        expect(loaded.action.defaultMode).toBe("review");
        expect(loaded.action.suggestedFollowup).toBe("draft a reply");
    });

    it("list returns active rules by default, DESC by createdAt", async () => {
        const { store } = mkStore();
        const a = store.insert(mkInput({ topic: "first" }));
        // Force a gap so createdAt differs
        await new Promise((r) => setTimeout(r, 10));
        const b = store.insert(mkInput({ topic: "second" }));
        const rules = store.list();
        expect(rules.length).toBe(2);
        expect(rules[0].id).toBe(b.id);  // most recent first
        expect(rules[1].id).toBe(a.id);
    });

    it("list excludes inactive rules when onlyActive is true (default)", () => {
        const { store } = mkStore();
        const a = store.insert(mkInput({ topic: "stays" }));
        const b = store.insert(mkInput({ topic: "paused" }));
        store.setActive(b.id, false);
        expect(store.list().length).toBe(1);
        expect(store.list()[0].id).toBe(a.id);
    });

    it("list(false) includes inactive rules", () => {
        const { store } = mkStore();
        const a = store.insert(mkInput());
        const b = store.insert(mkInput());
        store.setActive(b.id, false);
        expect(store.list(false).length).toBe(2);
    });

    it("softDelete sets active=0 but keeps the row", () => {
        const { store } = mkStore();
        const r = store.insert(mkInput());
        store.softDelete(r.id);
        expect(store.list().length).toBe(0);
        expect(store.list(false).length).toBe(1);
        expect(store.get(r.id)).not.toBeNull();
    });

    it("hardDelete removes the row entirely", () => {
        const { store } = mkStore();
        const r = store.insert(mkInput());
        store.hardDelete(r.id);
        expect(store.get(r.id)).toBeNull();
        expect(store.list(false).length).toBe(0);
    });

    it("setActive toggles the active flag", () => {
        const { store } = mkStore();
        const r = store.insert(mkInput());
        store.setActive(r.id, false);
        expect(store.get(r.id)?.active).toBe(false);
        store.setActive(r.id, true);
        expect(store.get(r.id)?.active).toBe(true);
    });

    it("markFired updates lastFiredAt", () => {
        const { store } = mkStore();
        const r = store.insert(mkInput());
        expect(r.lastFiredAt).toBe(0);
        store.markFired(r.id, 1234567890);
        expect(store.get(r.id)?.lastFiredAt).toBe(1234567890);
    });

    it("expiresAt is persisted when set", () => {
        const { store } = mkStore();
        const r = store.insert(mkInput({ expiresAt: 1234567890 }));
        expect(store.get(r.id)?.expiresAt).toBe(1234567890);
    });

    it("expiresAt is undefined when not set", () => {
        const { store } = mkStore();
        const r = store.insert(mkInput());
        expect(store.get(r.id)?.expiresAt).toBeUndefined();
    });
});
