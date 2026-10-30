// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// A search doesn't wait 12s for the slowest engine once one already answered well.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatherWithGrace } from "./web-search.js";

const later = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms));
const good = (l: string[]) => l.length >= 2;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("gatherWithGrace", () => {
    it("stops waiting for a slow engine a grace period after a good answer", async () => {
        let settled = false;
        const out = gatherWithGrace(
            [later(1000, ["a", "b"]), later(12000, ["slow"]), later(1500, [])],
            good,
            2500,
        ).then((r) => {
            settled = true;
            return r;
        });
        await vi.advanceTimersByTimeAsync(3400);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(200); // 1000 + 2500
        expect(settled).toBe(true);
        expect(await out).toEqual({ lists: [["a", "b"], [], []], finished: [true, false, true] });
    });

    it("with no good answer it waits for everyone, and a failing engine counts as empty", async () => {
        const out = gatherWithGrace(
            [later(1000, ["x"]), Promise.reject(new Error("down")), later(9000, ["y"])],
            good,
            2500,
        );
        await vi.advanceTimersByTimeAsync(9000);
        expect(await out).toEqual({ lists: [["x"], [], ["y"]], finished: [true, true, true] });
    });

    it("an engine answering inside the grace is kept", async () => {
        const out = gatherWithGrace([later(1000, ["a", "b"]), later(2000, ["c"])], good, 2500);
        await vi.advanceTimersByTimeAsync(2000);
        expect((await out).lists).toEqual([["a", "b"], ["c"]]);
    });
});
