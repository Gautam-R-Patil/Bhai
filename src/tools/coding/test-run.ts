// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── test_run ─────────────────────────────────
// Structured test runner that auto-detects the test framework in a
// project, runs the suite (or a targeted pattern), and parses the
// output through the coding error classifier so the agent gets back a
// typed failure list rather than a wall of text. Enables the TDD loop
// described in Phase 4B of the Phase 4 plan.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { classifyError, ErrorCategory, extractCodeLocation } from "../../agents/error-types.js";
import { getPathBlockedReason, isPathAllowed } from "../../security/allowlist.js";
import { auditLog } from "../../security/audit-log.js";
import type { ToolDefinition } from "../get-current-time.js";

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes — test suites can be slow
const MAX_OUTPUT_BYTES = 512 * 1024; // 512KB cap so we don't flood context
const RAW_TAIL_BYTES = 2000; // last 2KB of combined output preserved

// ── Framework Detection ──────────────────────

type Framework = "jest" | "vitest" | "mocha" | "playwright" | "pytest" | "cargo" | "go" | "unknown";

interface FrameworkChoice {
    framework: Framework;
    command: string;
    args: string[];
    notes?: string;
}

function readJsonSafe(filePath: string): Record<string, unknown> | null {
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function hasFileLike(dir: string, names: string[]): string | null {
    for (const name of names) {
        const full = path.join(dir, name);
        if (fs.existsSync(full)) return full;
    }
    return null;
}

function fileIncludes(filePath: string, needle: string): boolean {
    try {
        return fs.readFileSync(filePath, "utf-8").toLowerCase().includes(needle.toLowerCase());
    } catch {
        return false;
    }
}

function detectFramework(cwd: string, override?: string, pattern?: string): FrameworkChoice {
    const normalized = (override ?? "").trim().toLowerCase();
    if (normalized) {
        return fromExplicit(normalized, pattern);
    }

    const pkgJsonPath = path.join(cwd, "package.json");
    const pkg = readJsonSafe(pkgJsonPath);
    if (pkg) {
        const deps = {
            ...((pkg.dependencies as Record<string, string>) || {}),
            ...((pkg.devDependencies as Record<string, string>) || {}),
            ...((pkg.peerDependencies as Record<string, string>) || {}),
        };
        if (deps.vitest) return packageCmd("vitest", ["run", ...(pattern ? [pattern] : [])]);
        if (deps.jest || deps["@jest/core"]) return packageCmd("jest", pattern ? ["--testPathPattern", pattern] : []);
        if (deps["@playwright/test"] || deps.playwright) {
            return packageCmd("playwright", pattern ? ["test", pattern] : ["test"]);
        }
        if (deps.mocha) return packageCmd("mocha", pattern ? [pattern] : []);
        const scripts = (pkg.scripts as Record<string, string>) || {};
        if (typeof scripts.test === "string" && scripts.test.trim().length > 0) {
            return { framework: "unknown", command: "npm", args: ["test", "--silent"], notes: "fallback: npm test" };
        }
    }

    // Python project
    const pyprojectPath = hasFileLike(cwd, ["pyproject.toml"]);
    const setupCfg = hasFileLike(cwd, ["setup.cfg"]);
    const hasPytest =
        (pyprojectPath && fileIncludes(pyprojectPath, "pytest")) ||
        (setupCfg && fileIncludes(setupCfg, "pytest")) ||
        fs.existsSync(path.join(cwd, "pytest.ini"));
    if (hasPytest) {
        return {
            framework: "pytest",
            command: "pytest",
            args: pattern ? ["-k", pattern] : [],
        };
    }

    // Rust project
    if (fs.existsSync(path.join(cwd, "Cargo.toml"))) {
        return {
            framework: "cargo",
            command: "cargo",
            args: ["test", ...(pattern ? [pattern] : [])],
        };
    }

    // Go project
    if (fs.existsSync(path.join(cwd, "go.mod"))) {
        return {
            framework: "go",
            command: "go",
            args: pattern ? ["test", "-run", pattern, "./..."] : ["test", "./..."],
        };
    }

    return {
        framework: "unknown",
        command: "",
        args: [],
        notes: "no recognized test framework detected",
    };
}

function packageCmd(bin: string, extraArgs: string[]): FrameworkChoice {
    return {
        framework: bin as Framework,
        command: "npx",
        args: ["--no-install", bin, ...extraArgs],
    };
}

function fromExplicit(name: string, pattern?: string): FrameworkChoice {
    switch (name) {
        case "jest":
            return packageCmd("jest", pattern ? ["--testPathPattern", pattern] : []);
        case "vitest":
            return packageCmd("vitest", ["run", ...(pattern ? [pattern] : [])]);
        case "mocha":
            return packageCmd("mocha", pattern ? [pattern] : []);
        case "playwright":
            return packageCmd("playwright", pattern ? ["test", pattern] : ["test"]);
        case "pytest":
            return { framework: "pytest", command: "pytest", args: pattern ? ["-k", pattern] : [] };
        case "cargo":
            return { framework: "cargo", command: "cargo", args: ["test", ...(pattern ? [pattern] : [])] };
        case "go":
            return {
                framework: "go",
                command: "go",
                args: pattern ? ["test", "-run", pattern, "./..."] : ["test", "./..."],
            };
        default:
            return {
                framework: "unknown",
                command: name,
                args: pattern ? [pattern] : [],
                notes: "explicit framework override",
            };
    }
}

// ── Summary Parsing ──────────────────────────

interface SuiteTotals {
    passed?: number;
    failed?: number;
    skipped?: number;
}

function extractTotals(text: string, framework: Framework): SuiteTotals {
    const totals: SuiteTotals = {};
    // jest / vitest: "Tests: 3 failed, 12 passed, 15 total" / "Tests  3 failed | 12 passed"
    const jestVitest = text.match(/Tests?:?\s+(?:(\d+)\s+failed[^\d]*)?(?:(\d+)\s+passed)?/i);
    if (jestVitest) {
        if (jestVitest[1]) totals.failed = parseInt(jestVitest[1], 10);
        if (jestVitest[2]) totals.passed = parseInt(jestVitest[2], 10);
    }
    // pytest: "3 failed, 12 passed in 2.31s"
    if (framework === "pytest" || totals.passed === undefined) {
        const py = text.match(/(?:(\d+)\s+failed[^\d]*)?(?:(\d+)\s+passed)/);
        if (py) {
            if (py[1]) totals.failed = parseInt(py[1], 10);
            if (py[2]) totals.passed = parseInt(py[2], 10);
        }
    }
    // cargo: "test result: FAILED. 3 passed; 2 failed"
    if (framework === "cargo") {
        const rs = text.match(/(\d+)\s+passed;\s+(\d+)\s+failed/);
        if (rs) {
            totals.passed = parseInt(rs[1], 10);
            totals.failed = parseInt(rs[2], 10);
        }
    }
    // go: "FAIL\texitcode" — fall back to counting --- FAIL blocks
    if (framework === "go") {
        const failed = (text.match(/^---\s+FAIL:/gm) || []).length;
        const passed = (text.match(/^---\s+PASS:/gm) || []).length;
        if (failed || passed) {
            totals.failed = failed;
            totals.passed = passed;
        }
    }
    return totals;
}

// ── Failure Extraction ───────────────────────

interface TestFailure {
    file?: string;
    line?: number;
    column?: number;
    assertion?: string;
    snippet?: string;
}

const ASSERTION_HINT_PATTERNS = [
    /expected\s+.+/i,
    /assertion\s*failed/i,
    /assert\s+/i,
    /AssertionError[:\s]/,
    /Error:\s+.+/,
    /panicked at/,
];

function extractFailures(text: string, framework: Framework): TestFailure[] {
    const lines = text.split(/\r?\n/);
    const seen = new Set<string>();
    const failures: TestFailure[] = [];

    for (let i = 0; i < lines.length && failures.length < 50; i++) {
        const line = lines[i];
        if (!line) continue;
        // Anchor detection to framework-specific failure markers first, then
        // fall back to a generic "has a file:line and looks like an error"
        // heuristic.
        const isFailureLine =
            /FAIL(?:ED)?\b/i.test(line) ||
            /×|❌|✗/.test(line) ||
            /AssertionError|Error:|expected\s+.+to/i.test(line) ||
            (framework === "cargo" && /test\s+\S+\s+\.\.\.\s+FAILED/i.test(line)) ||
            (framework === "go" && /^---\s+FAIL:/.test(line)) ||
            (framework === "pytest" && /^FAILED\s+\S+/.test(line));
        if (!isFailureLine) continue;

        // Try to extract a location from this line or the next few
        const window = lines.slice(i, Math.min(i + 6, lines.length)).join("\n");
        const loc = extractCodeLocation(window);
        if (!loc?.file) {
            // No location — still capture as an unlocalized failure with
            // the best assertion-shaped hint we can find nearby
            const assertion = window.split("\n").find((l) => ASSERTION_HINT_PATTERNS.some((p) => p.test(l)));
            const key = `noloc::${(assertion || line).slice(0, 80)}`;
            if (!seen.has(key) && assertion) {
                seen.add(key);
                failures.push({ assertion: assertion.trim().slice(0, 200) });
            }
            continue;
        }

        const locKey = `${loc.file}:${loc.line ?? ""}:${loc.column ?? ""}`;
        if (seen.has(locKey)) continue;
        seen.add(locKey);

        const assertion = window.split("\n").find((l) => ASSERTION_HINT_PATTERNS.some((p) => p.test(l)));
        const snippetLines = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 4));
        failures.push({
            file: loc.file,
            line: loc.line,
            column: loc.column,
            assertion: assertion?.trim().slice(0, 300),
            snippet: snippetLines.join("\n").slice(0, 500),
        });
    }

    return failures;
}

// ── Command Execution ───────────────────────

interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    startupError?: string;
}

function runCommand(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
    return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        const onExit = (code: number | null, timedOut: boolean, startupError?: string) => {
            if (settled) return;
            settled = true;
            resolve({
                code: code ?? (startupError ? 127 : 1),
                stdout: stdout.slice(-MAX_OUTPUT_BYTES),
                stderr: stderr.slice(-MAX_OUTPUT_BYTES),
                timedOut,
                startupError,
            });
        };

        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(cmd, args, { cwd, env: process.env });
        } catch (err) {
            onExit(127, false, (err as Error).message);
            return;
        }

        const timer = setTimeout(() => {
            try {
                child.kill("SIGTERM");
            } catch {
                /* */
            }
            setTimeout(() => {
                try {
                    child.kill("SIGKILL");
                } catch {
                    /* */
                }
            }, 2000);
            onExit(null, true);
        }, timeoutMs);

        child.stdout?.on("data", (d) => {
            stdout += d.toString();
        });
        child.stderr?.on("data", (d) => {
            stderr += d.toString();
        });
        child.on("error", (err) => {
            clearTimeout(timer);
            onExit(null, false, err.message);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            onExit(code, false);
        });
    });
}

// ── Tool Definition ──────────────────────────

export const testRun: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "test_run",
            description:
                "Run the project's test suite and return structured pass/fail info. Auto-detects the framework (jest/vitest/mocha/playwright/pytest/cargo/go) by inspecting package.json, pyproject.toml, Cargo.toml, or go.mod in the working directory. Use after every Edit that touches code logic to close the verify loop before claiming done. Returns { framework, command, passed, failed, failures: [{file, line, assertion, snippet}], exit_code, raw_tail }.",
            parameters: {
                type: "object",
                properties: {
                    pattern: {
                        type: "string",
                        description:
                            "Optional test name or path pattern to narrow the run (e.g., 'auth' or 'src/tests/foo.test.ts'). Passed to the framework's filter flag (-k for pytest, --testPathPattern for jest, etc.).",
                    },
                    framework: {
                        type: "string",
                        description:
                            "Force a specific framework: jest | vitest | mocha | playwright | pytest | cargo | go. If omitted, auto-detects.",
                    },
                    cwd: {
                        type: "string",
                        description: "Working directory for the test run. Defaults to the current working directory.",
                    },
                    timeout_ms: {
                        type: "number",
                        description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}). Tests that exceed this are killed and the result reports timed_out=true.`,
                    },
                },
                required: [],
            },
        },
    },

    async handler(input) {
        const rawCwd = (input.cwd as string) || process.cwd();
        const cwd = path.resolve(rawCwd);
        if (!isPathAllowed(cwd)) {
            const reason = getPathBlockedReason(cwd) ?? `Path "${cwd}" is not allowed.`;
            return JSON.stringify({ success: false, error: reason });
        }
        try {
            const stat = fs.statSync(cwd);
            if (!stat.isDirectory()) return JSON.stringify({ success: false, error: `cwd is not a directory: ${cwd}` });
        } catch {
            return JSON.stringify({ success: false, error: `cwd not accessible: ${cwd}` });
        }

        const pattern = (input.pattern as string) || undefined;
        const frameworkOverride = (input.framework as string) || undefined;
        const timeoutMs = Math.max(1000, Number(input.timeout_ms) || DEFAULT_TIMEOUT_MS);

        const choice = detectFramework(cwd, frameworkOverride, pattern);
        if (choice.framework === "unknown" && !choice.command) {
            return JSON.stringify({
                success: false,
                error: "No recognized test framework. Pass `framework` explicitly or run the command via shell_exec.",
                framework: "unknown",
                notes: choice.notes,
            });
        }

        auditLog("test_run", { command: choice.command, args: choice.args, cwd, framework: choice.framework });

        const run = await runCommand(choice.command, choice.args, cwd, timeoutMs);
        const combined = `${run.stdout}\n${run.stderr}`;
        const totals = extractTotals(combined, choice.framework);
        const failures = extractFailures(combined, choice.framework);

        // Feed the tail through classifyError so downstream recovery logic
        // can react to compile/type/build errors that masquerade as test
        // failures (e.g., a tsc error that breaks test loading).
        const tail = combined.slice(-RAW_TAIL_BYTES);
        const classified = combined.trim() ? classifyError(tail, "test_run") : null;
        const classification =
            classified && classified.category !== ErrorCategory.Unknown
                ? { category: classified.category, location: classified.codeLocation }
                : undefined;

        const success =
            !run.timedOut && !run.startupError && (run.code === 0 || (totals.failed === 0 && failures.length === 0));

        return JSON.stringify({
            success,
            framework: choice.framework,
            command: `${choice.command} ${choice.args.join(" ")}`.trim(),
            cwd,
            passed: totals.passed,
            failed: totals.failed ?? failures.length,
            failures,
            exit_code: run.code,
            timed_out: run.timedOut,
            startup_error: run.startupError,
            classification,
            raw_tail: tail,
            notes: choice.notes,
        });
    },
};
