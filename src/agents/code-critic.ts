// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Code-Aware Multi-Critic ──────────────────
// Deterministic code quality critic that runs the project's real
// typechecker, linter, and test runner in parallel and aggregates
// their exit status into a ConsensusReflection-shaped result so it
// drops into the existing evaluator / swarm synthesis pipeline.
//
// Unlike the LLM-based multi-critic, these perspectives score from
// objective tool output (exit codes + parsed failure counts) so scores
// are stable across runs and cost ~zero LLM tokens.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { testRun } from "../tools/coding/test-run.js";
import { classifyError, ErrorCategory, extractCodeLocation } from "./error-types.js";
import type { ConsensusReflection } from "./multi-critic.js";

const COMPILE_TIMEOUT_MS = 20_000;
const LINT_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 90_000;
const SAST_TIMEOUT_MS = 30_000;

// ── Options ──────────────────────────────────

export interface CodeCriticOptions {
    /** Working directory whose project we evaluate. Defaults to process.cwd(). */
    cwd?: string;
    /** Description of the change under review (shown in issue messages). */
    taskDescription?: string;
    /** Skip the test runner (faster; good for mid-session evaluations). Default false. */
    skipTests?: boolean;
    /** Skip the lint step. Default false. */
    skipLint?: boolean;
    /** Skip the compile step. Default false. */
    skipCompile?: boolean;
    /** Skip the SAST (Semgrep) security check. Default false. */
    skipSast?: boolean;
    /** Per-check timeout override. */
    compileTimeoutMs?: number;
    lintTimeoutMs?: number;
    testTimeoutMs?: number;
    sastTimeoutMs?: number;
    /**
     * Phase 4J: if a URL is provided, the ui_verify perspective runs
     * browser_verify against it as an additional check. Meant for coder
     * steps that touched frontend/UI files and have a running dev server.
     */
    verifyUrl?: string;
    /** Selectors that must exist on the verified page. Forwarded to browser_verify. */
    verifyExpectSelectors?: string[];
    /** Text that must be visible on the verified page. */
    verifyExpectText?: string[];
}

// ── UI-file detection (shared helper) ─────────

const UI_FILE_EXTENSIONS = new Set([
    ".tsx",
    ".jsx",
    ".vue",
    ".svelte",
    ".html",
    ".htm",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".astro",
    ".marko",
    ".mdx",
]);

/**
 * Returns true if any of the file paths looks like a frontend/UI artifact.
 * Used by the swarm + sub-agent layers to decide whether to schedule a
 * post-coding browser verification step.
 */
export function touchesUI(files: string[]): boolean {
    for (const f of files) {
        const dot = f.lastIndexOf(".");
        if (dot < 0) continue;
        const ext = f.slice(dot).toLowerCase();
        if (UI_FILE_EXTENSIONS.has(ext)) return true;
    }
    return false;
}

// ── Perspective Result Shape ─────────────────

interface PerspectiveResult {
    name: "compile_check" | "test_runner" | "lint_style" | "ui_verify" | "sast";
    score: number; // 0-100
    weight: number; // aggregation weight
    issues: string[]; // short, actionable
    suggestions: string[];
    ran: boolean; // false means skipped / framework not present
    tool: string; // the command or tool name that ran
}

// ── Command helper ───────────────────────────

interface CmdResult {
    code: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    startupError?: string;
}

function runCmd(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<CmdResult> {
    return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        const done = (code: number | null, timedOut: boolean, startupError?: string) => {
            if (settled) return;
            settled = true;
            resolve({
                code: code ?? (startupError ? 127 : 1),
                stdout: stdout.slice(-64 * 1024),
                stderr: stderr.slice(-64 * 1024),
                timedOut,
                startupError,
            });
        };

        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(cmd, args, { cwd, env: process.env });
        } catch (err) {
            done(127, false, (err as Error).message);
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
            }, 1500);
            done(null, true);
        }, timeoutMs);

        child.stdout?.on("data", (d) => {
            stdout += d.toString();
        });
        child.stderr?.on("data", (d) => {
            stderr += d.toString();
        });
        child.on("error", (err) => {
            clearTimeout(timer);
            done(null, false, err.message);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            done(code, false);
        });
    });
}

// ── Project detection helpers ────────────────

function readPkg(cwd: string): Record<string, unknown> | null {
    try {
        const raw = fs.readFileSync(path.join(cwd, "package.json"), "utf-8");
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function hasFile(cwd: string, name: string): boolean {
    return fs.existsSync(path.join(cwd, name));
}

// ── Compile Check ────────────────────────────

async function runCompileCheck(cwd: string, timeoutMs: number): Promise<PerspectiveResult> {
    const result: PerspectiveResult = {
        name: "compile_check",
        score: 100,
        weight: 0.4,
        issues: [],
        suggestions: [],
        ran: false,
        tool: "",
    };

    const pkg = readPkg(cwd);
    let cmd: string | null = null;
    let args: string[] = [];

    if (pkg) {
        const scripts = (pkg.scripts as Record<string, string>) || {};
        if (scripts.typecheck) {
            cmd = "npm";
            args = ["run", "--silent", "typecheck"];
            result.tool = "npm run typecheck";
        } else if (hasFile(cwd, "tsconfig.json")) {
            cmd = "npx";
            args = ["--no-install", "tsc", "--noEmit"];
            result.tool = "tsc --noEmit";
        }
    }
    if (!cmd && hasFile(cwd, "Cargo.toml")) {
        cmd = "cargo";
        args = ["check", "--quiet"];
        result.tool = "cargo check";
    }
    if (!cmd && hasFile(cwd, "go.mod")) {
        cmd = "go";
        args = ["build", "./..."];
        result.tool = "go build ./...";
    }
    if (!cmd && hasFile(cwd, "pyproject.toml") && readPyprojectHas(cwd, "pyright")) {
        cmd = "pyright";
        args = ["--outputjson"];
        result.tool = "pyright";
    }

    if (!cmd) return result;

    result.ran = true;
    const run = await runCmd(cmd, args, cwd, timeoutMs);
    if (run.timedOut) {
        result.score = 60;
        result.issues.push(`${result.tool} timed out after ${timeoutMs}ms`);
        return result;
    }
    if (run.startupError) {
        result.ran = false;
        return result;
    }
    if (run.code === 0) return result;

    const combined = `${run.stdout}\n${run.stderr}`;
    const errorLines = combined
        .split(/\r?\n/)
        .filter((l) => /\berror\b|TS\d+|error\[E\d+\]/i.test(l))
        .slice(0, 6);
    result.issues = errorLines.map((l) => l.trim().slice(0, 200));

    // Feed top error into classifyError for suggestion
    if (errorLines.length > 0) {
        const classified = classifyError(errorLines[0], "compile_check");
        if (classified.category === ErrorCategory.TypeError) {
            result.suggestions.push(
                "Read the type definitions for the mismatched value and adjust either the type or the call site.",
            );
        } else if (classified.category === ErrorCategory.SyntaxError) {
            result.suggestions.push(
                "Open the reported file/line and fix the parse error — likely a missing brace/paren/semicolon.",
            );
        } else if (classified.category === ErrorCategory.BuildError) {
            result.suggestions.push(
                "Inspect the build error — a missing import, unresolved path, or misconfigured bundler is likely.",
            );
        }
        const loc = extractCodeLocation(errorLines[0]);
        if (loc?.file) result.suggestions.push(`Start at ${loc.file}${loc.line ? `:${loc.line}` : ""}.`);
    }

    // Score is 0 when compile fails with any errors — objective
    result.score = 0;
    return result;
}

function readPyprojectHas(cwd: string, needle: string): boolean {
    try {
        const raw = fs.readFileSync(path.join(cwd, "pyproject.toml"), "utf-8");
        return raw.toLowerCase().includes(needle);
    } catch {
        return false;
    }
}

// ── Lint Check ───────────────────────────────

async function runLintCheck(cwd: string, timeoutMs: number): Promise<PerspectiveResult> {
    const result: PerspectiveResult = {
        name: "lint_style",
        score: 100,
        weight: 0.2,
        issues: [],
        suggestions: [],
        ran: false,
        tool: "",
    };

    const pkg = readPkg(cwd);
    let cmd: string | null = null;
    let args: string[] = [];

    if (pkg) {
        const scripts = (pkg.scripts as Record<string, string>) || {};
        const deps = {
            ...((pkg.dependencies as Record<string, string>) || {}),
            ...((pkg.devDependencies as Record<string, string>) || {}),
        };
        if (scripts.lint) {
            cmd = "npm";
            args = ["run", "--silent", "lint"];
            result.tool = "npm run lint";
        } else if (deps["@biomejs/biome"]) {
            cmd = "npx";
            args = ["--no-install", "biome", "check", "."];
            result.tool = "biome check";
        } else if (deps.eslint) {
            cmd = "npx";
            args = ["--no-install", "eslint", "."];
            result.tool = "eslint";
        }
    }
    if (!cmd && hasFile(cwd, "Cargo.toml")) {
        cmd = "cargo";
        args = ["clippy", "--quiet"];
        result.tool = "cargo clippy";
    }
    if (!cmd && hasFile(cwd, "pyproject.toml") && readPyprojectHas(cwd, "ruff")) {
        cmd = "ruff";
        args = ["check", "."];
        result.tool = "ruff check";
    }

    if (!cmd) return result;

    result.ran = true;
    const run = await runCmd(cmd, args, cwd, timeoutMs);
    if (run.timedOut) {
        result.score = 70;
        result.issues.push(`${result.tool} timed out`);
        return result;
    }
    if (run.startupError) {
        result.ran = false;
        return result;
    }
    if (run.code === 0) return result;

    const combined = `${run.stdout}\n${run.stderr}`;
    const violations = combined
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0 && /error|warning|×|✗|lint/i.test(l))
        .slice(0, 6);
    result.issues = violations.map((l) => l.trim().slice(0, 200));
    // Soft score: a handful of lint findings = 60; many = 30
    result.score = violations.length <= 2 ? 70 : violations.length <= 5 ? 55 : 30;
    result.suggestions.push(
        "Re-run the linter with --fix (or --write) to auto-resolve safe violations before claiming done.",
    );
    return result;
}

// ── SAST Check (Semgrep) ──────────────────────
// Runs `semgrep --config=auto --error` over the diff against origin/HEAD
// (or the whole tree if no git). Only fires if `semgrep` is on PATH.
// Fails open — the binary missing is not a quality signal, just
// "we don't have this check available here".

async function runSastCheck(cwd: string, timeoutMs: number): Promise<PerspectiveResult> {
    const result: PerspectiveResult = {
        name: "sast",
        score: 100,
        weight: 0.15,
        issues: [],
        suggestions: [],
        ran: false,
        tool: "semgrep",
    };

    // Honor a global kill-switch to avoid adding latency when the user
    // hasn't opted into Semgrep (it can be slow on large repos).
    if (process.env.BHAI_NO_SAST === "true") return result;

    // Scan only changed files if in a git repo — massively faster on big trees.
    let scanArgs: string[] = ["--config=auto", "--json", "--quiet", "--error"];
    try {
        const diff = await runCmd("git", ["diff", "--name-only", "HEAD"], cwd, 3_000);
        if (diff.code === 0) {
            const files = diff.stdout
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter((s) => s.length > 0 && /\.(ts|tsx|js|jsx|py|rs|go|java|rb|php|c|cpp|h)$/.test(s));
            if (files.length > 0) scanArgs = scanArgs.concat(files);
            else scanArgs.push(cwd);
        } else {
            scanArgs.push(cwd);
        }
    } catch {
        scanArgs.push(cwd);
    }

    const run = await runCmd("semgrep", scanArgs, cwd, timeoutMs);
    if (run.startupError) return result; // semgrep not installed — silent
    result.ran = true;
    if (run.timedOut) {
        result.score = 75;
        result.issues.push("semgrep timed out — narrow the scope or set BHAI_NO_SAST=true");
        return result;
    }
    if (run.code === 0) return result; // clean

    // --error exits non-zero on findings. Parse --json output for detail.
    try {
        const parsed = JSON.parse(run.stdout || "{}") as {
            results?: Array<{
                check_id?: string;
                path?: string;
                start?: { line?: number };
                extra?: { severity?: string; message?: string };
            }>;
        };
        const results = parsed.results ?? [];
        if (results.length === 0) return result;
        const sev = (s?: string) => (s === "ERROR" ? 3 : s === "WARNING" ? 2 : 1);
        results.sort((a, b) => sev(b.extra?.severity) - sev(a.extra?.severity));
        const top = results.slice(0, 6);
        result.issues = top.map((r) => {
            const where = `${r.path ?? "?"}:${r.start?.line ?? "?"}`;
            const msg = (r.extra?.message ?? r.check_id ?? "finding").toString().slice(0, 200);
            return `[${(r.extra?.severity ?? "info").toLowerCase()}] ${where} — ${msg}`;
        });
        // Score scaled by worst severity + finding count
        const errors = results.filter((r) => r.extra?.severity === "ERROR").length;
        const warns = results.filter((r) => r.extra?.severity === "WARNING").length;
        if (errors > 0) result.score = Math.max(20, 60 - errors * 5);
        else if (warns > 3) result.score = 55;
        else result.score = 70;
        result.suggestions.push(
            "Semgrep flagged patterns that may be unsafe or insecure. Inspect each finding — if false-positive, add a nosemgrep comment; otherwise fix the pattern at the reported line.",
        );
    } catch {
        // Non-JSON output (error text) — fall back to a soft score
        result.score = 60;
        result.issues.push((run.stderr || run.stdout || "").slice(0, 300));
    }
    return result;
}

// ── Test Runner Check ────────────────────────

async function runTestCheck(cwd: string, timeoutMs: number): Promise<PerspectiveResult> {
    const result: PerspectiveResult = {
        name: "test_runner",
        score: 100,
        weight: 0.4,
        issues: [],
        suggestions: [],
        ran: false,
        tool: "test_run",
    };

    try {
        const raw = await testRun.handler({ cwd, timeout_ms: timeoutMs });
        const parsed = JSON.parse(raw) as {
            success: boolean;
            framework: string;
            failed?: number;
            passed?: number;
            failures?: { file?: string; line?: number; assertion?: string }[];
            timed_out?: boolean;
            startup_error?: string;
            error?: string;
        };

        if (parsed.error && /no recognized test framework/i.test(parsed.error)) {
            result.ran = false;
            return result;
        }

        result.ran = true;
        result.tool = `test_run (${parsed.framework})`;

        if (parsed.timed_out) {
            result.score = 60;
            result.issues.push("Test run timed out before completion.");
            return result;
        }
        if (parsed.startup_error) {
            result.score = 40;
            result.issues.push(`Test runner failed to start: ${parsed.startup_error}`);
            return result;
        }

        const failed = parsed.failed ?? 0;
        const passed = parsed.passed ?? 0;
        if (parsed.success && failed === 0) return result;

        // Score decays with failure count relative to total
        const total = passed + failed || 1;
        result.score = Math.max(0, Math.round(100 * (passed / total)));

        for (const f of (parsed.failures || []).slice(0, 5)) {
            const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "(unlocalized)";
            result.issues.push(`${loc} — ${f.assertion ?? "failing test"}`.slice(0, 200));
        }
        result.suggestions.push(
            "Read the failing test's assertion, understand what invariant broke, then edit the implementation (not the test unless the contract changed).",
        );
    } catch (err) {
        result.ran = false;
        result.issues.push(`test_run invocation failed: ${(err as Error).message}`);
    }
    return result;
}

// ── Aggregation ──────────────────────────────

function aggregate(results: PerspectiveResult[], taskDescription?: string): ConsensusReflection {
    const ran = results.filter((r) => r.ran);
    if (ran.length === 0) {
        // No checks executed — be transparent: neutral verdict, no retry
        return {
            overall_score: 70,
            key_issues: [],
            consensus_suggestions: [
                "No compile/lint/test runners were detected in this workspace — unable to auto-verify the change.",
            ],
            should_retry: false,
        };
    }

    const totalWeight = ran.reduce((s, r) => s + r.weight, 0);
    const overall = ran.reduce((s, r) => s + r.score * r.weight, 0) / (totalWeight || 1);

    const keyIssues: string[] = [];
    const suggestions: string[] = [];
    for (const r of ran) {
        if (r.score >= 85 || r.issues.length === 0) continue;
        for (const issue of r.issues) keyIssues.push(`[${r.name}] ${issue}`);
        for (const s of r.suggestions) if (!suggestions.includes(s)) suggestions.push(s);
    }

    const shouldRetry = overall < 60;

    if (taskDescription && keyIssues.length > 0) {
        keyIssues.unshift(`Changes evaluated: ${taskDescription.slice(0, 120)}`);
    }

    return {
        overall_score: Math.round(overall),
        key_issues: keyIssues.slice(0, 8),
        consensus_suggestions: suggestions.slice(0, 5),
        should_retry: shouldRetry,
    };
}

// ── Public API ───────────────────────────────

export async function runCodeMultiCritic(options: CodeCriticOptions = {}): Promise<ConsensusReflection> {
    const cwd = path.resolve(options.cwd || process.cwd());
    const checks: Promise<PerspectiveResult>[] = [];

    if (!options.skipCompile) {
        checks.push(runCompileCheck(cwd, options.compileTimeoutMs ?? COMPILE_TIMEOUT_MS));
    }
    if (!options.skipLint) {
        checks.push(runLintCheck(cwd, options.lintTimeoutMs ?? LINT_TIMEOUT_MS));
    }
    if (!options.skipTests) {
        checks.push(runTestCheck(cwd, options.testTimeoutMs ?? TEST_TIMEOUT_MS));
    }
    if (!options.skipSast) {
        checks.push(runSastCheck(cwd, options.sastTimeoutMs ?? SAST_TIMEOUT_MS));
    }
    if (options.verifyUrl) {
        checks.push(runUiVerify(options.verifyUrl, options.verifyExpectSelectors, options.verifyExpectText));
    }

    try {
        const results = await Promise.all(checks);
        return aggregate(results, options.taskDescription);
    } catch (err) {
        console.warn("[CODE-CRITIC] aggregation failed:", (err as Error).message);
        return {
            overall_score: 70,
            key_issues: [`Code critic errored: ${(err as Error).message}`],
            consensus_suggestions: [],
            should_retry: false,
        };
    }
}

// ── UI Verify Perspective (Phase 4J) ─────────

async function runUiVerify(url: string, expectSelectors?: string[], expectText?: string[]): Promise<PerspectiveResult> {
    const result: PerspectiveResult = {
        name: "ui_verify",
        score: 100,
        weight: 0.2,
        issues: [],
        suggestions: [],
        ran: true,
        tool: "browser_verify",
    };

    try {
        const { browserVerify } = await import("../tools/coding/browser-verify.js");
        const raw = await browserVerify.handler({
            url,
            expect_selectors: expectSelectors,
            expect_text: expectText,
            expect_no_console_errors: true,
            expect_no_failed_requests: true,
        });
        const parsed = JSON.parse(String(raw)) as {
            success?: boolean;
            navigation_error?: string;
            console_errors?: string[];
            page_errors?: string[];
            failed_requests?: string[];
            missing_selectors?: string[];
            missing_text?: string[];
            hint?: string;
        };

        if (parsed.success) return result;

        const ce = parsed.console_errors?.length ?? 0;
        const pe = parsed.page_errors?.length ?? 0;
        const fr = parsed.failed_requests?.length ?? 0;
        const ms = parsed.missing_selectors?.length ?? 0;
        const mt = parsed.missing_text?.length ?? 0;

        if (parsed.navigation_error) {
            result.score = 0;
            result.issues.push(`Navigation failed: ${parsed.navigation_error}`);
            result.suggestions.push("Start or restart the dev server, confirm the URL, then re-run browser_verify.");
            return result;
        }

        result.score = Math.max(0, 100 - ce * 15 - pe * 20 - fr * 10 - ms * 12 - mt * 8);
        for (const e of (parsed.console_errors || []).slice(0, 3)) result.issues.push(`console.error: ${e}`);
        for (const e of (parsed.page_errors || []).slice(0, 2)) result.issues.push(`uncaught: ${e}`);
        for (const r of (parsed.failed_requests || []).slice(0, 2)) result.issues.push(`request: ${r}`);
        for (const s of (parsed.missing_selectors || []).slice(0, 3)) result.issues.push(`missing selector: ${s}`);
        for (const t of (parsed.missing_text || []).slice(0, 3)) result.issues.push(`missing text: "${t}"`);

        if (parsed.hint) result.suggestions.push(parsed.hint);
    } catch (err) {
        result.ran = false;
        result.issues.push(`browser_verify unavailable: ${(err as Error).message}`);
    }
    return result;
}

// ── Convenience: expose to swarm alongside multi-critic ───

export async function runCodeCriticIfCoder(
    roles: string[],
    taskDescription?: string,
    cwd?: string,
): Promise<ConsensusReflection | null> {
    if (!roles.includes("coder") || process.env.BHAI_NO_CODE_CRITIC === "true") return null;
    // Phase 4J: when BHAI_VERIFY_URL is set, also run the browser-verify
    // perspective. Designed for dev workflows where the user starts the
    // dev server once and wants every coder step auto-verified in-browser.
    const verifyUrl = process.env.BHAI_VERIFY_URL?.trim() || undefined;
    return runCodeMultiCritic({ cwd, taskDescription, verifyUrl });
}
