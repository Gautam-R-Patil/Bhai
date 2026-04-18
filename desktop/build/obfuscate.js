// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Pre-bytecode JavaScript obfuscation script
// Transforms readable code into complex, hard-to-understand code

const JavaScriptObfuscator = require("javascript-obfuscator");
const fs = require("fs");
const path = require("path");

// Obfuscation settings - aggressive protection
const OBFUSCATION_OPTIONS = {
    // Control flow
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.75,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.4,

    // String protection
    stringArray: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayThreshold: 0.75,
    stringArrayIndexShift: true,
    stringArrayWrappersCount: 2,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 4,
    stringArrayWrappersType: "function",
    stringArrayEncoding: ["base64", "rc4"],

    // Identifier renaming
    identifierNamesGenerator: "hexadecimal",
    renameGlobals: false, // Keep exports accessible
    renameProperties: false, // Keep object properties

    // Anti-debugging
    debugProtection: true,
    debugProtectionInterval: 2000,
    disableConsoleOutput: false, // Keep console for bot logging

    // Self-defending
    selfDefending: true,

    // Misc
    numbersToExpressions: true,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 10,
    transformObjectKeys: true,
    unicodeEscapeSequence: false,

    // Target Node.js
    target: "node",

    // Ignore certain patterns
    reservedNames: ["^exports$", "^module$", "^require$", "^__dirname$", "^__filename$"],
    reservedStrings: [],

    // Source map (disabled for production)
    sourceMap: false,
};

// Light obfuscation for performance-critical files
const LIGHT_OBFUSCATION_OPTIONS = {
    compact: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    stringArray: true,
    stringArrayRotate: true,
    stringArrayThreshold: 0.5,
    stringArrayEncoding: ["base64"],
    identifierNamesGenerator: "hexadecimal",
    renameGlobals: false,
    renameProperties: false,
    debugProtection: false,
    selfDefending: false,
    target: "node",
    sourceMap: false,
};

// Files to skip obfuscation (native modules, binaries)
const SKIP_PATTERNS = [
    /\.node$/,
    /\.json$/,
    /\.map$/,
    /\.d\.ts$/,
    /node_modules/,
    /package\.json$/,
    /package-lock\.json$/,
];

// Files that need light obfuscation (performance sensitive)
const LIGHT_OBFUSCATION_PATTERNS = [
    /vector-index\.js$/,
    /sqlite\.js$/,
    /embedding\.js$/,
];

function shouldSkip(filePath) {
    return SKIP_PATTERNS.some(pattern => pattern.test(filePath));
}

function useLightObfuscation(filePath) {
    return LIGHT_OBFUSCATION_PATTERNS.some(pattern => pattern.test(filePath));
}

function obfuscateFile(filePath, outputPath) {
    try {
        const code = fs.readFileSync(filePath, "utf8");

        // Skip if too small or already obfuscated
        if (code.length < 100) {
            fs.copyFileSync(filePath, outputPath);
            return { skipped: true, reason: "too small" };
        }

        // Check for already obfuscated markers
        if (code.includes("_0x") && code.includes("['\\x")) {
            fs.copyFileSync(filePath, outputPath);
            return { skipped: true, reason: "already obfuscated" };
        }

        const options = useLightObfuscation(filePath)
            ? LIGHT_OBFUSCATION_OPTIONS
            : OBFUSCATION_OPTIONS;

        const obfuscated = JavaScriptObfuscator.obfuscate(code, options);

        // Add protection header
        const header = `// Protected by XAGI Labs © 2024-2026\n// Unauthorized access prohibited\n`;
        const protectedCode = header + obfuscated.getObfuscatedCode();

        fs.writeFileSync(outputPath, protectedCode);

        return {
            success: true,
            originalSize: code.length,
            obfuscatedSize: protectedCode.length,
            lightMode: useLightObfuscation(filePath)
        };
    } catch (error) {
        // If obfuscation fails, copy original file
        console.error(`[OBFUSCATE] Error processing ${filePath}:`, error.message);
        fs.copyFileSync(filePath, outputPath);
        return { error: error.message };
    }
}

function obfuscateDirectory(inputDir, outputDir) {
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const stats = { total: 0, obfuscated: 0, skipped: 0, errors: 0 };

    function processDir(currentInput, currentOutput) {
        const entries = fs.readdirSync(currentInput, { withFileTypes: true });

        for (const entry of entries) {
            const inputPath = path.join(currentInput, entry.name);
            const outputPath = path.join(currentOutput, entry.name);

            if (entry.isDirectory()) {
                fs.mkdirSync(outputPath, { recursive: true });
                processDir(inputPath, outputPath);
            } else if (entry.name.endsWith(".js") && !shouldSkip(inputPath)) {
                stats.total++;
                const result = obfuscateFile(inputPath, outputPath);

                if (result.success) {
                    stats.obfuscated++;
                    console.log(`[OBFUSCATE] ✓ ${entry.name} (${result.lightMode ? 'light' : 'full'}: ${result.originalSize} → ${result.obfuscatedSize})`);
                } else if (result.skipped) {
                    stats.skipped++;
                    console.log(`[OBFUSCATE] - ${entry.name} (${result.reason})`);
                } else {
                    stats.errors++;
                    console.log(`[OBFUSCATE] ✗ ${entry.name} (${result.error})`);
                }
            } else {
                // Copy non-JS files as-is
                fs.copyFileSync(inputPath, outputPath);
            }
        }
    }

    processDir(inputDir, outputDir);
    return stats;
}

// Main execution
if (require.main === module) {
    const args = process.argv.slice(2);

    if (args.length < 2) {
        console.log("Usage: node obfuscate.js <input-dir> <output-dir>");
        console.log("Example: node obfuscate.js ../dist ../dist-obfuscated");
        process.exit(1);
    }

    const inputDir = path.resolve(args[0]);
    const outputDir = path.resolve(args[1]);

    console.log(`[OBFUSCATE] Input: ${inputDir}`);
    console.log(`[OBFUSCATE] Output: ${outputDir}`);
    console.log("[OBFUSCATE] Starting obfuscation...\n");

    const stats = obfuscateDirectory(inputDir, outputDir);

    console.log("\n[OBFUSCATE] Complete!");
    console.log(`  Total files: ${stats.total}`);
    console.log(`  Obfuscated: ${stats.obfuscated}`);
    console.log(`  Skipped: ${stats.skipped}`);
    console.log(`  Errors: ${stats.errors}`);
}

module.exports = { obfuscateFile, obfuscateDirectory, OBFUSCATION_OPTIONS };
