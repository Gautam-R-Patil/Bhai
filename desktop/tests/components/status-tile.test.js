// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { describe, it, expect } from "vitest";
import { classForStatus } from "../../components/status-tile.js";

describe("classForStatus", () => {
    it("green", () => { expect(classForStatus("green")).toBe("sp-tile sp-tile--green"); });
    it("amber", () => { expect(classForStatus("amber")).toBe("sp-tile sp-tile--amber"); });
    it("neutral", () => { expect(classForStatus("neutral")).toBe("sp-tile sp-tile--neutral"); });
    it("unknown falls back to neutral", () => {
        expect(classForStatus("weird")).toBe("sp-tile sp-tile--neutral");
        expect(classForStatus(undefined)).toBe("sp-tile sp-tile--neutral");
    });
});
