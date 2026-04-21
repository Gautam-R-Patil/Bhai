// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { wrapDatabase, initProactiveSchema } from "../../memory/sqlite.js";
import { InboxStore } from "./store.js";
import type { ProactiveIntent } from "../intent.js";

function mkStore() {
    const raw = new BetterSqlite3(":memory:");
    const db = wrapDatabase(raw);
    initProactiveSchema(db);
    return { raw, store: new InboxStore(raw) };
}

function mkIntent(id: string): ProactiveIntent {
    return {
        id,
        source: "meeting_followup",
        mode: "review",
        urgency: "normal",
        channelPreference: "overlay",
        topic: "test",
        topicEmbedding: new Array(384).fill(0),
        evidence: [],
        payload: { kind: "meeting_followup", foo: "bar" },
        suggestedAction: { toolCalls: [], summary: "draft a recap email" },
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
    };
}

describe("InboxStore", () => {
    it("add returns a pending item", () => {
        const { store } = mkStore();
        const item = store.add({ intent: mkIntent("a"), composedText: "Draft recap?" });
        expect(item.status).toBe("pending");
        expect(item.composedText).toBe("Draft recap?");
        expect(item.createdAt).toBeGreaterThan(0);
    });

    it("get returns the stored item", () => {
        const { store } = mkStore();
        const intent = mkIntent("b");
        store.add({ intent, composedText: "msg" });
        const loaded = store.get("b");
        expect(loaded).not.toBeNull();
        expect(loaded?.intent.id).toBe("b");
        expect(loaded?.composedText).toBe("msg");
    });

    it("get returns null for unknown id", () => {
        const { store } = mkStore();
        expect(store.get("missing")).toBeNull();
    });

    it("intent JSON round-trips", () => {
        const { store } = mkStore();
        const intent = mkIntent("c");
        store.add({ intent, composedText: "msg" });
        const loaded = store.get("c")!;
        expect(loaded.intent.source).toBe("meeting_followup");
        expect(loaded.intent.suggestedAction?.summary).toBe("draft a recap email");
    });

    it("listPending returns only pending, newest first", async () => {
        const { store } = mkStore();
        store.add({ intent: mkIntent("a"), composedText: "1" });
        await new Promise((r) => setTimeout(r, 10));
        store.add({ intent: mkIntent("b"), composedText: "2" });
        await new Promise((r) => setTimeout(r, 10));
        store.add({ intent: mkIntent("c"), composedText: "3" });

        store.update("b", { status: "approved", userActionAt: Date.now(), userAction: "approve" });

        const pending = store.listPending();
        expect(pending.length).toBe(2);
        expect(pending[0].intent.id).toBe("c");
        expect(pending[1].intent.id).toBe("a");
    });

    it("listAll includes all statuses, newest first", async () => {
        const { store } = mkStore();
        store.add({ intent: mkIntent("a"), composedText: "1" });
        await new Promise((r) => setTimeout(r, 10));
        store.add({ intent: mkIntent("b"), composedText: "2" });
        store.update("a", { status: "rejected", userActionAt: Date.now(), userAction: "reject" });

        const all = store.listAll();
        expect(all.length).toBe(2);
        expect(all[0].intent.id).toBe("b");
        expect(all[1].intent.id).toBe("a");
        expect(all[1].status).toBe("rejected");
    });

    it("listAll(status) filters by status", () => {
        const { store } = mkStore();
        store.add({ intent: mkIntent("a"), composedText: "1" });
        store.add({ intent: mkIntent("b"), composedText: "2" });
        store.update("a", { status: "approved", userActionAt: Date.now(), userAction: "approve" });
        expect(store.listAll("approved").length).toBe(1);
        expect(store.listAll("pending").length).toBe(1);
    });

    it("update merges the patch and returns the new item", () => {
        const { store } = mkStore();
        store.add({ intent: mkIntent("a"), composedText: "msg" });
        const updated = store.update("a", {
            status: "approved",
            userActionAt: 123,
            userAction: "approve",
            executionStatus: "running",
        });
        expect(updated?.status).toBe("approved");
        expect(updated?.userActionAt).toBe(123);
        expect(updated?.userAction).toBe("approve");
        expect(updated?.executionStatus).toBe("running");
    });

    it("update returns null for unknown id", () => {
        const { store } = mkStore();
        expect(store.update("missing", { status: "approved" })).toBeNull();
    });

    it("defer round-trips deferredUntil", () => {
        const { store } = mkStore();
        store.add({ intent: mkIntent("a"), composedText: "msg" });
        store.update("a", {
            status: "deferred",
            userAction: "defer",
            userActionAt: 100,
            deferredUntil: 1000,
        });
        expect(store.get("a")?.deferredUntil).toBe(1000);
    });

    it("expireOld flips old pending to expired, returns count", () => {
        const { store } = mkStore();
        store.add({ intent: mkIntent("a"), composedText: "old" });
        // Force old timestamp
        const raw = (store as unknown as { db: { prepare: (sql: string) => { run: (...p: unknown[]) => unknown } } }).db;
        raw.prepare(`UPDATE inbox_items SET created_at = 1 WHERE intent_id = 'a'`).run();

        store.add({ intent: mkIntent("b"), composedText: "new" });

        const count = store.expireOld(1000);
        expect(count).toBe(1);
        expect(store.get("a")?.status).toBe("expired");
        expect(store.get("b")?.status).toBe("pending");
    });

    it("hardDelete removes the row", () => {
        const { store } = mkStore();
        store.add({ intent: mkIntent("a"), composedText: "msg" });
        store.hardDelete("a");
        expect(store.get("a")).toBeNull();
    });

    it("add with INSERT OR REPLACE lets a caller re-add the same id", () => {
        const { store } = mkStore();
        store.add({ intent: mkIntent("a"), composedText: "first" });
        store.add({ intent: mkIntent("a"), composedText: "second" });
        const loaded = store.get("a");
        expect(loaded?.composedText).toBe("second");
    });
});
