// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// A deferred inbox item comes back when due, with a timer only while something is deferred.
import BetterSqlite3 from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { initProactiveSchema, wrapDatabase } from "../../memory/sqlite.js";
import type { ProactiveIntent } from "../intent.js";
import { InboxEventBus, InboxManager } from "./manager.js";
import { InboxStore } from "./store.js";

it("arms a timer only while an item is deferred and releases it on time", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
        const raw = new BetterSqlite3(":memory:");
        initProactiveSchema(wrapDatabase(raw));
        const store = new InboxStore(raw);
        const inbox = new InboxManager({ store, bus: new InboxEventBus() });
        inbox.watchDeferred();
        expect(vi.getTimerCount()).toBe(0); // nothing deferred: no timer

        const intent = { id: "i1", source: "meeting_followup", mode: "review", topic: "x" } as unknown as ProactiveIntent;
        inbox.enqueue(intent, "follow up?");
        inbox.defer("i1", Date.now() + 90_000);
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(60_000);
        expect(inbox.get("i1")?.status).toBe("deferred");
        vi.advanceTimersByTime(31_000);
        expect(inbox.get("i1")?.status).toBe("pending");
        expect(vi.getTimerCount()).toBe(0);
    } finally {
        vi.useRealTimers();
    }
});
