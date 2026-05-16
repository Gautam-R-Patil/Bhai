// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Tests the pure decision logic + intent shape.
import { describe, it, expect } from "vitest";
import { _internals, buildIntent, decideNudge } from "./onboarding-graduation.js";

const DAY = _internals.MS_PER_DAY;
const NOW = 1_000_000_000_000;

describe("decideNudge — day gates", () => {
    it("returns no-launch-yet when firstLaunchAt is null", () => {
        const d = decideNudge({ now: NOW, state: { nudges: {} }, firstLaunchAt: null });
        expect(d).toEqual({ nudgeId: null, reason: "no-launch-yet" });
    });

    it("returns too-early on day 1", () => {
        const d = decideNudge({ now: NOW, state: { nudges: {} }, firstLaunchAt: NOW - 1 * DAY });
        expect(d).toEqual({ nudgeId: null, reason: "too-early" });
    });

    it("fires personalize-shortcuts on day 2", () => {
        const d = decideNudge({ now: NOW, state: { nudges: {} }, firstLaunchAt: NOW - 2 * DAY });
        expect(d).toEqual({ nudgeId: "personalize-shortcuts", reason: "ok" });
    });

    it("fires browser-memory on day 3 when day-2 already fired", () => {
        const state = { nudges: { "personalize-shortcuts": { firedAt: NOW - 1 * DAY } } };
        const d = decideNudge({ now: NOW, state, firstLaunchAt: NOW - 3 * DAY });
        expect(d).toEqual({ nudgeId: "browser-memory", reason: "ok" });
    });

    it("fires voice-speed on day 5 when days 2+3 already fired", () => {
        const state = {
            nudges: {
                "personalize-shortcuts": { firedAt: NOW - 3 * DAY },
                "browser-memory":        { firedAt: NOW - 2 * DAY },
            },
        };
        const d = decideNudge({ now: NOW, state, firstLaunchAt: NOW - 5 * DAY });
        expect(d).toEqual({ nudgeId: "voice-speed", reason: "ok" });
    });

    it("returns all-fired after every nudge has fired", () => {
        const state = {
            nudges: {
                "personalize-shortcuts": { firedAt: NOW - 5 * DAY },
                "browser-memory":        { firedAt: NOW - 4 * DAY },
                "voice-speed":           { firedAt: NOW - 3 * DAY },
            },
        };
        const d = decideNudge({ now: NOW, state, firstLaunchAt: NOW - 10 * DAY });
        expect(d).toEqual({ nudgeId: null, reason: "all-fired" });
    });

    it("returns graduated when state.graduatedAt is set", () => {
        const d = decideNudge({
            now: NOW,
            state: { graduatedAt: NOW - 1 * DAY, nudges: {} },
            firstLaunchAt: NOW - 10 * DAY,
        });
        expect(d).toEqual({ nudgeId: null, reason: "graduated" });
    });

    it("on day 5 with NO prior fires, lands on personalize-shortcuts (oldest unfired)", () => {
        // Each nudge is gated independently; day 5 satisfies all three day-floors
        // and we pick the first unfired one in priority order.
        const d = decideNudge({ now: NOW, state: { nudges: {} }, firstLaunchAt: NOW - 5 * DAY });
        expect(d).toEqual({ nudgeId: "personalize-shortcuts", reason: "ok" });
    });
});

describe("decideNudge — telemetry gates", () => {
    it("returns telemetry-gate when telemetryCheck returns false", () => {
        const d = decideNudge({
            now: NOW,
            state: { nudges: {} },
            firstLaunchAt: NOW - 2 * DAY,
            telemetryCheck: () => false,
        });
        expect(d.reason).toBe("telemetry-gate");
    });

    it("fires when telemetryCheck returns true", () => {
        const d = decideNudge({
            now: NOW,
            state: { nudges: {} },
            firstLaunchAt: NOW - 2 * DAY,
            telemetryCheck: () => true,
        });
        expect(d.nudgeId).toBe("personalize-shortcuts");
    });

    it("skipTelemetryGates bypasses the check", () => {
        const d = decideNudge({
            now: NOW,
            state: { nudges: {} },
            firstLaunchAt: NOW - 2 * DAY,
            skipTelemetryGates: true,
            telemetryCheck: () => false,
        });
        expect(d.nudgeId).toBe("personalize-shortcuts");
    });
});

describe("buildIntent", () => {
    const def = _internals.NUDGES[0]; // personalize-shortcuts
    const embedding = new Array(384).fill(0.1);

    it("produces an intent whose payload matches the nudge", () => {
        const intent = buildIntent({ nudge: def, hotkey: "Alt+Space", now: NOW, embedding });
        expect(intent.source).toBe("onboarding_graduation");
        expect(intent.mode).toBe("question");
        expect(intent.urgency).toBe("ambient");
        expect(intent.payload.kind).toBe("onboarding_graduation");
        expect(intent.payload.nudgeId).toBe("personalize-shortcuts");
        expect(intent.payload.body).toContain("Alt+Space");
    });

    it("substitutes {hotkey} placeholder", () => {
        const intent = buildIntent({ nudge: def, hotkey: "Ctrl+Space", now: NOW, embedding });
        expect(intent.payload.body).toContain("Ctrl+Space");
        expect(intent.payload.body).not.toContain("{hotkey}");
    });

    it("uses default hotkey when not provided", () => {
        const intent = buildIntent({ nudge: def, hotkey: undefined, now: NOW, embedding });
        expect(intent.payload.body).toContain("Alt+Space");
    });

    it("topicEmbedding is the passed embedding (length 384)", () => {
        const intent = buildIntent({ nudge: def, hotkey: "A", now: NOW, embedding });
        expect(intent.topicEmbedding.length).toBe(384);
    });

    it("validates as a real ProactiveIntent", async () => {
        const { validateIntent } = await import("../intent.js");
        const intent = buildIntent({ nudge: def, hotkey: "A", now: NOW, embedding });
        const v = validateIntent(intent);
        expect(v.ok).toBe(true);
    });

    it("expiresAt is 7 days after createdAt", () => {
        const intent = buildIntent({ nudge: def, hotkey: "A", now: NOW, embedding });
        expect(intent.expiresAt - intent.createdAt).toBe(7 * DAY);
    });
});
