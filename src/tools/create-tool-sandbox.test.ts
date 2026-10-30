// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Dynamic tool handlers must not reach the host process. Every one of these
// used to work: a host function or object in the sandbox leads to the host
// Function constructor, then process, then child_process.
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { _buildHandlerForTest as buildHandler } from "./create-tool.js";

const ESCAPES = [
    'return typeof parseInt.constructor("return process")()',
    'return typeof utils.path.join.constructor("return process")()',
    'return typeof utils.fs.readFileSync.constructor("return process")()',
    'return typeof input.constructor.constructor("return process")()',
    'return typeof utils.console.log.constructor("return process")()',
    'return typeof require("path").join.constructor("return process")()',
    'return typeof setTimeout(() => {}, 1).constructor.constructor("return process")()',
    'return typeof globalThis.__bridge',
    "return typeof call + typeof callSync",
    'return typeof (async () => {}).constructor("return process")',
];

describe("dynamic tool sandbox", () => {
    for (const code of ESCAPES) {
        it(`blocks: ${code}`, async () => {
            const out = await buildHandler(code)({});
            expect(out).not.toMatch(/"?object"?|function/);
        });
    }

    // The OS temp dir, not "/tmp": Windows has none, and the sandbox's path is the host's.
    const dir = tmpdir();

    it("still does real work: input, path, read-only fs, require", async () => {
        const out = await buildHandler(`
            const p = utils.path.join(input.dir, input.name);
            return { p, exists: typeof utils.fs.existsSync(input.dir) === "boolean", sep: require("path").sep, twice: input.n * 2 };
        `)({ dir, name: "x.txt", n: 21 });
        expect(JSON.parse(out)).toEqual({ p: path.join(dir, "x.txt"), exists: true, sep: path.sep, twice: 42 });
    });

    it("stat and readdir({withFileTypes}) give Node-shaped results with methods", async () => {
        const out = await buildHandler(`
            const st = utils.fs.statSync(input.dir);
            const ents = utils.fs.readdirSync(input.dir, { withFileTypes: true });
            const st2 = await utils.fs.stat(input.dir);
            return { dir: st.isDirectory(), file: st.isFile(), entsOk: ents.every((e) => typeof e.isFile === "function"), asyncDir: st2.isDirectory(),
                     escape: (() => { try { return typeof st.isFile.constructor("return process")(); } catch { return "blocked"; } })() };
        `)({ dir });
        expect(JSON.parse(out)).toEqual({ dir: true, file: false, entsOk: true, asyncDir: true, escape: "blocked" });
    });

    it("refuses sensitive reads and denied capabilities", async () => {
        expect(await buildHandler('return utils.fs.readFileSync(utils.homedir + "/.ssh/id_rsa")')({})).toMatch(/not allowed/);
        expect(await buildHandler("return utils.exec('ls')")({})).toMatch(/denied/);
        expect(await buildHandler('return require("child_process")')({})).toMatch(/not available/);
    });
});

// A persisted handler.js (forge/sandbox-supervisor.ts) gets the same utils as the
// sandbox: promise-returning utf8 reads, os.platform a string, and a console
// that never writes to stdout (the forge child's IPC channel).
describe("persisted handler contract", () => {
    it("matches the session sandbox", async () => {
        const { wrapHandler } = await import("../forge/sandbox-supervisor.js");
        const dir = fs.mkdtempSync(path.join(tmpdir(), "persisted-"));
        const file = path.join(dir, "a.txt");
        fs.writeFileSync(file, "x\ny");
        const code = `console.log("noise");
            return { lines: (await utils.fs.readFile(input.file)).split("\\n").length,
                sync: require("fs").readFileSync(input.file).length, platform: utils.require("os").platform };`;
        fs.writeFileSync(path.join(dir, "handler.js"), wrapHandler(code));
        const handler = createRequire(import.meta.url)(path.join(dir, "handler.js"));
        const write = vi.spyOn(process.stdout, "write");
        try {
            const want = { lines: 2, sync: 3, platform: process.platform };
            expect(await handler({ file })).toEqual(want);
            expect(write).not.toHaveBeenCalled();
            expect(JSON.parse(await buildHandler(code)({ file }))).toEqual(want);
        } finally {
            write.mockRestore();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("timer callbacks", () => {
    it("a busy-looping setTimeout callback is cut off instead of freezing the bot", async () => {
        const out = await buildHandler(`setTimeout(() => { for (;;) {} }, 0); return "started";`)({});
        expect(out).toContain("started");
        const t0 = Date.now();
        await new Promise((r) => setTimeout(r, 50)); // the host loop must come back
        expect(Date.now() - t0).toBeLessThan(8000); // ≤ the 5 s re-entry timeout, not forever
    }, 15_000);
});
