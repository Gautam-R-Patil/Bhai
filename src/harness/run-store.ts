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
import type { CandidateManifest, DimensionGradient, HarnessConfig, HarnessScore } from "./types.js";
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

        // Copy individual parent trace files into experience/parent/traces/
        // The proposer must read individual files (not summaries) — paper ablation shows
        // summary-only context gives median accuracy 34.9 vs 50.0 for raw-trace access.
        const parentTracesSourceDir = join(this.runDir, "candidates", parent.candidateId, "traces");
        const parentTraces = readCandidateTraces(this.runDir, parent.candidateId);
        const destTracesDir = join(experienceDir, "traces");
        mkdirSync(destTracesDir, { recursive: true });
        if (existsSync(parentTracesSourceDir)) {
            try {
                for (const file of readdirSync(parentTracesSourceDir).filter(f => f.endsWith(".json"))) {
                    copyFileSync(join(parentTracesSourceDir, file), join(destTracesDir, file));
                }
            } catch { /* non-fatal — proposer can still read from original path */ }
        }
        // Also write an aggregate summary alongside the individual files
        if (parentTraces.length > 0) {
            this._writeJson(join(destTracesDir, "summary.json"), {
                count: parentTraces.length,
                successRate: parentTraces.filter(t => t.taskSucceeded).length / parentTraces.length,
                avgEvalScore: parentTraces
                    .filter(t => t.evaluationScore !== null)
                    .reduce((s, t) => s + (t.evaluationScore ?? 0), 0)
                    / (parentTraces.filter(t => t.evaluationScore !== null).length || 1),
            });
        }

        // Absolute path for the candidate dir — used by bootstrap + AGENTS.md builders
        const candidateAbsDir = join(this.candidatesDir, candidate.candidateId);

        // Bootstrap summary: ATLAS architecture context
        const bootstrapSummary = _buildBootstrapSummary(parent, parentTraces.length, candidateAbsDir);
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
        const agentsMd = _buildAgentsMd(objective, parent, candidate, candidateAbsDir);
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

    /** Write TextGrad dimension gradient hints into the candidate's .metaharness/. */
    writeGradientHints(candidateId: string, gradients: DimensionGradient[]): void {
        const metaDir = join(this.candidatesDir, candidateId, ".metaharness");
        mkdirSync(metaDir, { recursive: true });
        const lines: string[] = ["# Dimension Gradient Hints", ""];
        for (const g of gradients) {
            lines.push(`## ${g.dimensionId}`);
            lines.push(`- Direction: ${g.proposedDirection}`);
            lines.push(`- Severity: ${g.severity}`);
            lines.push(`- Current value: \`${JSON.stringify(g.currentValue)}\``);
            lines.push(`- Critique: ${g.critique}`);
            lines.push("");
        }
        writeFileSync(join(metaDir, "gradient-hints.md"), lines.join("\n"), "utf-8");
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

function _buildBootstrapSummary(
    parent: CandidateManifest,
    traceCount: number,
    candidateAbsDir: string,
): string {
    const metaAbs = join(candidateAbsDir, ".metaharness");
    return `# ATLAS Meta-Harness Run Bootstrap

## What you are optimizing
ATLAS is a continuously running autonomous personal AI agent (Node.js/TypeScript).
You are optimizing its "harness" — the configuration parameters that control how ATLAS:
- Retrieves and weighs memories, selects tools, assembles context, evaluates responses

## Parent candidate: ${parent.candidateId}
- Objective score: ${parent.objective ?? "not yet scored"} | Outcome: ${parent.outcome}
- ${traceCount} execution traces available (read them individually — do NOT rely on summary)

## How to propose changes (use ABSOLUTE paths)
1. Read ${join(metaAbs, "AGENTS.md")} for full instructions
2. Read ${join(metaAbs, "registry-dimensions.md")} for all tunable dimensions
3. Read ${join(metaAbs, "experience", "parent", "traces")} for individual trace files
4. Write your proposed config to ${join(candidateAbsDir, "proposed-config.json")}

Note: read_file → use tool named \`read\`, glob_files → \`glob\`, grep_file → \`grep\`, write_file → \`write\`
`;
}

function _buildAgentsMd(
    objective: string,
    parent: CandidateManifest,
    candidate: CandidateManifest,
    candidateAbsDir: string,   // absolute path to candidates/<id>/ directory
): string {
    const metaAbs = join(candidateAbsDir, ".metaharness");
    const tracesAbs = join(metaAbs, "experience", "parent", "traces");
    const proposedConfigAbs = join(candidateAbsDir, "proposed-config.json");

    return `# MetaHarness Candidate Instructions

## Objective
${objective}

## Your task
Improve ATLAS's harness configuration to increase the objective score above the parent candidate (${parent.candidateId}, score: ${parent.objective ?? "n/a"}).

## CRITICAL — Read individual trace files using ABSOLUTE paths
Paper 2603.28052 ablation: summary-only context gives median accuracy 34.9
vs 50.0 for raw trace access. Summaries hide the specific failures you need
to diagnose. Use the \`read\` tool with the absolute paths shown below.

Do NOT use relative paths like \`.metaharness/...\` — they will fail because
your working directory may not be the harness data directory.

### Recommended workflow
1. \`glob\` pattern \`${tracesAbs}/*.json\` to list all trace files
2. \`read\` each individual trace JSON file (absolute path from glob output)
3. \`grep\` for \`"taskSucceeded": false\` to find failing traces quickly
4. Map failure patterns to specific dimensions in registry-dimensions.md
5. Write your proposed config to the absolute path shown in "Output" below

## Constraints
- Only modify \`proposed-config.json\` (absolute path below)
- Only change dimensions listed in registry-dimensions.md
- All numeric values must stay within the [min, max] ranges shown
- Do not change more than 4 dimensions at once
- Every change must cite a specific trace file as evidence

## Workspace layout (use these ABSOLUTE paths)
- ${join(metaAbs, "AGENTS.md")} — this file
- ${join(metaAbs, "registry-dimensions.md")} — all tunable parameters
- ${join(metaAbs, "parent-summary.json")} — parent scores and trace count
- ${join(metaAbs, "candidate-history.json")} — full history of all candidates
- ${join(metaAbs, "experience", "parent", "manifest.json")} — parent manifest
- ${join(metaAbs, "experience", "parent", "scores.json")} — parent evaluation scores
- ${tracesAbs}/<timestamp>_<uuid>.json — individual execution traces (read these directly)
- ${join(metaAbs, "gradient-hints.md")} — dimension critiques (if present; advisory, verify with traces)

## TextGrad Critiques (if gradient-hints.md exists)
${join(metaAbs, "gradient-hints.md")} may contain dimension-level critiques with severity ratings.
These are prior hypotheses — use them to prioritize trace inspection, but always verify
against actual trace evidence before proposing changes.

## Allowed tools
- \`read\` — read any file by absolute path
- \`glob\` — enumerate trace files (glob pattern)
- \`grep\` — search inside files
- \`write\` — write proposed-config.json only

## Forbidden
- Do not modify any file other than proposed-config.json
- Do not fabricate scores — the external evaluator decides outcomes
- Do NOT use summary.json as a substitute for individual trace files

## Output
Write a valid JSON file to this exact path:
${proposedConfigAbs}

Format:
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
