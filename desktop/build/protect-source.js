// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Post-Pack Source Protection ───────────────
// Runs after electron-builder packs the app.
// 1. Obfuscates JavaScript source code
// 2. Compiles to V8 bytecode
// 3. Encodes sensitive strings (prompts/skills)
// 4. Generates ASAR integrity checksum (SHA-256)
// 5. Strips source maps and TypeScript files
// 6. Creates anti-tamper markers
// 7. Injects native bindings

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

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

    // Control flow obfuscation - maximum
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 1, // 100% of functions

    // Dead code injection - maximum
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.5, // 50% dead code

    // String protection - maximum
    stringArray: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayThreshold: 1, // 100% of strings
    stringArrayIndexShift: true,
    stringArrayWrappersCount: 5, // Multiple wrapper layers
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 5,
    stringArrayWrappersType: "function",
    stringArrayEncoding: ["rc4"], // RC4 encryption for strings
    splitStrings: true,
    splitStringsChunkLength: 5, // Split into tiny chunks

    // Identifier obfuscation
    identifierNamesGenerator: "mangled-shuffled",
    identifiersDictionary: [],
    identifiersPrefix: "_",

    // Number obfuscation
    numbersToExpressions: true,

    // Object key transformation
    transformObjectKeys: true,

    // Anti-debugging - disabled for production stability
    // (debugProtection creates CPU-heavy loops that slow down the bot)
    debugProtection: false,
    debugProtectionInterval: 0,
    disableConsoleOutput: false, // Keep console for bot functionality

    // Self-defending code - disabled for stability
    // (selfDefending causes issues with some runtime environments)
    selfDefending: false,

    // Unicode escape
    unicodeEscapeSequence: true,

    // Keep module exports working
    renameGlobals: false,
    renameProperties: false,
    reservedNames: ["^exports$", "^module$", "^require$", "^__dirname$", "^__filename$", "^import$", "^from$"],
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
    /vector-index\.js$/, // Skip to preserve createRequire for native module loading
    /voice\/live\/.*\.js$/, // Skip live voice API clients — property names must be sent verbatim to Google/OpenAI
];

function shouldSkip(filePath) {
    return SKIP_PATTERNS.some(p => p.test(filePath));
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

        // First pass: JavaScript Obfuscator
        const obfuscated = JavaScriptObfuscator.obfuscate(code, OBFUSCATION_OPTIONS);
        let protectedCode = obfuscated.getObfuscatedCode();

        // Second pass: Additional scrambling
        protectedCode = additionalScramble(protectedCode);

        // Add misleading header
        const header = `// ${crypto.randomBytes(8).toString('hex')} © ${crypto.randomBytes(4).toString('hex')}\n`;

        fs.writeFileSync(filePath, header + protectedCode);
        return true;
    } catch (err) {
        console.log(`[PROTECT] Obfuscation failed for ${path.basename(filePath)}: ${err.message}`);
        return false;
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
        resourcesDir = path.join(appDir, "A.T.L.A.S.app", "Contents", "Resources");
    }

    const asarPath = path.join(resourcesDir, "app.asar");
    const botDir = path.join(resourcesDir, "bot");

    console.log("\n[PROTECT] ═══════════════════════════════════════");
    console.log("[PROTECT] Starting multi-layer source protection...");
    console.log("[PROTECT] ═══════════════════════════════════════\n");

    // 1. Protect bot source code (obfuscation + bytecode)
    const botDistDir = path.join(botDir, "dist");
    if (fs.existsSync(botDistDir)) {
        console.log("[PROTECT] Layer 1-2: Obfuscation + Bytecode compilation...");
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

    // Find the correct .node file for this platform
    const platform = process.platform;
    const arch = process.arch;
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

        // Copy the .node file
        const nodeFileName = path.basename(nativeNodeFile);
        fs.copyFileSync(nativeNodeFile, path.join(destNativeDir, nodeFileName));

        // Copy the index.js loader
        const indexJs = path.join(nativeDir, "index.js");
        if (fs.existsSync(indexJs)) {
            fs.copyFileSync(indexJs, path.join(destNativeDir, "index.js"));
        }

        // Copy index.d.ts for type hints
        const indexDts = path.join(nativeDir, "index.d.ts");
        if (fs.existsSync(indexDts)) {
            fs.copyFileSync(indexDts, path.join(destNativeDir, "index.d.ts"));
        }

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
