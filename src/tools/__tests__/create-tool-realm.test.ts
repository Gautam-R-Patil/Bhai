// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Dynamic tool handlers run in a vm realm whose global is Object.create(null)
// and whose host functions live only in bootstrap closures. Each payload here
// must end in a codegen/Reference error, never "object" (= reached process).
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { _buildHandlerForTest as buildHandler } from "../create-tool.js";

const PAYLOADS = [
    `return this.constructor.constructor('return typeof process')()`,
    `return globalThis.constructor.constructor('return 1')()`,
    `return Object.constructor('return typeof process')()`,
    `return tools.constructor.constructor('return 1')()`,
    `return console.log.constructor('return 1')()`,
    `return (async()=>{try{await tools.nonexistent({})}catch(e){return e.constructor.constructor('return typeof process')()}})()`,
    `const f=()=>f(); try{f()}catch(e){return e.constructor.constructor('return typeof process')()}`,
];

const EXTRA = [
    // Host awaiting a sandbox promise would hand host resolve functions to this `then`.
    `const t = Promise.prototype.then;
     Promise.prototype.then = function (ok, no) { let r = "blocked"; try { r = typeof ok.constructor("return process")(); } catch {} return t.call(this, () => ok(r), no); };
     return "x";`,
    // Overflow the stack so the host bridge throws a host-realm RangeError.
    `const f = (n) => { try { return f(n + 1); } catch { return utils.fs.existsSync("/tmp"); } };
     try { return f(0); } catch (e) { return e.constructor.constructor("return typeof process")(); }`,
    // Callsites of a host-invoked timer callback.
    `return await new Promise((ok) => setTimeout(() => {
        Error.prepareStackTrace = (_, fr) => fr;
        const fr = new Error().stack; let out = "none";
        for (const c of fr) {
            try { const fn = c.getFunction && c.getFunction(); if (fn) out = typeof fn.constructor("return process")(); } catch {}
            try { out = typeof c.constructor.constructor("return process")(); } catch {}
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

const HOST_CALLS = [
    "setTimeout(() => {}, 0)",
    "console.log(1)",
    'utils.fs.existsSync("/tmp")',
    'utils.path.join("a", "b")',
    'require("path")',
];

describe("dynamic tool realm is sealed", () => {
    for (const call of HOST_CALLS) {
        it(`a stack overflow at ${call} only ever yields sandbox errors`, async () => {
            expect(await buildHandler(FOREIGN_PROBE(call))({})).toBe("clean");
        });
    }

    it("a handler that never settles times out instead of hanging", async () => {
        vi.useFakeTimers();
        try {
            const out = buildHandler("await new Promise(() => {}); return 'never'")({});
            await vi.advanceTimersByTimeAsync(60_000);
            expect(await out).toBe('{"error":"Dynamic tool error: timeout after 60000ms"}');
        } finally {
            vi.useRealTimers();
        }
    });

    for (const code of PAYLOADS) {
        it(`blocks: ${code.slice(0, 90)}`, async () => {
            const out = await buildHandler(code)({});
            expect(out).toMatch(/Code generation from strings disallowed|is not defined/);
            expect(out).not.toMatch(/object|^1$/);
        });
    }

    for (const code of EXTRA) {
        it(`no escape: ${code.slice(0, 60).replace(/\s+/g, " ")}`, async () => {
            expect(await buildHandler(code)({})).not.toMatch(/object/);
        });
    }

    it("allowlisted reads still work; sensitive reads still get the denial", async () => {
        const p = join(tmpdir(), `realm-read-${process.pid}.txt`);
        writeFileSync(p, "hello realm");
        expect(await buildHandler("return utils.fs.readFileSync(input.p)")({ p })).toBe("hello realm");
        // /etc is a critical OS path: denied before sealing and still denied now.
        expect(await buildHandler('return utils.fs.readFileSync("/etc/hosts")')({})).toMatch(/Path not allowed/);
        expect(await buildHandler('return utils.fs.readFileSync(utils.homedir + "/.ssh/id_rsa")')({})).toMatch(
            /Dynamic tool error: Path not allowed: .*\.ssh/,
        );
    });

    it("results and errors keep their shape", async () => {
        expect(await buildHandler("return { a: input.a, n: [1, 2] }")({ a: "x" })).toBe('{"a":"x","n":[1,2]}');
        expect(await buildHandler("return 'plain'")({})).toBe("plain");
        expect(await buildHandler("throw new Error('boom')")({})).toBe('{"error":"Dynamic tool error: boom"}');
        expect(await buildHandler("return await new Promise((ok) => setTimeout(() => ok('tick'), 5))")({})).toBe(
            "tick",
        );
    });
});
