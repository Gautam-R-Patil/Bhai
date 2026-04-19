// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Codebase Merkle Helpers ───────────────────
// SHA-256 hashing for content-based dirty detection, plus repo-root
// resolution (git rev-parse → cwd fallback) and per-repo keying.
// All helpers are pure + fail-open: any error returns a safe default.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** SHA-256 hex digest of an arbitrary string. Always 64 chars lowercase. */
export function sha256String(input: string): string {
    return createHash("sha256").update(input).digest("hex");
}

/**
 * SHA-256 hex digest of a file's contents. Returns an empty string on any
 * read error so callers can treat it as "unknown" without throwing.
 */
export function sha256File(filePath: string): string {
    try {
        const buf = fs.readFileSync(filePath);
        return createHash("sha256").update(buf).digest("hex");
    } catch {
        return "";
    }
}

/**
 * Resolve the git repo root for a directory. Runs `git rev-parse --show-toplevel`
 * with a 1s timeout; on any failure (non-git, git unavailable, timeout) falls
 * back to the resolved input directory.
 */
export function resolveRepoRoot(startDir: string): string {
    const dir = path.resolve(startDir);
    try {
        const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
            cwd: dir,
            encoding: "utf-8",
            timeout: 1000,
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (out && fs.existsSync(out)) return out;
    } catch {
        /* fall through */
    }
    return dir;
}

/** 16-char lowercase hex prefix of SHA-256(repoRoot). Used to key sidecar DBs. */
export function repoHash(repoRoot: string): string {
    return sha256String(path.resolve(repoRoot)).slice(0, 16);
}

/** True when the git command is available on PATH. */
export function gitAvailable(): boolean {
    try {
        execFileSync("git", ["--version"], {
            timeout: 500,
            stdio: ["ignore", "ignore", "ignore"],
        });
        return true;
    } catch {
        return false;
    }
}
