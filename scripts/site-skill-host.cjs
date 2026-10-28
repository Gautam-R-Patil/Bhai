// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Runs one Site Skill in its own process (src/skills/site/host.ts forks it per
// task). A throw, hang, process.exit or OOM in the skill ends this process,
// never the bot. One JSON message in ({id, phase, ctx}), one out. The skill
// gets the shared helpers (site-skill-lib.cjs) as step()'s third argument.
//
// A minted skill (its skill.json has a "minted" field) is model-written code:
// it is loaded with vm.runInNewContext and gets only module/exports and URL, no
// require, process or globals of ours. Node's vm is not a security boundary;
// this is defense in depth behind the minter's static gate, replay, review and
// the owner's approval.
const fs = require("node:fs");
const nodePath = require("node:path");
const vm = require("node:vm");
const lib = Object.freeze(require("./site-skill-lib.cjs"));

function load(file) {
    let minted = false;
    try {
        minted = !!JSON.parse(fs.readFileSync(nodePath.join(nodePath.dirname(file), "skill.json"), "utf8")).minted;
    } catch {}
    if (!minted) return require(file);
    const module = { exports: {} };
    vm.runInNewContext(
        fs.readFileSync(file, "utf8"),
        { module, exports: module.exports, URL, URLSearchParams },
        { filename: file, timeout: 1000 },
    );
    return module.exports;
}

let skill;
try {
    skill = load(process.argv[2]);
} catch (e) {
    skill = { loadError: String((e && e.message) || e).slice(0, 300) };
}

process.on("message", async (m) => {
    if (!m || typeof m.id !== "number") return;
    if (skill.loadError || typeof skill.step !== "function") {
        process.send({ id: m.id, ok: false, kind: "load_error", error: skill.loadError || "no step() export" });
        return;
    }
    try {
        const result = await skill.step(m.phase, m.ctx, lib);
        process.send({ id: m.id, ok: true, result });
    } catch (e) {
        process.send({ id: m.id, ok: false, kind: "handler_error", error: String((e && e.message) || e).slice(0, 300) });
    }
});
