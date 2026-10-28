// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Run untrusted (LLM-written) JS in a fresh vm context without handing it a
// single host-realm object. Any host function, object, Promise or Error that
// reaches the sandbox exposes `.constructor.constructor` = the host Function,
// whose code generation is on → `return process` → full escape. So:
//   - the context global has a null prototype (a plain `{}` leaks host Object
//     through `this.constructor`), and string/wasm code generation is off;
//   - the context keeps its OWN builtins (JSON, Math, Promise, parseInt, ...);
//   - every crossing carries primitives only (JSON strings). Host callbacks
//     are captured in strict in-context closures user code can't reach, and
//     host errors/results never cross as objects.
// vm is still not a hard boundary (a synchronous infinite loop after the first
// await blocks the host); persisted tools run under the kernel sandbox.

import * as vm from "node:vm";

export type IsolatedResult = { ok: true; result: unknown } | { ok: false; error: string; stack?: string };

export interface IsolatedRunOpts {
    /** Source of a function expression; called as fn(input, api, console). */
    fn: string;
    /** In-context expression for the `api` argument; may use `call(name, args)`. */
    api?: string;
    input?: unknown;
    /** Host side of `call(name, args)`; its result reaches the sandbox as JSON. */
    onCall?: (name: string, args: unknown) => unknown;
    onLog?: (level: "log" | "warn" | "error", line: string) => void;
    timeoutMs: number;
    filename: string;
}

const BOOT = `"use strict";
(function (hostLog, hostCall, hostTimer, hostClear, hostDone, inputJson, userFn, makeApi) {
    const S = String, stringify = JSON.stringify, parse = JSON.parse, P = Promise;
    const say = (level) => (...a) => { hostLog(level, a.map((x) => S(x)).join(" ")); };
    const console = Object.freeze({ log: say("log"), info: say("log"), debug: say("log"), warn: say("warn"), error: say("error") });
    const call = (name, args) => new P((resolve, reject) => {
        hostCall(S(name), stringify(args === undefined ? null : args),
            (j) => resolve(j === undefined ? undefined : parse(j)), (m) => reject(new Error(m)));
    });
    globalThis.setTimeout = (f, ms, ...a) => hostTimer(+ms || 0, () => f(...a));
    globalThis.clearTimeout = (id) => hostClear(+id);
    const text = (f) => { try { return S(f()); } catch { return ""; } };
    const fail = (e) => hostDone(text(() => e && e.message !== undefined ? e.message : e) || "error", undefined, text(() => e && e.stack));
    P.resolve().then(() => userFn(parse(inputJson), makeApi(call), console)).then((v) => {
        let j;
        try { j = stringify(v); } catch (e) { return fail(e); }
        hostDone(null, j);
    }, fail);
})`;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function runIsolated(opts: IsolatedRunOpts): Promise<IsolatedResult> {
    const ctx = vm.createContext(Object.create(null), {
        name: opts.filename,
        codeGeneration: { strings: false, wasm: false },
    });
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    let nextTimer = 1;
    let settled = false;

    return new Promise((resolve) => {
        const finish = (r: IsolatedResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            for (const t of timers.values()) clearTimeout(t);
            timers.clear();
            resolve(r);
        };
        const deadline = setTimeout(
            () => finish({ ok: false, error: `timeout after ${opts.timeoutMs}ms` }),
            opts.timeoutMs,
        );

        // Every host fn below takes only primitives, returns only primitives,
        // and never throws into the sandbox.
        const hostLog = (level: unknown, line: unknown) => {
            try {
                opts.onLog?.(level === "warn" || level === "error" ? level : "log", str(line));
            } catch {
                /* never throw a host error into the sandbox */
            }
        };
        const hostCall = (name: unknown, argsJson: unknown, ok: unknown, err: unknown) => {
            if (typeof ok !== "function" || typeof err !== "function") return;
            Promise.resolve()
                .then(() => {
                    if (!opts.onCall) throw new Error("no host calls available");
                    return opts.onCall(str(name), JSON.parse(str(argsJson) || "null"));
                })
                .then(
                    (r) => (r === undefined ? undefined : JSON.stringify(r)),
                    (e) => {
                        throw String((e as Error)?.message ?? e);
                    },
                )
                .then(
                    (j) => {
                        if (!settled) ok(j);
                    },
                    (m) => {
                        if (!settled) err(String(m));
                    },
                )
                .catch(() => {});
        };
        const hostTimer = (ms: unknown, cb: unknown) => {
            if (typeof cb !== "function") return 0;
            const id = nextTimer++;
            const t = setTimeout(
                () => {
                    timers.delete(id);
                    try {
                        cb();
                    } catch {
                        /* sandbox error in a timer callback */
                    }
                },
                typeof ms === "number" ? Math.max(0, ms) : 0,
            );
            timers.set(id, t);
            return id;
        };
        const hostClear = (id: unknown) => {
            if (typeof id !== "number") return;
            clearTimeout(timers.get(id));
            timers.delete(id);
        };
        const hostDone = (error: unknown, json: unknown, stack: unknown) => {
            if (typeof error === "string") return finish({ ok: false, error, stack: str(stack) || undefined });
            let result: unknown;
            try {
                result = typeof json === "string" ? JSON.parse(json) : undefined;
            } catch {
                result = undefined;
            }
            finish({ ok: true, result });
        };

        try {
            const boot = vm.runInContext(BOOT, ctx, { filename: opts.filename }) as (...a: unknown[]) => void;
            const makeApi = vm.runInContext(`"use strict"; (call) => (${opts.api ?? "undefined"})`, ctx, {
                filename: opts.filename,
            });
            const userFn = vm.runInContext(`(${opts.fn})`, ctx, {
                filename: opts.filename,
                timeout: opts.timeoutMs,
            });
            boot(
                hostLog,
                hostCall,
                hostTimer,
                hostClear,
                hostDone,
                JSON.stringify(opts.input ?? null),
                userFn,
                makeApi,
            );
        } catch (e) {
            let message: unknown;
            try {
                message = (e as { message?: unknown })?.message;
            } catch {
                /* sandbox getter */
            }
            finish({ ok: false, error: typeof message === "string" ? message : "sandbox setup failed" });
        }
    });
}
