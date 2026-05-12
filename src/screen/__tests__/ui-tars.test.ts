// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { describe, expect, it } from "vitest";
import { parseGroundingResponse } from "../ui-tars.js";

describe("parseGroundingResponse", () => {
    it("parses a clean JSON object", () => {
        const r = parseGroundingResponse('{"x": 412, "y": 318, "confidence": 0.93, "reasoning": "the Save button"}');
        expect(r).toEqual({ x: 412, y: 318, confidence: 0.93, reasoning: "the Save button" });
    });

    it("handles braces inside reasoning string (P3 R1 finding)", () => {
        const r = parseGroundingResponse('{"x": 100, "y": 200, "confidence": 0.9, "reasoning": "the {Save} button"}');
        expect(r?.x).toBe(100);
        expect(r?.reasoning).toBe("the {Save} button");
    });

    it("clamps coords to ±32767 (defence against hallucinated MAX_SAFE_INTEGER)", () => {
        const r = parseGroundingResponse('{"x": 99999999, "y": -99999999, "confidence": 0.9}');
        expect(r?.x).toBe(32767);
        expect(r?.y).toBe(-32767);
    });

    it("extracts JSON from surrounding prose", () => {
        const r = parseGroundingResponse(
            'Looking at the screenshot, the target is clearly the Save button. Here is my answer: {"x": 412, "y": 318, "confidence": 0.95}',
        );
        expect(r?.x).toBe(412);
        expect(r?.y).toBe(318);
    });

    it("extracts JSON from code-fenced response", () => {
        const r = parseGroundingResponse('```json\n{"x": 100, "y": 200, "confidence": 0.8}\n```');
        expect(r?.x).toBe(100);
    });

    it("clamps confidence to 0..1", () => {
        const r = parseGroundingResponse('{"x": 1, "y": 1, "confidence": 1.5}');
        expect(r?.confidence).toBe(1);
        const r2 = parseGroundingResponse('{"x": 1, "y": 1, "confidence": -0.3}');
        expect(r2?.confidence).toBe(0);
    });

    it("defaults confidence to 0.5 when missing", () => {
        const r = parseGroundingResponse('{"x": 1, "y": 1}');
        expect(r?.confidence).toBe(0.5);
    });

    it("rounds non-integer coords", () => {
        const r = parseGroundingResponse('{"x": 412.7, "y": 317.2, "confidence": 0.9}');
        expect(r?.x).toBe(413);
        expect(r?.y).toBe(317);
    });

    it("returns null on missing x/y", () => {
        expect(parseGroundingResponse('{"confidence": 0.9}')).toBeNull();
        expect(parseGroundingResponse('{"x": 100, "confidence": 0.9}')).toBeNull();
    });

    it("returns null on non-numeric coords", () => {
        expect(parseGroundingResponse('{"x": "abc", "y": 100}')).toBeNull();
    });

    it("returns null on empty input", () => {
        expect(parseGroundingResponse("")).toBeNull();
        expect(parseGroundingResponse("no json here")).toBeNull();
    });

    it("accepts negative coordinates (e.g. secondary monitor)", () => {
        const r = parseGroundingResponse('{"x": -100, "y": 500, "confidence": 0.8}');
        expect(r?.x).toBe(-100);
        expect(r?.y).toBe(500);
    });
});
