// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Two unanswered proactive sends mean FYI-only, until the owner talks back.
import BetterSqlite3 from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { wrapDatabase } from "../memory/sqlite.js";
import {
    initNotificationTracker,
    isFatigued,
    recordNotification,
    recordOwnerEngagement,
} from "./notification-tracker.js";

let raw: BetterSqlite3.Database;
// Moves every row logged so far 10 minutes into the past.
const earlier = () => raw.prepare("UPDATE notification_log SET sent_at = datetime(sent_at, '-10 minutes')").run();

describe("proactive fatigue", () => {
    beforeEach(() => {
        raw = new BetterSqlite3(":memory:");
        initNotificationTracker(wrapDatabase(raw));
    });

    it("two unanswered sends is fatigue; one is not", () => {
        recordNotification("proactive", "nudge 1");
        earlier();
        expect(isFatigued()).toBe(false);
        recordNotification("proactive", "nudge 2");
        expect(isFatigued()).toBe(true);
    });

    it("one message fanned out to Telegram and the overlay is one send", () => {
        recordNotification("proactive", "research complete");
        recordNotification("proactive", "research complete");
        expect(isFatigued()).toBe(false);
    });

    it("heartbeat's own log of the same delivery doesn't count twice", () => {
        recordNotification("proactive", "a thought");
        recordNotification("thought", "a thought");
        expect(isFatigued()).toBe(false);
    });

    it("the owner replying (any channel) clears it", () => {
        recordNotification("proactive", "nudge 1");
        earlier();
        recordNotification("proactive", "nudge 2");
        recordOwnerEngagement();
        expect(isFatigued()).toBe(false);
    });
});
