// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { expect, it } from "vitest";
import { setBounded } from "./bounded-map.js";

it("keeps the most recent entries up to the cap; re-setting a key makes it recent", () => {
    const m = new Map<string, number>();
    for (const k of ["a", "b", "c"]) setBounded(m, k, 1, 3);
    setBounded(m, "a", 2, 3); // a is now newest
    setBounded(m, "d", 1, 3); // b (oldest) goes
    expect([...m.keys()]).toEqual(["c", "a", "d"]);
    expect(m.get("a")).toBe(2);
});
