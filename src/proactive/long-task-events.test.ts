// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi } from "vitest";
import { LongTaskCompletionBus } from "./long-task-events.js";

describe("LongTaskCompletionBus", () => {
    const mk = (id: string) => ({
        taskId: id,
        task: "t",
        summary: "s",
        durationSec: 1,
        ts: Date.now(),
    });

    it("fires subscribers on emit", () => {
        const bus = new LongTaskCompletionBus();
        const spy = vi.fn();
        bus.subscribe(spy);
        bus.emit(mk("a"));
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0].taskId).toBe("a");
    });

    it("unsubscribe stops further events", () => {
        const bus = new LongTaskCompletionBus();
        const spy = vi.fn();
        const unsub = bus.subscribe(spy);
        bus.emit(mk("a"));
        unsub();
        bus.emit(mk("b"));
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("isolates subscriber errors", () => {
        const bus = new LongTaskCompletionBus();
        const thrower = vi.fn(() => { throw new Error("boom"); });
        const ok = vi.fn();
        bus.subscribe(thrower);
        bus.subscribe(ok);
        bus.emit(mk("a"));
        expect(thrower).toHaveBeenCalled();
        expect(ok).toHaveBeenCalled();
    });

    it("delivers multiple emits in order", () => {
        const bus = new LongTaskCompletionBus();
        const received: string[] = [];
        bus.subscribe((e) => received.push(e.taskId));
        bus.emit(mk("a"));
        bus.emit(mk("b"));
        bus.emit(mk("c"));
        expect(received).toEqual(["a", "b", "c"]);
    });
});
