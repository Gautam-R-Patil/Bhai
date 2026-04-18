// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Typed Error Classification ───────────────
// Categorizes errors so recovery strategies can be applied appropriately.
// Transient errors → retry. Permanent errors → skip. Timeout → extend + retry.

// ── Error Categories ─────────────────────────

export enum ErrorCategory {
    /** Transient network/API failures — retry likely to help */
    Transient = "transient",
    /** Permanent logical errors — retry will fail again */
    Permanent = "permanent",
    /** Rate limits, quota exceeded — backoff + retry */
    ResourceLimit = "resource_limit",
    /** Tool not found or not available — reroute to different role */
    ToolMissing = "tool_missing",
    /** JSON/response parsing failures — rephrase + retry */
    ParseError = "parse_error",
    /** Operation exceeded time limit — extend timeout + retry */
    Timeout = "timeout",
    /** User-caused: invalid input, bad URL, etc. — skip */
    UserCaused = "user_caused",
    /** Missing system dependency (e.g. sox, ffmpeg, brew) — auto-install + retry */
    DependencyMissing = "dependency_missing",
    /** Source file has a syntax error the compiler/parser rejected */
    SyntaxError = "syntax_error",
    /** Type checker reported a mismatch (tsc, mypy, etc.) */
    TypeError = "type_error",
    /** Test runner (jest/vitest/pytest/cargo test) reported a failing test */
    TestFailure = "test_failure",
    /** Linter (eslint/biome/clippy) flagged a violation */
    LintError = "lint_error",
    /** Build system failure (webpack/rollup/cargo build/make) */
    BuildError = "build_error",
    /** Module/package import resolution failure */
    ImportError = "import_error",
    /** Runtime exception thrown while executing user code */
    RuntimeError = "runtime_error",
    /** Unknown error category */
    Unknown = "unknown",
}

/** Structured location info extracted from a coding error. */
export interface CodeErrorLocation {
    file?: string;
    line?: number;
    column?: number;
    snippet?: string;
    suggestion?: string;
}

// ── Classified Error ─────────────────────────

export interface ClassifiedError {
    /** The error category determining recovery strategy */
    category: ErrorCategory;
    /** Human-readable error message */
    message: string;
    /** Which tool caused the error, if applicable */
    tool?: string;
    /** Whether this error is worth retrying */
    retryable: boolean;
    /** Additional context metadata */
    context: Record<string, string>;
    /** For coding errors: extracted file/line/column/snippet, when available */
    codeLocation?: CodeErrorLocation;
}

// ── Classification Patterns ──────────────────

const TRANSIENT_PATTERNS = [
    /ECONNRESET/i,
    /ECONNREFUSED/i,
    /ETIMEDOUT/i,
    /ENOTFOUND/i,
    /socket hang up/i,
    /network error/i,
    /fetch failed/i,
    /503 Service Unavailable/i,
    /502 Bad Gateway/i,
    /500 Internal Server Error/i,
    /EPIPE/i,
    /connection reset/i,
    /request failed/i,
];

const RATE_LIMIT_PATTERNS = [
    /429/,
    /rate.?limit/i,
    /too many requests/i,
    /quota exceeded/i,
    /throttl/i,
    /capacity/i,
    /overloaded/i,
];

const TIMEOUT_PATTERNS = [
    /timed? ?out/i,
    /timeout/i,
    /exceeded.*time/i,
    /deadline/i,
    /ESOCKETTIMEDOUT/i,
];

const PARSE_PATTERNS = [
    /JSON\.parse/i,
    /unexpected end of json/i,
    /invalid json/i,
    /not valid JSON/i,
];

const TOOL_MISSING_PATTERNS = [
    /tool.*not found/i,
    /unknown tool/i,
    /no tool named/i,
    /function.*not found/i,
    /not available/i,
];

const DEPENDENCY_MISSING_PATTERNS = [
    /command not found/i,
    /not recognized as.*command/i,  // Windows
    /ENOENT.*spawn/i,
    /spawn.*ENOENT/i,
    /brew install/i,
    /apt.install/i,
    /choco install/i,
    /npm install/i,
    /is not installed/i,
    /not found.*install/i,
    /Install.*sox/i,
    /Install.*ffmpeg/i,
    /Install.*ffprobe/i,
    /Install.*brightness/i,
    /Install.*blueutil/i,
    /module.*not found/i,
    /Cannot find module/i,
    /MODULE_NOT_FOUND/i,
];

// ── Coding-specific patterns ────────────────
// Each of these pattern sets is tried in a specific order below; extractors
// pull `{file, line, column}` out of the message when the pattern matches.

const TYPE_ERROR_PATTERNS = [
    /error TS\d+:/,                         // TypeScript: error TS2345: ...
    /\bType '[^']*' is not assignable to/,  // TS type mismatch phrasing
    /\bmypy\b.*error:/,                     // Python mypy
    /\bpyright\b.*error:/,                  // Pyright
    /error\[E\d+\]: mismatched types/,      // Rust rustc
];

const SYNTAX_ERROR_PATTERNS = [
    /SyntaxError:/,                         // JS / Python
    /Parse error:/i,
    /expected.*got/i,
    /unterminated string literal/i,
    /unexpected indent/,                    // Python
];

const TEST_FAILURE_PATTERNS = [
    /\d+ failing/i,                         // mocha
    /Tests:\s+\d+ failed/i,                 // jest
    /FAIL\s+.*\.test\.[a-z]+/,              // jest/vitest file header
    /✗|×|❌/,                                // bullet-style failure (narrow fallback)
    /\bAssertionError\b/,                   // python unittest / pytest
    /expected.*to (?:equal|be|contain)/i,   // chai/jest-style
    /test result: FAILED/,                  // cargo test
];

const LINT_ERROR_PATTERNS = [
    /eslint.*error/i,
    /\berror\s+.*\s+no-unused-vars/i,
    /biome.*(?:error|lint)/i,
    /clippy::.*\s+error/i,                  // rust clippy
    /ruff.*:\s*[EW]\d+/,                    // python ruff
];

const BUILD_ERROR_PATTERNS = [
    /\berror.*(?:compiler|compilation)/i,
    /webpack.*errors?/i,
    /webpack compiled with/i,
    /rollup.*errors?/i,
    /cargo.*could not compile/i,
    /make.*\*\*\*\s+Error/i,
    /npm ERR!/,
    /Build failed/i,
    /Compilation failed/i,
];

const IMPORT_ERROR_PATTERNS = [
    /Cannot find module/,
    /Module not found/,
    /ImportError:/,                         // Python
    /unresolved import/i,                   // Rust
    /cannot find name/i,                    // TS
];

const RUNTIME_ERROR_PATTERNS = [
    /ReferenceError:/,
    /TypeError:.*is not a function/,
    /RangeError:/,
    /NullPointerException/,
    /Traceback \(most recent call last\)/,  // Python
    /thread '.*' panicked at/,              // Rust panic
    /\bPanic: /,
    /Uncaught Exception:/i,
];

// ── Coding error location extractors ────────
// Parse a common `path/to/file:line:col` shape out of the error message.

const LOCATION_PATTERNS: RegExp[] = [
    // tsc: path(line,col): error ...
    /([\w./\-]+)\((\d+),(\d+)\):/,
    // eslint / rust / python: path:line:col
    /([\w./\-]+):(\d+):(\d+)/,
    // jest/vitest: at path:line:col
    /at\s+[^\s]*\s+\(([\w./\-]+):(\d+):(\d+)\)/,
    // just path:line (no column)
    /([\w./\-]+):(\d+)\b/,
];

function extractCodeLocation(message: string): CodeErrorLocation | undefined {
    for (const p of LOCATION_PATTERNS) {
        const m = message.match(p);
        if (m) {
            const line = m[2] ? parseInt(m[2], 10) : undefined;
            const column = m[3] ? parseInt(m[3], 10) : undefined;
            return {
                file: m[1],
                line: Number.isFinite(line) ? line : undefined,
                column: Number.isFinite(column) ? column : undefined,
            };
        }
    }
    return undefined;
}

const USER_CAUSED_PATTERNS = [
    /404 Not Found/i,
    /403 Forbidden/i,
    /401 Unauthorized/i,
    /invalid url/i,
    /permission denied/i,
    /access denied/i,
    /no such file/i,
    /ENOENT/i,
    /EACCES/i,
];

// ── Classifier ───────────────────────────────

/**
 * Classify an error message into a typed error with recovery metadata.
 */
export function classifyError(
    message: string,
    tool?: string,
    durationMs?: number,
): ClassifiedError {
    const context: Record<string, string> = {};
    if (tool) context.tool = tool;
    if (durationMs !== undefined) context.durationMs = String(durationMs);

    // Check patterns in priority order (most specific first)
    for (const pattern of TIMEOUT_PATTERNS) {
        if (pattern.test(message)) {
            return { category: ErrorCategory.Timeout, message, tool, retryable: true, context };
        }
    }

    for (const pattern of RATE_LIMIT_PATTERNS) {
        if (pattern.test(message)) {
            return { category: ErrorCategory.ResourceLimit, message, tool, retryable: true, context };
        }
    }

    for (const pattern of TOOL_MISSING_PATTERNS) {
        if (pattern.test(message)) {
            return { category: ErrorCategory.ToolMissing, message, tool, retryable: false, context };
        }
    }

    for (const pattern of PARSE_PATTERNS) {
        if (pattern.test(message)) {
            return { category: ErrorCategory.ParseError, message, tool, retryable: true, context };
        }
    }

    // Dependency missing — check before user_caused since ENOENT+spawn overlaps
    for (const pattern of DEPENDENCY_MISSING_PATTERNS) {
        if (pattern.test(message)) {
            return { category: ErrorCategory.DependencyMissing, message, tool, retryable: true, context };
        }
    }

    // ── Coding-specific categories ────────────
    // Order matters: more specific shapes first (type errors can include
    // the word "error" so they overlap with build errors).
    const codeLocation = extractCodeLocation(message);

    for (const p of TYPE_ERROR_PATTERNS) {
        if (p.test(message)) {
            return { category: ErrorCategory.TypeError, message, tool, retryable: false, context, codeLocation };
        }
    }
    for (const p of SYNTAX_ERROR_PATTERNS) {
        if (p.test(message)) {
            return { category: ErrorCategory.SyntaxError, message, tool, retryable: false, context, codeLocation };
        }
    }
    for (const p of IMPORT_ERROR_PATTERNS) {
        if (p.test(message)) {
            return { category: ErrorCategory.ImportError, message, tool, retryable: true, context, codeLocation };
        }
    }
    for (const p of TEST_FAILURE_PATTERNS) {
        if (p.test(message)) {
            return { category: ErrorCategory.TestFailure, message, tool, retryable: true, context, codeLocation };
        }
    }
    for (const p of LINT_ERROR_PATTERNS) {
        if (p.test(message)) {
            return { category: ErrorCategory.LintError, message, tool, retryable: true, context, codeLocation };
        }
    }
    for (const p of BUILD_ERROR_PATTERNS) {
        if (p.test(message)) {
            return { category: ErrorCategory.BuildError, message, tool, retryable: true, context, codeLocation };
        }
    }
    for (const p of RUNTIME_ERROR_PATTERNS) {
        if (p.test(message)) {
            return { category: ErrorCategory.RuntimeError, message, tool, retryable: true, context, codeLocation };
        }
    }

    for (const pattern of USER_CAUSED_PATTERNS) {
        if (pattern.test(message)) {
            return { category: ErrorCategory.UserCaused, message, tool, retryable: false, context };
        }
    }

    for (const pattern of TRANSIENT_PATTERNS) {
        if (pattern.test(message)) {
            return { category: ErrorCategory.Transient, message, tool, retryable: true, context };
        }
    }

    // Default: permanent (unknown errors shouldn't be blindly retried)
    return { category: ErrorCategory.Unknown, message, tool, retryable: false, context };
}

/**
 * Quick check: is this error message from a tool result indicating failure?
 */
export function isToolError(result: string): boolean {
    if (result.startsWith('{"error":') || result.startsWith('{"error"')) return true;
    if (result.startsWith("Error:") || result.startsWith("ERROR:")) return true;
    try {
        const parsed = JSON.parse(result);
        return "error" in parsed && typeof parsed.error === "string";
    } catch {
        return false;
    }
}
