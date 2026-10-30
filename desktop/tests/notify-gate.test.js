// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";
import { createNotifyGate } from "../notify-gate.js";

const gate = (prefs = {}) => createNotifyGate((k) => prefs[k]);

describe("bot notification gate", () => {
    it("skips done and proactive while a Bhai window is in front", () => {
        const g = gate();
        expect(g({ kind: "done", body: "a" }, true)).toBe(false);
        expect(g({ kind: "proactive", body: "b" }, true)).toBe(false);
        expect(g({ kind: "done", body: "a" }, false)).toBe(true);
    });

    it("always shows reminders, stuck and handoff, unless notifications are off", () => {
        expect(gate()({ kind: "stuck", body: "a" }, true)).toBe(true);
        expect(gate({ notifyOnMessage: false })({ kind: "reminder", body: "a" }, true)).toBe(true);
        expect(gate({ notifyOnTask: false })({ kind: "handoff", body: "a" }, true)).toBe(true);
        expect(gate({ notificationsEnabled: false })({ kind: "stuck", body: "a" }, false)).toBe(false);
    });

    it("follows each kind's own setting", () => {
        expect(gate({ notifyOnTask: false })({ kind: "done", body: "a" }, false)).toBe(false);
        expect(gate({ notifyOnMessage: false })({ kind: "proactive", body: "a" }, false)).toBe(false);
        expect(gate({ notifyOnMessage: false })({ kind: "done", body: "a" }, false)).toBe(true);
    });

    it("drops the same text repeated within 10s and unknown kinds", () => {
        const g = gate();
        expect(g({ kind: "done", body: "same" }, false, 0)).toBe(true);
        expect(g({ kind: "proactive", body: "same" }, false, 5_000)).toBe(false);
        expect(g({ kind: "done", body: "same" }, false, 20_000)).toBe(true);
        expect(g({ kind: "toString", body: "x" }, false)).toBe(false);
    });
});
