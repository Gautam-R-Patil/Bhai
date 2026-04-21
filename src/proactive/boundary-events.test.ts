// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, vi } from "vitest";
import { BoundaryBus } from "./boundary-events.js";

describe("BoundaryBus", () => {
    it("fires subscribers when an event is emitted", () => {
        const bus = new BoundaryBus();
        const spy = vi.fn();
        bus.subscribe(spy);
        bus.emit({ kind: "idle_start", ts: 1 });
        expect(spy).toHaveBeenCalledWith({ kind: "idle_start", ts: 1 });
    });

    it("debounces rapid identical events within 500ms", () => {
        const bus = new BoundaryBus();
        const spy = vi.fn();
        bus.subscribe(spy);
        bus.emit({ kind: "idle_start", ts: 1 });
        bus.emit({ kind: "idle_start", ts: 100 });
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("allows different kinds through even within 500ms", () => {
        const bus = new BoundaryBus();
        const spy = vi.fn();
        bus.subscribe(spy);
        bus.emit({ kind: "idle_start", ts: 1 });
        bus.emit({ kind: "screen_lock", ts: 100 });
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it("allows same kind after >500ms gap", () => {
        const bus = new BoundaryBus();
        const spy = vi.fn();
        bus.subscribe(spy);
        bus.emit({ kind: "idle_start", ts: 1 });
        bus.emit({ kind: "idle_start", ts: 501 });
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it("unsubscribe stops further events", () => {
        const bus = new BoundaryBus();
        const spy = vi.fn();
        const unsub = bus.subscribe(spy);
        bus.emit({ kind: "idle_start", ts: 1 });
        unsub();
        bus.emit({ kind: "app_switch", ts: 2000 });
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("isolates subscriber errors", () => {
        const bus = new BoundaryBus();
        const thrower = vi.fn(() => { throw new Error("boom"); });
        const ok = vi.fn();
        bus.subscribe(thrower);
        bus.subscribe(ok);
        bus.emit({ kind: "app_switch", ts: 1 });
        expect(thrower).toHaveBeenCalled();
        expect(ok).toHaveBeenCalled();  // second subscriber still fires
    });
});
