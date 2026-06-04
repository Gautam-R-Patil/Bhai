// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * Spawn a long-running provisioning command (model pull, dep install) that must
 * SURVIVE the parent process exiting. A plain execFileAsync child receives
 * SIGTERM/SIGHUP when the bot process quits, which orphaned multi-GB pulls
 * mid-download. This spawns detached + unref'd (reparented to init), logs to a
 * file, and uses a lockfile to prevent a second concurrent spawn for the same
 * task (e.g. boot firing twice).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../config/paths.js";

const LOCK_STALE_MS = 60 * 60 * 1000; // 1h — a real pull/install won't exceed this

/**
 * Returns "started" if a detached process was launched, "locked" if another is
 * already running (fresh lock), or "error" on failure. Never throws.
 */
export function spawnDetachedLogged(
    name: string,
    cmd: string,
    args: string[],
    opts: { logFile?: string } = {},
): "started" | "locked" | "error" {
    let dataDir: string;
    try {
        dataDir = getDataDir();
    } catch {
        return "error";
    }
    const lockPath = join(dataDir, `.${name}.lock`);

    // Honor a fresh lock; clear a stale one (previous run died without cleanup).
    if (existsSync(lockPath)) {
        try {
            const ts = Number(readFileSync(lockPath, "utf-8").trim()) || 0;
            if (Date.now() - ts < LOCK_STALE_MS) return "locked";
            rmSync(lockPath, { force: true });
        } catch {
            /* unreadable lock — treat as stale */
            try { rmSync(lockPath, { force: true }); } catch { /* ignore */ }
        }
    }

    const logPath = opts.logFile || join(dataDir, `${name}.log`);
    let outFd: number;
    try {
        writeFileSync(lockPath, String(Date.now()), { mode: 0o600 });
        outFd = openSync(logPath, "w"); // truncate-on-open so the log doesn't grow unbounded
    } catch {
        return "error";
    }

    let child: ChildProcess;
    try {
        child = spawn(cmd, args, {
            detached: true,
            stdio: ["ignore", outFd, outFd],
            windowsHide: true,
        });
    } catch {
        try { closeSync(outFd); } catch { /* ignore */ }
        try { rmSync(lockPath, { force: true }); } catch { /* ignore */ }
        return "error";
    }

    // Clear the lock when the (detached) child exits, if this process is still
    // around to observe it. If we've already exited, the stale-lock check on the
    // next run handles cleanup.
    child.on("exit", () => {
        try { closeSync(outFd); } catch { /* ignore */ }
        try { rmSync(lockPath, { force: true }); } catch { /* ignore */ }
    });
    child.unref();
    return "started";
}

/** True iff a fresh (non-stale) lock for `name` exists. */
export function isProvisioningInFlight(name: string): boolean {
    try {
        const lockPath = join(getDataDir(), `.${name}.lock`);
        if (!existsSync(lockPath)) return false;
        const ts = Number(readFileSync(lockPath, "utf-8").trim()) || 0;
        if (Date.now() - ts >= LOCK_STALE_MS) return false;
        // sanity: lock file must be readable + recent
        statSync(lockPath);
        return true;
    } catch {
        return false;
    }
}
