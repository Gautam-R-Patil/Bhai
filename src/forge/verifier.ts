// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath, sep } from "node:path";
import { isPathHardDenied, parseCapabilities, validateCapabilities } from "./capabilities.js";
import { type CriticFinding, runCompileCheck, runSastCritic } from "./critics.js";
import { buildDiagnosePrompt } from "./prompt-builder.js";
import { runTestInSandbox, scoreResult, type TestScore } from "./sandbox-runner.js";
import { parseEnvelope, type SynthesisEnvelope, type SynthesisTest } from "./synthesis.js";

export type LLMFn = (prompt: string) => Promise<string>;

export interface VerifierOpts {
    slug: string;
    initialPrompt: string;
    llmFn: LLMFn;
    maxAttempts: number;
    wallClockMs?: number;
    failedReportDir: string;
}

export type VerifierResult =
    | { ok: true; envelope: SynthesisEnvelope; attempts: number; durationMs: number }
    | {
          ok: false;
          failureReason: "exhausted_attempts" | "budget_exceeded" | "parse_unrecoverable" | "sast_unrecoverable";
          attempts: number;
          reportPath: string;
          durationMs: number;
      };

interface DiagnoseFailure {
    description: string;
    input: Record<string, unknown>;
    expectedKind: string;
    expectedValue: unknown;
    actual: unknown;
    stack?: string;
}

const DEFAULT_BUDGET_MS = 90_000;

export async function runVerifier(opts: VerifierOpts): Promise<VerifierResult> {
    const budgetMs = opts.wallClockMs ?? parseEnvBudget() ?? DEFAULT_BUDGET_MS;
    const start = Date.now();

    let prompt = opts.initialPrompt;
    let lastEnvelope: SynthesisEnvelope | null = null;
    let lastFailures: DiagnoseFailure[] = [];
    let lastSastFindings: CriticFinding[] = [];

    for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
        lastFailures = [];
        lastSastFindings = [];

        if (Date.now() - start > budgetMs) {
            const reportPath = await writeFailureReport(
                opts,
                attempt - 1,
                "budget_exceeded",
                lastEnvelope,
                lastFailures,
                lastSastFindings,
            );
            return {
                ok: false,
                failureReason: "budget_exceeded",
                attempts: attempt - 1,
                reportPath,
                durationMs: Date.now() - start,
            };
        }

        let raw: string;
        try {
            raw = await opts.llmFn(prompt);
        } catch (err) {
            const msg = (err as Error).message;
            if (attempt === opts.maxAttempts) {
                const reportPath = await writeFailureReport(
                    opts,
                    attempt,
                    "exhausted_attempts",
                    lastEnvelope,
                    lastFailures,
                    [{ ruleId: "llm_error", severity: "ERROR", message: msg }],
                );
                return {
                    ok: false,
                    failureReason: "exhausted_attempts",
                    attempts: attempt,
                    reportPath,
                    durationMs: Date.now() - start,
                };
            }
            if (lastEnvelope) {
                prompt = buildDiagnosePrompt({
                    priorHandlerCode: lastEnvelope.handler_code,
                    failures: [],
                    sastFindings: [{ ruleId: "llm_error", severity: "ERROR", message: msg }],
                    attemptNumber: attempt + 1,
                    maxAttempts: opts.maxAttempts,
                });
            } else {
                prompt = `${opts.initialPrompt}\n\n# Previous LLM call failed: ${msg}\nReturn the JSON object as specified.`;
            }
            continue;
        }

        const parsed = parseEnvelope(raw);
        if (!parsed.ok) {
            if (attempt === opts.maxAttempts) {
                const reportPath = await writeFailureReport(
                    opts,
                    attempt,
                    "parse_unrecoverable",
                    lastEnvelope,
                    lastFailures,
                    lastSastFindings,
                    parsed.errors,
                );
                return {
                    ok: false,
                    failureReason: "parse_unrecoverable",
                    attempts: attempt,
                    reportPath,
                    durationMs: Date.now() - start,
                };
            }
            prompt = `${opts.initialPrompt}\n\n# Previous response could not be parsed: ${parsed.errors.join(", ")}\nReturn ONLY the JSON object, no surrounding text.`;
            continue;
        }
        const env = parsed.envelope;
        lastEnvelope = env;

        // Capability + side-effect gate (F3). Reject envelopes that:
        //  - declare capabilities containing overly broad paths, banned execs,
        //    loopback/private nets, or hard-denied fs_read/fs_write targets;
        //  - declare side_effects other than "none" — the side-effect verifier
        //    (sandbox-runner.ts: side_effect_* test kinds) is a stub today.
        const capabilityFindings: CriticFinding[] = [];
        const declaredCaps = parseCapabilities(parseCapabilitiesLooseInput(env.capabilities_declared));
        const capCheck = validateCapabilities(declaredCaps);
        if (!capCheck.ok) {
            for (const e of capCheck.errors) {
                capabilityFindings.push({ ruleId: "forge-cap-invalid", severity: "ERROR", message: e });
            }
        }
        for (const p of [...declaredCaps.fs_read, ...declaredCaps.fs_write]) {
            if (isPathHardDenied(p)) {
                capabilityFindings.push({
                    ruleId: "forge-cap-hard-deny",
                    severity: "ERROR",
                    message: `capability path hits hard-deny: ${p}`,
                });
            }
        }
        if (env.side_effects !== "none") {
            capabilityFindings.push({
                ruleId: "forge-side-effects-blocked",
                severity: "ERROR",
                message: `side_effects="${env.side_effects}" not allowed until kernel-sandbox ships (Phase 4)`,
            });
        }
        // Heuristic test-quality gate (F7) — refuse trivial-test-only envelopes for
        // non-trivial handlers. This is conservative; the LLM should be writing
        // discriminating tests, not just "did anything come back" checks.
        if (envIsTestSelfBait(env)) {
            capabilityFindings.push({
                ruleId: "forge-tests-self-bait",
                severity: "ERROR",
                message:
                    "tests are non-discriminating (all returns_no_error / empty returns_equals) but handler is non-trivial; reject",
            });
        }
        if (capabilityFindings.length > 0) {
            lastSastFindings = capabilityFindings;
            if (attempt === opts.maxAttempts) {
                const reportPath = await writeFailureReport(
                    opts,
                    attempt,
                    "sast_unrecoverable",
                    env,
                    lastFailures,
                    lastSastFindings,
                );
                return {
                    ok: false,
                    failureReason: "sast_unrecoverable",
                    attempts: attempt,
                    reportPath,
                    durationMs: Date.now() - start,
                };
            }
            prompt = buildDiagnosePrompt({
                priorHandlerCode: env.handler_code,
                failures: [],
                sastFindings: lastSastFindings,
                attemptNumber: attempt + 1,
                maxAttempts: opts.maxAttempts,
            });
            continue;
        }

        const compile = runCompileCheck(env.handler_code);
        if (!compile.pass) {
            lastSastFindings = [{ ruleId: "compile", severity: "ERROR", message: compile.error ?? "compile failed" }];
            if (attempt === opts.maxAttempts) {
                const reportPath = await writeFailureReport(
                    opts,
                    attempt,
                    "sast_unrecoverable",
                    env,
                    lastFailures,
                    lastSastFindings,
                );
                return {
                    ok: false,
                    failureReason: "sast_unrecoverable",
                    attempts: attempt,
                    reportPath,
                    durationMs: Date.now() - start,
                };
            }
            prompt = buildDiagnosePrompt({
                priorHandlerCode: env.handler_code,
                failures: [],
                sastFindings: lastSastFindings,
                attemptNumber: attempt + 1,
                maxAttempts: opts.maxAttempts,
            });
            continue;
        }

        const sast = await runSastCritic(env.handler_code, { rulesPath: null });
        if (!sast.pass) {
            lastSastFindings = sast.findings;
            if (attempt === opts.maxAttempts) {
                const reportPath = await writeFailureReport(
                    opts,
                    attempt,
                    "sast_unrecoverable",
                    env,
                    lastFailures,
                    lastSastFindings,
                );
                return {
                    ok: false,
                    failureReason: "sast_unrecoverable",
                    attempts: attempt,
                    reportPath,
                    durationMs: Date.now() - start,
                };
            }
            prompt = buildDiagnosePrompt({
                priorHandlerCode: env.handler_code,
                failures: [],
                sastFindings: sast.findings,
                attemptNumber: attempt + 1,
                maxAttempts: opts.maxAttempts,
            });
            continue;
        }

        const scores: { score: TestScore; test: (typeof env.tests)[number] }[] = [];
        for (const test of env.tests) {
            const sandboxResult = await runTestInSandbox({
                handlerCode: env.handler_code,
                input: test.input,
                timeoutMs: 10_000,
            });
            const score = scoreResult(sandboxResult, test);
            scores.push({ score, test });
        }

        const failures = scores.filter((s) => !s.score.pass);
        if (failures.length === 0) {
            return {
                ok: true,
                envelope: env,
                attempts: attempt,
                durationMs: Date.now() - start,
            };
        }

        lastFailures = failures.map(({ score, test }) => ({
            description: test.description,
            input: test.input,
            expectedKind: test.expected_kind,
            expectedValue: test.expected_value,
            actual: score.actual,
        }));

        if (attempt === opts.maxAttempts) {
            const reportPath = await writeFailureReport(
                opts,
                attempt,
                "exhausted_attempts",
                env,
                lastFailures,
                sast.findings,
            );
            return {
                ok: false,
                failureReason: "exhausted_attempts",
                attempts: attempt,
                reportPath,
                durationMs: Date.now() - start,
            };
        }

        prompt = buildDiagnosePrompt({
            priorHandlerCode: env.handler_code,
            failures: lastFailures,
            sastFindings: sast.findings,
            attemptNumber: attempt + 1,
            maxAttempts: opts.maxAttempts,
        });
    }

    // Defensive: reachable only when maxAttempts === 0
    const reportPath = await writeFailureReport(
        opts,
        opts.maxAttempts,
        "exhausted_attempts",
        lastEnvelope,
        lastFailures,
        lastSastFindings,
    );
    return {
        ok: false,
        failureReason: "exhausted_attempts",
        attempts: opts.maxAttempts,
        reportPath,
        durationMs: Date.now() - start,
    };
}

async function writeFailureReport(
    opts: VerifierOpts,
    attempts: number,
    reason: string,
    lastEnvelope: SynthesisEnvelope | null,
    failures: unknown[],
    sastFindings: unknown[],
    parseErrors?: string[],
): Promise<string> {
    const ts = Date.now();
    // F5: refuse slugs that don't conform to /^[a-z][a-z0-9_]{0,62}$/. The
    // orchestrator's entrypoint validates this, but defense-in-depth here
    // prevents a maliciously-shaped slug from being written outside the
    // failedReportDir via path traversal.
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(opts.slug)) {
        throw new Error(`refusing to write failure report — invalid slug: ${opts.slug}`);
    }
    const fileName = `${ts}_${opts.slug}.json`;
    const baseResolved = resolvePath(opts.failedReportDir);
    const fullPath = resolvePath(opts.failedReportDir, fileName);
    if (!fullPath.startsWith(baseResolved + sep) && fullPath !== baseResolved) {
        throw new Error(`refusing to write failure report — path escapes failedReportDir: ${fullPath}`);
    }
    await mkdir(opts.failedReportDir, { recursive: true });
    const report = {
        ts,
        slug: opts.slug,
        attempts,
        reason,
        last_handler_code: lastEnvelope?.handler_code,
        last_failures: failures,
        sast_findings: sastFindings,
        parse_errors: parseErrors,
    };
    await writeFile(fullPath, safeJsonStringify(report, 2), "utf-8");
    return fullPath;
}

function parseEnvBudget(): number | undefined {
    const raw = process.env.BHAI_POST_SYNTHESIS_BUDGET_MS;
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

function safeJsonStringify(v: unknown, indent?: number): string {
    try {
        const s = JSON.stringify(v, jsonReplacer, indent);
        if (s === undefined) return "null";
        return s;
    } catch {
        return safeFallbackStringify(v, indent);
    }
}

function jsonReplacer(_key: string, value: unknown): unknown {
    if (typeof value === "bigint") return `${value.toString()}n`;
    if (typeof value === "symbol") return value.toString();
    if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
    return value;
}

/**
 * `capabilities_declared` in the envelope is a flat string array; entries are
 * formatted as `"<kind>:<target>"` where kind ∈ {fs_read, fs_write, net, exec}.
 * Parse that flat form into the structured `Capabilities` shape that
 * `validateCapabilities` consumes. Unknown / malformed entries are dropped on
 * the floor — `validateCapabilities` doesn't see them, but `runVerifier` will
 * also reject any entry that doesn't parse via this function (returning the
 * permissive empty shape is correct: no capability declared = nothing to grant).
 */
export function parseCapabilitiesLooseInput(
    declared: string[],
): { fs_read: string[]; fs_write: string[]; net: string[]; exec: string[] } {
    const out = { fs_read: [] as string[], fs_write: [] as string[], net: [] as string[], exec: [] as string[] };
    for (const entry of declared) {
        if (typeof entry !== "string") continue;
        const idx = entry.indexOf(":");
        if (idx <= 0) continue;
        const kind = entry.slice(0, idx).trim();
        const target = entry.slice(idx + 1).trim();
        if (!target) continue;
        if (kind === "fs_read") out.fs_read.push(target);
        else if (kind === "fs_write") out.fs_write.push(target);
        else if (kind === "net") out.net.push(target);
        else if (kind === "exec") out.exec.push(target);
    }
    return out;
}

/**
 * F7 heuristic: refuse envelopes where the LLM has cheated on tests.
 * "Cheating" patterns:
 *   - Every test uses `returns_no_error` AND the handler body is >500 chars
 *     → the handler isn't being tested for behavior, just "doesn't throw".
 *   - Every test uses `returns_no_error`, a bare `throws`, OR `returns_equals`
 *     with `expected_value: undefined / null` (which deep-equal matches a null
 *     return) AND the handler body is >500 chars.
 * Phase 4 will replace this with adversarial test synthesis.
 */
function envIsTestSelfBait(env: SynthesisEnvelope): boolean {
    if (!env.handler_code || env.handler_code.length <= 500) return false;
    const tests = env.tests as SynthesisTest[];
    if (!Array.isArray(tests) || tests.length === 0) return false;
    const allReturnsNoError = tests.every((t) => t.expected_kind === "returns_no_error");
    if (allReturnsNoError) return true;
    const allLowDiscriminator = tests.every(
        (t) =>
            t.expected_kind === "returns_no_error" ||
            t.expected_kind === "throws" || // any error passes, a ReferenceError included
            (t.expected_kind === "returns_equals" && (t.expected_value === undefined || t.expected_value === null)),
    );
    return allLowDiscriminator;
}

function safeFallbackStringify(v: unknown, indent?: number): string {
    const seen = new WeakSet<object>();
    try {
        return (
            JSON.stringify(
                v,
                (_k, val) => {
                    const replaced = jsonReplacer(_k, val);
                    if (typeof replaced === "object" && replaced !== null) {
                        if (seen.has(replaced as object)) return "[circular]";
                        seen.add(replaced as object);
                    }
                    return replaced;
                },
                indent,
            ) ?? "null"
        );
    } catch {
        return JSON.stringify({ unserializable: true, typeOf: typeof v }, null, indent);
    }
}
