// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateWidgetToken } from "../../widget/widget.js";

const VALID_32 = "a".repeat(32);
const VALID_64 = "b".repeat(64);

describe("F1: validateWidgetToken — fail-CLOSED + timingSafeEqual", () => {
    let original: string | undefined;

    beforeEach(() => {
        original = process.env.WIDGET_TOKEN;
        delete process.env.WIDGET_TOKEN;
    });

    afterEach(() => {
        if (original === undefined) delete process.env.WIDGET_TOKEN;
        else process.env.WIDGET_TOKEN = original;
    });

    it("returns false when WIDGET_TOKEN env is unset (null input)", () => {
        expect(validateWidgetToken(null)).toBe(false);
    });

    it("returns false when WIDGET_TOKEN env is unset (any input)", () => {
        expect(validateWidgetToken("anything")).toBe(false);
    });

    it("returns false when WIDGET_TOKEN is too short (< 32 chars)", () => {
        process.env.WIDGET_TOKEN = "short";
        expect(validateWidgetToken("short")).toBe(false);
    });

    it("returns false on wrong token (same length)", () => {
        process.env.WIDGET_TOKEN = VALID_32;
        expect(validateWidgetToken("c".repeat(32))).toBe(false);
    });

    it("returns true on exact match", () => {
        process.env.WIDGET_TOKEN = VALID_32;
        expect(validateWidgetToken(VALID_32)).toBe(true);
    });

    it("returns true with a 64-char token", () => {
        process.env.WIDGET_TOKEN = VALID_64;
        expect(validateWidgetToken(VALID_64)).toBe(true);
    });

    it("returns false on length mismatch (does not throw)", () => {
        process.env.WIDGET_TOKEN = VALID_32;
        // Different length — must return false, NOT throw (timingSafeEqual throws).
        expect(() => validateWidgetToken("a".repeat(16))).not.toThrow();
        expect(validateWidgetToken("a".repeat(16))).toBe(false);
        expect(validateWidgetToken("a".repeat(33))).toBe(false);
    });

    it("returns false when token is null and env set", () => {
        process.env.WIDGET_TOKEN = VALID_32;
        expect(validateWidgetToken(null)).toBe(false);
    });

    it("returns false when token is empty string and env set", () => {
        process.env.WIDGET_TOKEN = VALID_32;
        expect(validateWidgetToken("")).toBe(false);
    });
});
