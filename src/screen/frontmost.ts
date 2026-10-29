// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * Which app is in front (macOS), and waiting for one to get there. `open -a`
 * returns before the app is frontmost, so keystrokes sent right after it land
 * in the previous app; a fixed sleep is too long on a fast Mac and too short
 * for a cold launch. Poll instead.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface FrontmostApp {
    name: string; // localized name, e.g. "Visual Studio Code"
    bundleName: string; // e.g. "Visual Studio Code.app"
    bundleId: string; // e.g. "com.microsoft.VSCode"
    pid: number;
}

const FRONTMOST_JXA =
    'ObjC.import("AppKit");var a=$.NSWorkspace.sharedWorkspace.frontmostApplication;' +
    'JSON.stringify({name:ObjC.unwrap(a.localizedName)||"",bundleName:ObjC.unwrap(a.bundleURL.lastPathComponent)||"",' +
    'bundleId:ObjC.unwrap(a.bundleIdentifier)||"",pid:a.processIdentifier})';

/** The frontmost app on macOS; null elsewhere or on failure. */
export async function getFrontmostApp(): Promise<FrontmostApp | null> {
    if (process.platform !== "darwin") return null;
    try {
        const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", FRONTMOST_JXA], {
            timeout: 2000,
        });
        return JSON.parse(stdout.trim()) as FrontmostApp;
    } catch {
        return null;
    }
}

/** Does `app` (a name, "Name.app", a bundle path or a bundle id, as `open -a` takes) name this app? */
export function frontmostMatches(app: string, f: FrontmostApp): boolean {
    const norm = (s: string) =>
        s
            .trim()
            .toLowerCase()
            .replace(/\.app\/?$/, "");
    const want = norm(app.replace(/\/+$/, "").split("/").pop() || app);
    return !!want && [f.name, f.bundleName, f.bundleId].some((s) => !!s && norm(s) === want);
}

/**
 * Poll until `app` is frontmost (macOS only). Returns its info, or null if it
 * never came to the front within `timeoutMs`.
 */
export async function waitForFrontmost(app: string, timeoutMs = 5000, intervalMs = 100): Promise<FrontmostApp | null> {
    if (process.platform !== "darwin") return null;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const f = await getFrontmostApp();
        if (f && frontmostMatches(app, f)) return f;
        if (Date.now() >= deadline) return null;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}
