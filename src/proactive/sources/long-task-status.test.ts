// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { makeLongTaskStatusSource } from "./long-task-status.js";
import type { LongTaskCompletionEvent } from "../long-task-events.js";

function makeFakeBus() {
    const subs: Array<(e: LongTaskCompletionEvent) => void> = [];
    return {
        emit: (e: LongTaskCompletionEvent) => subs.forEach((f) => f(e)),
        subscribeToCompletion: (fn: (e: LongTaskCompletionEvent) => void) => {
            subs.push(fn);
            return () => {
                const i = subs.indexOf(fn);
                if (i >= 0) subs.splice(i, 1);
            };
        },
    };
}

const event = (id: string, task = "migration", summary = "done"): LongTaskCompletionEvent => ({
    taskId: id,
    task,
    summary,
    durationSec: 42,
    ts: Date.now(),
});

describe("long_task_status source", () => {
    it("returns empty when no completion events have fired", async () => {
        const bus = makeFakeBus();
        const src = makeLongTaskStatusSource({ subscribeToCompletion: bus.subscribeToCompletion });
        const out = await src.collectIntents({ now: Date.now() });
        expect(out).toEqual([]);
    });

    it("returns one intent per completion event", async () => {
        const bus = makeFakeBus();
        const src = makeLongTaskStatusSource({ subscribeToCompletion: bus.subscribeToCompletion });
        // First call subscribes
        await src.collectIntents({ now: Date.now() });
        // Emit a completion
        bus.emit(event("t1"));
        // Second call drains the pending buffer
        const out = await src.collectIntents({ now: Date.now() });
        expect(out.length).toBe(1);
        expect(out[0].source).toBe("long_task_status");
        expect(out[0].mode).toBe("fyi");
        expect(out[0].urgency).toBe("normal");
    });

    it("payload carries task + summary for the template fast-path", async () => {
        const bus = makeFakeBus();
        const src = makeLongTaskStatusSource({ subscribeToCompletion: bus.subscribeToCompletion });
        await src.collectIntents({ now: Date.now() });
        bus.emit(event("t2", "deep research", "23 sources indexed"));
        const out = await src.collectIntents({ now: Date.now() });
        expect(out[0].payload.kind).toBe("long_task_status");
        expect((out[0].payload as unknown as { task: string }).task).toBe("deep research");
        expect((out[0].payload as unknown as { summary: string }).summary).toBe("23 sources indexed");
    });

    it("multiple completions → multiple intents in emit order", async () => {
        const bus = makeFakeBus();
        const src = makeLongTaskStatusSource({ subscribeToCompletion: bus.subscribeToCompletion });
        await src.collectIntents({ now: Date.now() });
        bus.emit(event("a"));
        bus.emit(event("b"));
        bus.emit(event("c"));
        const out = await src.collectIntents({ now: Date.now() });
        expect(out.length).toBe(3);
        // taskId is stored in evidence; easiest to verify emit order via that
        const ids = out.map((i) => i.evidence.find((e) => e.label === "taskId")?.value);
        expect(ids).toEqual(["a", "b", "c"]);
    });

    it("drain is destructive: second collectIntents returns empty if no new emits", async () => {
        const bus = makeFakeBus();
        const src = makeLongTaskStatusSource({ subscribeToCompletion: bus.subscribeToCompletion });
        await src.collectIntents({ now: Date.now() });
        bus.emit(event("x"));
        const first = await src.collectIntents({ now: Date.now() });
        expect(first.length).toBe(1);
        const second = await src.collectIntents({ now: Date.now() });
        expect(second).toEqual([]);
    });

    it("embedding is 384-length zero vector (dedup-friendly)", async () => {
        const bus = makeFakeBus();
        const src = makeLongTaskStatusSource({ subscribeToCompletion: bus.subscribeToCompletion });
        await src.collectIntents({ now: Date.now() });
        bus.emit(event("y"));
        const [intent] = await src.collectIntents({ now: Date.now() });
        expect(intent.topicEmbedding.length).toBe(384);
        expect(intent.topicEmbedding.every((v) => v === 0)).toBe(true);
    });
});
