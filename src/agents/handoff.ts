// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Structured Handoff Messages ──────────────
// Replaces raw output concatenation between sub-agent steps
// with structured, token-efficient context propagation.

import type { SubAgentResult, AgentRole } from "./sub-agent.js";
import type { MeshStep } from "./mesh.js";

// ── Constants ────────────────────────────────

const MAX_SUMMARY_CHARS = 300;
const MAX_FINDINGS = 5;
const MAX_FINDING_CHARS = 150;
const MAX_ERRORS = 3;
const MAX_RAW_TAIL_CHARS = 1500;
const MAX_ARTIFACT_CHARS = 200; // cap each path/url — URL_PATTERN can match arbitrarily long URLs

// ── Types ────────────────────────────────────

export interface HandoffMessage {
    fromStep: string;
    fromRole: AgentRole;
    status: "success" | "partial" | "failed";
    summary: string;
    keyFindings: string[];
    artifacts: ArtifactRef[];
    errors: string[];
    rawOutputTail: string;
}

export interface ArtifactRef {
    type: "file" | "url" | "data";
    path: string;
}

// ── Extraction Patterns ──────────────────────

const FILE_PATH_PATTERN = /(?:^|\s)(\/[\w/._-]+\.\w{1,10})\b/g;
const URL_PATTERN = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
const BULLET_PATTERN = /^\s*[-*•]\s+(.+)/gm;
const ERROR_PATTERN = /(?:^|\n).*(?:error|failed|warning|exception)[:.\s].{5,}/gi;

// ── Builder ──────────────────────────────────

/**
 * Build a structured handoff message from a sub-agent result.
 */
export function buildHandoff(result: SubAgentResult, step: MeshStep): HandoffMessage {
    const output = result.output || "";

    // Extract summary: first paragraph or first 300 chars
    const firstPara = output.split(/\n\n/)[0] || output;
    const summary = firstPara.substring(0, MAX_SUMMARY_CHARS).trim();

    // Extract bullet points as key findings
    const findings: string[] = [];
    let match;
    BULLET_PATTERN.lastIndex = 0;
    while ((match = BULLET_PATTERN.exec(output)) !== null && findings.length < MAX_FINDINGS) {
        const finding = match[1].substring(0, MAX_FINDING_CHARS).trim();
        if (finding.length > 10) findings.push(finding);
    }

    // Extract file paths and URLs as artifacts
    const artifacts: ArtifactRef[] = [];
    const seenPaths = new Set<string>();

    FILE_PATH_PATTERN.lastIndex = 0;
    while ((match = FILE_PATH_PATTERN.exec(output)) !== null && artifacts.length < 10) {
        const path = match[1].substring(0, MAX_ARTIFACT_CHARS);
        if (!seenPaths.has(path)) {
            seenPaths.add(path);
            artifacts.push({ type: "file", path });
        }
    }

    URL_PATTERN.lastIndex = 0;
    while ((match = URL_PATTERN.exec(output)) !== null && artifacts.length < 10) {
        const url = match[0].substring(0, MAX_ARTIFACT_CHARS);
        if (!seenPaths.has(url)) {
            seenPaths.add(url);
            artifacts.push({ type: "url", path: url });
        }
    }

    // Extract errors
    const errors: string[] = [];
    if (result.error) {
        errors.push(result.error.substring(0, MAX_FINDING_CHARS));
    }
    ERROR_PATTERN.lastIndex = 0;
    while ((match = ERROR_PATTERN.exec(output)) !== null && errors.length < MAX_ERRORS) {
        const errMsg = match[0].trim().substring(0, MAX_FINDING_CHARS);
        if (errMsg.length > 10 && !errors.includes(errMsg)) errors.push(errMsg);
    }

    // Raw tail for edge cases
    const rawOutputTail = output.length > MAX_RAW_TAIL_CHARS
        ? output.substring(output.length - MAX_RAW_TAIL_CHARS)
        : output;

    return {
        fromStep: step.id,
        fromRole: step.role,
        status: result.success ? "success" : (result.output ? "partial" : "failed"),
        summary,
        keyFindings: findings,
        artifacts,
        errors,
        rawOutputTail,
    };
}

// ── Serializer ───────────────────────────────

/**
 * Serialize a handoff message into a human-readable format
 * that LLMs can naturally parse.
 */
export function serializeHandoff(handoff: HandoffMessage): string {
    const lines: string[] = [];

    lines.push(`[HANDOFF from ${handoff.fromStep} (${handoff.fromRole}) - ${handoff.status.toUpperCase()}]`);

    if (handoff.summary) {
        lines.push(`Summary: ${handoff.summary}`);
    }

    if (handoff.keyFindings.length > 0) {
        lines.push("Findings:");
        for (const f of handoff.keyFindings) {
            lines.push(`  - ${f}`);
        }
    }

    if (handoff.artifacts.length > 0) {
        const artifactStrs = handoff.artifacts.map(a => `${a.type}:${a.path}`);
        lines.push(`Artifacts: ${artifactStrs.join(", ")}`);
    }

    if (handoff.errors.length > 0) {
        lines.push("Errors:");
        for (const e of handoff.errors) {
            lines.push(`  ⚠️ ${e}`);
        }
    }

    // The summary is only the first paragraph; the tail carries the actual
    // result (tables, values, conclusions) that downstream steps need.
    const tail = handoff.rawOutputTail.trim();
    if (tail && tail !== handoff.summary) {
        lines.push(`Output (last ${MAX_RAW_TAIL_CHARS} chars):`, tail);
    }

    lines.push("[END HANDOFF]");

    return lines.join("\n");
}

// ── Mesh Integration Helper ──────────────────

/**
 * Build structured context from dependency results for a step.
 * Replaces raw output concatenation in mesh.ts.
 */
export function buildDependencyContext(
    step: MeshStep,
    results: Map<string, { result: SubAgentResult; step: MeshStep }>,
): string {
    return step.depends_on
        .map(depId => {
            const dep = results.get(depId);
            if (!dep) return "";
            const handoff = buildHandoff(dep.result, dep.step);
            return serializeHandoff(handoff);
        })
        .filter(Boolean)
        .join("\n\n");
}
