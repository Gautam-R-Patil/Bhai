// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The fatigue gate must see the owner talking back, or it mutes every proactive message.
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

    it("5 unanswered notifications in 4h is fatigue", () => {
        for (let i = 0; i < 5; i++) recordNotification("proactive", `nudge ${i}`);
        expect(isFatigued()).toBe(true);
    });

    it("the owner replying (any channel) clears it", () => {
        for (let i = 0; i < 5; i++) recordNotification("proactive", `nudge ${i}`);
        recordOwnerEngagement();
        expect(isFatigued()).toBe(false);
    });
});
