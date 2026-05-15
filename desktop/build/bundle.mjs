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

    // We have TWO files both named `native/index.js`:
    //   • <rootForBundle>/native/index.js — the NAPI-generated CJS loader (loads .node binary)
    //   • src/native/index.ts → dist/native/index.js — our TS wrapper with named ESM exports
    // The TS wrapper uses createRequire to load the NAPI loader at runtime. Static
    // imports like `import { nativeContainsSecrets } from "../native/index.js"` from
    // src/security/secrets-sanitizer.ts target the WRAPPER and need to be bundled inline
    // so their named ESM exports survive. Dynamic `import("../native/index.js")` from
    // src/index.ts targets the root NAPI loader directly (for addProtectedPath /
    // monitorLoadRules which are NAPI-only) and must stay external.
    //
    // The fix: resolve the import path against the importer manually. If it lands on
    // the root NAPI loader, externalize. Otherwise let esbuild bundle the TS wrapper.
    // The root NAPI loader is always at `<distDir>/../native/index.js` — true for
    // both repo dev-mode (<repo>/dist + <repo>/native) and afterPack mode
    // (<app>/Contents/Resources/bot/dist + <app>/Contents/Resources/bot/native).
    const rootNativeIndex = path.resolve(distDir, "..", "native", "index.js");

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

        plugins: [
            {
                name: "native-remap",
                setup(build) {
                    build.onResolve({ filter: /native[/\\]index\.js$/ }, (args) => {
                        if (!args.importer) return null;
                        const resolved = path.resolve(path.dirname(args.importer), args.path);
                        if (resolved === rootNativeIndex) {
                            // Root NAPI CJS loader — externalize with a path relative to the bundle.
                            return { path: "./native/index.js", external: true };
                        }
                        // dist/native/index.js TS wrapper or anything else — let esbuild resolve normally.
                        return null;
                    });
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
