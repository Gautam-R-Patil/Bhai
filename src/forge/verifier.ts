// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CriticFinding, runCompileCheck, runSastCritic } from "./critics.js";
import { buildDiagnosePrompt } from "./prompt-builder.js";
import { runTestInSandbox, scoreResult, type TestScore } from "./sandbox-runner.js";
import { parseEnvelope, type SynthesisEnvelope } from "./synthesis.js";

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
    const fileName = `${ts}_${opts.slug}.json`;
    const fullPath = join(opts.failedReportDir, fileName);
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
    const raw = process.env.ATLAS_POST_SYNTHESIS_BUDGET_MS;
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
