// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Dependency Self-Healing — Auto-detect & fix missing audio dependencies ──

import { execFile, exec } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

/** Cache: once resolved, don't re-check */
let soxResolved = false;

/**
 * Ensure sox is available. If missing, attempt auto-install.
 * Returns true if sox is ready, false if unrecoverable.
 */
export async function ensureSox(): Promise<boolean> {
    if (soxResolved) return true;

    // 1. Check if sox is already available
    if (await isSoxInstalled()) {
        soxResolved = true;
        return true;
    }

    console.log("[DEP] sox not found — attempting auto-install...");

    // 2. Try auto-install based on platform
    const installed = await autoInstallSox();
    if (installed && await isSoxInstalled()) {
        soxResolved = true;
        console.log("[DEP] sox auto-installed successfully");
        return true;
    }

    // 3. If first method failed, try alternatives
    const fallbackInstalled = await fallbackInstallSox();
    if (fallbackInstalled && await isSoxInstalled()) {
        soxResolved = true;
        console.log("[DEP] sox installed via fallback method");
        return true;
    }

    console.error("[DEP] Could not auto-install sox — live voice will not work");
    return false;
}

async function isSoxInstalled(): Promise<boolean> {
    try {
        await execFileAsync("sox", ["--version"]);
        return true;
    } catch {
        // Also check `rec` directly (some installs have rec but not sox in PATH)
        try {
            await execFileAsync("rec", ["--version"]);
            return true;
        } catch {
            return false;
        }
    }
}

async function autoInstallSox(): Promise<boolean> {
    const platform = process.platform;

    if (platform === "darwin") {
        // macOS: try brew first
        return await tryCommand("brew", ["install", "sox"], "Homebrew")
            || await tryCommand("port", ["install", "sox"], "MacPorts");
    }

    if (platform === "linux") {
        // Linux: try apt, then yum, then dnf, then pacman
        return await tryCommand("sudo", ["apt-get", "install", "-y", "sox"], "apt")
            || await tryCommand("sudo", ["yum", "install", "-y", "sox"], "yum")
            || await tryCommand("sudo", ["dnf", "install", "-y", "sox"], "dnf")
            || await tryCommand("sudo", ["pacman", "-S", "--noconfirm", "sox"], "pacman");
    }

    if (platform === "win32") {
        // Windows: try choco, then winget, then scoop
        return await tryCommand("choco", ["install", "sox", "-y"], "Chocolatey")
            || await tryShellCommand("winget install --id SoX.SoX --accept-package-agreements --accept-source-agreements", "winget")
            || await tryCommand("scoop", ["install", "sox"], "scoop");
    }

    return false;
}

async function fallbackInstallSox(): Promise<boolean> {
    const platform = process.platform;

    if (platform === "darwin") {
        // macOS: if brew isn't installed, try installing it first
        const hasBrew = await commandExists("brew");
        if (!hasBrew) {
            console.log("[DEP] Homebrew not found — attempting to install Homebrew first...");
            try {
                await execAsync(
                    '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
                    { timeout: 120000 },
                );
                // After Homebrew install, try sox again
                return await tryCommand("brew", ["install", "sox"], "Homebrew (fresh)");
            } catch {
                console.warn("[DEP] Homebrew auto-install failed");
                return false;
            }
        }
    }

    if (platform === "linux") {
        // Linux: try snap as last resort
        return await tryCommand("snap", ["install", "sox"], "snap");
    }

    return false;
}

async function tryCommand(cmd: string, args: string[], label: string): Promise<boolean> {
    try {
        console.log(`[DEP] Trying ${label}: ${cmd} ${args.join(" ")}`);
        await execFileAsync(cmd, args, { timeout: 120000 });
        return true;
    } catch (err) {
        console.warn(`[DEP] ${label} failed: ${(err as Error).message?.split("\n")[0]}`);
        return false;
    }
}

async function tryShellCommand(cmd: string, label: string): Promise<boolean> {
    try {
        console.log(`[DEP] Trying ${label}: ${cmd}`);
        await execAsync(cmd, { timeout: 120000 });
        return true;
    } catch (err) {
        console.warn(`[DEP] ${label} failed: ${(err as Error).message?.split("\n")[0]}`);
        return false;
    }
}

async function commandExists(cmd: string): Promise<boolean> {
    try {
        const which = process.platform === "win32" ? "where" : "which";
        await execFileAsync(which, [cmd]);
        return true;
    } catch {
        return false;
    }
}
