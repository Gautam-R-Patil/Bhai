// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

export type LongTaskCompletionEvent = {
    taskId: string;
    task: string;               // short description (the "task" field for the template)
    summary: string;            // the completion summary / quality report
    durationSec: number;
    ts: number;
};

export class LongTaskCompletionBus {
    private subs: Array<(e: LongTaskCompletionEvent) => void> = [];

    subscribe(fn: (e: LongTaskCompletionEvent) => void): () => void {
        this.subs.push(fn);
        return () => {
            this.subs = this.subs.filter((x) => x !== fn);
        };
    }

    emit(e: LongTaskCompletionEvent): void {
        for (const s of this.subs) {
            try {
                s(e);
            } catch {
                // subscriber errors isolated
            }
        }
    }
}

export const globalLongTaskBus = new LongTaskCompletionBus();
