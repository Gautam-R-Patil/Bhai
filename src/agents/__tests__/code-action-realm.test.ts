// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// code_action / code_execute programs run in a vm realm that must hold no host
// object: any host function inside leads to the host Function constructor,
// then process, and past the tool allowlist, plan-mode and confirmation gates,
// the audit log and the secrets sanitizer.
import { describe, expect, it } from "vitest";
import { executeCodeAction } from "../code-action-agent.js";

const exec = async (n: string, i: Record<string, unknown>) => `${n}:${JSON.stringify(i)}`;
const run = (code: string, timeout?: number) =>
    executeCodeAction(code, exec, { allowedTools: ["read", "grep"], timeout });

const PAYLOADS = [
    `return this.constructor.constructor('return typeof process')()`,
    `return globalThis.constructor.constructor('return 1')()`,
    `return Object.constructor('return typeof process')()`,
    `return tools.constructor.constructor('return 1')()`,
    `return console.log.constructor('return 1')()`,
    `return (async()=>{try{await tools.nonexistent({})}catch(e){return e.constructor.constructor('return typeof process')()}})()`,
    `const f=()=>f(); try{f()}catch(e){return e.constructor.constructor('return typeof process')()}`,
];
// The literal payloads trip the string denylist first; these reach the realm itself.
const PAST_DENYLIST = PAYLOADS.map((p) => p.replaceAll(".constructor.constructor", '.constructor["constructor"]'));

const EXTRA = [
    // Host awaiting a sandbox promise would hand host resolve functions to this `then`.
    `const t = Promise.prototype.then;
     Promise.prototype.then = function (ok, no) { let r = "blocked"; try { r = typeof ok.constructor("return process")(); } catch {} return t.call(this, () => ok(r), no); };
     return "x";`,
    // Overflow the stack so a host bridge call throws a host-realm RangeError.
    `const f = (n) => { try { return f(n + 1); } catch { return tools.read({}); } };
     try { return await f(0); } catch (e) { return e.constructor["constructor"]("return typeof process")(); }`,
    // Callsites of a host-invoked timer callback.
    `return await new Promise((ok) => setTimeout(() => {
        Error.prepareStackTrace = (_, fr) => fr;
        const fr = new Error().stack; let out = "none";
        for (const c of fr) {
            try { const fn = c.getFunction && c.getFunction(); if (fn) out = typeof fn.constructor("return process")(); } catch {}
            try { out = typeof c.constructor["constructor"]("return process")(); } catch {}
        }
        ok(out);
    }, 1));`,
];

// Recurses to the stack limit, then calls a host-backed global at each depth on
// the way out until one call succeeds; any caught error that is not this
// realm's Error came from the host.
const FOREIGN_PROBE = (call: string) => `
    let foreign = 0, settled = false;
    const f = () => {
        try { f(); } catch {}
        if (settled) return; // past the depths where the call can overflow
        try { ${call}; settled = true; } catch (e) { if (e !== null && typeof e === "object" && !(e instanceof Error)) foreign++; }
    };
    try { f(); } catch {}
    if (foreign) throw new Error("foreign=" + foreign);
    return "clean";`;

// Every host function the sandbox can reach, called at every stack depth.
const HOST_CALLS = [
    "setTimeout(() => {}, 0)",
    "clearTimeout(1)",
    "console.log(1)",
    "console.error(1)",
    "tools.read({}).then(undefined, () => {})",
];

describe("code_action realm is sealed", () => {
    for (const call of HOST_CALLS) {
        it(`a stack overflow at ${call} only ever yields sandbox errors`, async () => {
            const r = await run(FOREIGN_PROBE(call));
            expect(r.error).toBeUndefined();
            expect(r.success).toBe(true);
        });
    }

    it("a non-Error thrown out of the sandbox still returns success:false", async () => {
        const r = await run("return 1; }); throw null; (async function () {");
        expect(r).toMatchObject({ success: false, error: "null" });
    });

    it("leftover timers cannot call tools after the call returns", async () => {
        const calls: string[] = [];
        const spy = async (n: string, i: Record<string, unknown>) => {
            calls.push(JSON.stringify(i));
            return n;
        };
        const r = await executeCodeAction(
            `setTimeout(() => tools.read({ late: 1 }).catch(() => {}), 20); return await tools.read({ early: 1 });`,
            spy,
            { allowedTools: ["read"] },
        );
        expect(r.output).toBe("read");
        await new Promise((ok) => setTimeout(ok, 60));
        expect(calls).toEqual(['{"early":1}']);
    });

    for (const code of [...PAYLOADS, ...PAST_DENYLIST]) {
        it(`blocks: ${code.slice(0, 90)}`, async () => {
            const r = await run(code);
            expect(r.success).toBe(false);
            expect(r.error).toMatch(/Code generation from strings disallowed|is not defined|dangerous operations/);
            expect(r.output).not.toMatch(/object|^1$/);
        });
    }

    for (const code of EXTRA) {
        it(`no escape: ${code.slice(0, 60).replace(/\s+/g, " ")}`, async () => {
            const r = await run(code);
            expect(`${r.output} ${r.error ?? ""}`).not.toMatch(/object/);
        });
    }

    it("still refuses a tool outside allowedTools", async () => {
        const r = await run(`await tools.read({}); return await tools.shell_exec({ command: "ls" });`);
        expect(r).toEqual({
            code: expect.any(String),
            output: "",
            success: false,
            error: 'Tool "shell_exec" is not in the allowed tool list. Available: read, grep',
        });
    });

    it("a two-tool program gives the same output as before sealing", async () => {
        const r = await run(`const a = await tools.read({ file_path: "/x" });
console.log("got", a.length);
const b = await tools.grep({ pattern: a.slice(0, 4) });
return { a, b, n: [1, 2] };`);
        // Captured from the pre-seal implementation.
        expect(r.output).toBe(
            '[Console output]\ngot 23\n\n[Return value]\n{\n  "a": "read:{\\"file_path\\":\\"/x\\"}",\n  "b": "grep:{\\"pattern\\":\\"read\\"}",\n  "n": [\n    1,\n    2\n  ]\n}',
        );
        expect(r.success).toBe(true);
    });

    it("logs-only, plain-string and timer programs keep their output", async () => {
        expect((await run(`console.log("only logs"); await tools.read({});`)).output).toBe("only logs");
        expect((await run(`return "plain " + (await tools.read({ q: 1 }));`)).output).toBe('plain read:{"q":1}');
        const t = await run(`const id = setTimeout(() => { throw 1; }, 1); clearTimeout(id);
            return await new Promise((ok) => setTimeout(() => ok("tick"), 5));`);
        expect(t.output).toBe("tick");
    });

    it("a synchronous infinite loop is cut off instead of hanging the bot", async () => {
        const r = await run("while (true) {}", 300);
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/timed out/);
    });

    it("Buffer and URL are gone (documented)", async () => {
        expect((await run("return typeof Buffer + typeof URL + typeof process + typeof require")).output).toBe(
            "undefinedundefinedundefinedundefined",
        );
    });
});
