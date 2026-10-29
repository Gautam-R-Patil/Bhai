// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Sandbox code must never run on a host stack without vm's timeout: a loop in
// a microtask, a getter or Proxy trap on a thrown value, or a hook on the
// launcher global would otherwise freeze the whole bot.
import { describe, expect, it } from "vitest";
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
        expect(await run(inject(`Object.defineProperty(globalThis, "__bhaiRun", { set() ${LOOP} })`))).toMatchObject({ ok: false });
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
