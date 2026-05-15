// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { ensureToolResult, isErrorResultString, toolError, toolResult, toolSuccess } from "./tool-result.js";

describe("toolError", () => {
    it("returns a JSON string with an error field", () => {
        const raw = toolError("boom");
        expect(JSON.parse(raw)).toEqual({ error: "boom" });
    });

    it("coerces Error instances to their message", () => {
        const raw = toolError(new Error("oops"));
        expect(JSON.parse(raw)).toEqual({ error: "oops" });
    });

    it("coerces non-string non-Error values to string", () => {
        const raw = toolError(42 as unknown as string);
        expect(JSON.parse(raw)).toEqual({ error: "42" });
    });

    it("merges extra fields alongside the error", () => {
        const raw = toolError("nope", { code: 404, path: "/x" });
        expect(JSON.parse(raw)).toEqual({ error: "nope", code: 404, path: "/x" });
    });

    it("does NOT let extras overwrite the error field", () => {
        const raw = toolError("real error", {
            error: "fake",
        } as unknown as Record<string, unknown>);
        expect(JSON.parse(raw)).toEqual({ error: "real error" });
    });

    it("stringifies a null message as 'null'", () => {
        const raw = toolError(null as unknown as string);
        expect(JSON.parse(raw)).toEqual({ error: "null" });
    });
});

describe("toolSuccess", () => {
    it("returns a JSON string with the given payload", () => {
        const raw = toolSuccess({ data: [1, 2, 3] });
        expect(JSON.parse(raw)).toEqual({ data: [1, 2, 3] });
    });

    it("never includes an error field on a plain payload", () => {
        const raw = toolSuccess({ ok: true });
        expect(JSON.parse(raw)).not.toHaveProperty("error");
    });

    it("accepts a primitive and wraps under { result }", () => {
        expect(JSON.parse(toolSuccess("hello"))).toEqual({ result: "hello" });
        expect(JSON.parse(toolSuccess(42))).toEqual({ result: 42 });
        expect(JSON.parse(toolSuccess(true))).toEqual({ result: true });
    });

    it("accepts arrays and wraps under { result }", () => {
        expect(JSON.parse(toolSuccess([1, 2]))).toEqual({ result: [1, 2] });
    });

    it("accepts null and wraps under { result: null }", () => {
        expect(JSON.parse(toolSuccess(null))).toEqual({ result: null });
    });
});

describe("toolResult", () => {
    it("returns toolError shape when `ok: false`", () => {
        const raw = toolResult({ ok: false, error: "x" });
        expect(JSON.parse(raw)).toEqual({ error: "x" });
    });

    it("returns toolSuccess shape when `ok: true`", () => {
        const raw = toolResult({ ok: true, data: { hello: "world" } });
        expect(JSON.parse(raw)).toEqual({ hello: "world" });
    });
});

describe("isErrorResultString", () => {
    it("detects an error-shaped JSON string", () => {
        expect(isErrorResultString(toolError("x"))).toBe(true);
    });

    it("rejects a success-shaped JSON string", () => {
        expect(isErrorResultString(toolSuccess({ ok: true }))).toBe(false);
    });

    it("rejects non-JSON input without throwing", () => {
        expect(isErrorResultString("not json")).toBe(false);
        expect(isErrorResultString("")).toBe(false);
    });

    it("rejects a JSON string where error is not a string", () => {
        expect(isErrorResultString('{"error": null}')).toBe(false);
        expect(isErrorResultString('{"error": 5}')).toBe(false);
    });
});

describe("ensureToolResult", () => {
    it("passes strings through untouched", () => {
        expect(ensureToolResult("already a string")).toBe("already a string");
    });

    it("serializes objects", () => {
        const out = ensureToolResult({ hello: "world" });
        expect(JSON.parse(out)).toEqual({ hello: "world" });
    });

    it("serializes null/undefined to JSON null", () => {
        expect(ensureToolResult(null)).toBe("null");
        expect(ensureToolResult(undefined)).toBe("null");
    });
});
