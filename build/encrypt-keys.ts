/**
 * Build-time API Key Encryption
 *
 * This script runs at build time to encrypt bundled API keys (OpenRouter, Convex).
 * The encrypted keys are written to dist/ and decrypted at runtime.
 *
 * This provides obfuscation (not perfect security, but better than plaintext).
 *
 * Usage: npx tsx build/encrypt-keys.ts
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Keys to encrypt — ONLY public URLs allowed as fallbacks.
// API keys and deploy keys MUST come from environment variables.
// NEVER hardcode secrets here — they end up in the shipped app binary.
if (process.env.CONVEX_DEPLOY_KEY) {
    console.error("ERROR: CONVEX_DEPLOY_KEY must NOT be bundled into client code. Remove it from the build environment.");
    process.exit(1);
}

const BUNDLED_KEYS: Record<string, string> = {
    // Convex URL is public (it's just a cloud endpoint identifier)
    convex_url: process.env.CONVEX_URL || "https://avid-finch-726.convex.cloud",
};

// Generate a unique key for this build (derived from build timestamp + random)
function generateBuildKey(): Buffer {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(16).toString("hex");
    // Derive a 32-byte key using SHA-256
    return crypto.createHash("sha256").update(`${timestamp}:${random}`).digest();
}

// Encrypt data with AES-256-GCM
function encrypt(data: string, key: Buffer): { encrypted: string; iv: string; authTag: string } {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

    let encrypted = cipher.update(data, "utf8", "base64");
    encrypted += cipher.final("base64");

    return {
        encrypted,
        iv: iv.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
    };
}

// Obfuscate the key (basic string manipulation to make it harder to find)
function obfuscateKey(key: Buffer): string {
    // Split key into chunks and encode differently
    const hex = key.toString("hex");
    const chunks: string[] = [];

    for (let i = 0; i < hex.length; i += 8) {
        const chunk = hex.slice(i, i + 8);
        // Alternate between different encoding methods
        if (i % 16 === 0) {
            chunks.push(Buffer.from(chunk, "hex").toString("base64"));
        } else {
            chunks.push(chunk.split("").reverse().join(""));
        }
    }

    return JSON.stringify(chunks);
}

// Generate the deobfuscation code (to be included in runtime)
// NOTE: Output must be plain JavaScript (no TypeScript annotations) so the obfuscator can process it.
function generateDeobfuscator(obfuscatedKey: string): string {
    return `
// Auto-generated key deobfuscator - do not edit
const _c = ${obfuscatedKey};
export function _dk() {
    const h = [];
    for (let i = 0; i < _c.length; i++) {
        if (i % 2 === 0) {
            h.push(Buffer.from(_c[i], "base64").toString("hex"));
        } else {
            h.push(_c[i].split("").reverse().join(""));
        }
    }
    return Buffer.from(h.join(""), "hex");
}
`.trim();
}

async function main() {
    console.log("🔐 Encrypting bundled API keys...");

    const distDir = path.resolve("dist/config");
    fs.mkdirSync(distDir, { recursive: true });

    // Generate build key
    const buildKey = generateBuildKey();
    console.log("  ✓ Generated unique build key");

    // Encrypt the keys
    const keysJson = JSON.stringify(BUNDLED_KEYS);
    const encryptedData = encrypt(keysJson, buildKey);
    console.log("  ✓ Encrypted API keys");

    // Write encrypted keys file
    const encryptedFile = {
        v: 1, // version
        d: encryptedData.encrypted,
        i: encryptedData.iv,
        t: encryptedData.authTag,
    };

    fs.writeFileSync(
        path.join(distDir, "keys.enc.json"),
        JSON.stringify(encryptedFile),
        "utf8"
    );
    console.log("  ✓ Wrote dist/config/keys.enc.json");

    // Write obfuscated key
    const obfuscatedKey = obfuscateKey(buildKey);
    const deobfuscatorCode = generateDeobfuscator(obfuscatedKey);

    fs.writeFileSync(
        path.join(distDir, "k.js"),
        deobfuscatorCode,
        "utf8"
    );
    console.log("  ✓ Wrote dist/config/k.js");

    console.log("✅ API key encryption complete");
}

main().catch(err => {
    console.error("❌ Key encryption failed:", err.message);
    process.exit(1);
});
