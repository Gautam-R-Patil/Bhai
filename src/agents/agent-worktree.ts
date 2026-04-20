// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Agent Worktree Isolation (Phase 4G) ──────
// Thin utility for creating throwaway git worktrees so multiple
// parallel coder sub-agents can operate on the same repo without file
// conflicts. Opt-in (mesh.ts gates on ATLAS_AGENT_WORKTREE=true and
// parallel coder-step count >= 2).
//
// This file is pure process/filesystem helper — it has no knowledge of
// sub-agents; callers decide when to allocate/release a worktree and
// thread its path through SubAgentTask.workingDirectory.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const WORKTREES_ROOT = path.resolve("data", "agent-worktrees");
const BRANCH_PREFIX = "atlas/agent";

// ── Detection ────────────────────────────────

export function isGitRepo(cwd: string = process.cwd()): boolean {
    try {
        const res = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "pipe" });
        return res.status === 0 && res.stdout.toString().trim() === "true";
    } catch {
        return false;
    }
}

export function isWorktreeEnabled(): boolean {
    return process.env.ATLAS_AGENT_WORKTREE === "true" && process.env.ATLAS_NO_AGENT_WORKTREE !== "true";
}

// ── Lifecycle ────────────────────────────────

export interface AgentWorktree {
    path: string;
    branch: string;
    cleanup(): void;
}

const activeWorktrees = new Set<AgentWorktree>();
let sigintHooked = false;
let orphansPruned = false;

function hookSigint(): void {
    if (sigintHooked) return;
    sigintHooked = true;
    const cleanupAll = () => {
        for (const wt of activeWorktrees) {
            try {
                wt.cleanup();
            } catch {
                /* best-effort */
            }
        }
    };
    process.on("SIGINT", cleanupAll);
    process.on("SIGTERM", cleanupAll);
    process.on("exit", cleanupAll);
}

/**
 * Reconcile orphaned worktree refs left behind by previous crashes
 * (SIGKILL, OOM, hard reboots bypass the SIGINT handler). Runs
 * `git worktree prune` once per process, and sweeps any directory
 * under data/agent-worktrees/ whose git ref is gone. Idempotent.
 */
function pruneOrphanWorktrees(cwd: string): void {
    if (orphansPruned) return;
    orphansPruned = true;
    try {
        spawnSync("git", ["worktree", "prune"], { cwd, stdio: "pipe" });
    } catch {
        /* non-fatal — next `worktree add` will surface any remaining issue */
    }
    // Sweep data/agent-worktrees/ for dirs no longer registered
    try {
        if (!existsSync(WORKTREES_ROOT)) return;
        const list = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd, stdio: "pipe" });
        const known = new Set<string>();
        if (list.status === 0) {
            for (const line of list.stdout.toString().split("\n")) {
                if (line.startsWith("worktree ")) known.add(line.slice("worktree ".length).trim());
            }
        }
        for (const entry of readdirSync(WORKTREES_ROOT, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const full = path.join(WORKTREES_ROOT, entry.name);
            if (!known.has(full)) {
                try { rmSync(full, { recursive: true, force: true }); } catch { /* */ }
            }
        }
    } catch {
        /* sweep is best-effort */
    }
}

/**
 * Create a throwaway git worktree at `data/agent-worktrees/{id}` with
 * a fresh branch. Returns a handle with a `cleanup()` function; the
 * caller MUST call cleanup (or rely on SIGINT/exit auto-cleanup).
 *
 * Returns null when worktrees are unavailable (not a git repo, git
 * command failed, etc.) — callers should fall back to shared cwd.
 */
export function setupAgentWorktree(id: string, cwd: string = process.cwd()): AgentWorktree | null {
    if (!isWorktreeEnabled() || !isGitRepo(cwd)) return null;

    hookSigint();
    pruneOrphanWorktrees(cwd);

    if (!existsSync(WORKTREES_ROOT)) {
        try {
            mkdirSync(WORKTREES_ROOT, { recursive: true });
        } catch {
            return null;
        }
    }

    const safeId = id.replace(/[^\w.-]/g, "_").slice(0, 40);
    const branch = `${BRANCH_PREFIX}/${safeId}-${Date.now()}`;
    const wtPath = path.join(WORKTREES_ROOT, `${safeId}-${Date.now()}`);

    const res = spawnSync("git", ["worktree", "add", "-b", branch, wtPath, "HEAD"], { cwd, stdio: "pipe" });
    if (res.status !== 0) {
        console.warn(`[WORKTREE] failed to create ${wtPath}: ${res.stderr?.toString().trim()}`);
        return null;
    }

    const handle: AgentWorktree = {
        path: wtPath,
        branch,
        cleanup() {
            activeWorktrees.delete(handle);
            try {
                spawnSync("git", ["worktree", "remove", "--force", wtPath], { cwd, stdio: "pipe" });
            } catch {
                /* */
            }
            try {
                spawnSync("git", ["branch", "-D", branch], { cwd, stdio: "pipe" });
            } catch {
                /* */
            }
            // Last-resort fs removal if git worktree remove left something behind
            if (existsSync(wtPath)) {
                try {
                    rmSync(wtPath, { recursive: true, force: true });
                } catch {
                    /* */
                }
            }
        },
    };
    activeWorktrees.add(handle);
    return handle;
}

export function cleanupAllWorktrees(): void {
    for (const wt of [...activeWorktrees]) {
        try {
            wt.cleanup();
        } catch {
            /* */
        }
    }
}
