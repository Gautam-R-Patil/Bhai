// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { promises as fs } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { LLMClient } from "../../llm.js";
import { MODELS } from "../../llm.js";
import { extractJSON } from "../../utils/json-extract.js";
import { PlanValidationError } from "./planner.js";
import { type EditPlan, validateEditPlan } from "./schema.js";

export type CheckResult = { ok: true } | { ok: false; errors: string[] };

export async function checkSourcesExist(plan: EditPlan, projectRoot?: string): Promise<CheckResult> {
    const root = projectRoot ?? process.cwd();
    const errors: string[] = [];

    await Promise.all(
        plan.sources.map(async (source) => {
            const absPath = isAbsolute(source.path) ? source.path : resolve(root, source.path);
            try {
                await fs.access(absPath);
            } catch {
                errors.push(`Source id="${source.id}" path="${source.path}" not found (resolved: ${absPath})`);
            }
        }),
    );

    return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function checkDurations(plan: EditPlan): CheckResult {
    const sourceMap = new Map(plan.sources.map((s) => [s.id, s]));
    const errors: string[] = [];

    for (const clip of plan.tracks.video) {
        const source = sourceMap.get(clip.source);
        if (!source) {
            errors.push(`Video clip id="${clip.id}" references unknown source id="${clip.source}"`);
            continue;
        }
        if (clip.in >= clip.out) {
            errors.push(`Video clip id="${clip.id}" has in=${clip.in} >= out=${clip.out}`);
        }
        if (clip.out > source.duration) {
            errors.push(
                `Video clip id="${clip.id}" out=${clip.out} exceeds source "${clip.source}" duration=${source.duration}`,
            );
        }
    }

    return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function checkTransitionBetweenExists(plan: EditPlan): CheckResult {
    const videoIds = new Set(plan.tracks.video.map((v) => v.id));
    const errors: string[] = [];

    for (const tx of plan.transitions ?? []) {
        const [a, b] = tx.between;
        if (!videoIds.has(a)) {
            errors.push(`Transition references video id="${a}" which does not exist in tracks.video`);
        }
        if (!videoIds.has(b)) {
            errors.push(`Transition references video id="${b}" which does not exist in tracks.video`);
        }
    }

    return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export async function repairPlan(llm: LLMClient, badPlan: unknown, errors: string[]): Promise<EditPlan> {
    const badPlanJson = JSON.stringify(badPlan, null, 2);
    const errorList = errors.join("\n");

    const response = await llm.chat({
        messages: [
            {
                role: "user",
                content: `The following edit plan failed validation:\n\`\`\`json\n${badPlanJson}\n\`\`\`\n\nValidation errors:\n${errorList}\n\nFix every error. Output ONLY the corrected JSON:`,
            },
        ],
        modelOverride: MODELS.SONNET,
    });

    const content = response.choices[0]?.message?.content ?? "";
    const extracted = extractJSON(content);

    if (extracted === null) {
        throw new PlanValidationError("repairPlan: LLM repair response contained no valid JSON", badPlan, errors);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(extracted);
    } catch {
        throw new PlanValidationError("repairPlan: JSON.parse failed on extracted repair response", badPlan, errors);
    }

    const result = validateEditPlan(parsed);
    if (result.ok) return result.plan;

    throw new PlanValidationError("repairPlan: LLM-repaired plan still failed Zod validation", parsed, result.errors);
}
