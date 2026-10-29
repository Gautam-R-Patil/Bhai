// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Sandbox code must never run on a host stack without vm's timeout: a loop in
// a microtask, a getter or Proxy trap on a thrown value, or a hook on the
// launcher global would otherwise freeze the whole bot.
import { describe, expect, it } from "vitest";
import { executeCodeAction } from "../agents/code-action-agent.js";
import { runTestInSandbox } from "../forge/sandbox-runner.js";
import { loggableRejection, runIsolated } from "./vm-isolate.js";

const run = (fn: string) => runIsolated({ fn, timeoutMs: 200, filename: "t.vm" });
const LOOP = "{ while (true) {} }";
const TRAP = `new Proxy({}, { get() ${LOOP}, getPrototypeOf() ${LOOP} })`;
const inject = (code: string) => `async () => 1); ${code}; (() => {}`;

describe("runIsolated never hangs the host", () => {
    for (const fn of [
        `async () => { await null; while (true) {} }`,
        `async () => { await new Promise((r) => setTimeout(r, 1)); while (true) {} }`,
        `async () => { throw ${TRAP}; }`,
        `async () => ${TRAP}`,
        `async () => { setTimeout(() => { throw ${TRAP}; }, 1); await new Promise((r) => setTimeout(r, 300)); }`,
        inject(`throw ${TRAP}`),
        inject(`throw { get stack() ${LOOP}, get message() ${LOOP} }`),
    ]) {
        it(fn.slice(0, 80), async () => {
            expect(await run(fn)).toEqual({ ok: false, error: "timeout after 200ms" });
        });
    }

    it("the launcher global cannot be hooked or shadowed", async () => {
        expect(await run(inject(`Object.defineProperty(globalThis, "__bhaiRun", { set() ${LOOP} })`))).toMatchObject({
            ok: false,
        });
        expect(await run(inject("let __bhaiRun = 1"))).toMatchObject({ ok: false });
    });

    it("a sandbox rejection is logged without touching it", async () => {
        const vm = await import("node:vm");
        const proxy = vm.runInNewContext(`new Proxy({}, { get() ${LOOP}, getPrototypeOf() ${LOOP} })`);
        expect(loggableRejection(proxy)).toBe("[object from another realm]");
        expect(loggableRejection(new Error("x"))).toMatch(/^Error: x/);
        expect(loggableRejection("s")).toBe("s");
    });
});

const ESCAPES = [
    `return parseInt.constructor("return process")().pid;`,
    `return this.constructor.constructor("return process")().pid;`,
    `return JSON.parse.constructor("return process")().pid;`,
    `return console.log.constructor("return process")().pid;`,
    `return input.constructor.constructor("return process")().pid;`,
    `return utils.fetch.constructor("return process")().pid;`,
    `const p = utils.fetch().catch((e) => e); const e = await p; return e.constructor.constructor("return process")().pid;`,
    `return setTimeout.constructor("return process")().pid;`,
];

describe("vm sandboxes hand untrusted code no host Function", () => {
    it.each(ESCAPES)("forge verifier: %s", async (handlerCode) => {
        const r = await runTestInSandbox({ handlerCode, input: { a: 1 }, timeoutMs: 2000 });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/Code generation from strings disallowed|not defined/);
    });

    it("forge verifier still runs normal handlers", async () => {
        const r = await runTestInSandbox({
            handlerCode: `console.log("hi"); await new Promise((res) => setTimeout(res, 1)); return { n: input.a + 1, s: JSON.stringify([1]) };`,
            input: { a: 1 },
        });
        expect(r).toMatchObject({ ok: true, result: { n: 2, s: "[1]" }, stdout: "hi\n" });
    });

    it("code_action: host builtins, console and tool results can't escape", async () => {
        const executor = async (name: string) => {
            if (name === "boom") throw new Error("host error");
            return "tool-result";
        };
        for (const code of [
            `return parseInt.constructor("return process")().pid;`,
            `return console.log.constructor("return process")().pid;`,
            `return tools.x.constructor("return process")().pid;`,
            `const P = tools.x({}).constructor; return P.constructor("return process")().pid;`,
            `try { await tools.boom({}); } catch (e) { const E = e.constructor; return E.constructor("return process")().pid; }`,
        ]) {
            const r = await executeCodeAction(code, executor, { timeout: 2000 });
            expect(r.success).toBe(false);
            expect(r.error).toMatch(/Code generation from strings disallowed/);
        }
        const ok = await executeCodeAction(`const r = await tools.web_search({ q: "x" }); return r + "!";`, executor);
        expect(ok).toMatchObject({ success: true, output: "tool-result!" });
    });
});
