// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.

import type { CriticFinding } from "./critics.js";

export interface Exemplar {
    slug: string;
    description: string;
    handlerCode: string;
    testsJson: string;
    capabilities: string;
    similarity: number;
}

export interface BuildSynthesisOpts {
    name: string;
    description: string;
    parametersSchema: Record<string, unknown>;
    exemplars: Exemplar[];
    trackB: boolean;
    patternClass?: string;
    evidenceSummary?: string;
}

export function buildSynthesisPrompt(opts: BuildSynthesisOpts): string {
    const parts: string[] = [];

    parts.push("# Tool to synthesize");
    parts.push("");
    parts.push(`Name: ${opts.name}`);
    parts.push(`Description: ${opts.description}`);
    parts.push("");
    parts.push("Parameter schema:");
    parts.push("```json");
    parts.push(JSON.stringify(opts.parametersSchema, null, 2));
    parts.push("```");
    parts.push("");

    if (opts.trackB) {
        parts.push("# Track B (retrospective synthesis)");
        parts.push("");
        parts.push(`This is a retrospective synthesis from yesterday's tool-call history.`);
        if (opts.patternClass) parts.push(`Observed pattern: ${opts.patternClass}`);
        if (opts.evidenceSummary) {
            parts.push("Evidence summary:");
            parts.push(opts.evidenceSummary);
        }
        parts.push("");
    }

    if (opts.exemplars.length > 0) {
        parts.push("# Past successful tools matching this description");
        parts.push("");
        parts.push("Study these as examples of structure, test shape, and capability declarations.");
        parts.push("");
        for (const ex of opts.exemplars) {
            parts.push(`## Exemplar: ${ex.slug} (similarity: ${ex.similarity.toFixed(2)})`);
            parts.push("");
            parts.push(`Description: ${ex.description}`);
            parts.push("");
            parts.push("Handler:");
            parts.push("```js");
            parts.push(truncate(ex.handlerCode, 2000));
            parts.push("```");
            parts.push("");
            parts.push("Tests:");
            parts.push("```json");
            parts.push(truncate(ex.testsJson, 1000));
            parts.push("```");
            parts.push("");
            parts.push(`Capabilities: ${ex.capabilities}`);
            parts.push("");
        }
    } else {
        parts.push("# No similar tools exist yet");
        parts.push("");
        parts.push(
            "This is one of the first synthesized tools in this library. Set a high quality bar — your tests will be the verification standard for future similar requests.",
        );
        parts.push("");
    }

    parts.push("# Your task");
    parts.push("");
    parts.push(
        "Produce the JSON object specified in the contract. Be specific in capability declarations. Write 3-7 tests covering the happy path AND at least one edge case (bad input, missing file, network failure, etc).",
    );

    return parts.join("\n");
}

export interface BuildDiagnoseOpts {
    priorHandlerCode: string;
    failures: Array<{
        description: string;
        input: Record<string, unknown>;
        expectedKind: string;
        expectedValue: unknown;
        actual: unknown;
        stack?: string;
    }>;
    sastFindings: CriticFinding[];
    attemptNumber: number;
    maxAttempts: number;
}

export function buildDiagnosePrompt(opts: BuildDiagnoseOpts): string {
    const parts: string[] = [];

    parts.push("# Prior attempt failed");
    parts.push("");
    parts.push("Your previous response produced this handler:");
    parts.push("```js");
    parts.push(truncate(opts.priorHandlerCode, 3000));
    parts.push("```");
    parts.push("");

    if (opts.failures.length > 0) {
        parts.push(`When run against your own tests, ${opts.failures.length} failed:`);
        parts.push("");
        for (const f of opts.failures) {
            parts.push(`## Test: ${f.description}`);
            parts.push(`Input: ${JSON.stringify(f.input)}`);
            parts.push(`Expected: ${f.expectedKind} = ${JSON.stringify(f.expectedValue)}`);
            parts.push(`Actual: ${JSON.stringify(f.actual).slice(0, 200)}`);
            if (f.stack) parts.push(`Stack: ${f.stack.split("\n").slice(0, 5).join("\n")}`);
            parts.push("");
        }
    }

    if (opts.sastFindings.length > 0) {
        parts.push("## SAST findings (must be resolved)");
        for (const f of opts.sastFindings) {
            parts.push(`- ${f.ruleId} (line ${f.line ?? "?"}): ${f.message}`);
        }
        parts.push("");
    }

    parts.push("# Your task");
    parts.push("");
    parts.push("Diagnose WHY the failures happened, then produce a corrected JSON response.");
    parts.push(`Your synthesis_notes MUST explain what you changed and why.`);
    parts.push("");
    parts.push(`This is attempt ${opts.attemptNumber} of ${opts.maxAttempts}.`);

    return parts.join("\n");
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max) + `\n... ${s.length - max} more characters truncated`;
}
