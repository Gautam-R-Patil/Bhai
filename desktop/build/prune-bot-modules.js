// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Trims the packaged bot/node_modules (a copy of the repo's node_modules, dev
// tree included) to what `npm ci --omit=dev` installs from package-lock.json,
// then drops files no Node runtime on the target OS/arch loads: C/C++ build
// sources, other platforms' prebuilds, browser-only builds, type declarations.

const fs = require("node:fs");
const path = require("node:path");

/** Lock keys a production install has: everything not flagged `dev`. */
function prodLockKeys(lock) {
    const keep = new Set();
    for (const [k, v] of Object.entries(lock.packages || {})) {
        if (k && !v.dev && !v.link) keep.add(k);
    }
    return keep;
}

// Whole packages that are in the production tree but that Node never loads:
// @huggingface/transformers' Node build stubs onnxruntime-web out
// (dist/transformers.node.mjs: "onnxruntime-web (ignored)").
const NODE_IGNORED_PACKAGES = new Set(["node_modules/@huggingface/transformers/node_modules/onnxruntime-web"]);

const ALWAYS_DROP = [
    // C/C++ sources and headers: the runtime loads the built .node files.
    /\.(c|cc|cpp|h|hpp)$/,
    /^better-sqlite3\/(deps|src)\//,
    // tree-sitter grammars: the generator's input and the web (wasm) builds.
    // src/node-types.json stays: bindings/node/index.js requires it.
    /^tree-sitter[^/]*\/(.*\/)?grammar\.json$/,
    /^tree-sitter[^/]*\/.*\.wasm$/,
    // Browser builds; each package's Node entry point is kept.
    /^onnxruntime-web\/dist\/(?!ort-web\.node\.js$|ort-wasm-threaded[^/]*\.js$)/,
    /^@huggingface\/transformers\/dist\/(?!transformers\.node\.(mjs|cjs)$)/,
    /^@xenova\/transformers\/dist\//,
    /^kokoro-js\/dist\/kokoro\.web\.js$/,
    // pdf-parse always loads its default pdf.js (v1.10.100); pdf-lib's main is cjs/.
    /^pdf-parse\/lib\/pdf\.js\/(?!v1\.10\.100\/)/,
    /^pdf-lib\/(es|dist)\//,
    // Type declarations and source maps.
    /\.d\.[mc]?ts$/,
    /\.map$/,
];

function dropsPrebuild(rel, platform, arch) {
    const m = /(?:^|\/)prebuilds\/([^/]+)\//.exec(rel);
    if (!m) return false;
    const dir = m[1];
    if (!dir.startsWith(`${platform}-`)) return true;
    const archs = dir.slice(platform.length + 1).split("+");
    // A universal Mac app runs both arches' prebuilds.
    return arch === "universal" ? !archs.some((a) => a === "x64" || a === "arm64") : !archs.includes(arch);
}

/**
 * Whether a file under node_modules is dead weight on `platform`/`arch`.
 * `rel` is the posix path from the containing node_modules, e.g.
 * "better-sqlite3/deps/sqlite3/sqlite3.c".
 */
function shouldDropFile(rel, platform, arch) {
    if (ALWAYS_DROP.some((re) => re.test(rel))) return true;
    if (dropsPrebuild(rel, platform, arch)) return true;
    const fallback = /^clipboardy\/fallbacks\/([^/]+)\//.exec(rel);
    if (fallback) return fallback[1] !== { win32: "windows", linux: "linux" }[platform];
    if (rel === "ssh2/util/pagent.exe") return platform !== "win32";
    return false;
}

function sizeOf(p) {
    let total = 0;
    const st = fs.lstatSync(p);
    if (!st.isDirectory()) return st.size;
    for (const e of fs.readdirSync(p)) total += sizeOf(path.join(p, e));
    return total;
}

/**
 * Prunes `<botDir>/node_modules` in place. Returns counts, bytes freed and the
 * production lock entries (not optional) that are missing from the copied tree.
 */
function pruneBotModules(botDir, lock, { platform, arch }) {
    const keep = prodLockKeys(lock);
    const ignored = NODE_IGNORED_PACKAGES;
    const result = { removedPackages: 0, removedFiles: 0, bytes: 0, missing: [] };

    const remove = (p) => {
        result.bytes += sizeOf(p);
        fs.rmSync(p, { recursive: true, force: true });
    };

    // Files of one package, not descending into its own node_modules.
    const trimFiles = (pkgDir, relBase, isPackageRoot) => {
        for (const e of fs.readdirSync(pkgDir, { withFileTypes: true })) {
            if (isPackageRoot && e.name === "node_modules") continue;
            const abs = path.join(pkgDir, e.name);
            const rel = `${relBase}/${e.name}`;
            if (e.isDirectory()) {
                trimFiles(abs, rel, false);
                if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
            } else if (shouldDropFile(rel, platform, arch)) {
                remove(abs);
                result.removedFiles++;
            }
        }
    };

    const walk = (nmDir, keyPrefix) => {
        if (!fs.existsSync(nmDir)) return;
        for (const e of fs.readdirSync(nmDir, { withFileTypes: true })) {
            if (e.name === ".bin") continue;
            // npm's hidden lockfile: only npm reads it, and it no longer matches.
            if (e.name === ".package-lock.json") {
                remove(path.join(nmDir, e.name));
                continue;
            }
            if (e.name.startsWith(".")) continue;
            const names = e.name.startsWith("@")
                ? fs.readdirSync(path.join(nmDir, e.name)).map((s) => `${e.name}/${s}`)
                : [e.name];
            for (const name of names) {
                const dir = path.join(nmDir, name);
                if (!fs.statSync(dir).isDirectory()) continue;
                const key = `${keyPrefix}node_modules/${name}`;
                if (!keep.has(key) || ignored.has(key)) {
                    remove(dir);
                    result.removedPackages++;
                    continue;
                }
                trimFiles(dir, name, true);
                walk(path.join(dir, "node_modules"), `${key}/`);
            }
            if (e.name.startsWith("@") && fs.readdirSync(path.join(nmDir, e.name)).length === 0) {
                fs.rmdirSync(path.join(nmDir, e.name));
            }
        }
        // .bin links into packages removed above dangle, and electron-builder
        // fails with ENOENT when it stats them for signing.
        const binDir = path.join(nmDir, ".bin");
        if (fs.existsSync(binDir)) {
            for (const name of fs.readdirSync(binDir)) {
                if (!fs.existsSync(path.join(binDir, name))) fs.unlinkSync(path.join(binDir, name));
            }
            if (fs.readdirSync(binDir).length === 0) fs.rmdirSync(binDir);
        }
        // A node_modules left empty (all its packages extraneous) goes too.
        if (keyPrefix && fs.readdirSync(nmDir).length === 0) fs.rmdirSync(nmDir);
    };

    walk(path.join(botDir, "node_modules"), "");

    for (const k of keep) {
        // Optional entries are other platforms' binaries; @types/* hold only
        // declarations (the build's filter leaves them out on purpose).
        if (lock.packages[k].optional || /(^|\/)node_modules\/@types\//.test(k)) continue;
        if ([...ignored].some((ign) => k === ign || k.startsWith(`${ign}/`))) continue;
        if (!fs.existsSync(path.join(botDir, k))) result.missing.push(k);
    }
    return result;
}

module.exports = { prodLockKeys, shouldDropFile, pruneBotModules, NODE_IGNORED_PACKAGES };
