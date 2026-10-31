// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// The protect() memo is dropped after 10 minutes with no call, and answers stay the same.
import { expect, it, vi } from "vitest";

it("drops the memo after 10 idle minutes, keeps it while calls come in", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
        const { protect, _protectMemoSizeForTests } = await import("./pii-vault.js");
        const a = protect("The weather in Pune is nice today");
        expect(_protectMemoSizeForTests()).toBe(1);
        vi.advanceTimersByTime(9 * 60_000);
        protect("hello there"); // a turn: the memo stays
        vi.advanceTimersByTime(9 * 60_000);
        expect(_protectMemoSizeForTests()).toBe(2);
        vi.advanceTimersByTime(2 * 60_000); // 11 min since the last call
        expect(_protectMemoSizeForTests()).toBe(0);
        expect(protect("The weather in Pune is nice today")).toBe(a);
    } finally {
        vi.useRealTimers();
    }
});
