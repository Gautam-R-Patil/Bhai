// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Meta-Harness: Proposer ─────────────────────────────────────────────────
// Uses ATLAS's own LLM client to read all prior candidate history + traces
// from the .metaharness/ filesystem and propose the next harness configuration.
//
// This implements the core Meta-Harness paper insight: giving the proposer
// ~10M tokens of diagnostic context (all prior candidates, traces, scores)
// via filesystem ops, enabling causal reasoning about what failed and why.
//
// The proposer is instructed to read specific files (AGENTS.md, registry-
// dimensions.md, candidate-history.json, parent traces) and then write a
// proposed-config.json with targeted dimension changes.

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";
import type { CandidateManifest, HarnessConfig } from "./types.js";
import type { HarnessRunStore } from "./run-store.js";
import { getRegistry, getDimension } from "./registry.js";
import { extractJSON } from "../utils/json-extract.js";

// ── Proposer ────────────────────────────────────────────────────────────────

/**
 * Read the .metaharness/ filesystem for the candidate and propose a new
 * HarnessConfig by calling the LLM with full diagnostic context.
 *
 * This is the heart of Meta-Harness: the agent reads ALL prior history
 * and makes targeted, causally-motivated changes rather than random search.
 */
export async function proposeNextCandidate(
    llm: LLMClient,
    candidate: CandidateManifest,
    runStore: HarnessRunStore,
): Promise<HarnessConfig> {
    const metaDir = join(runStore.runDir, "candidates", candidate.candidateId, ".metaharness");

    // Build rich context by reading the .metaharness/ filesystem
    const context = _buildProposerContext(metaDir, candidate, runStore);

    const systemPrompt = `You are an expert AI systems optimizer working on the ATLAS autonomous agent.
Your task is to analyze the harness configuration history and propose targeted improvements.

Rules:
- Propose changes to at most 4 dimensions at once
- All changes must stay within the [min, max] ranges shown in the registry
- Motivate every change with specific evidence from the execution traces or scores
- Output ONLY a valid JSON object for the proposed-config.json file
- Do not include explanations outside the JSON`;

    const userPrompt = `${context}

Based on the above analysis, propose the next harness configuration.

Output ONLY valid JSON in this exact format:
{
  "candidateId": "${candidate.candidateId}",
  "dimensions": {
    "dimension.id": newValue,
    ...
  },
  "reasoning": "Brief explanation of why these specific changes were chosen",
  "createdAt": "${new Date().toISOString()}"
}

Focus on the dimensions most likely to improve the composite score based on the trace failures.`;

    const messages: ChatCompletionMessageParam[] = [
        { role: "user", content: userPrompt },
    ];

    try {
        const response = await llm.chat({
            messages,
            systemPrompt,
            thinkingLevel: "medium",  // this is a reasoning task
            responseFormat: "json_object",
        });

        const text = response.choices?.[0]?.message?.content || "{}";
        const jsonStr = extractJSON(text);
        if (!jsonStr) throw new Error("Proposer returned no JSON");

        const parsed = JSON.parse(jsonStr);
        const proposedDimensions: Record<string, unknown> = {};

        // Validate and clamp all proposed values against registry constraints
        for (const [id, value] of Object.entries(parsed.dimensions ?? {})) {
            const dim = getDimension(id);
            if (!dim) {
                console.warn(`[PROPOSER] Unknown dimension "${id}" — skipping`);
                continue;
            }
            if (typeof value === "number" && dim.minValue !== undefined && dim.maxValue !== undefined) {
                proposedDimensions[id] = Math.max(dim.minValue, Math.min(dim.maxValue, value));
            } else if (typeof value === "string") {
                proposedDimensions[id] = value;
            } else {
                proposedDimensions[id] = value;
            }
        }

        if (Object.keys(proposedDimensions).length === 0) {
            console.warn("[PROPOSER] No valid dimensions proposed — returning parent config");
            return candidate.harnessConfig;
        }

        // Merge with parent config (inherit unspecified dimensions)
        const merged = {
            ...candidate.harnessConfig.dimensions,
            ...proposedDimensions,
        };

        const config: HarnessConfig = {
            candidateId: candidate.candidateId,
            dimensions: merged,
            createdAt: new Date().toISOString(),
        };

        console.log(`[PROPOSER] Proposed ${Object.keys(proposedDimensions).length} changes for ${candidate.candidateId}:`);
        for (const [id, v] of Object.entries(proposedDimensions)) {
            const parent = candidate.harnessConfig.dimensions[id];
            console.log(`  ${id}: ${JSON.stringify(parent)} → ${JSON.stringify(v)}`);
        }
        if (parsed.reasoning) {
            console.log(`[PROPOSER] Reasoning: ${parsed.reasoning}`);
        }

        return config;
    } catch (err) {
        console.error("[PROPOSER] Failed to get proposal from LLM:", (err as Error).message);
        // Return parent config as a no-op fallback
        return candidate.harnessConfig;
    }
}

// ── Context builder ─────────────────────────────────────────────────────────

function _buildProposerContext(
    metaDir: string,
    candidate: CandidateManifest,
    runStore: HarnessRunStore,
): string {
    const sections: string[] = [];

    // 1. AGENTS.md instructions (already written by run-store)
    const agentsMdPath = join(metaDir, "AGENTS.md");
    if (existsSync(agentsMdPath)) {
        sections.push("## Instructions\n" + readFileSync(agentsMdPath, "utf-8"));
    }

    // 2. Registry dimensions with current values
    const dimsMdPath = join(metaDir, "registry-dimensions.md");
    if (existsSync(dimsMdPath)) {
        sections.push(readFileSync(dimsMdPath, "utf-8"));
    }

    // 3. Parent summary (scores + trace analysis)
    const parentSummaryPath = join(metaDir, "parent-summary.json");
    if (existsSync(parentSummaryPath)) {
        try {
            const ps = JSON.parse(readFileSync(parentSummaryPath, "utf-8"));
            sections.push(`## Parent Performance Summary
Parent: ${ps.parentCandidateId}
Objective: ${ps.parentObjective ?? "not scored"}
Outcome: ${ps.parentOutcome}

${ps.traceSummary || "No trace summary available."}`);
        } catch { /* non-fatal */ }
    }

    // 4. Candidate history (key for causal reasoning — what has been tried before)
    const historyPath = join(metaDir, "candidate-history.json");
    if (existsSync(historyPath)) {
        try {
            const history = JSON.parse(readFileSync(historyPath, "utf-8")) as Array<{
                candidateId: string;
                objective: number | null;
                outcome: string;
                outcomeSummary: string;
            }>;
            sections.push(`## Candidate History (${history.length} candidates)
${history.map(c => `- **${c.candidateId}**: score=${c.objective ?? "n/a"}, outcome=${c.outcome} — ${c.outcomeSummary}`).join("\n")}`);
        } catch { /* non-fatal */ }
    }

    // 5. Parent config snapshot (what was tried)
    const parentConfigPath = join(metaDir, "experience", "parent", "harness-config.json");
    if (existsSync(parentConfigPath)) {
        try {
            const pc = JSON.parse(readFileSync(parentConfigPath, "utf-8"));
            sections.push(`## Parent Harness Config
\`\`\`json
${JSON.stringify(pc.dimensions ?? {}, null, 2)}
\`\`\``);
        } catch { /* non-fatal */ }
    }

    // 6. Parent scores (detailed breakdown)
    const scoresPath = join(metaDir, "experience", "parent", "scores.json");
    if (existsSync(scoresPath)) {
        try {
            const sc = JSON.parse(readFileSync(scoresPath, "utf-8"));
            sections.push(`## Parent Score Breakdown
- Composite: ${sc.composite}
- Memory recall: ${sc.memoryRecallScore}
- Tool selection: ${sc.toolSelectionScore}
- Task completion: ${sc.taskCompletionScore}
- Token efficiency: ${sc.tokenEfficiency}`);
        } catch { /* non-fatal */ }
    }

    // 7. Trace summary (most diagnostic section)
    const traceSummaryPath = join(metaDir, "experience", "parent", "traces", "summary.json");
    if (existsSync(traceSummaryPath)) {
        try {
            const ts = JSON.parse(readFileSync(traceSummaryPath, "utf-8"));
            sections.push(`## Execution Trace Analysis
Total traces: ${ts.count ?? 0}
Success rate: ${ts.successRate !== undefined ? (ts.successRate * 100).toFixed(1) + "%" : "n/a"}
Avg eval score: ${ts.avgEvalScore?.toFixed(1) ?? "n/a"}

Recent traces (last 5):
${(ts.traces ?? []).slice(-5).map((t: { queryText: string; taskSucceeded: boolean; evaluationScore: number | null; memoryHitCount: number }) =>
    `  - [${t.taskSucceeded ? "✓" : "✗"}] "${t.queryText.substring(0, 60)}" evalScore=${t.evaluationScore ?? "n/a"} memHits=${t.memoryHitCount}`
).join("\n")}`);
        } catch { /* non-fatal */ }
    }

    return sections.join("\n\n---\n\n");
}
