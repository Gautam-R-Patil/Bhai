// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
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

describe("proactive fatigue", () => {
    beforeEach(() => initNotificationTracker(wrapDatabase(new BetterSqlite3(":memory:"))));

    it("two unanswered sends is fatigue; one is not", () => {
        recordNotification("proactive", "nudge 1");
        expect(isFatigued()).toBe(false);
        recordNotification("proactive", "nudge 2");
        expect(isFatigued()).toBe(true);
    });

    it("heartbeat's own log of the same delivery doesn't count twice", () => {
        recordNotification("proactive", "a thought");
        recordNotification("thought", "a thought");
        expect(isFatigued()).toBe(false);
    });

    it("the owner replying (any channel) clears it", () => {
        recordNotification("proactive", "nudge 1");
        recordNotification("proactive", "nudge 2");
        recordOwnerEngagement();
        expect(isFatigued()).toBe(false);
    });
});
