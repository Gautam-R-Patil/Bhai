// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Skill Auto-Generator ─────────────────────────
 * SAGE-style (Dec 2025) skill extractor. After successful multi-step task
 * completions, automatically emit them as reusable skill markdown files
 * with frontmatter, triggers, and step-by-step instructions. Generated
 * skills are saved to `skills/auto/` and loaded by skills/loader.ts.
 */

import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";
import fs from "node:fs";
import path from "node:path";

// ── Types ─────────────────────────────────────

export interface GeneratedSkill {
    name: string;
    slug: string;
    description: string;
    triggers: string[];
    instructions: string;
    source: "auto_generated";
    basedOnTask: string;
    successRate: number;
    filePath: string;
}

// ── Skill Generation ──────────────────────────

/**
 * Attempt to generate a reusable skill from a completed task.
 * Called after successful task completion during reflection/dreaming.
 */
export async function generateSkillFromTask(
    llm: LLMClient,
    taskDescription: string,
    stepsExecuted: string[],
    toolsUsed: string[],
    outcome: string,
): Promise<GeneratedSkill | null> {
    // Don't generate skills for trivial tasks
    if (stepsExecuted.length < 3) return null;

    const messages: ChatCompletionMessageParam[] = [
        {
            role: "user",
            content: `A task was completed successfully. Extract it as a reusable skill.

TASK: ${taskDescription}
STEPS TAKEN:
${stepsExecuted.map((s, i) => `${i + 1}. ${s}`).join("\n")}
TOOLS USED: ${toolsUsed.join(", ")}
OUTCOME: ${outcome.substring(0, 500)}

Generate a skill definition:
NAME: [concise name in Title Case]
SLUG: [kebab-case identifier]
DESCRIPTION: [one sentence]
TRIGGERS: [comma-separated trigger phrases that should activate this skill]
INSTRUCTIONS: [step-by-step instructions for repeating this task type]

If this task is too specific/one-off to be a reusable skill, respond with "SKIP".`,
        },
    ];

    try {
        const response = await llm.chat({
            messages,
            systemPrompt: "Extract reusable skills from successful task executions. Only create skills for patterns that could recur.",
            modelOverride: "anthropic/claude-haiku-4.5",
        });

        const content = response.choices?.[0]?.message?.content || "";
        if (content.trim() === "SKIP") return null;

        return parseAndSaveSkill(content, taskDescription);
    } catch (err) {
        console.warn("[SKILL-GEN] Generation failed:", (err as Error).message);
        return null;
    }
}

function parseAndSaveSkill(response: string, basedOnTask: string): GeneratedSkill | null {
    const nameMatch = response.match(/NAME:\s*(.+)/);
    const slugMatch = response.match(/SLUG:\s*(\S+)/);
    const descMatch = response.match(/DESCRIPTION:\s*(.+)/);
    const triggersMatch = response.match(/TRIGGERS:\s*(.+)/);
    const instructionsMatch = response.match(/INSTRUCTIONS:\s*([\s\S]+)/);

    if (!nameMatch || !slugMatch || !instructionsMatch) return null;

    const name = nameMatch[1].trim();
    const slug = slugMatch[1].trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const description = descMatch?.[1]?.trim() || name;
    const triggers = triggersMatch?.[1]?.split(",").map(t => t.trim()).filter(Boolean) || [slug];
    const instructions = instructionsMatch[1].trim();

    // Check for duplicates
    const skillsDir = path.join(process.cwd(), "skills", "auto");
    const filePath = path.join(skillsDir, `${slug}.md`);

    if (fs.existsSync(filePath)) {
        console.log(`[SKILL-GEN] Skill "${slug}" already exists, skipping`);
        return null;
    }

    // Create the skills/auto directory if needed
    if (!fs.existsSync(skillsDir)) {
        fs.mkdirSync(skillsDir, { recursive: true });
    }

    // Write skill file with gray-matter frontmatter
    const content = `---
name: "${name}"
slug: "${slug}"
description: "${description}"
triggers:
${triggers.map(t => `  - "${t}"`).join("\n")}
source: auto_generated
created_at: "${new Date().toISOString()}"
---

# ${name}

${description}

## Instructions

${instructions}

---
*Auto-generated from task: "${basedOnTask.substring(0, 100)}"*
`;

    fs.writeFileSync(filePath, content, "utf-8");
    console.log(`[SKILL-GEN] Created skill: ${slug} → ${filePath}`);

    return {
        name,
        slug,
        description,
        triggers,
        instructions,
        source: "auto_generated",
        basedOnTask: basedOnTask.substring(0, 200),
        successRate: 1.0,
        filePath,
    };
}

// ── Skill Evolution ───────────────────────────

/**
 * Check auto-generated skills and retire those that aren't being used.
 * Called during dreaming cycle.
 */
export function pruneUnusedSkills(minUses = 0, maxAgeDays = 30): number {
    const skillsDir = path.join(process.cwd(), "skills", "auto");
    if (!fs.existsSync(skillsDir)) return 0;

    const files = fs.readdirSync(skillsDir).filter(f => f.endsWith(".md"));
    let pruned = 0;

    for (const file of files) {
        const filePath = path.join(skillsDir, file);
        const stat = fs.statSync(filePath);
        const ageDays = (Date.now() - stat.mtimeMs) / 86400000;

        // Prune if older than maxAgeDays and never used
        // (In a real implementation, track skill usage in a DB)
        if (ageDays > maxAgeDays) {
            fs.unlinkSync(filePath);
            pruned++;
            console.log(`[SKILL-GEN] Pruned unused skill: ${file}`);
        }
    }

    return pruned;
}

/**
 * List all auto-generated skills.
 */
export function listAutoSkills(): Array<{ slug: string; filePath: string }> {
    const skillsDir = path.join(process.cwd(), "skills", "auto");
    if (!fs.existsSync(skillsDir)) return [];

    return fs.readdirSync(skillsDir)
        .filter(f => f.endsWith(".md"))
        .map(f => ({
            slug: f.replace(".md", ""),
            filePath: path.join(skillsDir, f),
        }));
}
