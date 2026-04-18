// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Protected File Loader ─────────────────────────
// Loads XOR-encoded .protected files at runtime.
// Falls back to unprotected files in dev mode.

import fs from "node:fs";
import path from "node:path";

// Must match the key used in desktop/build/protect-source.js
const PROTECTION_KEY = Buffer.from("ATLAS_PROTECTED_2026");

/**
 * Decode a XOR-encoded base64 string
 */
function decodeProtectedString(encodedBase64: string): string | null {
    try {
        const encoded = Buffer.from(encodedBase64, "base64");
        const decoded = Buffer.alloc(encoded.length);
        for (let i = 0; i < encoded.length; i++) {
            decoded[i] = encoded[i] ^ PROTECTION_KEY[i % PROTECTION_KEY.length];
        }
        return decoded.toString("utf8");
    } catch {
        return null;
    }
}

/**
 * Load a potentially protected file.
 * Checks for .protected version first, falls back to original.
 */
export function loadProtectedFile(filePath: string): string | null {
    // Check for protected version first
    const protectedPath = filePath + ".protected";
    if (fs.existsSync(protectedPath)) {
        try {
            const encoded = fs.readFileSync(protectedPath, "utf8");
            const decoded = decodeProtectedString(encoded);
            if (decoded) {
                return decoded;
            }
        } catch {
            // Fall through to unprotected
        }
    }

    // Fall back to unprotected (dev mode)
    if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, "utf8");
    }

    return null;
}

/**
 * Load a prompt file by name from the prompts directory.
 * Handles both protected and unprotected versions.
 */
export function loadPromptFile(promptsDir: string, filename: string): string {
    const basePath = path.join(promptsDir, filename);
    const content = loadProtectedFile(basePath);
    if (content) {
        return content.trim();
    }
    console.warn(`⚠️  Prompt file not found: ${basePath}`);
    return "";
}

/**
 * Load a skill file. Handles both protected and unprotected versions.
 */
export function loadSkillFile(filePath: string): string | null {
    return loadProtectedFile(filePath);
}

/**
 * Check if a file exists (either protected or unprotected version)
 */
export function protectedFileExists(filePath: string): boolean {
    const protectedPath = filePath + ".protected";
    return fs.existsSync(protectedPath) || fs.existsSync(filePath);
}

/**
 * List files in a directory, accounting for .protected versions
 * Returns base names without the .protected extension
 */
export function listProtectedDir(dir: string, extension: string): string[] {
    if (!fs.existsSync(dir)) return [];

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = new Set<string>();

    for (const entry of entries) {
        if (entry.isFile()) {
            if (entry.name.endsWith(".protected")) {
                // Remove .protected suffix and add the base file with original extension
                const baseName = entry.name.replace(".protected", "");
                if (baseName.endsWith(extension)) {
                    files.add(baseName);
                }
            } else if (entry.name.endsWith(extension)) {
                files.add(entry.name);
            }
        }
    }

    return Array.from(files);
}
