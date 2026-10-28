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
// Sandbox code never runs on a host stack without vm's timeout: the context
// has its own microtask queue (drained, under the timeout, at the end of each
// runInContext), and every host→sandbox entry goes through `enter`. The host
// also never reads a property of a sandbox value outside that timeout (a
// getter or Proxy trap would run unbounded; vm's displayErrors decoration is
// off for the same reason). Persisted tools run under the
// kernel sandbox; vm is the in-process layer.

import * as vm from "node:vm";
import { types } from "node:util";

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
(function (rawLog, rawCall, rawTimer, rawClear, rawDone, inputJson, userFn, makeApi) {
    const S = String, stringify = JSON.stringify, parse = JSON.parse, P = Promise, E = Error;
    // A host fn can still throw from the host realm (a stack overflow at the
    // call itself): swap anything thrown for a sandbox Error.
    const safe = (f) => (...a) => { try { return f(...a); } catch { throw new E("host call failed"); } };
    const hostLog = safe(rawLog), hostCall = safe(rawCall), hostTimer = safe(rawTimer), hostClear = safe(rawClear), hostDone = safe(rawDone);
    const say = (level) => (...a) => { hostLog(level, a.map((x) => S(x)).join(" ")); };
    const console = Object.freeze({ log: say("log"), info: say("log"), debug: say("log"), warn: say("warn"), error: say("error") });
    // The host call runs before the promise exists, so a failed call (a stack
    // overflow at the bridge) throws synchronously instead of leaving a
    // rejected, still-unhandled promise at the stack limit, where Node's own
    // rejection tracking overflows and later reports it as unhandled.
    const call = (name, args) => {
        let res, rej;
        hostCall(S(name), stringify(args === undefined ? null : args),
            (j) => res(j === undefined ? undefined : parse(j)), (m) => rej(new E(m)));
        return new P((a, b) => { res = a; rej = b; });
    };
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

// Made before any user code runs. `arm` parks a call that `enter` then starts
// under the timeout through `__bhaiRun`, a non-configurable global user code
// can neither replace, shadow nor hook with a setter; `describe` turns a
// thrown sandbox value into a string inside the sandbox.
const KIT = `"use strict"; (() => {
    const S = String;
    let nf, na;
    Object.defineProperty(globalThis, "__bhaiRun", {
        value: () => { const f = nf, a = na; nf = na = undefined; return f(...a); },
    });
    return [
        (f, a) => { nf = f; na = a; },
        (e) => { try { return S(e && e.message !== undefined ? e.message : e) || "error"; } catch { return "error"; } },
    ];
})()`;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * vm's timeout error (made in the context's realm, so a forgery reads as a
 * timeout too, which is harmless). Checked without running a getter or trap:
 * isNativeError is false for a Proxy, and an own-descriptor read calls nothing.
 */
const isTimeout = (e: unknown): boolean =>
    types.isNativeError(e) && Object.getOwnPropertyDescriptor(e, "code")?.value === "ERR_SCRIPT_EXECUTION_TIMEOUT";

export function runIsolated(opts: IsolatedRunOpts): Promise<IsolatedResult> {
    const ctx = vm.createContext(Object.create(null), {
        name: opts.filename,
        codeGeneration: { strings: false, wasm: false },
        microtaskMode: "afterEvaluate",
    });
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    let nextTimer = 1;
    let settled = false;
    const startedAt = Date.now();
    const timedOut: IsolatedResult = { ok: false, error: `timeout after ${opts.timeoutMs}ms` };

    return new Promise((resolve) => {
        const finish = (r: IsolatedResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            for (const t of timers.values()) clearTimeout(t);
            timers.clear();
            resolve(r);
        };
        const deadline = setTimeout(() => finish(timedOut), opts.timeoutMs);

        const [arm, describe] = vm.runInContext(KIT, ctx) as [(f: unknown, a: unknown[]) => void, unknown];
        /** Run sandbox fn `f(...args)` (and the microtasks it queues) under the remaining time. */
        const enter = (f: unknown, args: unknown[]): unknown => {
            arm(f, args);
            return vm.runInContext("globalThis.__bhaiRun()", ctx, {
                displayErrors: false, // decorating a thrown value reads its `stack`: a getter/trap, unbounded
                timeout: Math.max(1, opts.timeoutMs - (Date.now() - startedAt)),
            });
        };
        /** Enter from a host callback: a timeout ends the run, sandbox throws stay inside. */
        const enterQuietly = (f: unknown, args: unknown[]) => {
            if (settled) return;
            try {
                enter(f, args);
            } catch (e) {
                if (isTimeout(e)) finish(timedOut);
            }
        };

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
            // The tool runs on a fresh stack; this async fn never rejects.
            void (async () => {
                try {
                    await null;
                    let reply: [unknown, string | undefined];
                    try {
                        if (!opts.onCall) throw new Error("no host calls available");
                        const r = await opts.onCall(str(name), JSON.parse(str(argsJson) || "null"));
                        reply = [ok, r === undefined ? undefined : JSON.stringify(r)];
                    } catch (e) {
                        reply = [err, String((e as Error)?.message ?? e)];
                    }
                    enterQuietly(reply[0], [reply[1]]);
                } catch {
                    /* host-side failure; the sandbox call stays pending until the deadline */
                }
            })();
        };
        const hostTimer = (ms: unknown, cb: unknown) => {
            if (typeof cb !== "function") return 0;
            const id = nextTimer++;
            const t = setTimeout(
                () => {
                    timers.delete(id);
                    enterQuietly(cb, []);
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
            const boot = vm.runInContext(BOOT, ctx, { filename: opts.filename });
            const makeApi = vm.runInContext(`"use strict"; (call) => (${opts.api ?? "undefined"})`, ctx, {
                filename: opts.filename,
            });
            // Injected source can run code (and throw anything) right here.
            const userFn = vm.runInContext(`(${opts.fn})`, ctx, {
                filename: opts.filename,
                displayErrors: false,
                timeout: opts.timeoutMs,
            });
            enter(boot, [hostLog, hostCall, hostTimer, hostClear, hostDone, JSON.stringify(opts.input ?? null), userFn, makeApi]);
        } catch (e) {
            if (isTimeout(e)) return finish(timedOut);
            let error = "sandbox setup failed";
            try {
                error = str(enter(describe, [e])) || error;
            } catch (e2) {
                if (isTimeout(e2)) return finish(timedOut);
            }
            finish({ ok: false, error });
        }
    });
}

/**
 * Something loggable for a value that may come from a sandbox: an unhandled
 * rejection inside one still reaches the host's `unhandledRejection` handler,
 * where `instanceof` or a property read would run a Proxy trap or getter
 * unbounded. Host values (a proxy-free chain to the host Object.prototype)
 * come back as-is, or as the stack for an Error.
 */
export function loggableRejection(reason: unknown): unknown {
    if (reason === null || (typeof reason !== "object" && typeof reason !== "function")) return reason;
    let p: unknown = reason;
    while (p !== null && p !== Object.prototype && !types.isProxy(p)) p = Object.getPrototypeOf(p);
    if (p !== Object.prototype) return `[${typeof reason} from another realm]`;
    return reason instanceof Error ? reason.stack : reason;
}
