// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Self-Healing Module — Auto-detect & fix runtime errors ──
// When the agent encounters errors (missing deps, broken installs, etc.),
// this module attempts to diagnose and fix the issue automatically
// before falling back to error messages.

import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { ErrorCategory } from "./error-types.js";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

// ── Heal Attempts Cache (avoid re-trying known failures) ──

const healAttempted = new Map<string, { success: boolean; timestamp: number }>();
const HEAL_COOLDOWN = 5 * 60 * 1000; // Don't retry same fix within 5 min

// ── Known System Dependencies ────────────────────

interface DepFix {
    /** Regex to detect the missing dependency from error messages */
    patterns: RegExp[];
    /** Binary name to check if installed */
    binary: string;
    /** Install commands per platform: [command, args[]] */
    install: {
        darwin?: [string, string[]][]; // macOS — try in order
        linux?: [string, string[]][]; // Linux
        win32?: [string, string[]][]; // Windows
    };
    /** npm package to install if it's a Node module */
    npmPackage?: string;
}

const KNOWN_DEPS: DepFix[] = [
    {
        binary: "sox",
        patterns: [/sox/i, /\brec\b.*ENOENT/i, /\bplay\b.*ENOENT/i, /spawn rec/i, /spawn play/i],
        install: {
            darwin: [["brew", ["install", "sox"]]],
            linux: [
                ["sudo", ["apt-get", "install", "-y", "sox"]],
                ["sudo", ["dnf", "install", "-y", "sox"]],
            ],
            win32: [["choco", ["install", "sox", "-y"]]],
        },
    },
    {
        binary: "ffmpeg",
        patterns: [/ffmpeg/i, /ffprobe/i, /spawn ffmpeg/i, /spawn ffprobe/i],
        install: {
            darwin: [["brew", ["install", "ffmpeg"]]],
            linux: [
                ["sudo", ["apt-get", "install", "-y", "ffmpeg"]],
                ["sudo", ["dnf", "install", "-y", "ffmpeg"]],
            ],
            win32: [["choco", ["install", "ffmpeg", "-y"]]],
        },
    },
    {
        binary: "tesseract",
        patterns: [/tesseract.*not found/i, /spawn tesseract/i, /ENOENT.*tesseract/i, /No OCR tool available/i],
        install: {
            linux: [
                ["sudo", ["apt-get", "install", "-y", "tesseract-ocr"]],
                ["sudo", ["dnf", "install", "-y", "tesseract"]],
                ["sudo", ["pacman", "-S", "--noconfirm", "tesseract"]],
            ],
        },
    },
    {
        binary: "brightness",
        patterns: [/brightness.*not found/i, /spawn brightness/i, /Install.*brightness/i],
        install: {
            darwin: [["brew", ["install", "brightness"]]],
        },
    },
    {
        binary: "blueutil",
        patterns: [/blueutil/i, /spawn blueutil/i],
        install: {
            darwin: [["brew", ["install", "blueutil"]]],
        },
    },
];

// ── Main Self-Heal Function ──────────────────────

/**
 * Attempt to automatically fix an error.
 * Returns true if the fix was applied and the operation should be retried.
 * Returns false if the error couldn't be auto-fixed.
 */
export async function attemptSelfHeal(
    errorMessage: string,
    errorCategory?: ErrorCategory,
): Promise<{ fixed: boolean; action: string }> {
    // Only attempt for dependency errors, ENOENT/spawn errors, or module errors
    const isDependencyError =
        errorCategory === ErrorCategory.DependencyMissing ||
        /ENOENT.*spawn/i.test(errorMessage) ||
        /spawn.*ENOENT/i.test(errorMessage) ||
        /command not found/i.test(errorMessage) ||
        /not recognized as.*command/i.test(errorMessage) ||
        /Cannot find module/i.test(errorMessage) ||
        /MODULE_NOT_FOUND/i.test(errorMessage);

    if (!isDependencyError) {
        return { fixed: false, action: "not_applicable" };
    }

    // ── Check known system dependencies ──
    for (const dep of KNOWN_DEPS) {
        const matches = dep.patterns.some((p) => p.test(errorMessage));
        if (!matches) continue;

        // Check cooldown
        const cacheKey = `sys:${dep.binary}`;
        const cached = healAttempted.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < HEAL_COOLDOWN) {
            return { fixed: cached.success, action: cached.success ? "already_fixed" : "cooldown" };
        }

        // Check if already installed
        if (await binaryExists(dep.binary)) {
            healAttempted.set(cacheKey, { success: true, timestamp: Date.now() });
            return { fixed: true, action: "already_present" };
        }

        // Try installing
        console.log(`[SELF-HEAL] Detected missing dependency: ${dep.binary} — attempting auto-install...`);
        const installed = await installSystemDep(dep);
        healAttempted.set(cacheKey, { success: installed, timestamp: Date.now() });

        if (installed) {
            console.log(`[SELF-HEAL] Successfully installed ${dep.binary}`);
            return { fixed: true, action: `installed:${dep.binary}` };
        } else {
            console.warn(`[SELF-HEAL] Could not auto-install ${dep.binary}`);
            return { fixed: false, action: `install_failed:${dep.binary}` };
        }
    }

    // ── Check npm module errors ──
    const npmMatch = errorMessage.match(/Cannot find module ['"]([^'"]+)['"]/);
    if (npmMatch) {
        const moduleName = npmMatch[1];
        // Only auto-install if it looks like a top-level package (not a path)
        if (!moduleName.startsWith(".") && !moduleName.startsWith("/")) {
            const cacheKey = `npm:${moduleName}`;
            const cached = healAttempted.get(cacheKey);
            if (cached && Date.now() - cached.timestamp < HEAL_COOLDOWN) {
                return { fixed: cached.success, action: cached.success ? "already_fixed" : "cooldown" };
            }

            console.log(`[SELF-HEAL] Missing npm module: ${moduleName} — attempting install...`);
            const installed = await installNpmPackage(moduleName);
            healAttempted.set(cacheKey, { success: installed, timestamp: Date.now() });

            if (installed) {
                console.log(`[SELF-HEAL] Successfully installed npm package: ${moduleName}`);
                return { fixed: true, action: `npm_installed:${moduleName}` };
            }
        }
    }

    return { fixed: false, action: "unknown_dependency" };
}

// ── System Dependency Installer ──────────────────

async function installSystemDep(dep: DepFix): Promise<boolean> {
    const platform = process.platform as "darwin" | "linux" | "win32";
    const commands = dep.install[platform];
    if (!commands || commands.length === 0) return false;

    for (const [cmd, args] of commands) {
        try {
            console.log(`[SELF-HEAL] Running: ${cmd} ${args.join(" ")}`);
            await execFileAsync(cmd, args, { timeout: 120000 });
            // Verify it actually installed
            if (await binaryExists(dep.binary)) return true;
        } catch (err) {
            console.warn(`[SELF-HEAL] ${cmd} failed: ${(err as Error).message?.split("\n")[0]}`);
        }
    }

    return false;
}

// ── NPM Package Installer ───────────────────────

async function installNpmPackage(packageName: string): Promise<boolean> {
    try {
        console.log(`[SELF-HEAL] Running: npm install ${packageName}`);
        await execAsync(`npm install ${packageName}`, { timeout: 60000 });
        return true;
    } catch {
        return false;
    }
}

// ── Binary Existence Check ───────────────────────

async function binaryExists(name: string): Promise<boolean> {
    try {
        const which = process.platform === "win32" ? "where" : "which";
        await execFileAsync(which, [name]);
        return true;
    } catch {
        return false;
    }
}
