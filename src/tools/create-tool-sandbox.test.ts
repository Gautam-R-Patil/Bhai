// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Dynamic tool handlers must not reach the host process. Every one of these
// used to work: a host function or object in the sandbox leads to the host
// Function constructor, then process, then child_process.
import { describe, expect, it } from "vitest";
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
    'return typeof (async () => {}).constructor("return process")',
];

describe("dynamic tool sandbox", () => {
    for (const code of ESCAPES) {
        it(`blocks: ${code}`, async () => {
            const out = await buildHandler(code)({});
            expect(out).not.toMatch(/"?object"?|function/);
        });
    }

    it("still does real work: input, path, read-only fs, require", async () => {
        const out = await buildHandler(`
            const p = utils.path.join("/tmp", input.name);
            return { p, exists: typeof utils.fs.existsSync("/tmp") === "boolean", sep: require("path").sep, twice: input.n * 2 };
        `)({ name: "x.txt", n: 21 });
        expect(JSON.parse(out)).toEqual({ p: "/tmp/x.txt", exists: true, sep: "/", twice: 42 });
    });

    it("stat and readdir({withFileTypes}) give Node-shaped results with methods", async () => {
        const out = await buildHandler(`
            const st = utils.fs.statSync("/tmp");
            const ents = utils.fs.readdirSync("/tmp", { withFileTypes: true });
            const st2 = await utils.fs.stat("/tmp");
            return { dir: st.isDirectory(), file: st.isFile(), entsOk: ents.every((e) => typeof e.isFile === "function"), asyncDir: st2.isDirectory(),
                     escape: (() => { try { return typeof st.isFile.constructor("return process")(); } catch { return "blocked"; } })() };
        `)({});
        expect(JSON.parse(out)).toEqual({ dir: true, file: false, entsOk: true, asyncDir: true, escape: "blocked" });
    });

    it("refuses sensitive reads and denied capabilities", async () => {
        expect(await buildHandler('return utils.fs.readFileSync(utils.homedir + "/.ssh/id_rsa")')({})).toMatch(/not allowed/);
        expect(await buildHandler("return utils.exec('ls')")({})).toMatch(/denied/);
        expect(await buildHandler('return require("child_process")')({})).toMatch(/not available/);
    });
});
