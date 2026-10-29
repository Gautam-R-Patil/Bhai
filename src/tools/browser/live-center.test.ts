// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, expect, it } from "vitest";
import { liveCenter } from "./live-center.js";

describe("liveCenter: a fallback click uses where the element is now", () => {
    it("measures the element's current box", async () => {
        const handle = { boundingBox: async () => ({ x: 100, y: 400, width: 200, height: 40 }) };
        expect(await liveCenter(handle)).toEqual({ x: 200, y: 420 });
    });

    it("is null when the element is gone, hidden or can't be measured — never the scan's stale x/y", async () => {
        expect(await liveCenter({ boundingBox: async () => null })).toBeNull();
        expect(await liveCenter({ boundingBox: async () => ({ x: 5, y: 5, width: 0, height: 0 }) })).toBeNull();
        expect(await liveCenter({ boundingBox: () => Promise.reject(new Error("detached")) })).toBeNull();
        expect(await liveCenter(null)).toBeNull();
    });
});
