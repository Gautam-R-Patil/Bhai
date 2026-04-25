// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validatePatch, applyCodeChange, revertCodeChanges } from "../patch-validator.js";
import type { CodeChange } from "../code-proposer.js";

describe("validatePatch", () => {
    it("accepts a simple patch that only imports from ../registry.js", () => {
        const content = `import type { HarnessDimension } from "../registry.js";
export function scoreFusion(x: number): number { return x * 0.5; }`;
        const result = validatePatch(content, "fusion.ts");
        expect(result.valid).toBe(true);
        expect(result.violations).toEqual([]);
    });

    it("rejects imports from outside ../", () => {
        const content = `import fs from "node:fs";
export function foo() {}`;
        const result = validatePatch(content, "x.ts");
        expect(result.valid).toBe(false);
        expect(result.violations.some(v => /import/i.test(v))).toBe(true);
    });

    it("rejects process.env writes", () => {
        const content = `export function leak() { process.env.SECRET = "x"; }`;
        const result = validatePatch(content, "leak.ts");
        expect(result.valid).toBe(false);
        expect(result.violations.some(v => /process\.env/i.test(v))).toBe(true);
    });

    it.each([
        ["require call", `const x = require("fs");`],
        ["eval call", `eval("2+2");`],
        ["Function constructor", `new Function("return 1")();`],
        ["child_process import", `import cp from "child_process";`],
        ["exec call", `exec("rm -rf /");`],
        ["spawn call", `spawn("bash");`],
    ])("rejects %s", (_label, body) => {
        const content = `export function f() { ${body} }`;
        const result = validatePatch(content, "bad.ts");
        expect(result.valid).toBe(false);
    });

    it.each([
        ["fetch", `fetch("https://evil.example.com");`],
        ["http.", `http.get("x");`],
        ["https.", `https.request({});`],
        ["net.Socket", `new net.Socket();`],
        ["WebSocket", `new WebSocket("wss://x");`],
    ])("rejects network primitive %s", (_label, body) => {
        const content = `export function f() { ${body} }`;
        const result = validatePatch(content, "net.ts");
        expect(result.valid).toBe(false);
    });

    it.each([
        ["fs.rm", `fs.rm("/etc/passwd", () => {});`],
        ["fs.rmSync", `fs.rmSync("/tmp/other");`],
        ["fs.unlink", `fs.unlink("/var/secret", () => {});`],
    ])("rejects %s on paths outside data/harness/", (_label, body) => {
        const content = `export function f() { ${body} }`;
        const result = validatePatch(content, "rm.ts");
        expect(result.valid).toBe(false);
    });

    it("rejects files over 50KB", () => {
        const content = "export function f() {}\n" + "x".repeat(60_000);
        const result = validatePatch(content, "huge.ts");
        expect(result.valid).toBe(false);
        expect(result.violations.some(v => /50KB|size/i.test(v))).toBe(true);
    });

    it("rejects files with no exported function or const", () => {
        const content = `const x = 1; const y = 2;`;
        const result = validatePatch(content, "noexport.ts");
        expect(result.valid).toBe(false);
        expect(result.violations.some(v => /export/i.test(v))).toBe(true);
    });

    it("accepts `export const` as a valid export", () => {
        const content = `export const K = 15;`;
        const result = validatePatch(content, "k.ts");
        expect(result.valid).toBe(true);
    });

    it("accepts `export function` with proper imports", () => {
        const content = `import type { HarnessDimension } from "../types.js";
export function clip(x: number): number { return Math.max(0, Math.min(1, x)); }`;
        const result = validatePatch(content, "clip.ts");
        expect(result.valid).toBe(true);
    });
});

describe("applyCodeChange + revertCodeChanges", () => {
    let target: string;

    beforeEach(() => {
        target = mkdtempSync(join(tmpdir(), "atlas-patch-"));
    });

    afterEach(() => {
        try { rmSync(target, { recursive: true, force: true }); } catch { /* */ }
    });

    it("writes the patch file to <target>/src/harness/proposed-changes/<patchFile>", () => {
        const change: CodeChange = { patchFile: "weights.ts", content: "export const W = 0.7;" };
        applyCodeChange(change, target);
        const final = join(target, "src/harness/proposed-changes/weights.ts");
        expect(existsSync(final)).toBe(true);
        expect(readFileSync(final, "utf-8")).toBe("export const W = 0.7;");
    });

    it("creates the directory if it does not exist", () => {
        const change: CodeChange = { patchFile: "nested.ts", content: "export const N = 1;" };
        applyCodeChange(change, target);
        expect(existsSync(join(target, "src/harness/proposed-changes"))).toBe(true);
    });

    it("revertCodeChanges deletes everything under src/harness/proposed-changes/", () => {
        mkdirSync(join(target, "src/harness/proposed-changes"), { recursive: true });
        writeFileSync(join(target, "src/harness/proposed-changes/a.ts"), "export const A = 1;");
        writeFileSync(join(target, "src/harness/proposed-changes/b.ts"), "export const B = 2;");
        revertCodeChanges(target);
        const dir = join(target, "src/harness/proposed-changes");
        if (existsSync(dir)) {
            expect(readdirSync(dir)).toHaveLength(0);
        } else {
            expect(existsSync(dir)).toBe(false);
        }
    });

    it("revertCodeChanges is a no-op if the directory does not exist", () => {
        expect(() => revertCodeChanges(target)).not.toThrow();
    });
});
