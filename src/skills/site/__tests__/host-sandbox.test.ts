// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The shim fails closed: only built-in skills (<bot>/site-skills) get plain
// require(). A user/store skill with no `minted` flag still runs in the vm
// context (no require, no process), and a bad skill.json is a load error.
import { fork } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SkillHost } from "../host.js";

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../scripts");
const root = mkdtempSync(path.join(tmpdir(), "site-sandbox-"));
const hosts: SkillHost[] = [];
afterAll(() => {
    for (const h of hosts) h.close();
});

const add = (
    dir: string,
    name: string,
    code: string,
    manifest: string = JSON.stringify({ name, domains: ["a.test"] }),
) => {
    mkdirSync(path.join(dir, name), { recursive: true });
    writeFileSync(path.join(dir, name, "skill.json"), manifest);
    writeFileSync(path.join(dir, name, "skill.cjs"), code);
    return path.join(dir, name, "skill.cjs");
};
const run = (skill: string) => {
    const h = new SkillHost(skill);
    hosts.push(h);
    return h.call("search", { snapshot: { url: "https://a.test/" } });
};

describe("site-skill-host sandboxing", () => {
    const store = path.join(root, "store");

    it("a user/store skill without `minted` gets no require, process or Function escape", async () => {
        const skill = add(
            store,
            "probe",
            `exports.step = async () => {
                let escape;
                try { escape = typeof ({}).constructor.constructor("return process")(); } catch { escape = "blocked"; }
                return { done: { summary: JSON.stringify({ require: typeof require, process: typeof process, escape }) } };
            };`,
        );
        const r = await run(skill);
        expect(JSON.parse(r.done?.summary ?? "{}")).toEqual({
            require: "undefined",
            process: "undefined",
            escape: "blocked",
        });
    });

    it("a user/store skill that calls require('fs') at load is a load error and writes nothing", async () => {
        const marker = path.join(root, "pwned");
        const skill = add(
            store,
            "writer",
            `require("fs").writeFileSync(${JSON.stringify(marker)}, "x"); exports.step = () => ({ done: { summary: "ran" } });`,
        );
        expect(await run(skill)).toEqual({ fail: { reason: "skill_load_error" } });
        expect(existsSync(marker)).toBe(false);
    });

    it("a missing or unparseable skill.json is a load error", async () => {
        const ok = `exports.step = () => ({ done: { summary: "ran" } });`;
        expect(await run(add(store, "bad-json", ok, "{not json"))).toEqual({ fail: { reason: "skill_load_error" } });
        expect(await run(add(store, "null-json", ok, "null"))).toEqual({ fail: { reason: "skill_load_error" } });
        const missing = path.join(store, "no-manifest");
        mkdirSync(missing, { recursive: true });
        writeFileSync(path.join(missing, "skill.cjs"), ok);
        expect(await run(path.join(missing, "skill.cjs"))).toEqual({ fail: { reason: "skill_load_error" } });
    });

    it("an unserializable result or a throw of a bare object is skill_error, not a crashed child", async () => {
        const cases = {
            "async-bigint": `exports.step = async () => ({ done: { summary: "x" }, n: 1n });`,
            "async-circular": `exports.step = async () => { const o = {}; o.o = o; return o; };`,
            "async-null-proto-throw": `exports.step = async () => { throw Object.create(null); };`,
            "async-null-proto-reject": `exports.step = () => Promise.reject(Object.create(null));`,
            "sync-bigint": `exports.step = () => ({ n: 1n });`,
            "sync-null-proto-throw": `exports.step = () => { throw Object.create(null); };`,
        };
        for (const [name, code] of Object.entries(cases)) {
            const h = new SkillHost(add(store, name, code));
            hosts.push(h);
            expect([name, await h.call("search", {})]).toEqual([name, { fail: { reason: "skill_error" } }]);
            // Same child answers again: it was never killed and respawned.
            expect(await h.call("search", {})).toEqual({ fail: { reason: "skill_error" } });
            expect(h.spawned).toHaveLength(1);
        }
    });

    it("a built-in skill (<bot>/site-skills beside the shim's scripts/) still runs with require", async () => {
        // A copy of the shim in <root>/bot/scripts makes <root>/bot/site-skills its built-in dir.
        const bot = path.join(root, "bot");
        mkdirSync(path.join(bot, "scripts"), { recursive: true });
        for (const f of ["site-skill-host.cjs", "site-skill-lib.cjs"])
            copyFileSync(path.join(scripts, f), path.join(bot, "scripts", f));
        const code = `const os = require("node:os"); exports.step = async () => ({ done: { summary: typeof os.homedir } });`;
        const builtin = add(path.join(bot, "site-skills"), "b", code);
        const outside = add(path.join(bot, "elsewhere"), "b", code);
        const callShim = (skill: string) =>
            new Promise<{ ok?: boolean; kind?: string; result?: { done?: { summary: string } } }>((resolve) => {
                const c = fork(path.join(bot, "scripts", "site-skill-host.cjs"), [skill], {
                    serialization: "json",
                    stdio: ["ignore", "ignore", "ignore", "ipc"],
                });
                c.once("message", (m) => {
                    c.kill("SIGKILL");
                    resolve(m as never);
                });
                c.send({ id: 1, phase: "search", ctx: {} });
            });
        expect((await callShim(builtin)).result).toEqual({ done: { summary: "function" } });
        // Same code one folder over (or reached via "..") is sandboxed: require is gone.
        expect(await callShim(outside)).toMatchObject({ ok: false, kind: "load_error" });
        expect(await callShim(path.join(bot, "site-skills", "..", "elsewhere", "b", "skill.cjs"))).toMatchObject({
            ok: false,
            kind: "load_error",
        });
    });
});
