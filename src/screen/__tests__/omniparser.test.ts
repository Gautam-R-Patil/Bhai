// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, expect, it } from "vitest";
import { findElementByCaption, type OmniParserElement } from "../omniparser.js";

function el(id: number, caption: string, score = 0.9): OmniParserElement {
    return {
        id,
        bbox: [0, 0, 100, 30],
        score,
        classId: 0,
        caption,
        role: "interactive",
        center: { x: 50, y: 15 },
    };
}

describe("findElementByCaption", () => {
    it("returns null on empty query", () => {
        expect(findElementByCaption([], "")).toBeNull();
        expect(findElementByCaption([el(1, "Save")], "")).toBeNull();
    });

    it("returns null when no element has a caption", () => {
        const r = findElementByCaption([el(1, ""), el(2, "")], "save");
        expect(r).toBeNull();
    });

    it("finds exact match", () => {
        const r = findElementByCaption([el(1, "Save Document"), el(2, "Cancel")], "Cancel");
        expect(r?.id).toBe(2);
    });

    it("finds substring match", () => {
        const r = findElementByCaption([el(1, "Save Document"), el(2, "Cancel")], "doc");
        expect(r?.id).toBe(1);
    });

    it("respects confidence as a tiebreaker", () => {
        const r = findElementByCaption([el(1, "Save", 0.5), el(2, "Save", 0.95)], "save");
        // Both score equally on substring; higher detector confidence wins.
        expect(r?.id).toBe(2);
    });

    it("returns null when no match clears 0.5 floor", () => {
        const r = findElementByCaption([el(1, "completely unrelated text")], "xyz");
        expect(r).toBeNull();
    });
});
