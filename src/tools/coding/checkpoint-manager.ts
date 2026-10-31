// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Pre-mutation filesystem checkpoints ──────────────────────
 * Snapshots a project dir into a SHADOW git store (env-isolated GIT_DIR /
 * GIT_WORK_TREE / GIT_INDEX_FILE) before edit/write/append_file mutations, so
 * work is recoverable even in non-git dirs — and the user's own .git is never
 * touched. Fail-open: any git/fs error is swallowed so a snapshot failure can
 * never block a tool call. Default-ON; disable with BHAI_NO_AUTO_CHECKPOINT.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getWorkspaceDir, getWorkspaceSubdir } from "../../config/paths.js";
import { gitAvailable, repoHash, resolveRepoRoot } from "../../memory/codebase-merkle.js";

const STORE_SUBDIR = ".bhai-checkpoints";
// Name before the ATLAS → Bhai rename; a workspace that has only this one keeps using it.
const OLD_STORE_SUBDIR = ".atlas-checkpoints";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_STORE_BYTES = 500 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;
const DEDUP_WINDOW_MS = 30_000;

const EXCLUDE_GLOBS = [
    "node_modules/",
    ".git/",
    ".env",
    ".env.*",
    "*.lock",
    "*.png",
    "*.jpg",
    "*.jpeg",
    "*.gif",
    "*.webp",
    "*.mp4",
    "*.mov",
    "*.mp3",
    "*.wav",
    "*.pdf",
    "*.zip",
    "*.tar",
    "*.tar.gz",
    "*.tgz",
    "*.7z",
    "*.rar",
    "*.exe",
    "*.dll",
    "*.so",
    "*.dylib",
    "*.node",
    "*.wasm",
    "*.bin",
    "*.o",
    "*.a",
    "dist/",
    "build/",
    "target/",
    "*.log",
];

// Time-window dedup: one snapshot per project per ~30s window. Avoids an
// agent.ts turn-boundary edit while still collapsing a burst of edits.
const lastSnap = new Map<string, number>();

function disabled(): boolean {
    return process.env.BHAI_NO_AUTO_CHECKPOINT === "true";
}

function storeRoot(): string {
    const ws = getWorkspaceDir();
    const old = path.join(ws, OLD_STORE_SUBDIR);
    // A workspace with only the old store keeps using it (never moved: an older build reads it too).
    if (!fs.existsSync(path.join(ws, STORE_SUBDIR)) && fs.existsSync(old)) return old;
    return getWorkspaceSubdir(STORE_SUBDIR);
}

function gitDirFor(root: string): string {
    return path.join(storeRoot(), repoHash(root));
}

interface ShadowResult {
    stdout: string;
    stderr: string;
    code: number;
}

function runShadow(gitDir: string, workTree: string, args: string[], timeout = GIT_TIMEOUT_MS): ShadowResult {
    try {
        const out = execFileSync("git", args, {
            env: {
                ...process.env,
                GIT_DIR: gitDir,
                GIT_WORK_TREE: workTree,
                GIT_INDEX_FILE: path.join(gitDir, "index"),
                GIT_TERMINAL_PROMPT: "0",
            },
            encoding: "utf-8",
            timeout,
            stdio: ["ignore", "pipe", "pipe"],
            maxBuffer: 16 * 1024 * 1024,
        });
        return { stdout: out, stderr: "", code: 0 };
    } catch (err) {
        const e = err as { stdout?: string; stderr?: string; status?: number };
        return { stdout: e.stdout ?? "", stderr: e.stderr ?? String(err), code: e.status ?? 1 };
    }
}

function ensureStore(gitDir: string, workTree: string): boolean {
    if (!fs.existsSync(path.join(gitDir, "HEAD"))) {
        const r = runShadow(gitDir, workTree, ["init", "-q", "--initial-branch=bhai"]);
        if (r.code !== 0) return false;
        runShadow(gitDir, workTree, ["config", "user.email", "checkpoints@bhai.local"]);
        runShadow(gitDir, workTree, ["config", "user.name", "Bhai Checkpoints"]);
        runShadow(gitDir, workTree, ["config", "gc.auto", "0"]);
        runShadow(gitDir, workTree, ["config", "commit.gpgsign", "false"]);
    }
    fs.mkdirSync(path.join(gitDir, "info"), { recursive: true });
    fs.writeFileSync(path.join(gitDir, "info", "exclude"), `${EXCLUDE_GLOBS.join("\n")}\n`);
    return true;
}

function dirSizeBytes(dir: string): number {
    let total = 0;
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        try {
            if (e.isDirectory()) total += dirSizeBytes(full);
            else total += fs.statSync(full).size;
        } catch {
            /* skip unreadable entry */
        }
    }
    return total;
}

// Belt-and-suspenders over info/exclude: drop any staged file above the size
// cap (git compresses big blobs but still stores them otherwise).
function dropLargeFromIndex(gitDir: string, workTree: string): void {
    const ls = runShadow(gitDir, workTree, ["ls-files"]);
    if (ls.code !== 0) return;
    for (const rel of ls.stdout.split("\n")) {
        const f = rel.trim();
        if (!f) continue;
        try {
            if (fs.statSync(path.join(workTree, f)).size > MAX_FILE_BYTES) {
                runShadow(gitDir, workTree, ["rm", "--cached", "-q", "--", f]);
            }
        } catch {
            /* file vanished mid-snapshot — ignore */
        }
    }
}

export async function ensureCheckpoint(dir: string, reason: string): Promise<void> {
    if (disabled() || !gitAvailable()) return;
    try {
        const root = resolveRepoRoot(dir);
        const key = repoHash(root);
        const now = Date.now();
        const prev = lastSnap.get(key);
        if (prev !== undefined && now - prev < DEDUP_WINDOW_MS) return;

        const gitDir = gitDirFor(root);
        if (!ensureStore(gitDir, root)) return;
        if (dirSizeBytes(gitDir) > MAX_STORE_BYTES) {
            pruneStore(gitDir, root);
            if (dirSizeBytes(gitDir) > MAX_STORE_BYTES) {
                lastSnap.set(key, now);
                return;
            }
        }
        if (runShadow(gitDir, root, ["add", "-A"]).code !== 0) return;
        dropLargeFromIndex(gitDir, root);
        // diff --cached --quiet exits non-zero when there ARE staged changes.
        if (runShadow(gitDir, root, ["diff", "--cached", "--quiet"]).code === 0) {
            lastSnap.set(key, now);
            return;
        }
        runShadow(gitDir, root, ["commit", "-q", "--no-gpg-sign", "-m", `checkpoint: ${reason}`]);
        lastSnap.set(key, now);
    } catch {
        /* fail-open: never throw into the hook chain */
    }
}

export interface CheckpointEntry {
    sha: string;
    date: string;
    subject: string;
}

export function listCheckpoints(dir: string, limit = 50): CheckpointEntry[] {
    if (!gitAvailable()) return [];
    try {
        const root = resolveRepoRoot(dir);
        const gitDir = gitDirFor(root);
        if (!fs.existsSync(path.join(gitDir, "HEAD"))) return [];
        const r = runShadow(gitDir, root, ["log", `-${limit}`, "--format=%H%x1f%cI%x1f%s"]);
        if (r.code !== 0) return [];
        return r.stdout
            .split("\n")
            .filter(Boolean)
            .map((line) => {
                const [sha, date, subject] = line.split("\x1f");
                return { sha, date, subject };
            });
    } catch {
        return [];
    }
}

export function statusReport(): string {
    try {
        const root = storeRoot();
        if (!fs.existsSync(root)) return "📦 Checkpoints: no snapshots yet.";
        const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
        if (dirs.length === 0) return "📦 Checkpoints: no snapshots yet.";
        const totalMb = (dirSizeBytes(root) / (1024 * 1024)).toFixed(1);
        return `📦 Checkpoints: ${dirs.length} project store(s), ${totalMb} MB total under ${root}\nUse \`/checkpoints prune\` to gc, \`/checkpoints clear\` to wipe.`;
    } catch {
        return "📦 Checkpoints: unavailable.";
    }
}

export function pruneStore(gitDir: string, workTree: string): void {
    runShadow(gitDir, workTree, ["reflog", "expire", "--expire=now", "--all"]);
    runShadow(gitDir, workTree, ["gc", "--prune=now", "--quiet"]);
}

export function pruneAll(): { pruned: number } {
    let pruned = 0;
    try {
        const root = storeRoot();
        if (!fs.existsSync(root)) return { pruned: 0 };
        for (const e of fs.readdirSync(root, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            pruneStore(path.join(root, e.name), root);
            pruned++;
        }
    } catch {
        /* fail-open */
    }
    return { pruned };
}

export function clearAll(): { removed: number } {
    let removed = 0;
    try {
        const root = storeRoot();
        if (!fs.existsSync(root)) return { removed: 0 };
        for (const e of fs.readdirSync(root, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            fs.rmSync(path.join(root, e.name), { recursive: true, force: true });
            removed++;
        }
        lastSnap.clear();
    } catch {
        /* fail-open */
    }
    return { removed };
}

export interface RestoreResult {
    success: boolean;
    safety_sha?: string;
    error?: string;
}

export function restoreCheckpoint(dir: string, sha: string): RestoreResult {
    if (!gitAvailable()) return { success: false, error: "git unavailable" };
    if (!/^[a-f0-9]{7,40}$/i.test(sha)) return { success: false, error: "invalid sha" };
    try {
        const root = resolveRepoRoot(dir);
        const gitDir = gitDirFor(root);
        if (!fs.existsSync(path.join(gitDir, "HEAD"))) return { success: false, error: "no checkpoint store" };
        if (runShadow(gitDir, root, ["rev-parse", "--verify", `${sha}^{commit}`]).code !== 0) {
            return { success: false, error: "unknown checkpoint sha" };
        }
        // Pre-rollback safety snapshot so the rollback is itself undoable.
        runShadow(gitDir, root, ["add", "-A"]);
        runShadow(gitDir, root, ["commit", "-q", "--no-gpg-sign", "-m", "pre-rollback safety"]);
        const safety = runShadow(gitDir, root, ["rev-parse", "HEAD"]);
        const safetySha = safety.code === 0 ? safety.stdout.trim() : undefined;
        const co = runShadow(gitDir, root, ["checkout", sha, "--", "."]);
        if (co.code !== 0) return { success: false, error: co.stderr.slice(0, 200), safety_sha: safetySha };
        return { success: true, safety_sha: safetySha };
    } catch (err) {
        return { success: false, error: String(err).slice(0, 200) };
    }
}
