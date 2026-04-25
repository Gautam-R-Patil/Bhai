// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Bundles the entire bot dist/ into a single bot-bundle.mjs file so that
// individual source file names are never shipped in the production app.
// Called from protect-source.js afterPack hook or directly via:
//   node desktop/build/bundle.mjs [inputDir] [outputFile]

import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Bundle a compiled dist/ directory into one opaque .mjs file.
 * All npm package imports stay external (node_modules is NOT inlined).
 * Only relative application imports (./*, ../*) are bundled.
 *
 * @param {string} distDir   Path to the compiled bot dist/ directory
 * @param {string} outFile   Path for the output bundle file
 */
export async function bundleBot(distDir, outFile) {
    const entry = path.join(distDir, "index.js");
    if (!fs.existsSync(entry)) throw new Error(`Entry not found: ${entry}`);

    fs.mkdirSync(path.dirname(outFile), { recursive: true });

    const result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        platform: "node",
        format: "esm",
        target: ["node20"],

        // Keep all npm packages external — only inline application source files.
        // This hides our internal file names without complexity of bundling native deps.
        packages: "external",

        outfile: outFile,

        // Remove legal comments that can reveal internal paths or library names.
        legalComments: "none",

        // Suppress minification — obfuscator runs next and handles that.
        minify: false,

        // Remap dynamic imports of the native binary loader to a path relative
        // to the bundle output location (not the original source file's depth).
        plugins: [
            {
                name: "native-remap",
                setup(build) {
                    // Any import that resolves through native/index.js (the NAPI binary
                    // loader) must stay external and path must be ./native/index.js
                    // relative to the bundle file, not relative to each source file.
                    build.onResolve(
                        { filter: /[/\\]native[/\\]index\.js$|^\.{1,2}[/\\](\.\.\/)*native[/\\]index\.js$/ },
                        () => ({ path: "./native/index.js", external: true }),
                    );
                },
            },
        ],
    });

    if (result.errors.length > 0) {
        throw new Error(`esbuild errors: ${result.errors.map((e) => e.text).join(", ")}`);
    }

    const kb = Math.round(fs.statSync(outFile).size / 1024);
    console.log(`[BUNDLE] ✓ ${path.basename(outFile)} — ${kb} KB`);
    return outFile;
}

// ── Standalone invocation ───────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
    const rootDir = path.resolve(__dirname, "../..");
    const distDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(rootDir, "dist");
    const outFile = process.argv[3]
        ? path.resolve(process.argv[3])
        : path.join(rootDir, "dist-bundle", "bot-bundle.mjs");

    console.log(`[BUNDLE] Input:  ${distDir}`);
    console.log(`[BUNDLE] Output: ${outFile}`);
    await bundleBot(distDir, outFile);
}
