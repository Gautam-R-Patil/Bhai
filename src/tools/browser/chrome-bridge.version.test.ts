// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// An extension older than the copy shipped with Bhai is asked to reload: the
// comparison is numeric per part, so 1.0.10 is newer than 1.0.9.

import { describe, expect, it, vi } from "vitest";

vi.mock("../../overlay/overlay-chat.js", () => ({ getOverlayLocalToken: () => "t" }));

const { isNewerVersion } = await import("./chrome-bridge.js");

describe("isNewerVersion", () => {
    it("compares dotted versions part by part", () => {
        expect(isNewerVersion("1.0.5", "1.0.4")).toBe(true);
        expect(isNewerVersion("1.0.10", "1.0.9")).toBe(true);
        expect(isNewerVersion("1.1", "1.0.9")).toBe(true);
        expect(isNewerVersion("1.0.4", "1.0.4")).toBe(false);
        expect(isNewerVersion("1.0.4", "1.0.5")).toBe(false);
        expect(isNewerVersion("1.0", "1.0.0")).toBe(false);
    });
});
