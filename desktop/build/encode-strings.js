// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Sensitive String Encoding Script
// Encodes prompts, skills, and other sensitive text files

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Encoding key (derived from build timestamp for uniqueness)
const BUILD_KEY = crypto.createHash("sha256")
    .update(Date.now().toString() + "ATLAS_PROTECTED")
    .digest();

/**
 * XOR encode/decode a buffer with the build key
 */
function xorEncode(buffer) {
    const result = Buffer.alloc(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
        result[i] = buffer[i] ^ BUILD_KEY[i % BUILD_KEY.length];
    }
    return result;
}

/**
 * Encode a string file to protected format
 */
function encodeFile(inputPath, outputPath) {
    const content = fs.readFileSync(inputPath);

    // Step 1: XOR with key
    const xored = xorEncode(content);

    // Step 2: Base64 encode
    const encoded = xored.toString("base64");

    // Step 3: Shuffle in chunks
    const chunks = [];
    const chunkSize = 64;
    for (let i = 0; i < encoded.length; i += chunkSize) {
        chunks.push(encoded.slice(i, i + chunkSize));
    }

    // Interleave chunks with random order stored in header
    const order = Array.from({ length: chunks.length }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
    }

    const shuffled = order.map(i => chunks[i]).join("");

    // Create protected file format
    const protected = {
        v: 1, // Version
        o: order.join(","), // Chunk order
        c: chunkSize,
        d: shuffled,
        h: crypto.createHash("md5").update(content).digest("hex"), // Integrity hash
    };

    fs.writeFileSync(outputPath, JSON.stringify(protected));

    return {
        originalSize: content.length,
        encodedSize: JSON.stringify(protected).length,
    };
}

/**
 * Generate decoder module for runtime
 */
function generateDecoder(buildKey) {
    const keyHex = buildKey.toString("hex");

    // Split key into parts for obfuscation
    const keyParts = [];
    for (let i = 0; i < keyHex.length; i += 8) {
        keyParts.push(keyHex.slice(i, i + 8));
    }

    return `// Auto-generated decoder - © XAGI Labs
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Reconstructed key (obfuscated)
const _k = [${keyParts.map(p => `'${p}'`).join(",")}].join('');
const _key = Buffer.from(_k, 'hex');

function _xor(buf) {
    const r = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) {
        r[i] = buf[i] ^ _key[i % _key.length];
    }
    return r;
}

function decodeProtectedFile(filePath) {
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        if (data.v !== 1) throw new Error('Unsupported version');

        // Reconstruct chunk order
        const order = data.o.split(',').map(Number);
        const chunks = [];
        const chunkSize = data.c;

        // Extract shuffled chunks
        for (let i = 0; i < order.length; i++) {
            chunks.push(data.d.slice(i * chunkSize, (i + 1) * chunkSize));
        }

        // Unshuffle
        const unshuffled = new Array(order.length);
        for (let i = 0; i < order.length; i++) {
            unshuffled[order[i]] = chunks[i];
        }

        // Decode
        const base64 = unshuffled.join('');
        const xored = Buffer.from(base64, 'base64');
        const content = _xor(xored);

        // Verify integrity
        const hash = crypto.createHash('md5').update(content).digest('hex');
        if (hash !== data.h) {
            throw new Error('Integrity check failed');
        }

        return content.toString('utf8');
    } catch (err) {
        console.error('[DECODE] Failed to decode:', err.message);
        return null;
    }
}

function loadProtectedPrompt(name) {
    const promptPath = path.join(__dirname, 'prompts', name + '.protected');
    if (fs.existsSync(promptPath)) {
        return decodeProtectedFile(promptPath);
    }
    // Fallback to unprotected (dev mode)
    const fallbackPath = path.join(__dirname, 'prompts', name + '.md');
    if (fs.existsSync(fallbackPath)) {
        return fs.readFileSync(fallbackPath, 'utf8');
    }
    return null;
}

function loadProtectedSkill(name) {
    const skillPath = path.join(__dirname, 'skills', name + '.protected');
    if (fs.existsSync(skillPath)) {
        return decodeProtectedFile(skillPath);
    }
    // Fallback to unprotected (dev mode)
    const fallbackPath = path.join(__dirname, 'skills', name + '.md');
    if (fs.existsSync(fallbackPath)) {
        return fs.readFileSync(fallbackPath, 'utf8');
    }
    return null;
}

module.exports = {
    decodeProtectedFile,
    loadProtectedPrompt,
    loadProtectedSkill,
};
`;
}

/**
 * Encode all files in a directory
 */
function encodeDirectory(inputDir, outputDir, extension = ".md") {
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const stats = { total: 0, encoded: 0, errors: 0 };

    function processDir(currentInput, currentOutput) {
        if (!fs.existsSync(currentInput)) return;

        const entries = fs.readdirSync(currentInput, { withFileTypes: true });

        for (const entry of entries) {
            const inputPath = path.join(currentInput, entry.name);
            const outputPath = path.join(currentOutput, entry.name);

            if (entry.isDirectory()) {
                fs.mkdirSync(outputPath, { recursive: true });
                processDir(inputPath, outputPath);
            } else if (entry.name.endsWith(extension)) {
                stats.total++;

                try {
                    const protectedPath = outputPath.replace(extension, ".protected");
                    const result = encodeFile(inputPath, protectedPath);
                    stats.encoded++;
                    console.log(`[ENCODE] ✓ ${entry.name} (${result.originalSize} → ${result.encodedSize})`);
                } catch (error) {
                    stats.errors++;
                    console.log(`[ENCODE] ✗ ${entry.name}: ${error.message}`);
                    // Copy original as fallback
                    fs.copyFileSync(inputPath, outputPath);
                }
            } else {
                // Copy other files
                fs.copyFileSync(inputPath, outputPath);
            }
        }
    }

    processDir(inputDir, outputDir);
    return stats;
}

/**
 * Main function to encode prompts and skills
 */
function encodeProjectStrings(projectRoot, outputRoot) {
    console.log("[ENCODE] Encoding sensitive strings...\n");

    const results = {
        prompts: { total: 0, encoded: 0, errors: 0 },
        skills: { total: 0, encoded: 0, errors: 0 },
    };

    // Encode prompts
    const promptsInput = path.join(projectRoot, "prompts");
    const promptsOutput = path.join(outputRoot, "prompts");
    if (fs.existsSync(promptsInput)) {
        console.log("[ENCODE] Processing prompts...");
        results.prompts = encodeDirectory(promptsInput, promptsOutput, ".md");
    }

    // Encode skills
    const skillsInput = path.join(projectRoot, "skills");
    const skillsOutput = path.join(outputRoot, "skills");
    if (fs.existsSync(skillsInput)) {
        console.log("\n[ENCODE] Processing skills...");
        results.skills = encodeDirectory(skillsInput, skillsOutput, ".md");
    }

    // Generate decoder
    const decoderPath = path.join(outputRoot, "decoder.js");
    fs.writeFileSync(decoderPath, generateDecoder(BUILD_KEY));
    console.log("\n[ENCODE] Generated decoder module");

    return results;
}

// Main execution
if (require.main === module) {
    const args = process.argv.slice(2);

    if (args.length < 2) {
        console.log("Usage: node encode-strings.js <project-root> <output-root>");
        console.log("Example: node encode-strings.js ../ ../dist-protected");
        process.exit(1);
    }

    const projectRoot = path.resolve(args[0]);
    const outputRoot = path.resolve(args[1]);

    console.log(`[ENCODE] Project: ${projectRoot}`);
    console.log(`[ENCODE] Output: ${outputRoot}\n`);

    const results = encodeProjectStrings(projectRoot, outputRoot);

    console.log("\n[ENCODE] Complete!");
    console.log(`  Prompts: ${results.prompts.encoded}/${results.prompts.total} encoded`);
    console.log(`  Skills: ${results.skills.encoded}/${results.skills.total} encoded`);
}

module.exports = {
    encodeFile,
    encodeDirectory,
    encodeProjectStrings,
    generateDecoder,
    xorEncode,
    BUILD_KEY,
};
