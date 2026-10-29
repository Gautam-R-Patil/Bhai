// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Boundary events — transitions in user state that the scheduler uses to
// decide when to release queued proactive intents. Emitted from activity.ts
// (idle, app_switch) and environment-sensors.ts (screen_lock/unlock in future).
// The Observer (Task 2.3) subscribes to this bus and notifies the Rust
// scheduler via scheduler_mark_boundary().

export type BoundaryEventKind =
    | "idle_start"
    | "idle_end"
    | "app_switch"
    | "screen_lock"
    | "screen_unlock"
    | "meeting_end"
    | "typing_stopped"
    | "morning_window";

export type BoundaryEvent = {
    kind: BoundaryEventKind;
    ts: number;
    meta?: Record<string, unknown>;
};

export class BoundaryBus {
    private subs: Array<(e: BoundaryEvent) => void> = [];
    private lastByKind = new Map<BoundaryEventKind, number>();

    subscribe(fn: (e: BoundaryEvent) => void): () => void {
        this.subs.push(fn);
        return () => {
            this.subs = this.subs.filter((x) => x !== fn);
        };
    }

    emit(e: BoundaryEvent): void {
        const last = this.lastByKind.get(e.kind) ?? -Infinity;
        if (e.ts - last < 500) return;
        this.lastByKind.set(e.kind, e.ts);
        for (const s of this.subs) {
            try {
                s(e);
            } catch {
                // subscriber errors are isolated — one bad handler doesn't block others
            }
        }
    }
}

export const globalBoundaryBus = new BoundaryBus();
