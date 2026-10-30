// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Post-Pack Source Protection ───────────────
// Runs after electron-builder packs the app.
// 0. Bundles bot/dist/ → bot/bot-bundle.mjs (hides all 450+ file names)
// 1. Obfuscates bot/bot-bundle.mjs
// 2. Compiles to V8 bytecode
// 3. Encodes sensitive strings (prompts/skills)
// 4. Generates ASAR integrity checksum (SHA-256)
// 5. Strips source maps and TypeScript files
// 6. Creates anti-tamper markers
// 7. Injects native bindings

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, execSync, spawnSync } = require("node:child_process");
const { pruneBotModules } = require("./prune-bot-modules.js");

// Import protection modules
let JavaScriptObfuscator;
let bytenode;

try {
    JavaScriptObfuscator = require("javascript-obfuscator");
} catch {
    console.log("[PROTECT] javascript-obfuscator not available, skipping obfuscation");
}

try {
    bytenode = require("bytenode");
} catch {
    console.log("[PROTECT] bytenode not available, skipping bytecode compilation");
}

// MAXIMUM PROTECTION obfuscation settings
const OBFUSCATION_OPTIONS = {
    // Maximum compactness
    compact: true,
    simplify: true,

    // Control flow obfuscation — backed off from 100% to 0.75. At threshold=1 on
    // a 3.2 MB bundle the obfuscator occasionally emits invalid JS that parses on
    // the build box but SyntaxErrors on user machines. 0.75 keeps ~75% of functions
    // flattened with far lower risk of malformed output.
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.75,

    // Dead code injection — backed off similarly. 0.3 still injects enough to
    // make the bundle unreadable without being a flakiness landmine.
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.3,

    // String protection
    stringArray: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayThreshold: 0.8,
    stringArrayIndexShift: true,
    stringArrayWrappersCount: 2,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 4,
    stringArrayWrappersType: "function",
    stringArrayEncoding: ["rc4"],
    splitStrings: true,
    splitStringsChunkLength: 10,

    // Identifier obfuscation
    identifierNamesGenerator: "mangled-shuffled",
    identifiersDictionary: [],
    identifiersPrefix: "_",

    // Number obfuscation
    numbersToExpressions: true,

    // Object key transformation — OFF. Combined with controlFlowFlattening it
    // broke object literals in class fields (ChromePageProxy's mouse = {...} and
    // keyboard = {...}): the flattening helper's const landed after its use, so
    // dblclick/wheel/move/press threw "X[Y(...)] is not a function" / "Cannot
    // access 'X' before initialization" in release builds only. Reproduced on the
    // real bridge bundle 6/6 rolls; off, 5/5 pass. Keep it off unless that is
    // re-tested with a bundle that has class-field object literals.
    transformObjectKeys: false,

    // Anti-debugging - disabled for production stability
    // (debugProtection creates CPU-heavy loops that slow down the bot)
    debugProtection: false,
    debugProtectionInterval: 0,
    disableConsoleOutput: false, // Keep console for bot functionality

    // Self-defending code - disabled for stability
    // (selfDefending causes issues with some runtime environments)
    selfDefending: false,

    // Unicode escape — OFF. Strings are still rc4-encrypted in the string
    // array; escaping every ASCII character as \uXXXX only made the bundle 70%
    // bigger (16.9 → 9.7 MB) and slower to parse at every start. escapeLiterals()
    // escapes non-Latin-1 characters in string and regex literals, so V8 keeps
    // the source one byte per char, and module paths in full as before.
    unicodeEscapeSequence: false,

    // Keep module exports working
    renameGlobals: false,
    renameProperties: false,
    reservedNames: [
        "^exports$", "^module$", "^require$", "^__dirname$", "^__filename$",
        "^import$", "^from$",
        "^esmRequire$",    // createRequire(import.meta.url) alias in vector-index.js
        "^nativeModule$",  // the loaded native binding reference variable
    ],
    reservedStrings: ["import", "export", "from", "require"],

    // Target Node.js
    target: "node",

    // No source map
    sourceMap: false,
};

// Files to skip
const SKIP_PATTERNS = [
    /\.node$/,
    /\.json$/,
    /\.jsc$/,
    /\.map$/,
    /\.d\.ts$/,
    /node_modules/,
    /package\.json$/,
    /voice\/live\/.*\.js$/, // Skip live voice API clients — property names must be sent verbatim to Google/OpenAI
];

function shouldSkip(filePath) {
    return SKIP_PATTERNS.some(p => p.test(filePath));
}

/**
 * Post-obfuscation pass over string and regex literals.
 *
 * V8 stores a script's source one byte per character only when every character
 * is Latin-1 (≤ U+00FF). With unicodeEscapeSequence off the obfuscator leaves
 * string and regex literals as written, and their emoji / Devanagari / CJK would
 * make the whole bundle two bytes per character. In both, \uXXXX (a surrogate
 * pair for astral characters) means the same thing, with or without a regex's
 * u flag, and so it does in place of an identity escape (\ + character). A
 * backslash before U+2028/U+2029 in a string is a line continuation, which adds
 * nothing. Template literals are left alone: a tag such as String.raw would see
 * the escape itself.
 *
 * Module paths ('../dist/…js', the keys of esbuild's lazy-init wrappers) are
 * written fully as \xNN, as unicodeEscapeSequence did, so the bundle's file
 * names stay out of a plain-text search.
 */
function escapeLiterals(code) {
    const acorn = require("acorn");
    const hex = (ch) => {
        const n = ch.charCodeAt(0);
        return n > 0xff ? `\\u${n.toString(16).padStart(4, "0")}` : `\\x${n.toString(16).padStart(2, "0")}`;
    };
    let out = "";
    let last = 0;
    for (const tok of acorn.tokenizer(code, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true })) {
        const isString = tok.type === acorn.tokTypes.string;
        if (tok.type !== acorn.tokTypes.regexp && !isString) continue;
        const raw = code.slice(tok.start, tok.end);
        if (isString && /^['"]\.\.\/dist\/[\w./-]+['"]$/.test(raw)) {
            out += code.slice(last, tok.start) + raw[0] + [...raw.slice(1, -1)].map(hex).join("") + raw[0];
            last = tok.end;
            continue;
        }
        if (!/[\u0100-\uffff]/.test(raw)) continue;
        let fixed = "";
        for (let i = 0; i < raw.length; i++) {
            const c = raw[i];
            if (c === "\\") {
                const n = raw[++i];
                if (n === " " || n === " ") continue;
                fixed += n.charCodeAt(0) > 0xff ? hex(n) : c + n;
            } else {
                fixed += c.charCodeAt(0) > 0xff ? hex(c) : c;
            }
        }
        out += code.slice(last, tok.start) + fixed;
        last = tok.end;
    }
    return out + code.slice(last);
}

/**
 * Additional scrambling pass - makes code even harder to read
 * NOTE: Disabled comment injection — the naive string-boundary parser cannot
 * reliably handle obfuscated code that uses hex escapes (\x27, \x22, \x60)
 * inside string literals, causing "Invalid or unexpected token" at runtime.
 * The javascript-obfuscator output is already thoroughly protected.
 */
function additionalScramble(code) {
    return code;
}

/**
 * Obfuscate a JavaScript file with maximum protection
 */
function obfuscateFile(filePath) {
    if (!JavaScriptObfuscator) return false;

    try {
        const code = fs.readFileSync(filePath, "utf8");
        if (code.length < 100 || code.includes("_0x")) return false;

        // Try up to 8 times — the obfuscator with controlFlowFlattening
        // occasionally produces invalid JS. The bundle has grown large
        // enough that 3 rolls can occasionally all be bad; 8 is well
        // within the time budget (each attempt is ~2-4s) and dramatically
        // reduces flake. Parse-check via `node --check` (which handles
        // ESM import/export unlike vm.Script) before writing, so a bad
        // roll doesn't ship.
        const { spawnSync } = require("node:child_process");
        const tmpDir = require("node:os").tmpdir();
        let lastErr = null;
        for (let attempt = 1; attempt <= 8; attempt++) {
            const obfuscated = JavaScriptObfuscator.obfuscate(code, OBFUSCATION_OPTIONS);
            let protectedCode = obfuscated.getObfuscatedCode();
            protectedCode = additionalScramble(protectedCode);
            protectedCode = escapeLiterals(protectedCode);
            const wide = (protectedCode.match(/[\u0100-\uffff]/g) || []).length;
            if (wide) {
                console.warn(
                    `[PROTECT] ⚠ ${wide} non-Latin-1 characters left (template literals?): V8 will hold this bundle at two bytes per character`,
                );
            }
            const header = `// ${crypto.randomBytes(8).toString('hex')} © ${crypto.randomBytes(4).toString('hex')}\n`;
            const finalCode = header + protectedCode;
            // Write to a tmp .mjs so Node treats it as ESM for the parse check.
            const probe = path.join(tmpDir, `atlas-obf-check-${process.pid}-${attempt}.mjs`);
            fs.writeFileSync(probe, finalCode);
            const r = spawnSync(process.execPath, ["--check", probe], { encoding: "utf8" });
            fs.unlinkSync(probe);
            if (r.status !== 0) {
                lastErr = new Error(r.stderr.split("\n")[0] || "node --check failed");
                console.warn(`[PROTECT] ✗ Attempt ${attempt}: obfuscator emitted unparseable JS (${lastErr.message.slice(0, 100)}) — retrying`);
                continue;
            }
            fs.writeFileSync(filePath, finalCode);
            if (attempt > 1) console.log(`[PROTECT] ✓ Succeeded on attempt ${attempt}`);
            return true;
        }
        console.error(`[PROTECT] ✗ ${path.basename(filePath)} obfuscation failed after 8 attempts. Last error: ${lastErr?.message}`);
        throw new Error(`Obfuscation of ${path.basename(filePath)} failed parse-check 8x — aborting build (was shipping broken bundle before this guard).`);
    } catch (err) {
        console.log(`[PROTECT] Obfuscation failed for ${path.basename(filePath)}: ${err.message}`);
        throw err;  // Propagate — do NOT ship an un-obfuscated or broken bundle.
    }
}

/**
 * Check if file uses ES modules (import/export)
 * Handles both regular and obfuscated code patterns
 */
function usesESModules(code) {
    // Check for regular import/export statements
    if (/\bimport\s+/m.test(code) || /\bexport\s+/m.test(code) || /from\s*['"]/m.test(code)) {
        return true;
    }

    // Check for empty export (export {} or export{})
    if (/\bexport\s*\{/m.test(code)) {
        return true;
    }

    // Check for hex-encoded import/export in obfuscated code
    // import = \x69\x6d\x70\x6f\x72\x74, export = \x65\x78\x70\x6f\x72\x74
    if (/\\x69\\x6d\\x70\\x6f\\x72\\x74/i.test(code) || /\\x65\\x78\\x70\\x6f\\x72\\x74/i.test(code)) {
        return true;
    }

    // Check for unicode-escaped import/export
    if (/\\u0069\\u006d\\u0070\\u006f\\u0072\\u0074/i.test(code) || /\\u0065\\u0078\\x70\\u006f\\u0072\\u0074/i.test(code)) {
        return true;
    }

    return false;
}

/**
 * Compile a JavaScript file to V8 bytecode
 * Only works for CommonJS modules, skips ES modules
 * NOTE: We skip bytecode for obfuscated files as obfuscation provides sufficient protection
 *       and bytenode has issues with obfuscated ES module syntax
 */
async function compileToBytecode(filePath) {
    if (!bytenode) return false;

    try {
        const code = fs.readFileSync(filePath, "utf8");

        // Skip ES modules - bytenode only works with CommonJS
        if (usesESModules(code)) {
            return false;
        }

        // Skip ALL obfuscated files - they already have sufficient protection
        // and mixing obfuscation + bytecode causes ES module detection issues
        if (code.includes("_0x")) {
            return false;
        }

        const jscPath = filePath.replace(/\.js$/, ".jsc");

        await bytenode.compileFile({
            filename: filePath,
            output: jscPath,
            compileAsModule: true,
            electron: true,
        });

        // Replace JS with loader
        const loader = `'use strict';require('bytenode');module.exports=require('./${path.basename(jscPath)}');`;
        fs.writeFileSync(filePath, loader);
        return true;
    } catch (err) {
        // Silent fail - obfuscation is the main protection layer
        return false;
    }
}

/**
 * Process directory with obfuscation and bytecode compilation
 */
async function protectDirectory(dir, stats = { obfuscated: 0, bytecode: 0, total: 0 }) {
    if (!fs.existsSync(dir)) return stats;

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory() && !entry.name.includes("node_modules")) {
            await protectDirectory(fullPath, stats);
        } else if (entry.name.endsWith(".js") && !shouldSkip(fullPath)) {
            stats.total++;

            // Step 1: Obfuscate
            if (obfuscateFile(fullPath)) {
                stats.obfuscated++;
            }

            // Step 2: Compile to bytecode
            if (await compileToBytecode(fullPath)) {
                stats.bytecode++;
            }
        }
    }

    return stats;
}

/**
 * Encode sensitive strings (prompts, skills)
 */
function encodeStrings(resourcesDir) {
    const botDir = path.join(resourcesDir, "bot");

    // Simple XOR encoding for prompts and skills
    const encodeFile = (filePath) => {
        const content = fs.readFileSync(filePath);
        const key = Buffer.from("ATLAS_PROTECTED_2026");
        const encoded = Buffer.alloc(content.length);

        for (let i = 0; i < content.length; i++) {
            encoded[i] = content[i] ^ key[i % key.length];
        }

        const protectedPath = filePath + ".protected";
        fs.writeFileSync(protectedPath, encoded.toString("base64"));
        fs.unlinkSync(filePath); // Remove original
        return true;
    };

    let encoded = 0;

    // Encode prompts
    const promptsDir = path.join(botDir, "prompts");
    if (fs.existsSync(promptsDir)) {
        const files = fs.readdirSync(promptsDir);
        for (const file of files) {
            if (file.endsWith(".md")) {
                try {
                    encodeFile(path.join(promptsDir, file));
                    encoded++;
                } catch {}
            }
        }
    }

    // Encode skills
    const skillsDir = path.join(botDir, "skills");
    if (fs.existsSync(skillsDir)) {
        const files = fs.readdirSync(skillsDir);
        for (const file of files) {
            if (file.endsWith(".md")) {
                try {
                    encodeFile(path.join(skillsDir, file));
                    encoded++;
                } catch {}
            }
        }
    }

    return encoded;
}

/**
 * Remove source maps and TypeScript files
 */
function removeSourceMaps(dir) {
    if (!fs.existsSync(dir)) return 0;

    let removed = 0;
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            removed += removeSourceMaps(fullPath);
        } else if (
            entry.name.endsWith(".map") ||
            entry.name.endsWith(".ts") ||
            entry.name.endsWith(".d.ts")
        ) {
            fs.unlinkSync(fullPath);
            removed++;
        }
    }

    return removed;
}

/**
 * Strip non-runtime residues that ship next to the obfuscated bundle.
 *
 * `electron-builder`'s extraResources copies whole directories (scripts/, src/overlay/,
 * native/) verbatim. Most of what lands there is needed at runtime, but a few items
 * are pure source-code leaks that should never reach end users:
 *
 *   • native/index.d.ts                    — TypeScript declarations listing every
 *                                            NAPI export name + signature (3000+ lines)
 *   • scripts/dump_ax.swift, get_location.swift
 *                                          — superseded by compiled *_bin binaries
 *   • scripts/final_render.html            — empty placeholder
 *   • scripts/check-deps.mjs               — Windows-only; drop on macOS/Linux
 *   • scripts/dump_uia.ps1                 — Windows-only; drop on macOS/Linux
 *   • scripts/dump_atspi.py                — Linux-only;  drop on macOS/Windows
 *   • scripts/atlas-hotkey.lua             — Hammerspoon (macOS); drop on Win/Linux
 *   • scripts/atlas-hotkey.ahk             — AutoHotkey (Windows); drop on macOS/Linux
 *
 * Anything still needed for the target platform is preserved.
 */
function cleanResidues(botDir, platform) {
    const removed = [];

    // Always-safe deletions — TypeScript decls, dev/build-only scripts, and
    // source-code artifacts superseded by compiled binaries.
    const alwaysDelete = [
        // TypeScript surface leak
        path.join(botDir, "native", "index.d.ts"),
        // Empty / placeholder files
        path.join(botDir, "scripts", "final_render.html"),
        // Swift source replaced by compiled binaries
        path.join(botDir, "scripts", "dump_ax.swift"),
        path.join(botDir, "scripts", "get_location.swift"),
        path.join(botDir, "scripts", "ocr_screen.swift"),
        // Dev/build-only scripts (never invoked from production runtime)
        path.join(botDir, "scripts", "release.mjs"),
        path.join(botDir, "scripts", "postbuild-copy-assets.mjs"),
        path.join(botDir, "scripts", "patch-baileys.mjs"),
        path.join(botDir, "scripts", "patch-baileys.sh"),
        path.join(botDir, "scripts", "migrate-channel.mjs"),
        path.join(botDir, "scripts", "run-tests.sh"),
    ];

    // Per-platform: keep only the helper scripts for the target OS.
    if (platform === "darwin") {
        alwaysDelete.push(
            path.join(botDir, "scripts", "dump_uia.ps1"),
            path.join(botDir, "scripts", "dump_atspi.py"),
            path.join(botDir, "scripts", "ocr_screen.ps1"),
            path.join(botDir, "scripts", "check-deps.mjs"),
            path.join(botDir, "scripts", "atlas-hotkey.ahk"),
        );
    } else if (platform === "win32") {
        alwaysDelete.push(
            path.join(botDir, "scripts", "dump_atspi.py"),
            path.join(botDir, "scripts", "atlas-hotkey.lua"),
        );
    } else if (platform === "linux") {
        alwaysDelete.push(
            path.join(botDir, "scripts", "dump_uia.ps1"),
            path.join(botDir, "scripts", "ocr_screen.ps1"),
            path.join(botDir, "scripts", "check-deps.mjs"),
            path.join(botDir, "scripts", "atlas-hotkey.ahk"),
            path.join(botDir, "scripts", "atlas-hotkey.lua"),
        );
    }

    for (const file of alwaysDelete) {
        if (fs.existsSync(file)) {
            try {
                fs.unlinkSync(file);
                removed.push(path.basename(file));
            } catch (e) {
                console.warn(`[PROTECT] → could not delete ${file}: ${e.message}`);
            }
        }
    }

    // Minify overlay.html (it's pure HTML/JS embedded into the bot; we can strip
    // comments + collapse whitespace without breaking it).
    const overlayHtml = path.join(botDir, "src", "overlay", "overlay.html");
    if (fs.existsSync(overlayHtml)) {
        try {
            let html = fs.readFileSync(overlayHtml, "utf-8");
            const before = html.length;
            // Strip HTML, JS, CSS comments — non-greedy so we don't eat content.
            html = html.replace(/<!--[\s\S]*?-->/g, ""); // HTML comments
            html = html.replace(/\/\*[\s\S]*?\*\//g, ""); // /* … */
            // Collapse repeated whitespace (preserve single space between tokens).
            html = html.replace(/\n\s*/g, "\n").replace(/[ \t]{2,}/g, " ");
            if (html.length < before) {
                fs.writeFileSync(overlayHtml, html);
            }
        } catch (e) {
            console.warn(`[PROTECT] → overlay.html minify failed: ${e.message}`);
        }
    }

    return removed.length;
}

/** electron-builder's Arch enum (ia32=0, x64=1, armv7l=2, arm64=3, universal=4) as a name. */
function archName(arch) {
    if (typeof arch === "string") return arch;
    return ["ia32", "x64", "armv7l", "arm64", "universal"][arch] || process.arch;
}

function findFiles(dir, nameRe, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) findFiles(p, nameRe, out);
        else if (e.isFile() && nameRe.test(e.name)) out.push(p);
    }
    return out;
}

/** Export names of a Node-API module, loaded in a child Node (a crash can't take the build down). */
function loadedExports(file) {
    const r = spawnSync(
        process.execPath,
        [
            "-e",
            "const m={exports:{}};process.dlopen(m,process.argv[1]);process.stdout.write(Object.keys(m.exports).sort().join(','))",
            file,
        ],
        { encoding: "utf8", timeout: 60000 },
    );
    if (r.status !== 0) throw new Error((r.stderr || "load failed").split("\n")[0]);
    return r.stdout;
}

/**
 * strip -x the large native libraries before electron-builder signs them:
 * onnxruntime's dylibs and the atlas-native module (native/Cargo.toml keeps
 * strip=false because of a linker bug, so it happens here, after linking).
 * A stripped file replaces the original only after it loads in this Node with
 * the same exports (a dylib through the .node binding next to it). Anything
 * that can't be checked here (another arch, no binding next to it) ships as is.
 */
function stripNativeLibraries(botDir, arch) {
    if (process.platform !== "darwin" || process.arch !== arch) return 0;
    let saved = 0;
    const libs = [
        ...findFiles(path.join(botDir, "node_modules"), /^libonnxruntime[^/]*\.dylib$/),
        ...findFiles(path.join(botDir, "native"), /^atlas-native\..*\.node$/),
    ];
    for (const file of libs) {
        const dir = path.dirname(file);
        const probes = file.endsWith(".node")
            ? [file]
            : fs
                  .readdirSync(dir)
                  .filter((n) => n.endsWith(".node"))
                  .map((n) => path.join(dir, n));
        if (probes.length === 0) continue;
        const backup = `${file}.unstripped`;
        const before = fs.statSync(file).size;
        try {
            const expected = probes.map(loadedExports);
            fs.copyFileSync(file, backup);
            execFileSync("strip", ["-x", file], { stdio: "pipe" });
            execFileSync("codesign", ["--force", "--sign", "-", file], { stdio: "pipe" });
            probes.forEach((p, i) => {
                if (loadedExports(p) !== expected[i]) throw new Error(`exports of ${path.basename(p)} changed`);
            });
            fs.unlinkSync(backup);
            saved += before - fs.statSync(file).size;
            console.log(
                `[PROTECT] → Stripped ${path.basename(file)}: ${(before / 1048576).toFixed(1)} → ${(fs.statSync(file).size / 1048576).toFixed(1)} MB`,
            );
        } catch (e) {
            if (fs.existsSync(backup)) fs.renameSync(backup, file);
            console.warn(`[PROTECT] → Kept ${path.basename(file)} unstripped: ${e.message}`);
        }
    }
    return saved;
}

/**
 * Generate integrity hash for ASAR
 */
function generateIntegrityHash(asarPath) {
    if (!fs.existsSync(asarPath)) return null;

    const asarBuffer = fs.readFileSync(asarPath);
    return crypto.createHash("sha256").update(asarBuffer).digest("hex");
}

/**
 * Main afterPack hook
 */
exports.default = async function afterPack(context) {
    const appDir = context.appOutDir;
    let resourcesDir = path.join(appDir, "resources");

    if (context.electronPlatformName === "darwin") {
        resourcesDir = path.join(appDir, "Bhai.app", "Contents", "Resources");
    }

    const asarPath = path.join(resourcesDir, "app.asar");
    const botDir = path.join(resourcesDir, "bot");
    const targetPlatform = context.electronPlatformName;
    const targetArch = archName(context.arch);

    console.log("\n[PROTECT] ═══════════════════════════════════════");
    console.log("[PROTECT] Starting multi-layer source protection...");
    console.log("[PROTECT] ═══════════════════════════════════════\n");

    // 0. Bundle bot/dist/ → bot/bot-bundle.mjs
    // This replaces 450+ named source files with one opaque bundle file,
    // completely hiding the internal architecture from the shipped app.
    const botDistDir = path.join(botDir, "dist");
    const bundleFile = path.join(botDir, "bot-bundle.mjs");
    if (fs.existsSync(botDistDir)) {
        console.log("[PROTECT] Layer 0: Bundling dist/ → bot-bundle.mjs...");
        try {
            const { bundleBot } = await import("./bundle.mjs");
            await bundleBot(botDistDir, bundleFile);
            // Delete the dist/ directory — the bundle replaces it entirely
            fs.rmSync(botDistDir, { recursive: true, force: true });
            console.log(`[PROTECT] → Deleted bot/dist/ (${botDistDir})`);
        } catch (bundleErr) {
            console.error("[PROTECT] ✗ Bundle failed:", bundleErr.message);
            console.warn("[PROTECT] Falling back to obfuscating dist/ directly (file names will be visible)");
        }
    }

    // 0.5 Residue cleanup — remove source artifacts the bundler can't subsume
    // (interpreted scripts, type declarations, helper sources superseded by
    // compiled binaries). Runs after bundling so file-name listings already
    // hide the dist/ surface; this strips the rest.
    console.log("\n[PROTECT] Layer 0.5: Residue cleanup...");
    const residueDeletions = cleanResidues(botDir, targetPlatform);
    console.log(`[PROTECT] → Removed ${residueDeletions} residue files`);

    // 0.6 Production-only node_modules for the target OS/arch: what
    // `npm ci --omit=dev` installs from the repo's package-lock.json, minus
    // files Node never loads there (C/C++ sources, other platforms' prebuilds,
    // browser builds, type declarations). A production package missing from
    // the copied tree fails the build instead of shipping a broken feature.
    console.log(`\n[PROTECT] Layer 0.6: Pruning bot/node_modules for ${targetPlatform}-${targetArch}...`);
    const lock = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package-lock.json"), "utf8"));
    const prune = pruneBotModules(botDir, lock, { platform: targetPlatform, arch: targetArch });
    if (prune.missing.length) {
        throw new Error(
            `bot/node_modules lacks production packages (run npm ci in the repo root): ${prune.missing.join(", ")}`,
        );
    }
    console.log(
        `[PROTECT] → Removed ${prune.removedPackages} packages and ${prune.removedFiles} files (${(prune.bytes / 1048576).toFixed(1)} MB)`,
    );

    // 1. Protect bot source code (obfuscation + bytecode)
    // After bundling, only bot-bundle.mjs needs protection. If bundling failed,
    // fall back to protecting the dist/ directory as before.
    if (fs.existsSync(bundleFile)) {
        console.log("[PROTECT] Layer 1-2: Obfuscation + Bytecode of bundle...");
        const ok = obfuscateFile(bundleFile);
        if (ok) console.log("[PROTECT] → Obfuscated: bot-bundle.mjs");
        const bytecodeOk = await compileToBytecode(bundleFile);
        if (bytecodeOk) console.log("[PROTECT] → Bytecode: bot-bundle.jsc");
    } else if (fs.existsSync(botDistDir)) {
        console.log("[PROTECT] Layer 1-2: Obfuscation + Bytecode compilation (fallback)...");
        const stats = await protectDirectory(botDistDir);
        console.log(`[PROTECT] → Obfuscated: ${stats.obfuscated}/${stats.total} files`);
        console.log(`[PROTECT] → Bytecode: ${stats.bytecode}/${stats.total} files`);
    }

    // 2. Encode sensitive strings (prompts, skills)
    console.log("\n[PROTECT] Layer 3: Encoding sensitive strings...");
    const encoded = encodeStrings(resourcesDir);
    console.log(`[PROTECT] → Encoded: ${encoded} files`);

    // 3. Remove source maps
    console.log("\n[PROTECT] Layer 4: Removing source maps...");
    const unpackedDir = path.join(resourcesDir, "app.asar.unpacked");
    let removed = removeSourceMaps(unpackedDir);
    removed += removeSourceMaps(botDir);
    console.log(`[PROTECT] → Removed: ${removed} files`);

    // 4. Generate ASAR integrity hash
    console.log("\n[PROTECT] Layer 5: Generating integrity hash...");
    const hash = generateIntegrityHash(asarPath);
    if (hash) {
        fs.writeFileSync(path.join(resourcesDir, ".integrity"), hash);
        console.log(`[PROTECT] → Hash: ${hash.substring(0, 16)}...`);
    }

    // 5. Inject native bindings for better-sqlite3
    // Use the unpacked asar copy that electron-builder already compiled for the target platform,
    // falling back to desktop/node_modules/ copy. Never use root ../node_modules as that may
    // be compiled for the wrong platform (e.g. system Node vs Electron, or wrong OS).
    console.log("\n[PROTECT] Layer 6: Injecting native bindings...");
    const unpackedSqliteNode = path.join(
        resourcesDir,
        "app.asar.unpacked",
        "node_modules",
        "better-sqlite3",
        "build",
        "Release",
        "better_sqlite3.node"
    );
    const desktopSqliteNode = path.join(
        process.cwd(),
        "node_modules",
        "better-sqlite3",
        "build",
        "Release",
        "better_sqlite3.node"
    );
    const hostSqliteNode = fs.existsSync(unpackedSqliteNode) ? unpackedSqliteNode : desktopSqliteNode;
    const destSqliteDir = path.join(
        botDir,
        "node_modules",
        "better-sqlite3",
        "build",
        "Release"
    );

    if (fs.existsSync(hostSqliteNode)) {
        fs.mkdirSync(destSqliteDir, { recursive: true });
        fs.copyFileSync(hostSqliteNode, path.join(destSqliteDir, "better_sqlite3.node"));
        console.log(`[PROTECT] → Injected better_sqlite3.node (from ${hostSqliteNode === unpackedSqliteNode ? "asar.unpacked" : "desktop/node_modules"})`);
    }

    // 5b. Inject native SIMD module for vector operations
    const nativeDir = path.join(process.cwd(), "..", "native");
    const destNativeDir = path.join(botDir, "native");

    // Find the .node file for the target platform and arch (not the build
    // machine's, which differ in a cross-arch build).
    const platform = targetPlatform;
    const arch = targetArch;
    let nativeNodeFile = null;

    if (platform === "darwin") {
        // Try universal first, then arch-specific
        const universalPath = path.join(nativeDir, "atlas-native.darwin-universal.node");
        const arm64Path = path.join(nativeDir, "atlas-native.darwin-arm64.node");
        const x64Path = path.join(nativeDir, "atlas-native.darwin-x64.node");

        if (fs.existsSync(universalPath)) {
            nativeNodeFile = universalPath;
        } else if (arch === "arm64" && fs.existsSync(arm64Path)) {
            nativeNodeFile = arm64Path;
        } else if (arch === "x64" && fs.existsSync(x64Path)) {
            nativeNodeFile = x64Path;
        }
    } else if (platform === "win32") {
        const winPath = path.join(nativeDir, `atlas-native.win32-${arch}-msvc.node`);
        if (fs.existsSync(winPath)) {
            nativeNodeFile = winPath;
        }
    } else if (platform === "linux") {
        // Try GNU first, then musl
        const gnuPath = path.join(nativeDir, `atlas-native.linux-${arch}-gnu.node`);
        const muslPath = path.join(nativeDir, `atlas-native.linux-${arch}-musl.node`);
        if (fs.existsSync(gnuPath)) {
            nativeNodeFile = gnuPath;
        } else if (fs.existsSync(muslPath)) {
            nativeNodeFile = muslPath;
        }
    }

    if (nativeNodeFile && fs.existsSync(nativeNodeFile)) {
        fs.mkdirSync(destNativeDir, { recursive: true });

        // Copy the .node file, and drop the other platforms' and arches' builds
        // that extraResources copied from ../native.
        const nodeFileName = path.basename(nativeNodeFile);
        fs.copyFileSync(nativeNodeFile, path.join(destNativeDir, nodeFileName));
        for (const other of fs.readdirSync(destNativeDir)) {
            if (/^atlas-native\..*\.node$/.test(other) && other !== nodeFileName) {
                fs.unlinkSync(path.join(destNativeDir, other));
            }
        }

        // Copy the loader: index.js (fail-open front) + binding.js (napi-generated)
        for (const loader of ["index.js", "binding.js"]) {
            const src = path.join(nativeDir, loader);
            if (fs.existsSync(src)) {
                fs.copyFileSync(src, path.join(destNativeDir, loader));
            }
        }

        // index.d.ts is intentionally NOT copied — TypeScript declarations are
        // only used at compile time and shipping them leaks the full NAPI surface
        // (3000+ lines listing every native export name + signature). Layer 0.5
        // (cleanResidues) ensures the original extra-resources copy is removed.

        // Copy package.json (important for Node to recognize this as CommonJS)
        const packageJson = path.join(nativeDir, "package.json");
        if (fs.existsSync(packageJson)) {
            fs.copyFileSync(packageJson, path.join(destNativeDir, "package.json"));
        }

        console.log(`[PROTECT] → Injected ${nodeFileName} (native SIMD)`);
    } else {
        console.log("[PROTECT] → Native SIMD module not found, skipping");
    }

    // 5c. Ensure sharp is available for embedding model
    const botSharpDir = path.join(botDir, "node_modules", "sharp");
    if (!fs.existsSync(botSharpDir)) {
        console.log("[PROTECT] → sharp not found in bot/node_modules, installing for target platform...");
        try {
            const { execSync } = require("child_process");
            execSync("npm install --no-save sharp", { cwd: botDir, timeout: 120000, stdio: "pipe" });
            console.log("[PROTECT] → sharp installed for target platform");
        } catch (sharpErr) {
            console.warn("[PROTECT] → sharp install failed (embedding model will use fallback):", sharpErr.message?.substring(0, 200));
        }
    } else {
        console.log("[PROTECT] → sharp already present in bot/node_modules");
    }

    // 5d. Strip symbols from the big native libraries (before signing).
    const stripped = stripNativeLibraries(botDir, targetArch);
    if (stripped) console.log(`[PROTECT] → Stripping saved ${(stripped / 1048576).toFixed(1)} MB`);

    // 6. Write protection marker
    const marker = {
        protected: true,
        timestamp: new Date().toISOString(),
        layers: ["obfuscation", "bytecode", "string-encoding", "integrity"],
        copyright: "© 2024-2026 XAGI Labs Private Limited. All rights reserved.",
        warning: "Tampering with this application is prohibited. Reverse engineering attempts are logged.",
    };
    fs.writeFileSync(path.join(resourcesDir, ".protected"), JSON.stringify(marker, null, 2));

    console.log("\n[PROTECT] ═══════════════════════════════════════");
    console.log("[PROTECT] Source protection complete!");
    console.log("[PROTECT] ═══════════════════════════════════════\n");
};

exports.escapeLiterals = escapeLiterals;
exports.OBFUSCATION_OPTIONS = OBFUSCATION_OPTIONS;
exports.archName = archName;
exports.stripNativeLibraries = stripNativeLibraries;
exports.obfuscateFile = obfuscateFile;
