// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import {
    classifyError,
    extractCodeLocation,
    isToolError,
    ErrorCategory,
} from "./error-types.js";

describe("classifyError — timeout (highest priority)", () => {
    it.each([
        "Operation timed out",
        "Request timeout after 30s",
        "Exceeded time limit",
        "deadline exceeded",
        "ESOCKETTIMEDOUT",
    ])("classifies '%s' as Timeout", (msg) => {
        expect(classifyError(msg).category).toEqual(ErrorCategory.Timeout);
    });

    it("timeout is retryable", () => {
        expect(classifyError("request timed out").retryable).toBe(true);
    });

    it("timeout beats other patterns (e.g. 'timed out on network error')", () => {
        // Would also match Transient via "network error", but Timeout runs first
        const r = classifyError("request timed out due to network error");
        expect(r.category).toEqual(ErrorCategory.Timeout);
    });
});

describe("classifyError — rate limit", () => {
    it.each([
        "HTTP 429",
        "rate limit exceeded",
        "Too Many Requests",
        "quota exceeded",
        "throttled by provider",
        "server at capacity",
        "model is overloaded",
    ])("classifies '%s' as ResourceLimit", (msg) => {
        expect(classifyError(msg).category).toEqual(ErrorCategory.ResourceLimit);
    });

    it("rate limit is retryable (after backoff)", () => {
        expect(classifyError("rate limit").retryable).toBe(true);
    });
});

describe("classifyError — tool missing", () => {
    it.each([
        "tool not found: fizzbuzz",
        "unknown tool: foo",
        "no tool named bar",
        "function not found",
        "not available on this platform",
    ])("classifies '%s' as ToolMissing", (msg) => {
        expect(classifyError(msg).category).toEqual(ErrorCategory.ToolMissing);
    });

    it("tool missing is NOT retryable (reroute instead)", () => {
        expect(classifyError("tool not found").retryable).toBe(false);
    });
});

describe("classifyError — parse errors", () => {
    it.each([
        "JSON.parse failed",
        "Unexpected end of JSON",
        "invalid json received",
        "Not valid JSON: {{{}",
    ])("classifies '%s' as ParseError", (msg) => {
        expect(classifyError(msg).category).toEqual(ErrorCategory.ParseError);
    });

    it("parse error is retryable (rephrase + retry)", () => {
        expect(classifyError("invalid json").retryable).toBe(true);
    });
});

describe("classifyError — dependency missing", () => {
    it.each([
        "sh: sox: command not found",
        "'ffmpeg' is not recognized as an internal or external command",
        "Error: spawn ENOENT",
        "ENOENT: spawn brew failed",
        "Cannot find module 'foo'",
        "MODULE_NOT_FOUND",
        "module not found: bar",
    ])("classifies '%s' as DependencyMissing", (msg) => {
        expect(classifyError(msg).category).toEqual(ErrorCategory.DependencyMissing);
    });

    it("dependency missing is retryable (after auto-install)", () => {
        expect(classifyError("command not found").retryable).toBe(true);
    });
});

describe("classifyError — coding-specific: TypeError", () => {
    it.each([
        "error TS2345: argument not assignable",
        "Type 'string' is not assignable to type 'number'",
        "mypy test.py:10: error: Incompatible types",
        "pyright test.py: error: ...",
        "error[E0308]: mismatched types",
    ])("classifies '%s' as TypeError", (msg) => {
        expect(classifyError(msg).category).toEqual(ErrorCategory.TypeError);
    });

    it("TypeError is NOT retryable (fix the source)", () => {
        expect(classifyError("error TS2345: foo").retryable).toBe(false);
    });
});

describe("classifyError — SyntaxError", () => {
    it.each([
        "SyntaxError: unexpected token }",
        "Parse error: expected semicolon",
        "expected ')' got '}'",
        "unterminated string literal",
        "  unexpected indent", // leading space should still match \bunexpected indent\b
    ])("classifies '%s' as SyntaxError", (msg) => {
        expect(classifyError(msg).category).toEqual(ErrorCategory.SyntaxError);
    });

    it("SyntaxError is NOT retryable", () => {
        expect(classifyError("SyntaxError: foo").retryable).toBe(false);
    });
});

describe("classifyError — ImportError", () => {
    it.each([
        "Cannot find module 'foo'",
        "Module not found: bar",
        "ImportError: cannot import name 'X'",
        "unresolved import: crate::foo",
        "cannot find name 'fs'",
    ])("classifies '%s' as one of ImportError or DependencyMissing", (msg) => {
        // Some overlap with DependencyMissing — both are valid classifications
        // for module-not-found. Pin that it's at least one of the two.
        const cat = classifyError(msg).category;
        expect([ErrorCategory.ImportError, ErrorCategory.DependencyMissing]).toContain(cat);
    });

    it("ImportError is retryable (could be a fetch/resolution blip)", () => {
        const r = classifyError("unresolved import: something");
        expect(r.retryable).toBe(true);
    });
});

describe("classifyError — TestFailure", () => {
    it.each([
        "5 failing tests",
        "Tests:       2 failed, 8 passed",
        "FAIL  src/foo.test.ts > suite > case",
        "AssertionError: expected 1 to equal 2",
        "expected 'foo' to equal 'bar'",
        "test result: FAILED",
    ])("classifies '%s' as TestFailure", (msg) => {
        expect(classifyError(msg).category).toEqual(ErrorCategory.TestFailure);
    });

    it("TestFailure is retryable (sometimes flaky)", () => {
        expect(classifyError("test result: FAILED").retryable).toBe(true);
    });
});

describe("classifyError — LintError", () => {
    it.each([
        "eslint reports 1 error",
        "error 'x' is defined but never used  no-unused-vars",
        "biome: lint check failed",
        "clippy::needless_return error",
    ])("classifies '%s' as LintError", (msg) => {
        expect(classifyError(msg).category).toEqual(ErrorCategory.LintError);
    });
});

describe("classifyError — BuildError", () => {
    it.each([
        "error: compiler failed",
        "webpack compiled with 3 errors",
        "cargo build: could not compile",
        "npm ERR! build script failed",
        "Build failed: missing dependency",
        "Compilation failed: ...",
    ])("classifies '%s' as BuildError", (msg) => {
        // Some could also match ImportError / RuntimeError — pin the general
        // category is reasonable (one of these build-adjacent ones).
        const cat = classifyError(msg).category;
        expect([
            ErrorCategory.BuildError,
            ErrorCategory.ImportError,
            ErrorCategory.RuntimeError,
        ]).toContain(cat);
    });
});

describe("classifyError — RuntimeError", () => {
    it.each([
        "ReferenceError: x is not defined",
        "TypeError: undefined is not a function",
        "RangeError: maximum call stack size",
        "java.lang.NullPointerException",
        "Traceback (most recent call last):\n  File 'x.py'",
        "thread 'main' panicked at 'assertion failed'",
        "Uncaught Exception: boom",
    ])("classifies '%s' as RuntimeError", (msg) => {
        expect(classifyError(msg).category).toEqual(ErrorCategory.RuntimeError);
    });
});

describe("classifyError — user caused", () => {
    it.each([
        "HTTP 404 Not Found",
        "403 Forbidden",
        "401 Unauthorized",
        "invalid URL: notaurl",
        "permission denied",
        "Access Denied",
        "No such file or directory",
        "EACCES",
    ])("classifies '%s' as UserCaused", (msg) => {
        expect(classifyError(msg).category).toEqual(ErrorCategory.UserCaused);
    });

    it("user caused is NOT retryable", () => {
        expect(classifyError("permission denied").retryable).toBe(false);
    });
});

describe("classifyError — transient (network)", () => {
    it.each([
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT", // timeout pattern would match too — see ordering test
        "socket hang up",
        "network error",
        "fetch failed",
        "503 Service Unavailable",
        "502 Bad Gateway",
        "500 Internal Server Error",
        "EPIPE",
        "connection reset",
    ])("classifies '%s' as Transient (or Timeout)", (msg) => {
        // ETIMEDOUT would be caught by TIMEOUT_PATTERNS first
        const cat = classifyError(msg).category;
        expect([ErrorCategory.Transient, ErrorCategory.Timeout]).toContain(cat);
    });

    it("transient is retryable", () => {
        expect(classifyError("ECONNRESET").retryable).toBe(true);
    });
});

describe("classifyError — Unknown fallback", () => {
    it("returns Unknown for prose that matches no pattern", () => {
        const r = classifyError("something unexpected happened during processing");
        expect(r.category).toEqual(ErrorCategory.Unknown);
    });

    it("Unknown is NOT retryable (conservative default)", () => {
        expect(classifyError("weird thing").retryable).toBe(false);
    });
});

describe("classifyError — context + metadata", () => {
    it("includes tool name in context when provided", () => {
        const r = classifyError("some error", "shell_exec");
        expect(r.tool).toEqual("shell_exec");
        expect(r.context.tool).toEqual("shell_exec");
    });

    it("includes durationMs in context when provided (as string)", () => {
        const r = classifyError("some error", "shell_exec", 5000);
        expect(r.context.durationMs).toEqual("5000");
    });

    it("context is empty when neither tool nor duration supplied", () => {
        const r = classifyError("some error");
        expect(r.context).toEqual({});
        expect(r.tool).toBeUndefined();
    });
});

describe("classifyError — priority ordering (subtle)", () => {
    it("timeout beats rate-limit when message has both", () => {
        const r = classifyError("request timed out after rate limit");
        expect(r.category).toEqual(ErrorCategory.Timeout);
    });

    it("dependency missing beats user_caused for ENOENT+spawn", () => {
        const r = classifyError("spawn ENOENT: bar");
        expect(r.category).toEqual(ErrorCategory.DependencyMissing);
    });

    it("TypeError beats BuildError when message has both", () => {
        const r = classifyError("error TS2345: compiler wouldn't complete the build");
        expect(r.category).toEqual(ErrorCategory.TypeError);
    });
});

describe("extractCodeLocation", () => {
    it("extracts tsc-style file(line,col): error", () => {
        const loc = extractCodeLocation("src/foo.ts(42,10): error TS2345");
        expect(loc).toEqual({ file: "src/foo.ts", line: 42, column: 10 });
    });

    it("extracts jest/vitest 'at fn (path:line:col)'", () => {
        const loc = extractCodeLocation(
            "AssertionError: x !== y\n at foo (src/test/bar.test.ts:55:17)",
        );
        expect(loc?.file).toEqual("src/test/bar.test.ts");
        expect(loc?.line).toEqual(55);
        expect(loc?.column).toEqual(17);
    });

    it("extracts plain path:line:col (eslint / rust)", () => {
        const loc = extractCodeLocation("src/lib.rs:10:5: error ...");
        expect(loc?.file).toEqual("src/lib.rs");
        expect(loc?.line).toEqual(10);
        expect(loc?.column).toEqual(5);
    });

    it("extracts path:line with no column", () => {
        const loc = extractCodeLocation("some error at src/index.ts:99");
        expect(loc?.file).toEqual("src/index.ts");
        expect(loc?.line).toEqual(99);
        expect(loc?.column).toBeUndefined();
    });

    it("prefers non-noise paths over node_modules / dist frames", () => {
        const msg =
            "at require (node_modules/foo/dist/bar.js:10:1)\n" +
            "    at handler (src/app.ts:20:5)\n";
        const loc = extractCodeLocation(msg);
        expect(loc?.file).toEqual("src/app.ts");
    });

    it("falls back to noise path when nothing better exists", () => {
        const msg = "at require (node_modules/foo/dist/bar.js:10:1)";
        const loc = extractCodeLocation(msg);
        expect(loc?.file).toMatch(/node_modules/);
    });

    it("returns undefined when no path pattern found", () => {
        expect(extractCodeLocation("just a plain error")).toBeUndefined();
    });
});

describe("isToolError", () => {
    it("returns true for '{\"error\":...}' JSON strings", () => {
        expect(isToolError('{"error":"something broke"}')).toBe(true);
    });

    it("returns true for strings starting with 'Error:'", () => {
        expect(isToolError("Error: tool crashed")).toBe(true);
    });

    it("returns true for 'ERROR:' prefix (uppercase)", () => {
        expect(isToolError("ERROR: kaboom")).toBe(true);
    });

    it("returns true when parsed JSON has string 'error' field", () => {
        expect(isToolError('{"error": "deeper problem", "ok": false}')).toBe(true);
    });

    it("returns true even for a non-string error field (documented: prefix-only check short-circuits)", () => {
        // The startsWith('{"error"') check fires before JSON.parse runs, so
        // the typeof guard only applies when the string shape doesn't
        // already match the prefix. This is a documented quirk — callers
        // who need stricter classification should re-parse downstream.
        expect(isToolError('{"error": 42}')).toBe(true);
    });

    it("returns false when a non-error-prefixed JSON has numeric error field", () => {
        // When the string does NOT start with '{"error"' (extra whitespace in
        // front), it goes through JSON.parse + typeof check, which correctly
        // returns false for a numeric error field.
        expect(isToolError('  {"error": 42}')).toBe(false);
    });

    it("returns false for normal success output", () => {
        expect(isToolError("Operation completed successfully")).toBe(false);
    });

    it("returns false for plain JSON without 'error' field", () => {
        expect(isToolError('{"result": "ok"}')).toBe(false);
    });

    it("returns false for non-JSON text that doesn't start with Error:", () => {
        expect(isToolError("some output")).toBe(false);
    });

    it("returns false for empty string", () => {
        expect(isToolError("")).toBe(false);
    });
});

describe("classifyError — relative-import specifiers are ImportError, not DependencyMissing", () => {
    it("'Cannot find module \"./utils\"' → ImportError (no install can fix a path typo)", () => {
        const r = classifyError("Error: Cannot find module './utils'");
        expect(r.category).toEqual(ErrorCategory.ImportError);
    });

    it("'Cannot find module \"express\"' (bare package) stays DependencyMissing", () => {
        const r = classifyError("Error: Cannot find module 'express'");
        expect(r.category).toEqual(ErrorCategory.DependencyMissing);
    });
});

describe("classifyError — bare × is not a test failure", () => {
    it("a resolution string with × does not classify as TestFailure", () => {
        const r = classifyError("rendered 1920×1080 but write failed");
        expect(r.category).not.toEqual(ErrorCategory.TestFailure);
    });

    it("a real ✗ failure bullet still classifies as TestFailure", () => {
        const r = classifyError("✗ should return 200");
        expect(r.category).toEqual(ErrorCategory.TestFailure);
    });
});
