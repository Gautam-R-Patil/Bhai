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

/** The frontmost app's bundle id, cheaply (lsappinfo, ~10ms); "" when unknown. */
export async function frontBundleId(): Promise<string> {
    if (process.platform !== "darwin") return "";
    try {
        const { stdout: asn } = await execFileAsync("lsappinfo", ["front"], { timeout: 1000 });
        const { stdout } = await execFileAsync("lsappinfo", ["info", "-only", "bundleid", asn.trim()], { timeout: 1000 });
        return /bundleID="([^"]+)"/.exec(stdout)?.[1] ?? "";
    } catch {
        return "";
    }
}

// What was in front after Bhai's last screen step. Between two steps of a task, another
// app can take the front (a notification, a launching app, the overlay): keystrokes then
// land in it. Seen live in the model eval: "45*12" typed into Chrome.
let lastFront: { id: string; at: number } | null = null;
/** Keystrokes go to whoever is in front: never take it from these. */
const SYSTEM_PROMPTS = /SecurityAgent|coreauthd|loginwindow|UserNotificationCenter|LocalAuthentication/i;

/** Record what's in front now: call after each screen-driving tool. */
export async function noteFrontAfterStep(): Promise<void> {
    const id = await frontBundleId();
    lastFront = id ? { id, at: Date.now() } : null;
}

/**
 * When another app took the front since Bhai's last screen step (within 30s), bring Bhai's
 * app back before typing. Returns that app's bundle id when it did. A security prompt
 * (password, Touch ID) is never pushed aside.
 */
export async function restoreFrontIfStolen(): Promise<string | undefined> {
    if (!lastFront || Date.now() - lastFront.at > 30_000) return undefined;
    const now = await frontBundleId();
    if (!now || now === lastFront.id || SYSTEM_PROMPTS.test(now)) return undefined;
    const want = lastFront.id;
    await execFileAsync("open", ["-b", want], { timeout: 3000 }).catch(() => {});
    for (let i = 0; i < 15; i++) {
        if ((await frontBundleId()) === want) return want;
        await new Promise((r) => setTimeout(r, 100));
    }
    return undefined;
}

/** The pid of a running app by name ("Calculator"), cheaply; 0 when it isn't running. */
export async function pidOfApp(appName: string): Promise<number> {
    if (process.platform !== "darwin") return 0;
    try {
        const { stdout: asn } = await execFileAsync("lsappinfo", ["find", `name=${appName}`], { timeout: 1500 });
        const first = asn.trim().split(/\s+/)[0];
        if (!first) return 0;
        const { stdout } = await execFileAsync("lsappinfo", ["info", "-only", "pid", first], { timeout: 1500 });
        return Number(/pid\s*=\s*(\d+)/.exec(stdout)?.[1] ?? 0);
    } catch {
        return 0;
    }
}
