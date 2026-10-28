// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Runs one Site Skill in its own process (src/skills/site/host.ts forks it per
// task). A throw, hang, process.exit or OOM in the skill ends this process,
// never the bot. One JSON message in ({id, phase, ctx}), one out. The skill
// gets the shared helpers (site-skill-lib.cjs) as step()'s third argument.
//
// A minted skill (its skill.json has a "minted" field) is model-written code.
// It runs in its own vm context that holds no object of this realm: the
// context's global has no prototype, code generation from strings and wasm
// are off, and module, exports, URL, URLSearchParams and lib are all built
// inside the context. ctx goes in and the result comes out as JSON text, so
// no host object or function ever reaches the skill (a host object's
// constructor would be this realm's Function, which hands back process). URL
// parsing calls back into this realm only through closures that take and
// return strings. Node's vm is still not a security boundary; this is defense
// in depth behind the minter's static gate, replay, review and the owner's
// approval.
"use strict";
const fs = require("node:fs");
const nodePath = require("node:path");
const vm = require("node:vm");
const LIB = nodePath.join(__dirname, "site-skill-lib.cjs");
const lib = Object.freeze(require(LIB));

// In the context. URL and URLSearchParams are read-only views: after a
// change to searchParams, href and search are not rebuilt.
// ponytail: read-only URL; add setters only if minted skills need to edit URLs.
const BOOT = `(function (hostUrl, hostQs, libFactory) {
  "use strict";
  const parse = JSON.parse, stringify = JSON.stringify;
  class URLSearchParams {
    #e;
    constructor(init) {
      if (init === undefined || init === null) this.#e = [];
      else if (typeof init === "object")
        this.#e = (Array.isArray(init) ? init : Object.entries(init)).map((p) => [String(p[0]), String(p[1])]);
      else this.#e = parse(hostQs("parse", String(init)));
    }
    get(n) { const p = this.#e.find((x) => x[0] === String(n)); return p ? p[1] : null; }
    getAll(n) { return this.#e.filter((x) => x[0] === String(n)).map((x) => x[1]); }
    has(n) { return this.#e.some((x) => x[0] === String(n)); }
    append(n, v) { this.#e.push([String(n), String(v)]); }
    delete(n) { this.#e = this.#e.filter((x) => x[0] !== String(n)); }
    set(n, v) { this.delete(n); this.append(n, v); }
    keys() { return this.#e.map((x) => x[0])[Symbol.iterator](); }
    values() { return this.#e.map((x) => x[1])[Symbol.iterator](); }
    entries() { return this.#e.map((x) => [x[0], x[1]])[Symbol.iterator](); }
    forEach(f) { for (const x of this.#e) f(x[1], x[0], this); }
    [Symbol.iterator]() { return this.entries(); }
    toString() { return hostQs("build", stringify(this.#e)); }
  }
  class URL {
    constructor(url, base) {
      const p = hostUrl(String(url), base === undefined ? null : String(base));
      if (p === null) throw new TypeError("Invalid URL");
      Object.assign(this, parse(p));
      this.searchParams = new URLSearchParams(this.search);
    }
    toString() { return this.href; }
    toJSON() { return this.href; }
  }
  globalThis.URL = URL;
  globalThis.URLSearchParams = URLSearchParams;
  const libModule = { exports: {} };
  libFactory(libModule, libModule.exports);
  const lib = Object.freeze(libModule.exports);
  globalThis.module = { exports: {} };
  globalThis.exports = globalThis.module.exports;
  // After the skill's own code ran: its step, called with JSON in and JSON out.
  return () => {
    const step = globalThis.module.exports.step;
    if (typeof step !== "function") return null;
    return (phase, ctxJson) => {
      const r = step(String(phase), parse(ctxJson), lib);
      return stringify(r === undefined ? null : r);
    };
  };
})`;

// Called from the context with strings only; they return a string (or null).
const URL_FIELDS = ["href", "origin", "protocol", "username", "host", "hostname", "port", "pathname", "search", "hash"];
function hostUrl(url, base) {
    try {
        const u = base === null ? new URL(url) : new URL(url, base);
        return JSON.stringify(Object.fromEntries(URL_FIELDS.map((k) => [k, u[k]])));
    } catch {
        return null;
    }
}
function hostQs(op, s) {
    try {
        return op === "parse"
            ? JSON.stringify([...new URLSearchParams(s)])
            : String(new URLSearchParams(JSON.parse(s)));
    } catch {
        return op === "parse" ? "[]" : "";
    }
}

function loadMinted(file) {
    const ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
    const libFactory = vm.runInContext(`(function (module, exports) {${fs.readFileSync(LIB, "utf8")}\n})`, ctx, {
        filename: LIB,
    });
    const ready = vm.runInContext(BOOT, ctx, { filename: "site-skill-boot.js" })(hostUrl, hostQs, libFactory);
    vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: file, timeout: 1000 });
    const run = ready();
    if (typeof run !== "function") return {};
    return {
        step: (phase, ctxIn) => {
            const out = run(String(phase), JSON.stringify(ctxIn ?? null));
            if (typeof out !== "string") throw new Error("skill result is not JSON");
            return JSON.parse(out);
        },
    };
}

function load(file) {
    let minted = false;
    try {
        minted = !!JSON.parse(fs.readFileSync(nodePath.join(nodePath.dirname(file), "skill.json"), "utf8")).minted;
    } catch {}
    return minted ? loadMinted(file) : require(file);
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
        process.send({
            id: m.id,
            ok: false,
            kind: "handler_error",
            error: String((e && e.message) || e).slice(0, 300),
        });
    }
});
