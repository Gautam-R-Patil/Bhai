// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { tryTemplate } from "./composer-templates.js";
import type { ProactiveIntent } from "./intent.js";

function mk(kind: string, payload: Record<string, unknown>): ProactiveIntent {
    const now = Date.now();
    return {
        id: `t-${kind}`,
        source: "calendar_morning",
        mode: "fyi",
        urgency: "normal",
        channelPreference: "telegram",
        topic: "test",
        topicEmbedding: new Array(384).fill(0),
        evidence: [],
        payload: { kind, ...payload },
        payloadKind: kind,
        createdAt: now,
        expiresAt: now + 3600_000,
    };
}

describe("composer templates — V3", () => {
    it("meeting_prep renders time and attendee hint", () => {
        const startMs = new Date("2026-05-08T10:00:00").getTime();
        const out = tryTemplate(mk("meeting_prep", { startMs, title: "sync", hasAttendees: true }), "telegram");
        expect(out).toContain("10:00");
        expect(out).toContain("sync");
        expect(out).toContain("pull context");
    });

    it("meeting_debrief asks a light question", () => {
        const out = tryTemplate(mk("meeting_debrief", { title: "1:1 with dheeraj" }), "telegram");
        expect(out).toContain("1:1 with dheeraj");
        expect(out).toContain("notes");
    });

    it("deadline_imminent shows time left in hours/minutes", () => {
        const dueMs = Date.now() + 45 * 60_000;
        const out = tryTemplate(mk("deadline_imminent", { dueMs, title: "ship PR" }), "telegram");
        expect(out).toContain("ship PR");
        expect(out).toMatch(/\d+m left/);
    });

    it("habit_anomaly names expected activity", () => {
        const out = tryTemplate(mk("habit_anomaly", { activity: "workout", expectedHour: 7 }), "telegram");
        expect(tryTemplate(mk("habit_anomaly", { activity: "journal", expectedHour: 0 }), "telegram")).toContain("12am");
        expect(out).toContain("workout");
        expect(out).toContain("7am");
    });

    it("focus_block_offer includes duration and neighbors", () => {
        const out = tryTemplate(
            mk("focus_block_offer", {
                durationMin: 120,
                prevEventTitle: "standup",
                nextEventTitle: "review",
            }),
            "telegram",
        );
        expect(out).toContain("2h");
        expect(out).toContain("standup");
        expect(out).toContain("review");
    });

    it("stale_email_draft names sender and age", () => {
        const out = tryTemplate(
            mk("stale_email_draft", {
                subject: "Contract review",
                from: "alex@partner.com",
                daysStale: 5,
            }),
            "telegram",
        );
        expect(out).toContain("Contract review");
        expect(out).toContain("alex@partner.com");
        expect(out).toContain("5d");
    });

    it("calendar_today_summary renders count and first event time", () => {
        const out = tryTemplate(
            mk("calendar_today_summary", {
                events: [{ start_ms: new Date("2026-05-08T09:30:00").getTime() }],
                conflicts: [],
            }),
            "telegram",
        );
        expect(out).toMatch(/1 on calendar/);
        expect(out).toContain("9:30");
    });

    it("tasks_today shows urgent + normal + overdue counts", () => {
        const out = tryTemplate(
            mk("tasks_today", {
                urgent: [{ title: "x" }, { title: "y" }],
                normal: [{ title: "z" }],
                overdue: [{ title: "a" }],
            }),
            "telegram",
        );
        expect(out).toContain("2 urgent");
        expect(out).toContain("1 normal");
        expect(out).toContain("1 overdue");
    });

    it("goals_status names first goal and progress", () => {
        const out = tryTemplate(
            mk("goals_status", {
                goals: [{ title: "ship bhai", progress: 60 }],
            }),
            "telegram",
        );
        expect(out).toContain("ship bhai");
        expect(out).toContain("60%");
    });

    it("weather_today adds umbrella heads-up for rain", () => {
        const out = tryTemplate(
            mk("weather_today", {
                summary: "rainy",
                temp_c: 22,
                rain_prob: 0.7,
            }),
            "telegram",
        );
        expect(out).toContain("rainy");
        expect(out).toContain("22°");
        expect(out).toContain("umbrella");
    });

    it("news_today lists headlines", () => {
        const out = tryTemplate(
            mk("news_today", {
                headlines: [{ title: "bhai ships v3" }, { title: "convex adds feature" }],
            }),
            "telegram",
        );
        expect(out).toContain("bhai ships v3");
        expect(out).toContain("convex adds feature");
    });
});
