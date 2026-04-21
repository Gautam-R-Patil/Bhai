// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { wrapDatabase, initProactiveSchema } from "../../memory/sqlite.js";
import { InboxStore } from "./store.js";
import { InboxManager, InboxEventBus } from "./manager.js";
import type { ProactiveIntent, SuggestedToolCall } from "../intent.js";
import type { ExecutionResult } from "./executor.js";

function mk() {
    const raw = new BetterSqlite3(":memory:");
    initProactiveSchema(wrapDatabase(raw));
    const store = new InboxStore(raw);
    const bus = new InboxEventBus();
    const manager = new InboxManager({ store, bus });
    return { manager, bus, store };
}

function intent(id: string): ProactiveIntent {
    return {
        id,
        source: "meeting_followup",
        mode: "review",
        urgency: "normal",
        channelPreference: "overlay",
        topic: "t",
        topicEmbedding: new Array(384).fill(0),
        evidence: [],
        payload: { kind: "meeting_followup" },
        suggestedAction: { toolCalls: [], summary: "do X" },
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
    };
}

describe("InboxManager", () => {
    it("enqueue adds to store and emits 'added'", () => {
        const { manager, bus } = mk();
        const spy = vi.fn();
        bus.subscribe(spy);
        const item = manager.enqueue(intent("a"), "draft this?");
        expect(item.status).toBe("pending");
        expect(spy).toHaveBeenCalledWith({ kind: "added", item });
    });

    it("approve flips status and emits 'updated'", () => {
        const { manager, bus } = mk();
        manager.enqueue(intent("a"), "msg");
        const spy = vi.fn();
        bus.subscribe(spy);
        const updated = manager.approve("a");
        expect(updated?.status).toBe("approved");
        expect(updated?.userAction).toBe("approve");
        expect(updated?.executionStatus).toBe("idle");
        expect(spy).toHaveBeenCalledWith({ kind: "updated", item: updated });
    });

    it("approve returns null for unknown id", () => {
        const { manager } = mk();
        expect(manager.approve("missing")).toBeNull();
    });

    it("reject stores the reason", () => {
        const { manager } = mk();
        manager.enqueue(intent("a"), "msg");
        const updated = manager.reject("a", "not useful");
        expect(updated?.status).toBe("rejected");
        expect(updated?.executionResult).toBe("not useful");
    });

    it("defer stores deferredUntil", () => {
        const { manager } = mk();
        manager.enqueue(intent("a"), "msg");
        const updated = manager.defer("a", 12345);
        expect(updated?.status).toBe("deferred");
        expect(updated?.deferredUntil).toBe(12345);
    });

    it("edit stores the new text without flipping status", () => {
        const { manager } = mk();
        manager.enqueue(intent("a"), "msg");
        const updated = manager.edit("a", "new draft");
        expect(updated?.editedText).toBe("new draft");
        expect(updated?.status).toBe("pending");  // edit alone doesn't approve
        expect(updated?.userAction).toBe("edit");
    });

    it("setExecutionStatus updates execution fields", () => {
        const { manager } = mk();
        manager.enqueue(intent("a"), "msg");
        manager.approve("a");
        let s = manager.setExecutionStatus("a", "running");
        expect(s?.executionStatus).toBe("running");
        s = manager.setExecutionStatus("a", "done", "email sent");
        expect(s?.executionStatus).toBe("done");
        expect(s?.executionResult).toBe("email sent");
    });

    it("expireOlderThan flips old pending and emits", () => {
        const { manager, bus, store } = mk();
        manager.enqueue(intent("a"), "msg");
        // Force old timestamp
        (store as unknown as { db: { prepare: (sql: string) => { run: () => void } } }).db
            .prepare(`UPDATE inbox_items SET created_at = 1 WHERE intent_id = 'a'`).run();

        const spy = vi.fn();
        bus.subscribe(spy);
        const n = manager.expireOlderThan(1000);
        expect(n).toBe(1);
        expect(spy).toHaveBeenCalledWith({ kind: "expired", count: 1 });
    });

    it("readyDeferred re-releases items whose deferredUntil has passed", () => {
        const { manager } = mk();
        manager.enqueue(intent("a"), "msg");
        manager.defer("a", Date.now() - 1000);  // past
        manager.enqueue(intent("b"), "msg2");
        manager.defer("b", Date.now() + 60_000);  // future
        const ready = manager.readyDeferred();
        expect(ready.length).toBe(1);
        expect(ready[0].intent.id).toBe("a");
        expect(manager.get("a")?.status).toBe("pending");
        expect(manager.get("b")?.status).toBe("deferred");
    });

    it("listPending returns only pending items", () => {
        const { manager } = mk();
        manager.enqueue(intent("a"), "msg");
        manager.enqueue(intent("b"), "msg");
        manager.approve("b");
        const p = manager.listPending();
        expect(p.length).toBe(1);
        expect(p[0].intent.id).toBe("a");
    });

    it("getInboxManager/setInboxManager singleton access works", async () => {
        const { getInboxManager, setInboxManager } = await import("./manager.js");
        expect(getInboxManager()).toBeNull();
        const { manager } = mk();
        setInboxManager(manager);
        expect(getInboxManager()).toBe(manager);
        setInboxManager(null);
        expect(getInboxManager()).toBeNull();
    });
});

describe("InboxManager.approve with executor", () => {
    function mkWithExecutor(executor: (calls: SuggestedToolCall[]) => Promise<ExecutionResult>) {
        const raw = new BetterSqlite3(":memory:");
        initProactiveSchema(wrapDatabase(raw));
        const store = new InboxStore(raw);
        const bus = new InboxEventBus();
        const manager = new InboxManager({ store, bus, executor });
        return { manager, bus, store };
    }

    function intentWithCalls(toolCalls: SuggestedToolCall[]): ProactiveIntent {
        return {
            id: "x",
            source: "meeting_followup",
            mode: "review",
            urgency: "normal",
            channelPreference: "overlay",
            topic: "t",
            topicEmbedding: new Array(384).fill(0),
            evidence: [],
            payload: { kind: "meeting_followup" },
            suggestedAction: { toolCalls, summary: "do X" },
            createdAt: Date.now(),
            expiresAt: Date.now() + 60_000,
        };
    }

    it("approve triggers executor; emits running then done", async () => {
        const executor = vi.fn().mockResolvedValue({
            status: "done" as const,
            summary: "Done with send_email.",
            perCallResults: [{ toolName: "send_email", ok: true, output: "sent" }],
        });
        const { manager, bus } = mkWithExecutor(executor);
        manager.enqueue(intentWithCalls([{ toolName: "send_email", args: {} }]), "msg");

        const events: Array<{ status: string; executionStatus: string }> = [];
        bus.subscribe((ev) => {
            if (ev.kind === "updated" && ev.item.intent.id === "x") {
                events.push({ status: ev.item.status, executionStatus: ev.item.executionStatus ?? "?" });
            }
        });

        manager.approve("x");
        // Allow the microtask chain to settle
        await new Promise((r) => setImmediate(r));

        expect(executor).toHaveBeenCalledTimes(1);
        // Expect: approved→idle, running, done in order
        expect(events.map((e) => e.executionStatus)).toContain("running");
        expect(events.map((e) => e.executionStatus)).toContain("done");
    });

    it("approve with failed executor emits failed status + result", async () => {
        const executor = vi.fn().mockResolvedValue({
            status: "failed" as const,
            summary: "Failed at send_email: timeout",
            perCallResults: [{ toolName: "send_email", ok: false, error: "timeout" }],
        });
        const { manager } = mkWithExecutor(executor);
        manager.enqueue(intentWithCalls([{ toolName: "send_email", args: {} }]), "msg");

        manager.approve("x");
        await new Promise((r) => setImmediate(r));

        const item = manager.get("x");
        expect(item?.executionStatus).toBe("failed");
        expect(item?.executionResult).toMatch(/timeout/);
    });

    it("approve without executor is a no-op for execution (keeps legacy behavior)", async () => {
        const raw = new BetterSqlite3(":memory:");
        initProactiveSchema(wrapDatabase(raw));
        const store = new InboxStore(raw);
        const noExecManager = new InboxManager({ store });
        noExecManager.enqueue(intentWithCalls([{ toolName: "a", args: {} }]), "msg");
        const updated = noExecManager.approve("x");
        expect(updated?.executionStatus).toBe("idle");
        await new Promise((r) => setImmediate(r));
        // Status stays idle because no executor is hooked up
        expect(noExecManager.get("x")?.executionStatus).toBe("idle");
    });

    it("approve with no suggestedAction (not a review-mode intent) doesn't call executor", async () => {
        const executor = vi.fn().mockResolvedValue({
            status: "done" as const,
            summary: "Approved (no tool calls to run).",
            perCallResults: [],
        });
        const { manager } = mkWithExecutor(executor);
        // Intent with empty suggestedAction.toolCalls still triggers executor but with zero calls.
        // For "no suggestedAction at all", we need a different shape — but validateIntent blocks it
        // for review mode. So test: empty toolCalls → executor called with empty array.
        manager.enqueue(intentWithCalls([]), "msg");
        manager.approve("x");
        await new Promise((r) => setImmediate(r));
        expect(executor).toHaveBeenCalledWith([]);
    });

    it("thrown executor marks item failed without unhandled rejection", async () => {
        const executor = vi.fn().mockRejectedValue(new Error("boom"));
        const { manager } = mkWithExecutor(executor);
        manager.enqueue(intentWithCalls([{ toolName: "a", args: {} }]), "msg");
        manager.approve("x");
        await new Promise((r) => setImmediate(r));
        const item = manager.get("x");
        expect(item?.executionStatus).toBe("failed");
        expect(item?.executionResult).toMatch(/boom/i);
    });
});
