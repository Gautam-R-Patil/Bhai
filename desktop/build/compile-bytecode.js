// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// V8 Bytecode Compilation Script
// Compiles JavaScript to V8 bytecode that cannot be decompiled

const bytenode = require("bytenode");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// Files to skip bytecode compilation (keep as JS)
const SKIP_PATTERNS = [
    /\.node$/,
    /\.json$/,
    /\.jsc$/,
    /node_modules/,
    /package\.json$/,
    /package-lock\.json$/,
];

// Entry point files that need special handling
const ENTRY_POINTS = [
    "index.js",
    "main.js",
];

function shouldSkip(filePath) {
    return SKIP_PATTERNS.some(pattern => pattern.test(filePath));
}

function isEntryPoint(fileName) {
    return ENTRY_POINTS.includes(fileName);
}

/**
 * Compile a JavaScript file to V8 bytecode
 */
async function compileFile(inputPath, outputPath) {
    try {
        const code = fs.readFileSync(inputPath, "utf8");

        // Skip if already bytecode or too small
        if (code.length < 50) {
            return { skipped: true, reason: "too small" };
        }

        // Compile to bytecode
        const jscPath = outputPath.replace(/\.js$/, ".jsc");

        await bytenode.compileFile({
            filename: inputPath,
            output: jscPath,
            compileAsModule: true,
            electron: true, // Compile for Electron's V8
        });

        // Create loader stub
        const loaderCode = `// Bytecode loader - © XAGI Labs
'use strict';
require('bytenode');
module.exports = require('${path.basename(jscPath)}');
`;
        fs.writeFileSync(outputPath, loaderCode);

        const originalSize = fs.statSync(inputPath).size;
        const bytecodeSize = fs.statSync(jscPath).size;

        return {
            success: true,
            originalSize,
            bytecodeSize,
            jscPath,
        };
    } catch (error) {
        return { error: error.message };
    }
}

/**
 * Create entry point wrapper for bytecode
 */
function createEntryWrapper(originalPath, jscPath) {
    const wrapperCode = `// A.T.L.A.S Entry Point - © XAGI Labs
// Protected with V8 bytecode compilation
'use strict';

// Load bytenode runtime
require('bytenode');

// Bytecode integrity check
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const jscFile = path.join(__dirname, '${path.basename(jscPath)}');
if (!fs.existsSync(jscFile)) {
    console.error('[SECURITY] Bytecode file missing. Application may be tampered.');
    process.exit(1);
}

// Load and execute bytecode
try {
    module.exports = require(jscFile);
} catch (err) {
    console.error('[SECURITY] Failed to load bytecode:', err.message);
    process.exit(1);
}
`;
    fs.writeFileSync(originalPath, wrapperCode);
}

/**
 * Compile entire directory to bytecode
 */
async function compileDirectory(inputDir, outputDir) {
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const stats = { total: 0, compiled: 0, skipped: 0, errors: 0 };

    async function processDir(currentInput, currentOutput) {
        const entries = fs.readdirSync(currentInput, { withFileTypes: true });

        for (const entry of entries) {
            const inputPath = path.join(currentInput, entry.name);
            const outputPath = path.join(currentOutput, entry.name);

            if (entry.isDirectory()) {
                fs.mkdirSync(outputPath, { recursive: true });
                await processDir(inputPath, outputPath);
            } else if (entry.name.endsWith(".js") && !shouldSkip(inputPath)) {
                stats.total++;

                // Copy file first
                fs.copyFileSync(inputPath, outputPath);

                const result = await compileFile(outputPath, outputPath);

                if (result.success) {
                    stats.compiled++;
                    console.log(`[BYTECODE] ✓ ${entry.name} (${result.originalSize} → ${result.bytecodeSize} bytes)`);

                    // Create special wrapper for entry points
                    if (isEntryPoint(entry.name)) {
                        createEntryWrapper(outputPath, result.jscPath);
                        console.log(`[BYTECODE]   ↳ Created entry wrapper`);
                    }
                } else if (result.skipped) {
                    stats.skipped++;
                    console.log(`[BYTECODE] - ${entry.name} (${result.reason})`);
                } else {
                    stats.errors++;
                    console.log(`[BYTECODE] ✗ ${entry.name} (${result.error})`);
                }
            } else {
                // Copy non-JS files as-is
                if (fs.existsSync(inputPath)) {
                    fs.copyFileSync(inputPath, outputPath);
                }
            }
        }
    }

    await processDir(inputDir, outputDir);
    return stats;
}

/**
 * Simple bytecode compilation without full directory processing
 * For use during electron-builder afterPack
 */
async function compileFilesInPlace(directory) {
    const stats = { total: 0, compiled: 0, errors: 0 };

    async function processDir(dir) {
        if (!fs.existsSync(dir)) return;

        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory() && !entry.name.includes("node_modules")) {
                await processDir(fullPath);
            } else if (entry.name.endsWith(".js") && !shouldSkip(fullPath)) {
                stats.total++;

                try {
                    const jscPath = fullPath.replace(/\.js$/, ".jsc");

                    // Compile to bytecode
                    await bytenode.compileFile({
                        filename: fullPath,
                        output: jscPath,
                        compileAsModule: true,
                        electron: true,
                    });

                    // Replace original with loader
                    const loaderCode = `'use strict';require('bytenode');module.exports=require('./${entry.name.replace('.js', '.jsc')}');`;
                    fs.writeFileSync(fullPath, loaderCode);

                    stats.compiled++;
                    console.log(`[BYTECODE] ✓ ${entry.name}`);
                } catch (error) {
                    stats.errors++;
                    console.log(`[BYTECODE] ✗ ${entry.name}: ${error.message}`);
                }
            }
        }
    }

    await processDir(directory);
    return stats;
}

// Main execution
if (require.main === module) {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log("Usage:");
        console.log("  node compile-bytecode.js <input-dir> <output-dir>  # Full compile");
        console.log("  node compile-bytecode.js --in-place <directory>    # In-place compile");
        process.exit(1);
    }

    (async () => {
        if (args[0] === "--in-place") {
            const dir = path.resolve(args[1] || ".");
            console.log(`[BYTECODE] Compiling in-place: ${dir}`);
            const stats = await compileFilesInPlace(dir);
            console.log(`\n[BYTECODE] Complete: ${stats.compiled}/${stats.total} compiled, ${stats.errors} errors`);
        } else {
            const inputDir = path.resolve(args[0]);
            const outputDir = path.resolve(args[1]);

            console.log(`[BYTECODE] Input: ${inputDir}`);
            console.log(`[BYTECODE] Output: ${outputDir}`);
            console.log("[BYTECODE] Starting compilation...\n");

            const stats = await compileDirectory(inputDir, outputDir);

            console.log("\n[BYTECODE] Complete!");
            console.log(`  Total files: ${stats.total}`);
            console.log(`  Compiled: ${stats.compiled}`);
            console.log(`  Skipped: ${stats.skipped}`);
            console.log(`  Errors: ${stats.errors}`);
        }
    })();
}

module.exports = { compileFile, compileDirectory, compileFilesInPlace };
