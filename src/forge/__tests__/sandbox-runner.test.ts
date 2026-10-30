// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { runTestInSandbox, scoreResult } from "../sandbox-runner.js";

describe("sandbox test runner", () => {
    it("runs a simple handler and returns the result", async () => {
        const r = await runTestInSandbox({
            handlerCode: "return input.x * 2;",
            input: { x: 7 },
            timeoutMs: 5000,
        });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.result).toBe(14);
    });

    it("captures handler errors", async () => {
        const r = await runTestInSandbox({
            handlerCode: `throw new Error("oops");`,
            input: {},
            timeoutMs: 5000,
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain("oops");
    });

    it("times out a long-running handler", async () => {
        const r = await runTestInSandbox({
            handlerCode: `await new Promise(r => setTimeout(r, 10000));`,
            input: {},
            timeoutMs: 500,
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/timeout/i);
    });

    it("gives handlers the same utils as session tools", async () => {
        const r = await runTestInSandbox({
            handlerCode: `return { exists: utils.fs.existsSync(input.dir), joined: require("path").join("a", "b"), viaUtils: typeof utils.console.log };`,
            input: { dir: tmpdir() },
            timeoutMs: 5000,
        });
        expect(r).toMatchObject({ ok: true, result: { exists: true, joined: join("a", "b"), viaUtils: "function" } });
    });

    it("captures console.log output to stdout", async () => {
        const r = await runTestInSandbox({
            handlerCode: `console.log("hello"); return 1;`,
            input: {}, timeoutMs: 1000,
        });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.stdout).toContain("hello");
    });
});

describe("score result", () => {
    it("scores returns_contains correctly", () => {
        const pass = scoreResult({ ok: true, result: "Invoice #123 details", stdout: "", stderr: "" }, { expected_kind: "returns_contains", expected_value: "Invoice #", input: {}, description: "" });
        expect(pass.pass).toBe(true);

        const fail = scoreResult({ ok: true, result: "no match", stdout: "", stderr: "" }, { expected_kind: "returns_contains", expected_value: "Invoice #", input: {}, description: "" });
        expect(fail.pass).toBe(false);
    });

    it("scores returns_equals correctly", () => {
        const pass = scoreResult({ ok: true, result: { a: 1 }, stdout: "", stderr: "" }, { expected_kind: "returns_equals", expected_value: { a: 1 }, input: {}, description: "" });
        expect(pass.pass).toBe(true);
        const fail = scoreResult({ ok: true, result: { a: 2 }, stdout: "", stderr: "" }, { expected_kind: "returns_equals", expected_value: { a: 1 }, input: {}, description: "" });
        expect(fail.pass).toBe(false);
    });

    it("scores returns_matches_regex correctly", () => {
        const pass = scoreResult({ ok: true, result: "Order #12345", stdout: "", stderr: "" }, { expected_kind: "returns_matches_regex", expected_value: "Order #\\d+", input: {}, description: "" });
        expect(pass.pass).toBe(true);
    });

    it("scores throws correctly", () => {
        const pass = scoreResult({ ok: false, error: "any error", stdout: "", stderr: "" }, { expected_kind: "throws", expected_value: "", input: {}, description: "" });
        expect(pass.pass).toBe(true);
        const fail = scoreResult({ ok: true, result: "no throw", stdout: "", stderr: "" }, { expected_kind: "throws", expected_value: "", input: {}, description: "" });
        expect(fail.pass).toBe(false);
    });

    it("scores throws_contains correctly", () => {
        const pass = scoreResult({ ok: false, error: "ENOENT: no such file", stdout: "", stderr: "" }, { expected_kind: "throws_contains", expected_value: "ENOENT", input: {}, description: "" });
        expect(pass.pass).toBe(true);
        const fail = scoreResult({ ok: false, error: "different error", stdout: "", stderr: "" }, { expected_kind: "throws_contains", expected_value: "ENOENT", input: {}, description: "" });
        expect(fail.pass).toBe(false);
    });

    it("scores returns_no_error correctly", () => {
        const pass = scoreResult({ ok: true, result: null, stdout: "", stderr: "" }, { expected_kind: "returns_no_error", expected_value: null, input: {}, description: "" });
        expect(pass.pass).toBe(true);
        const fail = scoreResult({ ok: false, error: "any", stdout: "", stderr: "" }, { expected_kind: "returns_no_error", expected_value: null, input: {}, description: "" });
        expect(fail.pass).toBe(false);
    });

    it("returns pass:false with explanation when regex is invalid", () => {
        const r = scoreResult(
            { ok: true, result: "x", stdout: "", stderr: "" },
            { expected_kind: "returns_matches_regex", expected_value: "[unclosed", input: {}, description: "" },
        );
        expect(r.pass).toBe(false);
        expect(r.explanation).toMatch(/invalid regex/i);
    });

    it("side-effect kinds never pass (nothing checks the side effect)", () => {
        const r = scoreResult(
            { ok: true, result: null, stdout: "", stderr: "" },
            { expected_kind: "side_effect_file_exists", expected_value: "/tmp/x", input: {}, description: "" },
        );
        expect(r.pass).toBe(false);
    });
});
