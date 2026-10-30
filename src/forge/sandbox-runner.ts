// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import { runIsolated } from "../security/vm-isolate.js";
import { dynamicToolSandbox } from "../tools/create-tool.js";
import type { SynthesisTest } from "./synthesis.js";

export type SandboxResult =
    | { ok: true; result: unknown; stdout: string; stderr: string }
    | { ok: false; error: string; stack?: string; stdout: string; stderr: string };

export interface SandboxRunOpts {
    handlerCode: string;
    input: Record<string, unknown>;
    timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function runTestInSandbox(opts: SandboxRunOpts): Promise<SandboxResult> {
    let stdout = "";
    let stderr = "";
    // Exactly the session-tool runtime (create-tool.ts): runIsolated hands the
    // handler no host-realm object, utils.fs is read-only and path-checked, and
    // fetch/exec refuse — the kernel sandbox enforces capabilities for persisted tools.
    const r = await runIsolated({
        ...dynamicToolSandbox(opts.handlerCode),
        input: opts.input,
        onLog: (level, line) => {
            if (level === "log") stdout += `${line}\n`;
            else stderr += `${line}\n`;
        },
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        filename: "forge-test.vm",
    });
    return r.ok
        ? { ok: true, result: r.result, stdout, stderr }
        : { ok: false, error: r.error, stack: r.stack, stdout, stderr };
}

export interface TestScore {
    pass: boolean;
    explanation: string;
    actual: unknown;
}

export function scoreResult(result: SandboxResult, test: SynthesisTest): TestScore {
    switch (test.expected_kind) {
        case "returns_contains": {
            if (!result.ok)
                return {
                    pass: false,
                    explanation: `expected return; got error: ${result.error}`,
                    actual: result.error,
                };
            const str = typeof result.result === "string" ? result.result : JSON.stringify(result.result);
            const target = String(test.expected_value);
            return {
                pass: str.includes(target),
                explanation: str.includes(target) ? "contains target" : `does not contain "${target}"`,
                actual: str.slice(0, 200),
            };
        }
        case "returns_equals": {
            if (!result.ok)
                return {
                    pass: false,
                    explanation: `expected return; got error: ${result.error}`,
                    actual: result.error,
                };
            const equal = deepEqual(result.result, test.expected_value);
            return { pass: equal, explanation: equal ? "deep-equal" : "did not deep-equal", actual: result.result };
        }
        case "returns_matches_regex": {
            if (!result.ok) return { pass: false, explanation: `expected return; got error`, actual: result.error };
            const str = typeof result.result === "string" ? result.result : JSON.stringify(result.result);
            let re: RegExp;
            try {
                re = new RegExp(String(test.expected_value));
            } catch (e) {
                return {
                    pass: false,
                    explanation: `invalid regex: ${(e as Error).message}`,
                    actual: str.slice(0, 200),
                };
            }
            const matches = re.test(str);
            return {
                pass: matches,
                explanation: matches ? "matches regex" : `did not match /${test.expected_value}/`,
                actual: str.slice(0, 200),
            };
        }
        case "throws": {
            return {
                pass: !result.ok,
                explanation: result.ok ? "did not throw" : "threw as expected",
                actual: result.ok ? result.result : result.error,
            };
        }
        case "throws_contains": {
            if (result.ok) return { pass: false, explanation: "expected throw, did not throw", actual: result.result };
            const has = String(result.error).includes(String(test.expected_value));
            return {
                pass: has,
                explanation: has
                    ? "threw with expected text"
                    : `threw but message did not contain "${test.expected_value}"`,
                actual: result.error,
            };
        }
        case "returns_no_error": {
            return {
                pass: result.ok,
                explanation: result.ok ? "no error" : `error: ${result.error}`,
                actual: result.ok ? result.result : result.error,
            };
        }
        case "side_effect_file_exists":
        case "side_effect_url_called": {
            // Nothing checks the side effect, so this would pass on any return.
            return {
                pass: false,
                explanation: `${test.expected_kind} tests are not supported; test the return value instead`,
                actual: result.ok ? result.result : result.error,
            };
        }
    }
    return { pass: false, explanation: "unknown expected_kind", actual: null };
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (typeof a !== typeof b) return false;
    if (typeof a !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        return a.every((v, i) => deepEqual(v, b[i]));
    }
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
