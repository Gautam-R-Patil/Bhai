// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── git_op Tool ───────────────────────────────
// Write-side git with hard safety rails. Only invoked when the user
// explicitly asks for a git action. Destructive ops require an
// evidence_phrase that is a substring of the user's turn. Never
// --no-verify / --no-gpg-sign. Never force-push to main/master/production.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gitAvailable, resolveRepoRoot } from "../../memory/codebase-merkle.js";
import { auditLog } from "../../security/audit-log.js";
import type { ToolDefinition } from "../get-current-time.js";

type Tier = "safe" | "confirm" | "destructive" | "blocked";

const PROTECTED_BRANCHES = new Set(["main", "master", "production"]);
const RELEASE_PREFIX = "release/";

// Flags we strip from every invocation regardless of what the agent asks.
const BANNED_FLAGS = new Set(["--no-verify", "--no-gpg-sign"]);

function classify(op: string, input: Record<string, unknown>): Tier {
    if (
        op === "status" ||
        op === "branch_list" ||
        op === "branch_create" ||
        op === "switch" ||
        op === "stash_push" ||
        op === "stash_pop" ||
        op === "stash_apply" ||
        op === "stash_list" ||
        op === "tag" ||
        op === "add" ||
        op === "commit"
    )
        return "safe";
    if (op === "revert" || op === "cherry_pick" || op === "merge") return "confirm";
    if (op === "rebase") return input.interactive === true ? "blocked" : "confirm";
    if (op === "reset") return "destructive";
    if (op === "clean") return "destructive";
    if (op === "push") return "destructive";
    return "blocked";
}

function isGitRepo(dir: string): boolean {
    try {
        return fs.existsSync(path.join(resolveRepoRoot(dir), ".git"));
    } catch {
        return false;
    }
}

function runGit(cwd: string, args: string[], timeoutMs = 10_000): { stdout: string; stderr: string; code: number } {
    try {
        const out = execFileSync("git", args, {
            cwd,
            encoding: "utf-8",
            timeout: timeoutMs,
            stdio: ["ignore", "pipe", "pipe"],
            maxBuffer: 8 * 1024 * 1024,
        });
        return { stdout: out, stderr: "", code: 0 };
    } catch (err) {
        const e = err as { stdout?: string; stderr?: string; status?: number };
        return { stdout: e.stdout ?? "", stderr: e.stderr ?? String(err), code: e.status ?? 1 };
    }
}

function stripBanned(args: string[]): string[] {
    return args.filter((a) => !BANNED_FLAGS.has(a));
}

function requirePhrase(input: Record<string, unknown>, needle: string): string | null {
    const phrase = typeof input.evidence_phrase === "string" ? input.evidence_phrase.trim().toLowerCase() : "";
    if (!phrase) return `evidence_phrase required (must include substring: "${needle}")`;
    if (!phrase.includes(needle)) return `evidence_phrase must contain the substring "${needle}"`;
    return null;
}

export const gitOpTool: ToolDefinition = {
    schema: {
        type: "function",
        function: {
            name: "git_op",
            description: `Safety-railed git write-side tool. Only call when the user explicitly asks.

Operations: status, branch_list, branch_create, switch, stash_push/pop/apply/list,
add (explicit paths only — never '.', '-A', '-u'), commit, tag, revert, cherry_pick,
merge, rebase, reset, clean, push.

Confirm tier (revert/cherry_pick/merge/rebase): default-preview. Agent surfaces
the preview and the user must re-call with confirmed: true.
Destructive tier (reset/clean/push-force): requires confirmed: true AND
evidence_phrase that is a substring of the user's own message
("force push", "reset hard", "clean force").

Hard blocks: --no-verify, --no-gpg-sign, force push to main/master/production/release/*,
interactive rebase, add -A/-u/.`,
            parameters: {
                type: "object",
                properties: {
                    operation: {
                        type: "string",
                        enum: [
                            "status",
                            "branch_list",
                            "branch_create",
                            "switch",
                            "stash_push",
                            "stash_pop",
                            "stash_apply",
                            "stash_list",
                            "add",
                            "commit",
                            "tag",
                            "revert",
                            "cherry_pick",
                            "merge",
                            "rebase",
                            "reset",
                            "clean",
                            "push",
                        ],
                    },
                    paths: { type: "array", items: { type: "string" }, description: "Explicit paths (add)." },
                    message: { type: "string", description: "Commit / tag message." },
                    name: { type: "string", description: "Branch / tag name." },
                    from: { type: "string", description: "Starting point for branch_create." },
                    branch: { type: "string", description: "Target branch for switch / push." },
                    create: { type: "boolean", description: "Create branch on switch." },
                    stash_first: { type: "boolean", description: "Auto-stash before switch." },
                    commit: { type: "string", description: "Commit SHA (revert / cherry_pick / tag)." },
                    onto: { type: "string", description: "rebase onto ref." },
                    interactive: { type: "boolean", description: "(Blocked) interactive rebase / edit." },
                    mode: { type: "string", enum: ["soft", "mixed", "hard"], description: "reset mode." },
                    to: { type: "string", description: "reset target ref." },
                    force: { type: "boolean", description: "push --force (blocked on main/master/production)." },
                    force_with_lease: { type: "boolean", description: "push --force-with-lease." },
                    set_upstream: { type: "boolean", description: "push -u." },
                    remote: { type: "string", description: "push remote (default origin)." },
                    dirs: { type: "boolean", description: "clean -d (dirs)." },
                    confirmed: { type: "boolean", description: "Required for Confirm + Destructive tiers." },
                    evidence_phrase: {
                        type: "string",
                        description: "Substring of the user's turn (destructive tier).",
                    },
                    amend: { type: "boolean", description: "commit --amend (requires the user to have said 'amend')." },
                    path: { type: "string", description: "Repo root (default cwd)." },
                },
                required: ["operation"],
            },
        },
    },

    async handler(input: Record<string, unknown>): Promise<string> {
        const operation = String(input.operation ?? "");
        const root = typeof input.path === "string" && input.path ? input.path : process.cwd();

        if (!gitAvailable()) return JSON.stringify({ success: false, error: "git not available" });
        if (!isGitRepo(root)) return JSON.stringify({ success: false, error: "not a git repo" });

        const tier = classify(operation, input);
        if (tier === "blocked") {
            return JSON.stringify({ success: false, error: `operation blocked at tool layer: ${operation}` });
        }

        // Destructive / Confirm gating
        if (tier === "confirm" || tier === "destructive") {
            if (input.confirmed !== true) {
                return JSON.stringify({
                    success: true,
                    preview: true,
                    would_run: operation,
                    effect_summary: `${operation} (awaiting confirmation)`,
                    note: "Agent must surface this preview and await explicit user approval before re-calling with confirmed: true.",
                });
            }
        }

        try {
            if (operation === "status") {
                const r = runGit(root, ["status", "--short", "--branch"]);
                return JSON.stringify({ success: r.code === 0, status: r.stdout, stderr: r.stderr });
            }
            if (operation === "branch_list") {
                const args = ["branch", "--color=never"];
                if (input.verbose === true) args.push("-vv");
                if (input.remote === true) args.push("-r");
                const r = runGit(root, args);
                return JSON.stringify({ success: r.code === 0, branches: r.stdout.split("\n").filter(Boolean) });
            }
            if (operation === "branch_create") {
                const name = String(input.name ?? "");
                if (!name) return JSON.stringify({ success: false, error: "name required" });
                const from = typeof input.from === "string" ? input.from : undefined;
                const args = ["branch", name];
                if (from) args.push(from);
                const r = runGit(root, args);
                auditLog("git_op.branch_create", { name, from, code: r.code });
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr });
            }
            if (operation === "switch") {
                const branch = String(input.branch ?? "");
                if (!branch) return JSON.stringify({ success: false, error: "branch required" });
                // Refuse dirty tree unless stash_first=true
                const status = runGit(root, ["status", "--porcelain"]);
                if (status.stdout.trim().length > 0 && input.stash_first !== true) {
                    return JSON.stringify({
                        success: false,
                        error: "dirty working tree; pass stash_first: true to auto-stash",
                    });
                }
                if (input.stash_first === true) runGit(root, ["stash", "push", "-u", "-m", "auto-stash before switch"]);
                const args = ["switch"];
                if (input.create === true) args.push("-c");
                args.push(branch);
                const r = runGit(root, args);
                auditLog("git_op.switch", { branch, created: input.create === true, code: r.code });
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr });
            }
            if (operation === "stash_push") {
                const r = runGit(root, ["stash", "push", "-u", "-m", "atlas-stash"]);
                auditLog("git_op.stash_push", { code: r.code });
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr });
            }
            if (operation === "stash_pop") {
                const r = runGit(root, ["stash", "pop"]);
                auditLog("git_op.stash_pop", { code: r.code });
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr });
            }
            if (operation === "stash_apply") {
                const r = runGit(root, ["stash", "apply"]);
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr });
            }
            if (operation === "stash_list") {
                const r = runGit(root, ["stash", "list"]);
                return JSON.stringify({ success: r.code === 0, stashes: r.stdout.split("\n").filter(Boolean) });
            }
            if (operation === "add") {
                const paths = Array.isArray(input.paths) ? (input.paths as unknown[]).map(String) : [];
                if (paths.length === 0)
                    return JSON.stringify({ success: false, error: "paths required (explicit paths only)" });
                for (const p of paths) {
                    if (p === "." || p === "-A" || p === "-u" || p === "--all") {
                        return JSON.stringify({
                            success: false,
                            error: `refused: add only accepts explicit paths (rejected: ${p})`,
                        });
                    }
                }
                const args = stripBanned(["add", "--", ...paths]);
                const r = runGit(root, args);
                auditLog("git_op.add", { paths, code: r.code });
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr });
            }
            if (operation === "commit") {
                const message = String(input.message ?? "");
                if (!message) return JSON.stringify({ success: false, error: "message required" });
                const args = ["commit", "-m", message];
                if (input.amend === true) {
                    const phraseErr = requirePhrase(input, "amend");
                    if (phraseErr) return JSON.stringify({ success: false, error: phraseErr });
                    args.push("--amend");
                }
                const r = runGit(root, stripBanned(args));
                auditLog("git_op.commit", { amend: input.amend === true, code: r.code });
                if (r.code !== 0) return JSON.stringify({ success: false, stderr: r.stderr, hook_failed: true });
                const sha = runGit(root, ["rev-parse", "HEAD"]).stdout.trim();
                return JSON.stringify({ success: true, commit_sha: sha, stdout: r.stdout });
            }
            if (operation === "tag") {
                const name = String(input.name ?? "");
                if (!name) return JSON.stringify({ success: false, error: "name required" });
                const args = ["tag", name];
                const message = typeof input.message === "string" ? input.message : undefined;
                if (message) {
                    args.splice(1, 0, "-a", "-m", message);
                }
                if (typeof input.commit === "string" && input.commit) args.push(input.commit);
                const r = runGit(root, stripBanned(args));
                auditLog("git_op.tag", { name, code: r.code });
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr });
            }
            if (operation === "revert") {
                const commit = String(input.commit ?? "");
                if (!commit) return JSON.stringify({ success: false, error: "commit required" });
                const r = runGit(root, stripBanned(["revert", "--no-edit", commit]));
                auditLog("git_op.revert", { commit, code: r.code });
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr });
            }
            if (operation === "cherry_pick") {
                const commit = String(input.commit ?? "");
                if (!commit) return JSON.stringify({ success: false, error: "commit required" });
                const r = runGit(root, stripBanned(["cherry-pick", commit]));
                auditLog("git_op.cherry_pick", { commit, code: r.code });
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr });
            }
            if (operation === "merge") {
                const branch = String(input.branch ?? "");
                if (!branch) return JSON.stringify({ success: false, error: "branch required" });
                const args = ["merge"];
                if (input.no_ff === true) args.push("--no-ff");
                args.push(branch);
                const r = runGit(root, stripBanned(args));
                auditLog("git_op.merge", { branch, no_ff: input.no_ff === true, code: r.code });
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr });
            }
            if (operation === "rebase") {
                if (input.interactive === true) {
                    return JSON.stringify({ success: false, error: "interactive rebase blocked at tool layer" });
                }
                const onto = String(input.onto ?? "");
                if (!onto) return JSON.stringify({ success: false, error: "onto required" });
                const r = runGit(root, stripBanned(["rebase", onto]));
                auditLog("git_op.rebase", { onto, code: r.code });
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr });
            }
            if (operation === "reset") {
                const mode = (typeof input.mode === "string" ? input.mode : "mixed") as "soft" | "mixed" | "hard";
                const to = String(input.to ?? "HEAD");
                if (mode === "hard") {
                    const phraseErr = requirePhrase(input, "reset hard");
                    if (phraseErr) return JSON.stringify({ success: false, error: phraseErr });
                }
                const r = runGit(root, stripBanned(["reset", `--${mode}`, to]));
                auditLog("git_op.reset", { mode, to, code: r.code });
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr });
            }
            if (operation === "clean") {
                const phraseErr = requirePhrase(input, "clean force");
                if (phraseErr) return JSON.stringify({ success: false, error: phraseErr });
                const args = ["clean", "-f"];
                if (input.dirs === true) args.push("-d");
                const paths = Array.isArray(input.paths) ? (input.paths as unknown[]).map(String) : [];
                if (paths.length > 0) args.push("--", ...paths);
                const r = runGit(root, stripBanned(args));
                auditLog("git_op.clean", { paths, code: r.code });
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr });
            }
            if (operation === "push") {
                const remote = typeof input.remote === "string" && input.remote ? input.remote : "origin";
                const branch =
                    typeof input.branch === "string" && input.branch
                        ? input.branch
                        : runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
                const force = input.force === true;
                const forceLease = input.force_with_lease === true;
                const setUpstream = input.set_upstream === true;

                if (force && (PROTECTED_BRANCHES.has(branch) || branch.startsWith(RELEASE_PREFIX))) {
                    return JSON.stringify({
                        success: false,
                        error: `force push to ${branch} is blocked at the tool layer`,
                    });
                }
                if (force) {
                    const phraseErr = requirePhrase(input, "force push");
                    if (phraseErr) return JSON.stringify({ success: false, error: phraseErr });
                }

                const args = ["push"];
                if (setUpstream) args.push("-u");
                if (forceLease && !force) args.push("--force-with-lease");
                if (force) args.push("--force");
                args.push(remote, branch);
                const r = runGit(root, stripBanned(args));
                auditLog("git_op.push", { remote, branch, force, force_with_lease: forceLease, code: r.code });
                return JSON.stringify({ success: r.code === 0, stderr: r.stderr, stdout: r.stdout });
            }
            return JSON.stringify({ success: false, error: `unknown operation: ${operation}` });
        } catch (err) {
            return JSON.stringify({ success: false, error: `git_op failed: ${(err as Error).message}` });
        }
    },
};
