// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";
import { actionToSend, createNotifyGate } from "../notify-gate.js";

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

    it("treats waiting like stuck and inbox like proactive", () => {
        expect(gate()({ kind: "waiting", body: "a" }, true)).toBe(true);
        expect(gate()({ kind: "inbox", body: "b" }, true)).toBe(false);
        expect(gate({ notifyOnMessage: false })({ kind: "inbox", body: "c" }, false)).toBe(false);
    });

    it("turns buttons into a chat message or an inbox decision, nothing else", () => {
        expect(actionToSend({ label: "Retry", message: "Try again." })).toEqual({ text: "Try again." });
        expect(actionToSend({ label: "Approve", ws: { type: "inbox:approve", id: "i1" } })).toEqual({ raw: { type: "inbox:approve", id: "i1" } });
        expect(actionToSend({ label: "x", ws: { type: "stop", id: "i1" } })).toBeNull();
        expect(actionToSend(undefined)).toBeNull();
    });

    it("drops the same text repeated within 10s and unknown kinds", () => {
        const g = gate();
        expect(g({ kind: "done", body: "same" }, false, 0)).toBe(true);
        expect(g({ kind: "proactive", body: "same" }, false, 5_000)).toBe(false);
        expect(g({ kind: "done", body: "same" }, false, 20_000)).toBe(true);
        expect(g({ kind: "toString", body: "x" }, false)).toBe(false);
    });
});
