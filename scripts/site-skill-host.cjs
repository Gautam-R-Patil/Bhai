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
//
// Only the built-in skills shipped with the app (<bot>/site-skills, beside this
// scripts/ dir) run with plain require(). Every other skill (user, store,
// minted, anywhere else) runs in the vm context whatever its manifest says, and
// a missing or unparseable skill.json is a load error, never a reason to trust.
"use strict";
const fs = require("node:fs");
const nodePath = require("node:path");
const vm = require("node:vm");
const LIB = nodePath.join(__dirname, "site-skill-lib.cjs");
const lib = Object.freeze(require(LIB));
const BUILTIN_DIR = nodePath.resolve(__dirname, "..", "site-skills");

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
    // Sync: returns the JSON. Async: returns null and settles through
    // settle(error, json) (strings only); the host never touches the promise.
    // Every outcome settles: a result JSON can't hold (BigInt, a cycle) or a
    // thrown value String() can't convert (Object.create(null)) is an error,
    // never an unhandled rejection that would kill this process.
    const why = (e) => {
      try { return String((e && e.message) || e); } catch { return "step failed"; }
    };
    return (phase, ctxJson, settle) => {
      const r = step(String(phase), parse(ctxJson), lib);
      if (r === null || (typeof r !== "object" && typeof r !== "function") || typeof r.then !== "function")
        return stringify(r === undefined ? null : r);
      Promise.resolve(r)
        .then((v) => stringify(v === undefined ? null : v))
        .then((json) => settle(null, json), (e) => settle(why(e), null));
      return null;
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
        step: (phase, ctxIn) =>
            new Promise((resolve, reject) => {
                const parseOut = (out) => {
                    if (typeof out !== "string") throw new Error("skill result is not JSON");
                    return JSON.parse(out);
                };
                const out = run(String(phase), JSON.stringify(ctxIn ?? null), (err, json) => {
                    try {
                        if (err !== null) throw new Error(String(err));
                        resolve(parseOut(json));
                    } catch (e) {
                        reject(e);
                    }
                });
                if (out !== null) resolve(parseOut(out));
            }),
    };
}

// realpath both sides: no "..", symlink or /tmp-vs-/private/tmp way in.
function isBuiltin(file) {
    try {
        const rel = nodePath.relative(fs.realpathSync(BUILTIN_DIR), fs.realpathSync(file));
        return !!rel && !rel.startsWith("..") && !nodePath.isAbsolute(rel);
    } catch {
        return false;
    }
}

function load(file) {
    // A missing or bad manifest throws: a load error, not a trusted skill.
    const manifest = JSON.parse(fs.readFileSync(nodePath.join(nodePath.dirname(file), "skill.json"), "utf8"));
    if (!manifest || typeof manifest !== "object") throw new Error("skill.json is not an object");
    return manifest.minted || !isBuiltin(file) ? loadMinted(file) : require(file);
}

// Node is up: from here the host's step deadline runs, so a slow process start
// (a loaded Windows machine) isn't read as the skill hanging. Loading the skill
// is the skill's own code and stays inside that deadline.
if (process.send) process.send({ ready: true });

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
        let error = "step failed";
        try {
            error = String((e && e.message) || e).slice(0, 300);
        } catch {} // a thrown Object.create(null) has no string form
        process.send({ id: m.id, ok: false, kind: "handler_error", error });
    }
});
