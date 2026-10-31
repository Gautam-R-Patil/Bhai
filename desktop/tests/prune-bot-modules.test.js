// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// The packaged bot ships a production-only node_modules for the target OS and
// arch: what `npm ci --omit=dev` installs, minus files no Node runtime loads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const {
    prodLockKeys,
    shouldDropFile,
    pruneBotModules,
    NODE_IGNORED_PACKAGES,
} = require("../build/prune-bot-modules.js");

const repo = path.join(__dirname, "..", "..");
const mac = { platform: "darwin", arch: "arm64" };

describe("prodLockKeys", () => {
    it("keeps what npm ci --omit=dev installs", () => {
        const keys = prodLockKeys({
            packages: {
                "": { name: "bhai" },
                "node_modules/a": {},
                "node_modules/b": { dev: true },
                "node_modules/c": { optional: true },
                "node_modules/d": { devOptional: true },
                "node_modules/a/node_modules/e": {},
            },
        });
        expect([...keys].sort()).toEqual([
            "node_modules/a",
            "node_modules/a/node_modules/e",
            "node_modules/c",
            "node_modules/d",
        ]);
    });
});

describe("shouldDropFile", () => {
    const drop = (rel, t = mac) => shouldDropFile(rel, t.platform, t.arch);

    it("drops C/C++ build sources but keeps the loaded binaries and node-types.json", () => {
        expect(drop("better-sqlite3/deps/sqlite3/sqlite3.c")).toBe(true);
        expect(drop("better-sqlite3/deps/download.sh")).toBe(true);
        expect(drop("better-sqlite3/src/better_sqlite3.cpp")).toBe(true);
        expect(drop("better-sqlite3/build/Release/better_sqlite3.node")).toBe(false);
        expect(drop("better-sqlite3/lib/database.js")).toBe(false);
        expect(drop("tree-sitter-typescript/typescript/src/parser.c")).toBe(true);
        expect(drop("tree-sitter-typescript/common/scanner.h")).toBe(true);
        expect(drop("tree-sitter-typescript/typescript/src/tree_sitter/parser.h")).toBe(true);
        expect(drop("tree-sitter-typescript/typescript/src/grammar.json")).toBe(true);
        expect(drop("tree-sitter-typescript/typescript/src/node-types.json")).toBe(false);
        expect(drop("tree-sitter-rust/src/node-types.json")).toBe(false);
        expect(drop("tree-sitter/src/node.cc")).toBe(true);
        expect(drop("tree-sitter-python/tree-sitter-python.wasm")).toBe(true);
        expect(drop("tree-sitter-typescript/bindings/node/index.js")).toBe(false);
        expect(drop("some-pkg/lib/thing.hpp")).toBe(true);
    });

    it("keeps only the target platform's prebuilds", () => {
        expect(drop("tree-sitter/prebuilds/darwin-arm64/tree-sitter.node")).toBe(false);
        expect(drop("tree-sitter/prebuilds/darwin-x64/tree-sitter.node")).toBe(true);
        expect(drop("tree-sitter/prebuilds/linux-x64/tree-sitter.node")).toBe(true);
        expect(drop("tree-sitter/prebuilds/win32-x64/tree-sitter.node")).toBe(true);
        expect(drop("x/prebuilds/darwin-x64+arm64/x.node")).toBe(false);
        expect(drop("x/prebuilds/ios-arm64/x.node")).toBe(true);
        expect(drop("x/prebuilds/ios-arm64-simulator/x.node")).toBe(true);
        const win = { platform: "win32", arch: "x64" };
        expect(drop("tree-sitter/prebuilds/win32-x64/tree-sitter.node", win)).toBe(false);
        expect(drop("tree-sitter/prebuilds/darwin-arm64/tree-sitter.node", win)).toBe(true);
        expect(drop("tree-sitter/prebuilds/win32-arm64/tree-sitter.node", win)).toBe(true);
    });

    it("keeps both Mac arches' prebuilds in a universal build", () => {
        const universal = { platform: "darwin", arch: "universal" };
        expect(drop("tree-sitter/prebuilds/darwin-arm64/tree-sitter.node", universal)).toBe(false);
        expect(drop("tree-sitter/prebuilds/darwin-x64/tree-sitter.node", universal)).toBe(false);
        expect(drop("tree-sitter/prebuilds/linux-x64/tree-sitter.node", universal)).toBe(true);
    });

    it("drops other platforms' clipboard fallbacks and the Windows pageant helper", () => {
        expect(drop("clipboardy/fallbacks/windows/clipboard_x86_64.exe")).toBe(true);
        expect(drop("clipboardy/fallbacks/linux/xsel")).toBe(true);
        expect(drop("ssh2/util/pagent.exe")).toBe(true);
        expect(drop("clipboardy/lib/macos.js")).toBe(false);
        const win = { platform: "win32", arch: "x64" };
        expect(drop("clipboardy/fallbacks/windows/clipboard_x86_64.exe", win)).toBe(false);
        expect(drop("clipboardy/fallbacks/linux/xsel", win)).toBe(true);
        expect(drop("ssh2/util/pagent.exe", win)).toBe(false);
        const linux = { platform: "linux", arch: "x64" };
        expect(drop("clipboardy/fallbacks/linux/xsel", linux)).toBe(false);
        expect(drop("clipboardy/fallbacks/windows/clipboard_x86_64.exe", linux)).toBe(true);
    });

    it("drops browser-only builds and keeps the Node entry points", () => {
        expect(drop("onnxruntime-web/dist/ort-web.node.js")).toBe(false);
        expect(drop("onnxruntime-web/dist/ort-wasm-threaded.js")).toBe(false);
        expect(drop("onnxruntime-web/dist/ort-wasm-threaded.worker.js")).toBe(false);
        expect(drop("onnxruntime-web/dist/ort-web.min.js")).toBe(true);
        expect(drop("onnxruntime-web/dist/ort.es6.min.js")).toBe(true);
        expect(drop("onnxruntime-web/package.json")).toBe(false);
        expect(drop("@huggingface/transformers/dist/transformers.node.mjs")).toBe(false);
        expect(drop("@huggingface/transformers/dist/transformers.node.cjs")).toBe(false);
        expect(drop("@huggingface/transformers/dist/transformers.web.js")).toBe(true);
        expect(drop("@huggingface/transformers/dist/transformers.min.js")).toBe(true);
        expect(drop("@huggingface/transformers/dist/transformers.js")).toBe(true);
        expect(drop("@huggingface/transformers/dist/transformers.node.min.mjs")).toBe(true);
        expect(drop("@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs")).toBe(true);
        expect(drop("@xenova/transformers/dist/transformers.min.js")).toBe(true);
        expect(drop("@xenova/transformers/src/transformers.js")).toBe(false);
        expect(drop("kokoro-js/dist/kokoro.web.js")).toBe(true);
        expect(drop("kokoro-js/dist/kokoro.js")).toBe(false);
        expect(drop("kokoro-js/voices/af_heart.bin")).toBe(false);
    });

    it("keeps only the pdf.js pdf-parse loads and pdf-lib's CommonJS build", () => {
        expect(drop("pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js")).toBe(false);
        expect(drop("pdf-parse/lib/pdf.js/v1.10.88/build/pdf.js")).toBe(true);
        expect(drop("pdf-parse/lib/pdf.js/v2.0.550/build/pdf.js")).toBe(true);
        expect(drop("pdf-parse/lib/pdf-parse.js")).toBe(false);
        expect(drop("pdf-lib/cjs/index.js")).toBe(false);
        expect(drop("pdf-lib/es/index.js")).toBe(true);
        expect(drop("pdf-lib/dist/pdf-lib.min.js")).toBe(true);
    });

    it("drops type declarations and source maps", () => {
        expect(drop("zod/v4/index.d.ts")).toBe(true);
        expect(drop("zod/v4/index.d.mts")).toBe(true);
        expect(drop("zod/v4/index.d.cts")).toBe(true);
        expect(drop("zod/v4/index.js.map")).toBe(true);
        expect(drop("zod/v4/index.js")).toBe(false);
        expect(drop("zod/v4/index.mjs")).toBe(false);
    });
});

describe("pruneBotModules", () => {
    function fixture(files) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prune-bot-"));
        for (const f of files) {
            fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
            fs.writeFileSync(path.join(dir, f), "x");
        }
        return dir;
    }

    it("removes dev, extraneous and Node-ignored packages and trims files of the rest", () => {
        const botDir = fixture([
            "node_modules/prod/index.js",
            "node_modules/prod/src/binding.cc",
            "node_modules/prod/node_modules/nested/index.js",
            "node_modules/devonly/index.js",
            "node_modules/extraneous/index.js",
            "node_modules/@scope/prod/index.js",
            "node_modules/@scope/dev/index.js",
            "node_modules/@huggingface/transformers/dist/transformers.node.mjs",
            "node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort.node.min.js",
            "node_modules/@huggingface/transformers/node_modules/onnxruntime-node/dist/index.js",
        ]);
        const lock = {
            packages: {
                "": {},
                "node_modules/prod": {},
                "node_modules/prod/node_modules/nested": {},
                "node_modules/devonly": { dev: true },
                "node_modules/@scope/prod": {},
                "node_modules/@scope/dev": { dev: true },
                "node_modules/@huggingface/transformers": {},
                "node_modules/@huggingface/transformers/node_modules/onnxruntime-web": {},
                "node_modules/@huggingface/transformers/node_modules/onnxruntime-node": {},
                "node_modules/optional-other-os": { optional: true },
            },
        };
        const r = pruneBotModules(botDir, lock, mac);
        const exists = (p) => fs.existsSync(path.join(botDir, p));
        expect(exists("node_modules/prod/index.js")).toBe(true);
        expect(exists("node_modules/prod/src/binding.cc")).toBe(false);
        expect(exists("node_modules/prod/node_modules/nested/index.js")).toBe(true);
        expect(exists("node_modules/devonly")).toBe(false);
        expect(exists("node_modules/extraneous")).toBe(false);
        expect(exists("node_modules/@scope/prod/index.js")).toBe(true);
        expect(exists("node_modules/@scope/dev")).toBe(false);
        expect(exists("node_modules/@huggingface/transformers/dist/transformers.node.mjs")).toBe(true);
        expect(exists("node_modules/@huggingface/transformers/node_modules/onnxruntime-web")).toBe(false);
        expect(exists("node_modules/@huggingface/transformers/node_modules/onnxruntime-node/dist/index.js")).toBe(true);
        expect(r.missing).toEqual([]);
        expect(r.removedPackages).toBe(4);
        expect(r.removedFiles).toBe(1);
        fs.rmSync(botDir, { recursive: true, force: true });
    });

    // On a Mac ffprobe gives the video tools exact durations (ffmpeg's banner is 10 ms).
    it("keeps ffprobe-static on every platform", () => {
        const lock = { packages: { "": {}, "node_modules/ffprobe-static": {} } };
        for (const [platform, kept] of [
            ["darwin", true],
            ["win32", true],
            ["linux", true],
        ]) {
            const botDir = fixture(["node_modules/ffprobe-static/index.js"]);
            const r = pruneBotModules(botDir, lock, { platform, arch: "x64" });
            expect(fs.existsSync(path.join(botDir, "node_modules/ffprobe-static/index.js"))).toBe(kept);
            expect(r.missing).toEqual([]);
            fs.rmSync(botDir, { recursive: true, force: true });
        }
    });

    // electron-builder stats every file it signs; a .bin link into a removed
    // package fails the build with ENOENT (node-cron/node_modules/.bin/uuid).
    it("removes .bin links into packages it removed and keeps the others", () => {
        const botDir = fixture([
            "node_modules/prod/index.js",
            "node_modules/prod/node_modules/nested/cli.js",
            "node_modules/prod/node_modules/stale/cli.js",
            "node_modules/other/index.js",
            "node_modules/other/node_modules/stale/cli.js",
        ]);
        const bin = (p) => path.join(botDir, p);
        fs.mkdirSync(bin("node_modules/prod/node_modules/.bin"));
        fs.symlinkSync("../nested/cli.js", bin("node_modules/prod/node_modules/.bin/nested"));
        fs.symlinkSync("../stale/cli.js", bin("node_modules/prod/node_modules/.bin/stale"));
        fs.mkdirSync(bin("node_modules/other/node_modules/.bin"));
        fs.symlinkSync("../stale/cli.js", bin("node_modules/other/node_modules/.bin/stale"));
        const lock = {
            packages: {
                "": {},
                "node_modules/prod": {},
                "node_modules/prod/node_modules/nested": {},
                "node_modules/other": {},
            },
        };
        pruneBotModules(botDir, lock, mac);
        const linked = (p) => {
            try {
                fs.lstatSync(bin(p));
                return true;
            } catch {
                return false;
            }
        };
        expect(fs.readFileSync(bin("node_modules/prod/node_modules/.bin/nested"), "utf8")).toBe("x");
        expect(linked("node_modules/prod/node_modules/.bin/stale")).toBe(false);
        expect(linked("node_modules/other/node_modules/.bin")).toBe(false);
        fs.rmSync(botDir, { recursive: true, force: true });
    });

    it("reports production packages the copied tree lacks", () => {
        const botDir = fixture(["node_modules/prod/index.js"]);
        const lock = {
            packages: {
                "": {},
                "node_modules/prod": {},
                "node_modules/gone": {},
                "node_modules/@types/node": {},
                "node_modules/@huggingface/transformers/node_modules/onnxruntime-web/node_modules/onnxruntime-common":
                    {},
            },
        };
        expect(pruneBotModules(botDir, lock, mac).missing).toEqual(["node_modules/gone"]);
        fs.rmSync(botDir, { recursive: true, force: true });
    });
});

// The runtime closure: every package the bot's code and runtime scripts load
// must survive the prune, and so must every package a surviving one depends on.
describe("the real lockfile's production tree", () => {
    const lock = JSON.parse(fs.readFileSync(path.join(repo, "package-lock.json"), "utf8"));
    const keep = prodLockKeys(lock);
    const BUILTIN = new Set(require("node:module").builtinModules);

    function resolveKey(fromKey, name) {
        let dir = fromKey;
        for (;;) {
            const k = `${dir ? `${dir}/` : ""}node_modules/${name}`;
            if (lock.packages[k]) return k;
            if (!dir) return null;
            const i = dir.lastIndexOf("/node_modules/");
            dir = i < 0 ? "" : dir.slice(0, i);
        }
    }

    function walk(dir, out) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name !== "__tests__" && e.name !== "node_modules") walk(p, out);
            } else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(e.name) && !/\.(test|spec)\.|\.d\.ts$/.test(e.name))
                out.push(p);
        }
        return out;
    }

    it("keeps every package src/, the runtime scripts and the desktop's bot requires load", () => {
        const files = walk(path.join(repo, "src"), []);
        for (const s of [
            "kokoro-worker.mjs",
            "pdf-text.cjs",
            "site-skill-host.cjs",
            "site-skill-lib.cjs",
            "check-deps.mjs",
        ]) {
            files.push(path.join(repo, "scripts", s));
        }
        files.push(path.join(repo, "native", "index.js"));
        const re =
            /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\brequire\.resolve\s*\(\s*|\bbotRequire\s*\(\s*|\bcreateRequire\([^)]*\)\s*\(\s*)["']([^"'./][^"']*)["']/g;
        const pkgs = new Set();
        for (const f of files) {
            const code = fs.readFileSync(f, "utf8");
            for (const m of code.matchAll(re)) {
                const spec = m[1];
                if (spec.startsWith("node:") || BUILTIN.has(spec.split("/")[0])) continue;
                const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
                if (/^[@a-z0-9][\w.@/-]*$/i.test(name)) pkgs.add(name);
            }
        }
        for (const p of ["google-auth-library", "acorn", "node-cron", "sharp", "pdf-parse", "@whiskeysockets/baileys"])
            expect(pkgs.has(p)).toBe(true);
        const main = fs.readFileSync(path.join(repo, "desktop", "main.js"), "utf8");
        for (const m of main.matchAll(/botRequire\("([^"]+)"\)/g)) pkgs.add(m[1]);
        // Type-only imports and names that are not packages (string templates,
        // optional peers the code feature-detects) are not in the lock at all.
        const missing = [...pkgs].filter((p) => lock.packages[`node_modules/${p}`] && !keep.has(`node_modules/${p}`));
        expect(missing).toEqual([]);
        for (const p of [
            "@xenova/transformers",
            "@huggingface/transformers",
            "kokoro-js",
            "better-sqlite3",
            "tree-sitter-typescript",
            "@googleapis/gmail",
            "playwright-core",
        ]) {
            expect(keep.has(`node_modules/${p}`)).toBe(true);
        }
        for (const p of [
            "convex",
            "@anthropic-ai/sdk",
            "fluent-ffmpeg",
            "resumed",
            "prettier",
            "esbuild",
            "typescript",
            "vitest",
        ]) {
            expect(keep.has(`node_modules/${p}`)).toBe(false);
        }
    });

    // Peers are left to npm: --omit=dev skips a peer only dev needs (e.g.
    // @slack/bolt's @types/express), and so does this prune.
    it("is closed: every dependency of a kept package is kept", () => {
        const broken = [];
        for (const k of keep) {
            for (const name of Object.keys(lock.packages[k].dependencies || {})) {
                const r = resolveKey(k, name);
                if (!r || !keep.has(r)) broken.push(`${k} -> ${r || name}`);
            }
        }
        expect(broken).toEqual([]);
    });

    it("never drops a kept package's Node entry point", () => {
        const nm = path.join(repo, "node_modules");
        if (!fs.existsSync(nm)) return;
        const pick = (e, conds) => {
            if (typeof e === "string") return [e];
            if (Array.isArray(e)) return e.flatMap((x) => pick(x, conds)).slice(0, 1);
            if (!e || typeof e !== "object") return [];
            const keys = Object.keys(e);
            if (keys[0]?.startsWith(".")) return keys.flatMap((k) => pick(e[k], conds));
            for (const k of keys) if (conds.includes(k)) return pick(e[k], conds);
            return [];
        };
        const bad = [];
        for (const k of keep) {
            if (NODE_IGNORED_PACKAGES.has(k)) continue;
            const pj = path.join(repo, k, "package.json");
            if (!fs.existsSync(pj)) continue;
            const p = JSON.parse(fs.readFileSync(pj, "utf8"));
            const name = k.slice(k.lastIndexOf("node_modules/") + "node_modules/".length);
            const targets = p.exports
                ? [
                      ...pick(p.exports, ["node", "import", "default"]),
                      ...pick(p.exports, ["node", "require", "default"]),
                  ]
                : [p.main || "index.js"];
            for (const t of targets) {
                if (t.includes("*")) continue;
                const rel = path.posix.join(name, t);
                if (shouldDropFile(rel, "darwin", "arm64")) bad.push(rel);
            }
        }
        expect(bad).toEqual([]);
    });
});
