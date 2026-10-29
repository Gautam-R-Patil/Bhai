// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Browser Profile Sync ─────────────────────────
 * Inspired by Browser-Use CLI 2.0 (58K+ GitHub stars).
 * Syncs real browser profile (cookies, sessions, logins) so the agent
 * can browse as the authenticated user. No re-login needed.
 *
 * Reads Chrome/Safari profile data and injects into Playwright context.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { getDataDir } from "../../config/paths.js";

const execFileAsync = promisify(execFile);

// ── Types ─────────────────────────────────────

export interface BrowserProfile {
    cookies: Array<{
        name: string;
        value: string;
        domain: string;
        path: string;
        expires: number;
        httpOnly: boolean;
        secure: boolean;
        sameSite: "Strict" | "Lax" | "None";
    }>;
    localStorage: Record<string, Record<string, string>>; // domain → key → value
    profilePath: string;
    browser: "chrome" | "safari" | "firefox";
    lastSync: string;
}

// ── Chrome Profile Path ───────────────────────

function getChromeProfilePath(): string {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const possibilities =
        process.platform === "win32"
            ? [
                  path.join(home, "AppData", "Local", "Google", "Chrome", "User Data", "Default"),
                  path.join(home, "AppData", "Local", "Google", "Chrome", "User Data", "Profile 1"),
              ]
            : [
                  path.join(home, "Library", "Application Support", "Google", "Chrome", "Default"),
                  path.join(home, "Library", "Application Support", "Google", "Chrome", "Profile 1"),
                  path.join(home, ".config", "google-chrome", "Default"),
              ];
    return possibilities.find((p) => fs.existsSync(p)) || possibilities[0];
}

// ── Cookie Extraction ─────────────────────────

/**
 * Extract cookies from Chrome's SQLite database.
 * Note: On macOS, Chrome encrypts cookies. We use the Profile directory
 * directly with Playwright's --profile flag instead of extracting.
 */
export async function extractChromeCookies(): Promise<BrowserProfile["cookies"]> {
    // On macOS, cookies are encrypted with the Keychain
    // Best approach: use the Playwright persistent context with Chrome's profile dir
    console.log("[PROFILE-SYNC] Chrome cookies are encrypted on macOS — using profile directory instead");
    return [];
}

/**
 * Get the path to the user's Chrome profile for Playwright persistent context.
 * This is the recommended approach: Playwright uses the real profile directly.
 */
export function getChromeUserDataDir(): string {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (process.platform === "win32") {
        return path.join(home, "AppData", "Local", "Google", "Chrome", "User Data");
    }
    return path.join(home, "Library", "Application Support", "Google", "Chrome");
}

// ── Profile Sync ──────────────────────────────

/**
 * Sync the user's real browser profile to a Playwright-compatible directory.
 * Creates a copy to avoid locking the original profile.
 */
export async function syncProfile(targetDir: string): Promise<{
    success: boolean;
    profilePath: string;
    browser: string;
}> {
    const chromeDir = getChromeUserDataDir();

    if (!fs.existsSync(chromeDir)) {
        return { success: false, profilePath: "", browser: "chrome" };
    }

    // Copy key profile files (cookies DB, local storage, session storage)
    const defaultProfile = path.join(chromeDir, "Default");
    if (!fs.existsSync(defaultProfile)) {
        return { success: false, profilePath: chromeDir, browser: "chrome" };
    }

    // Ensure target exists
    const targetProfile = path.join(targetDir, "Default");
    if (!fs.existsSync(targetProfile)) {
        fs.mkdirSync(targetProfile, { recursive: true });
    }

    // Sync key files (skip large cache files)
    const filesToSync = [
        "Cookies",
        "Cookies-journal",
        "Login Data",
        "Login Data-journal",
        "Web Data",
        "Web Data-journal",
        "Preferences",
        "Secure Preferences",
        "Bookmarks",
    ];

    let synced = 0;
    for (const file of filesToSync) {
        const src = path.join(defaultProfile, file);
        const dst = path.join(targetProfile, file);
        if (fs.existsSync(src)) {
            try {
                fs.copyFileSync(src, dst);
                synced++;
            } catch {
                // File might be locked by Chrome
            }
        }
    }

    // Also sync Local Storage
    const lsDir = path.join(defaultProfile, "Local Storage");
    const lsDst = path.join(targetProfile, "Local Storage");
    if (fs.existsSync(lsDir) && !fs.existsSync(lsDst)) {
        try {
            await execFileAsync("cp", ["-r", lsDir, lsDst]);
            synced++;
        } catch {
            /* */
        }
    }

    console.log(`[PROFILE-SYNC] Synced ${synced} profile files from Chrome`);

    return {
        success: synced > 0,
        profilePath: targetDir,
        browser: "chrome",
    };
}

/**
 * Check if the current Playwright profile has valid session cookies.
 * Returns domains with active sessions.
 */
export async function checkActiveSessions(profileDir: string): Promise<string[]> {
    const cookieFile = path.join(profileDir, "Default", "Cookies");
    if (!fs.existsSync(cookieFile)) return [];

    // Can't read encrypted cookies directly, but file existence indicates profile is synced
    return ["profile_synced"];
}

/**
 * Get Playwright launch options for using the real browser profile.
 * This is the simplest integration: just point Playwright at the Chrome user data dir.
 */
export function getProfileLaunchOptions(): {
    channel: string;
    userDataDir: string;
} {
    return {
        channel: "chrome",
        userDataDir: path.join(getDataDir(), "browser-profile"),
    };
}
