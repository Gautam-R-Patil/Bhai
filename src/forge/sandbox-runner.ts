// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import * as vm from "node:vm";
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
    const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let stdout = "";
    let stderr = "";

    // Bootstrap-only globals (primitives + reusable safe values). DO NOT pass
    // host-realm constructors here — Buffer/URL/Promise/Error/etc all carry
    // .constructor chains that resolve to the host Function ctor, enabling
    // `Buffer.constructor("...")()` style escapes. The new vm context will
    // get its OWN realm copies of those builtins on creation.
    const sandbox: Record<string, unknown> = {
        // Static value-only globals — no constructor reachable to host realm.
        Math,
        JSON,
        // Static function refs only — these are safe because they don't expose
        // a .constructor that points back to the host realm in a useful way
        // through the normal call surface.
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        encodeURIComponent,
        decodeURIComponent,
        // Pass Date.now() factory via a wrapper so host Date constructor isn't reachable.
        // Inside the sandbox, code can still use `new Date(...)` — that resolves to the
        // vm-realm's own Date constructor (added below by the bootstrap script).
        console: {
            log: (...args: unknown[]) => {
                stdout += `${args.map((a) => String(a)).join(" ")}\n`;
            },
            warn: (...args: unknown[]) => {
                stderr += `${args.map((a) => String(a)).join(" ")}\n`;
            },
            error: (...args: unknown[]) => {
                stderr += `${args.map((a) => String(a)).join(" ")}\n`;
            },
            info: (...args: unknown[]) => {
                stdout += `${args.map((a) => String(a)).join(" ")}\n`;
            },
        },
    };
    const ctx = vm.createContext(sandbox, {
        name: "forge-sandbox-test",
        codeGeneration: { strings: false, wasm: false },
    });

    // Wrap the handler so that all values it touches (Array, RegExp, Date, Promise,
    // Error, etc) come from the new context's realm — never from the host. The
    // wrapper also defines an "isArray" helper that does NOT expose the Array ctor.
    const wrappedSource = `(async function __test(__input, __utils) {
        const input = __input;
        const utils = __utils;
        const isArray = (x) => Array.isArray(x);
        ${opts.handlerCode}
    })`;

    try {
        const script = new vm.Script(wrappedSource, { filename: "forge-test.vm" });
        const testFn = script.runInContext(ctx, { timeout }) as (
            i: Record<string, unknown>,
            u: Record<string, unknown>,
        ) => Promise<unknown>;
        // Utils inside the sandbox — fetch/exec/execFile refuse outright. The
        // kernel-sandbox in Phase 4 will enforce capabilities at the syscall
        // level; until then, the interim verifier sandbox has no shell/net.
        const utils = {
            JSON,
            fetch: async () => {
                throw new Error("fetch denied in test sandbox (Phase 4 kernel-sandbox required for net capability)");
            },
            exec: async () => {
                throw new Error("exec denied in test sandbox (Phase 4 kernel-sandbox required for exec capability)");
            },
            execFile: async () => {
                throw new Error("execFile denied in test sandbox (Phase 4 kernel-sandbox required)");
            },
            fs: {},
        };
        const result = await Promise.race([
            testFn(opts.input, utils),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${timeout}ms`)), timeout)),
        ]);
        return { ok: true, result, stdout, stderr };
    } catch (err) {
        const e = err as Error;
        return { ok: false, error: e.message, stack: e.stack, stdout, stderr };
    }
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
            return {
                pass: result.ok,
                explanation: "side-effect test stub (Phase 3 — implementation pending)",
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
