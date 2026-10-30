// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// InboxManager — coordinates state transitions on InboxStore + emits events
// for the overlay (Task 4.2) and chat fallback (Task 4.3) layers to
// subscribe to. No WS/channel code lives here; pure bus.

import type { ProactiveIntent, SuggestedToolCall } from "../intent.js";
import type { InboxStore, InboxItem, InboxStatus } from "./store.js";
import type { ExecutionResult } from "./executor.js";
import { debugProactive } from "../kill-switches.js";

export type InboxEvent =
    | { kind: "added"; item: InboxItem }
    | { kind: "updated"; item: InboxItem }
    | { kind: "expired"; count: number };

export class InboxEventBus {
    private subs: Array<(e: InboxEvent) => void> = [];

    subscribe(fn: (e: InboxEvent) => void): () => void {
        this.subs.push(fn);
        return () => {
            this.subs = this.subs.filter((x) => x !== fn);
        };
    }

    emit(e: InboxEvent): void {
        for (const s of this.subs) {
            try { s(e); } catch { /* isolate subscriber errors */ }
        }
    }
}

export const globalInboxBus = new InboxEventBus();

export type InboxManagerDeps = {
    store: InboxStore;
    bus?: InboxEventBus;
    executor?: (calls: SuggestedToolCall[]) => Promise<ExecutionResult>;
};

export class InboxManager {
    private store: InboxStore;
    private bus: InboxEventBus;
    private executor?: (calls: SuggestedToolCall[]) => Promise<ExecutionResult>;
    private deferTimer: ReturnType<typeof setTimeout> | null = null;
    private watching = false;

    constructor(deps: InboxManagerDeps) {
        this.store = deps.store;
        this.bus = deps.bus ?? globalInboxBus;
        this.executor = deps.executor;
    }

    /** Called by the Observer when a review-mode intent is released. */
    enqueue(intent: ProactiveIntent, composedText: string): InboxItem {
        const item = this.store.add({ intent, composedText });
        debugProactive("inbox_added", { id: intent.id, source: intent.source });
        this.bus.emit({ kind: "added", item });
        return item;
    }

    /** Called when the user clicks Approve in the overlay or chat buttons. */
    approve(id: string): InboxItem | null {
        const updated = this.store.update(id, {
            status: "approved",
            userAction: "approve",
            userActionAt: Date.now(),
            executionStatus: "idle",
        });
        if (!updated) return null;
        debugProactive("inbox_approved", { id });
        this.bus.emit({ kind: "updated", item: updated });

        // Kick off execution in the background if an executor + suggestedAction are available
        if (this.executor && updated.intent.suggestedAction) {
            this.runExecution(id, updated.intent.suggestedAction.toolCalls).catch((err) => {
                debugProactive("inbox_execution_unhandled", { id, err: (err as Error).message });
            });
        }
        return updated;
    }

    private async runExecution(id: string, toolCalls: SuggestedToolCall[]): Promise<void> {
        if (!this.executor) return;
        // Mark as running
        const running = this.store.update(id, { executionStatus: "running" });
        if (running) this.bus.emit({ kind: "updated", item: running });

        try {
            const result = await this.executor(toolCalls);
            const done = this.store.update(id, {
                executionStatus: result.status === "done" ? "done" : "failed",
                executionResult: result.summary,
            });
            if (done) this.bus.emit({ kind: "updated", item: done });
            debugProactive("inbox_execution_complete", { id, status: result.status });
        } catch (err) {
            const msg = (err as Error).message;
            const failed = this.store.update(id, {
                executionStatus: "failed",
                executionResult: `Unexpected error: ${msg}`,
            });
            if (failed) this.bus.emit({ kind: "updated", item: failed });
            debugProactive("inbox_execution_failed", { id, err: msg });
        }
    }

    /** Called when the user clicks Reject. */
    reject(id: string, reason?: string): InboxItem | null {
        const updated = this.store.update(id, {
            status: "rejected",
            userAction: "reject",
            userActionAt: Date.now(),
            executionResult: reason,
        });
        if (!updated) return null;
        debugProactive("inbox_rejected", { id, reason: reason?.slice(0, 80) });
        this.bus.emit({ kind: "updated", item: updated });
        return updated;
    }

    /** Called when the user defers to a later time. */
    defer(id: string, until: number): InboxItem | null {
        const updated = this.store.update(id, {
            status: "deferred",
            userAction: "defer",
            userActionAt: Date.now(),
            deferredUntil: until,
        });
        if (!updated) return null;
        debugProactive("inbox_deferred", { id, until });
        this.bus.emit({ kind: "updated", item: updated });
        if (this.watching) this.watchDeferred();
        return updated;
    }

    /** Called when the user edits the proposed text before approving. */
    edit(id: string, newText: string): InboxItem | null {
        const updated = this.store.update(id, {
            userAction: "edit",
            userActionAt: Date.now(),
            editedText: newText,
        });
        if (!updated) return null;
        debugProactive("inbox_edited", { id });
        this.bus.emit({ kind: "updated", item: updated });
        return updated;
    }

    /** Called during execution to update the running → done/failed state. */
    setExecutionStatus(id: string, status: "idle" | "running" | "done" | "failed", result?: string): InboxItem | null {
        const updated = this.store.update(id, {
            executionStatus: status,
            executionResult: result,
        });
        if (!updated) return null;
        debugProactive("inbox_execution", { id, status });
        this.bus.emit({ kind: "updated", item: updated });
        return updated;
    }

    /** Expire pending items older than N hours (default 7 days). */
    expireOlderThan(ms: number): number {
        const cutoff = Date.now() - ms;
        const count = this.store.expireOld(cutoff);
        if (count > 0) {
            debugProactive("inbox_expired", { count });
            this.bus.emit({ kind: "expired", count });
        }
        return count;
    }

    /** Re-release deferred items whose deferredUntil has passed. Returns the items. */
    readyDeferred(): InboxItem[] {
        const deferred = this.store.listAll("deferred");
        const now = Date.now();
        const ready: InboxItem[] = [];
        for (const item of deferred) {
            if (item.deferredUntil && item.deferredUntil <= now) {
                const reactivated = this.store.update(item.intent.id, {
                    status: "pending",
                    deferredUntil: undefined,
                });
                if (reactivated) {
                    ready.push(reactivated);
                    this.bus.emit({ kind: "updated", item: reactivated });
                }
            }
        }
        return ready;
    }

    /**
     * Keep re-releasing deferred items on time: one timer for the earliest deferredUntil,
     * re-checked at least once a minute (a sleeping Mac's timers run late), and no timer at all
     * while nothing is deferred. defer() re-arms it.
     */
    watchDeferred(): void {
        this.watching = true;
        if (this.deferTimer) clearTimeout(this.deferTimer);
        this.deferTimer = null;
        this.readyDeferred();
        const next = Math.min(...this.store.listAll("deferred").map((i) => i.deferredUntil ?? Number.POSITIVE_INFINITY));
        if (!Number.isFinite(next)) return;
        this.deferTimer = setTimeout(() => this.watchDeferred(), Math.min(Math.max(next - Date.now(), 0), 60_000));
        this.deferTimer.unref?.();
    }

    /** Read-through accessors. */
    listPending(): InboxItem[] { return this.store.listPending(); }
    listAll(status?: InboxStatus): InboxItem[] { return this.store.listAll(status); }
    get(id: string): InboxItem | null { return this.store.get(id); }
}

// ── Singleton accessor (like getMonitorStore + getObserver) ──

let _manager: InboxManager | null = null;
export function getInboxManager(): InboxManager | null { return _manager; }
export function setInboxManager(m: InboxManager | null): void { _manager = m; }
