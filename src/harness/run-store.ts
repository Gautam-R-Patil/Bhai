// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Meta-Harness: Filesystem Run Store ────────────────────────────────────
// Manages optimization run state as a filesystem directory tree, enabling
// the proposer agent to read all prior candidates, traces, and scores via
// standard file operations. Inspired by the Meta-Harness paper (2603.28052).
//
// Layout:
//   data/harness/runs/<run_id>/
//   ├── run_config.json
//   ├── indexes/leaderboard.json
//   └── candidates/
//       ├── c0000/               ← baseline
//       │   ├── manifest.json
//       │   ├── harness-config.json
//       │   ├── scores.json
//       │   ├── traces/          ← execution traces written by trace-store
//       │   └── .metaharness/    ← proposer reads this
//       │       ├── AGENTS.md
//       │       ├── bootstrap/summary.md
//       │       └── experience/parent/
//       └── c0001/...

import {
    mkdirSync, writeFileSync, readFileSync, existsSync,
    readdirSync, copyFileSync, statSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import type { CandidateManifest, HarnessConfig, HarnessScore } from "./types.js";
import { snapshotConfig, formatRegistrySummary } from "./registry.js";
import { readCandidateTraces } from "./trace-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ATLAS_DATA_DIR = process.env.ATLAS_DATA_DIR || join(__dirname, "../../data");
const RUNS_BASE_DIR = join(ATLAS_DATA_DIR, "harness/runs");

// ── HarnessRunStore ─────────────────────────────────────────────────────────

export class HarnessRunStore {
    readonly runDir: string;
    readonly runId: string;
    private readonly candidatesDir: string;
    private readonly indexesDir: string;

    constructor(runDir?: string) {
        this.runId = runDir ? dirname(runDir).split("/").pop() ?? randomUUID().substring(0, 8) : _newRunId();
        this.runDir = runDir ?? join(RUNS_BASE_DIR, this.runId);
        this.candidatesDir = join(this.runDir, "candidates");
        this.indexesDir = join(this.runDir, "indexes");
    }

    /** Initialize the run directory structure and write config. */
    initializeRun(config: object): void {
        mkdirSync(this.runDir, { recursive: true });
        mkdirSync(this.candidatesDir, { recursive: true });
        mkdirSync(this.indexesDir, { recursive: true });
        this._writeJson(join(this.runDir, "run_config.json"), {
            ...config,
            startedAt: new Date().toISOString(),
        });
    }

    /** Materialize the baseline candidate (c0000) from the current registry state. */
    materializeBaseline(): CandidateManifest {
        return this._materializeCandidate("c0000", null);
    }

    /** Materialize a new candidate as a child of the given parent. */
    materializeCandidate(parent: CandidateManifest): CandidateManifest {
        const idx = this._nextCandidateIndex();
        const candidateId = `c${String(idx).padStart(4, "0")}`;
        return this._materializeCandidate(candidateId, parent.candidateId);
    }

    /**
     * Write the .metaharness/ instruction bundle into the candidate directory.
     * This is what the proposer agent reads to understand what to optimize.
     * Returns the path to the AGENTS.md instructions file.
     */
    writeInstructionBundle(
        candidate: CandidateManifest,
        parent: CandidateManifest,
        objective: string,
    ): string {
        const metaDir = join(this.candidatesDir, candidate.candidateId, ".metaharness");
        const experienceDir = join(metaDir, "experience", "parent");
        const bootstrapDir = join(metaDir, "bootstrap");
        mkdirSync(experienceDir, { recursive: true });
        mkdirSync(bootstrapDir, { recursive: true });

        // Copy parent artifacts into experience/parent/
        this._copyParentArtifacts(parent, experienceDir);

        // Copy parent traces into experience/parent/traces/
        const parentTraces = readCandidateTraces(this.runDir, parent.candidateId);
        if (parentTraces.length > 0) {
            const tracesDir = join(experienceDir, "traces");
            mkdirSync(tracesDir, { recursive: true });
            this._writeJson(join(tracesDir, "summary.json"), {
                count: parentTraces.length,
                successRate: parentTraces.filter(t => t.taskSucceeded).length / parentTraces.length,
                avgEvalScore: parentTraces
                    .filter(t => t.evaluationScore !== null)
                    .reduce((s, t) => s + (t.evaluationScore ?? 0), 0)
                    / (parentTraces.filter(t => t.evaluationScore !== null).length || 1),
                traces: parentTraces.slice(-20),  // last 20 for proposer context
            });
        }

        // Bootstrap summary: ATLAS architecture context
        const bootstrapSummary = _buildBootstrapSummary(parent, parentTraces.length);
        writeFileSync(join(bootstrapDir, "summary.md"), bootstrapSummary, "utf-8");

        // Registry snapshot for proposer
        this._writeJson(join(metaDir, "registry-snapshot.json"), parent.harnessConfig);
        writeFileSync(join(metaDir, "registry-dimensions.md"), formatRegistrySummary(), "utf-8");

        // Parent summary for quick reference
        // Note: traceSummary removed intentionally (v2) — proposer agent must
        // read individual trace files (paper 2603.28052 ablation: summaries
        // hide the specific failures needed for diagnosis).
        this._writeJson(join(metaDir, "parent-summary.json"), {
            parentCandidateId: parent.candidateId,
            parentObjective: parent.objective,
            parentOutcome: parent.outcome,
            traceCount: parentTraces.length,
            traceDir: "experience/parent/traces",
            hint: "Read individual trace files from traceDir. Do NOT rely on summary aggregates.",
        });

        // History leaderboard (all candidates so far)
        const history = this.readCandidateHistory();
        if (history.length > 0) {
            this._writeJson(join(metaDir, "candidate-history.json"), history.map(c => ({
                candidateId: c.candidateId,
                objective: c.objective,
                outcome: c.outcome,
                outcomeSummary: c.outcomeSummary,
                scores: c.scores,
            })));
        }

        // AGENTS.md — the main instruction file
        const agentsMd = _buildAgentsMd(objective, parent, candidate);
        const agentsMdPath = join(metaDir, "AGENTS.md");
        writeFileSync(agentsMdPath, agentsMd, "utf-8");

        return agentsMdPath;
    }

    /** Write evaluation scores to a candidate's scores.json. */
    writeScores(candidateId: string, scores: HarnessScore): void {
        const dir = join(this.candidatesDir, candidateId);
        mkdirSync(dir, { recursive: true });
        this._writeJson(join(dir, "scores.json"), scores);
    }

    /** Write the candidate manifest (source of truth for outcome + scores). */
    writeManifest(candidate: CandidateManifest): void {
        const dir = join(this.candidatesDir, candidate.candidateId);
        mkdirSync(dir, { recursive: true });
        this._writeJson(join(dir, "manifest.json"), {
            ...candidate,
            updatedAt: new Date().toISOString(),
        });
    }

    /** Write the final leaderboard to indexes/leaderboard.json. */
    writeLeaderboard(best: CandidateManifest, allIds: string[]): void {
        this._writeJson(join(this.indexesDir, "leaderboard.json"), {
            bestCandidateId: best.candidateId,
            bestObjective: best.objective,
            candidates: allIds,
            completedAt: new Date().toISOString(),
        });
    }

    /** Read all candidate manifests in this run (sorted by creation order). */
    readCandidateHistory(): CandidateManifest[] {
        if (!existsSync(this.candidatesDir)) return [];
        const dirs = readdirSync(this.candidatesDir)
            .filter(d => d.startsWith("c") && existsSync(join(this.candidatesDir, d, "manifest.json")))
            .sort();
        return dirs.map(d => {
            try {
                const raw = readFileSync(join(this.candidatesDir, d, "manifest.json"), "utf-8");
                return JSON.parse(raw) as CandidateManifest;
            } catch { return null; }
        }).filter(Boolean) as CandidateManifest[];
    }

    /** Read a single candidate's proposed harness config if it exists. */
    readProposedConfig(candidateId: string): HarnessConfig | null {
        const p = join(this.candidatesDir, candidateId, "proposed-config.json");
        if (!existsSync(p)) return null;
        try {
            return JSON.parse(readFileSync(p, "utf-8")) as HarnessConfig;
        } catch { return null; }
    }

    /** Write a proposed config for a candidate (written by proposer.ts). */
    writeProposedConfig(candidateId: string, config: HarnessConfig): void {
        const dir = join(this.candidatesDir, candidateId);
        mkdirSync(dir, { recursive: true });
        this._writeJson(join(dir, "proposed-config.json"), config);
        // Also write as harness-config.json for consistency
        this._writeJson(join(dir, "harness-config.json"), config);
    }

    // ── Internal helpers ──────────────────────────────────────────────────

    private _materializeCandidate(
        candidateId: string,
        parentCandidateId: string | null,
    ): CandidateManifest {
        const dir = join(this.candidatesDir, candidateId);
        mkdirSync(dir, { recursive: true });

        const config = snapshotConfig(candidateId);
        this._writeJson(join(dir, "harness-config.json"), config);

        const manifest: CandidateManifest = {
            candidateId,
            parentCandidateId,
            objective: null,
            valid: false,
            outcome: parentCandidateId === null ? "baseline" : "no-change",
            outcomeSummary: parentCandidateId === null ? "Baseline candidate." : "",
            harnessConfig: config,
            scores: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        this.writeManifest(manifest);
        return manifest;
    }

    private _nextCandidateIndex(): number {
        if (!existsSync(this.candidatesDir)) return 1;
        const ids = readdirSync(this.candidatesDir)
            .filter(d => /^c\d+$/.test(d));
        if (ids.length === 0) return 1;
        return Math.max(...ids.map(d => parseInt(d.slice(1), 10))) + 1;
    }

    private _copyParentArtifacts(parent: CandidateManifest, targetDir: string): void {
        const srcDir = join(this.candidatesDir, parent.candidateId);
        for (const filename of ["manifest.json", "scores.json", "harness-config.json"]) {
            const src = join(srcDir, filename);
            if (existsSync(src)) {
                mkdirSync(targetDir, { recursive: true });
                copyFileSync(src, join(targetDir, filename));
            }
        }
    }

    private _writeJson(path: string, data: unknown): void {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function _newRunId(): string {
    const ts = new Date().toISOString().replace(/[:.TZ-]/g, "").substring(0, 14);
    return `run_${ts}_${randomUUID().substring(0, 6)}`;
}

function _buildBootstrapSummary(parent: CandidateManifest, traceCount: number): string {
    return `# ATLAS Meta-Harness Run Bootstrap

## What you are optimizing
ATLAS is a continuously running autonomous personal AI agent (Node.js/TypeScript).
You are optimizing its "harness" — the configuration parameters that control how ATLAS:
- Retrieves and weighs memories
- Selects tools for each task
- Assembles context for the LLM
- Evaluates and escalates responses
- Runs research and multi-agent tasks

## Parent candidate: ${parent.candidateId}
- Objective score: ${parent.objective ?? "not yet scored"}
- Outcome: ${parent.outcome}
- Config snapshot: see harness-config.json
- Execution traces: ${traceCount} traces available in traces/ directory

## How to propose changes
1. Read \`.metaharness/AGENTS.md\` for full instructions
2. Read \`.metaharness/registry-dimensions.md\` for all tunable dimensions
3. Read \`.metaharness/parent-summary.json\` to understand what failed
4. Read \`.metaharness/experience/parent/traces/summary.json\` for trace data
5. Write your proposed config to \`proposed-config.json\`

## Key files
- \`.metaharness/registry-dimensions.md\` — all tunable parameters with ranges
- \`.metaharness/candidate-history.json\` — all prior candidates and their scores
- \`.metaharness/parent-summary.json\` — parent performance summary
- \`proposed-config.json\` — write your proposed config here (JSON)
`;
}

function _buildAgentsMd(
    objective: string,
    parent: CandidateManifest,
    candidate: CandidateManifest,
): string {
    return `# MetaHarness Candidate Instructions

## Objective
${objective}

## Your task
Improve ATLAS's harness configuration to increase the objective score above the parent candidate (${parent.candidateId}, score: ${parent.objective ?? "n/a"}).

## CRITICAL — Read individual trace files, NOT aggregate summaries
Paper 2603.28052 ablation: summary-only context gives median accuracy 34.9
vs 50.0 for raw trace access. Summaries hide the specific failures you need
to diagnose. Every agent invocation in the parent candidate has its own JSON
trace file under \`.metaharness/experience/parent/traces/\` named like
\`<timestamp>_<uuid>.json\` (or similar) — read each one with \`read_file\`,
or use \`shell_exec\` with \`ls\`/\`cat\`/\`grep\`/\`find\` to enumerate and
inspect them.

Do NOT rely on \`summary.json\` or \`parent-summary.json\` aggregates — they
are intentionally thin pointers, not substitutes for the raw trace evidence.

### Recommended workflow
1. \`shell_exec\` \`ls .metaharness/experience/parent/traces/*.json\` to list traces
2. \`read_file\` each individual \`<timestamp>_<uuid>.json\` trace file
3. \`grep\` for \`"taskSucceeded": false\` or low \`evaluationScore\` values
4. Map failure patterns to specific dimensions in \`registry-dimensions.md\`
5. Write \`proposed-config.json\` with a targeted change that cites the trace

## Constraints
- Only modify \`proposed-config.json\` in this candidate directory
- Only change dimensions listed in \`.metaharness/registry-dimensions.md\`
- All numeric values must stay within the [min, max] ranges shown
- Do not change more than 4 dimensions at once per proposal
- Every change must cite a specific trace file as evidence

## Workspace layout
- \`.metaharness/AGENTS.md\` — this file
- \`.metaharness/registry-dimensions.md\` — all tunable parameters
- \`.metaharness/parent-summary.json\` — thin pointer to traces (do NOT use the summary aggregates; use the individual trace files)
- \`.metaharness/candidate-history.json\` — full history of all candidates
- \`.metaharness/experience/parent/manifest.json\` — parent manifest
- \`.metaharness/experience/parent/scores.json\` — parent evaluation scores
- \`.metaharness/experience/parent/traces/<timestamp>_<uuid>.json\` — individual execution trace files (one per agent invocation; read these directly)
- \`proposed-config.json\` — write your proposed config here

## Allowed actions
- \`read_file\` any file in this candidate directory
- \`read_file\` \`.metaharness/\` files for context
- \`shell_exec\` for \`ls\`, \`cat\`, \`grep\`, \`find\` to enumerate + inspect trace files
- \`write_file\` \`proposed-config.json\` with your proposed dimension values

## Forbidden actions
- Do not modify any other files
- Do not fabricate scores — the external evaluator decides outcomes
- Do not write more dimensions than exist in registry-dimensions.md
- Do NOT rely on the \`summary.json\` aggregates — read the individual trace files

## Evaluation contract
Your proposal will be evaluated by running ATLAS's benchmark suite with your proposed config applied. The composite score (0-100) determines if this candidate is accepted. Improve over the parent to be marked "keep".

## Current candidate: ${candidate.candidateId}
Parent: ${parent.candidateId} (score: ${parent.objective ?? "n/a"})

## Output format
Write a valid JSON file to \`proposed-config.json\` in this format:
\`\`\`json
{
  "candidateId": "${candidate.candidateId}",
  "dimensions": {
    "memory.fusion.relevanceWeight": 0.55,
    "evaluator.acceptThreshold": 68
  },
  "createdAt": "${new Date().toISOString()}"
}
\`\`\`
Only include dimensions you are changing. Unspecified dimensions inherit from the parent.
`;
}
