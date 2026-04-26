// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Meta-Harness: Filesystem-Agent Code Proposer (v2) ──────────────────
// Replaces the JSON-summary proposer with an agent running inside an
// isolated git worktree with real filesystem access to individual trace
// files. Paper 2603.28052 ablation: summaries give median accuracy 34.9
// vs 50.0 for raw trace access.
//
// Falls back to proposeNextCandidate() when no git repo is available.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "../agent.js";
import { setupAgentWorktree, isGitRepo } from "../agents/agent-worktree.js";
import type { LLMClient } from "../llm.js";
import type { CandidateManifest, HarnessConfig } from "./types.js";
import type { HarnessRunStore } from "./run-store.js";
import { proposeNextCandidate } from "./proposer.js";

export interface CodeChange {
    patchFile: string;   // filename only (no path) inside src/harness/proposed-changes/
    content: string;
}

interface ProposeOptions {
    timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

// shell_exec intentionally excluded: it allows arbitrary commands and trace files
// could contain prompt-injected instructions. read_file + grep_file + glob_files
// are sufficient for all harness-proposer read operations.
const CODE_PROPOSER_ALLOWED_TOOLS = [
    "read_file",
    "write_file",
    "grep_file",
    "glob_files",
];

export async function proposeWithFilesystemAgent(
    llm: LLMClient,
    candidate: CandidateManifest,
    store: HarnessRunStore,
    opts: ProposeOptions = {},
): Promise<{ config: HarnessConfig; codeChanges: CodeChange[] }> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // The harness always wants worktree isolation regardless of ATLAS_AGENT_WORKTREE env var.
    // We temporarily force-enable the env flag for this call, then restore it.
    const prevWorktreeEnv = process.env.ATLAS_AGENT_WORKTREE;
    if (!isGitRepo()) {
        console.warn("[CODE-PROPOSER] Not a git repo — filesystem-agent unavailable, falling back to JSON proposer");
        const config = await proposeNextCandidate(llm, candidate, store);
        return { config, codeChanges: [] };
    }
    process.env.ATLAS_AGENT_WORKTREE = "true";
    const worktree = setupAgentWorktree(`harness-${candidate.candidateId}`);
    if (prevWorktreeEnv === undefined) delete process.env.ATLAS_AGENT_WORKTREE;
    else process.env.ATLAS_AGENT_WORKTREE = prevWorktreeEnv;

    if (worktree === null) {
        console.warn("[CODE-PROPOSER] git worktree creation failed — falling back to JSON proposer");
        const config = await proposeNextCandidate(llm, candidate, store);
        return { config, codeChanges: [] };
    }

    try {
        const metaDir = join(store.runDir, "candidates", candidate.candidateId, ".metaharness");
        const tracesDir = join(
            store.runDir, "candidates",
            candidate.parentCandidateId ?? candidate.candidateId,
            "traces",
        );

        const systemPrompt = buildSystemPrompt(metaDir, tracesDir, candidate, worktree.path);
        const userMessage = `Candidate ${candidate.candidateId}: analyze trace failures and propose the next harness configuration. Write proposed-config.json to ${worktree.path}.`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            await runAgent(
                llm,
                `${systemPrompt}\n\n${userMessage}`,
                async (msg) => { console.log(`[CODE-PROPOSER] ${msg}`); },
                undefined,                       // media
                controller.signal,               // signal
                undefined,                       // historyFork
                "complex",                       // modelHint → Pro tier
                CODE_PROPOSER_ALLOWED_TOOLS,     // toolAllowlist
                undefined,                       // channelContext
            );
        } catch (err) {
            clearTimeout(timer);
            console.warn(`[CODE-PROPOSER] runAgent failed: ${(err as Error).message}`);
            return { config: candidate.harnessConfig, codeChanges: [] };
        }
        clearTimeout(timer);

        // Read proposed-config.json
        const proposedConfigPath = join(worktree.path, "proposed-config.json");
        let config: HarnessConfig;
        if (existsSync(proposedConfigPath)) {
            try {
                const parsed = JSON.parse(readFileSync(proposedConfigPath, "utf-8")) as HarnessConfig;
                config = {
                    candidateId: candidate.candidateId,
                    dimensions: { ...candidate.harnessConfig.dimensions, ...(parsed.dimensions ?? {}) },
                    createdAt: parsed.createdAt ?? new Date().toISOString(),
                };
            } catch {
                console.warn("[CODE-PROPOSER] Invalid proposed-config.json — using parent config");
                config = candidate.harnessConfig;
            }
        } else {
            config = candidate.harnessConfig;
        }

        const codeChanges = collectCodeChanges(worktree.path);
        return { config, codeChanges };
    } finally {
        try { worktree.cleanup(); } catch { /* best-effort */ }
    }
}

function buildSystemPrompt(
    metaDir: string,
    tracesDir: string,
    candidate: CandidateManifest,
    worktreePath: string,
): string {
    return `You are optimizing the ATLAS harness configuration.

CRITICAL RULE — READ INDIVIDUAL TRACE FILES:
The traces/ directory contains one JSON file per agent invocation. Read them individually using read_file.
Do NOT rely on summary.json — summaries hide the specific failures you need to diagnose.
(Paper 2603.28052: summary-only context gives median accuracy 34.9 vs 50.0 for raw trace access.)

Available tools: read_file, write_file, grep_file, glob_files.
(No shell_exec available — use glob_files to enumerate trace files and read_file to read each.)

Files to read:
- ${join(metaDir, "AGENTS.md")} — candidate-specific instructions
- ${join(metaDir, "registry-dimensions.md")} — tunable parameters with ranges
- ${join(metaDir, "candidate-history.json")} — all prior candidates
- Trace files: use glob_files("${tracesDir}/*.json") to list, then read_file on each

Output:
- Write ${worktreePath}/proposed-config.json (required)
- Optionally write TypeScript patches to ${worktreePath}/src/harness/proposed-changes/*.ts

Candidate: ${candidate.candidateId} | Parent: ${candidate.parentCandidateId ?? "none"}
Rules: max 4 dimensions changed, all values within registry [min,max], changes must cite specific trace evidence.`;
}

function collectCodeChanges(worktreePath: string): CodeChange[] {
    const changesDir = join(worktreePath, "src/harness/proposed-changes");
    if (!existsSync(changesDir)) return [];
    const changes: CodeChange[] = [];
    try {
        for (const entry of readdirSync(changesDir)) {
            const full = join(changesDir, entry);
            try {
                if (statSync(full).isFile()) {
                    changes.push({ patchFile: entry, content: readFileSync(full, "utf-8") });
                }
            } catch { /* skip unreadable */ }
        }
    } catch { /* */ }
    return changes;
}
