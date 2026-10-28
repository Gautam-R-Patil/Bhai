// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// ── Autonomous Skill Creator ────────────────────
// Automatically generates reusable skill files after complex task
// completions (5+ tool calls, swarm/long-task). Analyzes tool call
// sequences, extracts procedures, detects pitfalls, and writes
// gray-matter markdown skills to skills/auto/.

import { addDraft, listDrafts, getDraftSlugs } from "../memory/self-improvement-drafts.js";
import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";
import { extractJSON } from "../utils/json-extract.js";

// ── Constants ────────────────────────────────────

const MIN_TOOL_CALLS = 5;             // Don't create skills for simple tasks
const MAX_TOOL_HISTORY_ITEMS = 40;    // Cap tool history to keep prompt manageable
const SIMILARITY_THRESHOLD = 0.6;     // Threshold for detecting duplicate skills

// ── Types ────────────────────────────────────────

export interface ToolCallRecord {
    name: string;
    args: any;
    result: string;
}

interface SkillAnalysis {
    name: string;
    slug: string;
    description: string;
    triggers: string[];
    procedure: string[];
    pitfalls: string[];
    verification: string[];
    tools_required: string[];
}

// ── Main Entry Point ─────────────────────────────

/**
 * After a complex task completes, analyze the tool call history and
 * potentially generate a reusable skill file.
 *
 * @param llm - LLM client for analysis
 * @param taskDescription - The original task description
 * @param toolCallHistory - Ordered list of tool calls made during the task
 * @param outcome - Whether the task succeeded, partially succeeded, or failed
 * @returns Path to the created skill file, or null if no skill was created
 */
export async function maybeCreateSkill(
    llm: LLMClient,
    taskDescription: string,
    toolCallHistory: Array<ToolCallRecord>,
    outcome: "success" | "partial" | "failure",
): Promise<string | null> {
    // Only create skills for successful or partially successful tasks
    if (outcome === "failure") {
        console.log("[AUTO-SKILL] Skipping skill creation for failed task");
        return null;
    }

    // Require minimum complexity
    if (toolCallHistory.length < MIN_TOOL_CALLS) {
        console.log(`[AUTO-SKILL] Skipping: only ${toolCallHistory.length} tool calls (min: ${MIN_TOOL_CALLS})`);
        return null;
    }

    // Check for duplicate/similar existing skills before spending an LLM call
    const existingSlugs = listExistingSkillSlugs();
    const taskWords = extractKeywords(taskDescription);

    for (const slug of existingSlugs) {
        const slugWords = slug.split("-");
        const overlap = taskWords.filter(w => slugWords.includes(w)).length;
        const similarity = overlap / Math.max(taskWords.length, slugWords.length, 1);
        if (similarity >= SIMILARITY_THRESHOLD) {
            console.log(`[AUTO-SKILL] Skipping: similar skill "${slug}" already exists (similarity: ${similarity.toFixed(2)})`);
            return null;
        }
    }

    // Truncate tool history to keep prompt within bounds
    const truncatedHistory = toolCallHistory.slice(0, MAX_TOOL_HISTORY_ITEMS);

    try {
        // Analyze the task and generate skill definition
        const analysis = await analyzeForSkill(llm, taskDescription, truncatedHistory, outcome);
        if (!analysis) {
            console.log("[AUTO-SKILL] LLM determined task is not worth creating a skill for");
            return null;
        }

        // Write the skill file
        const filePath = writeSkillFile(analysis, taskDescription);
        if (filePath) {
            console.log(`[AUTO-SKILL] Created skill: "${analysis.name}" -> ${filePath}`);
        }
        return filePath;
    } catch (err) {
        console.warn("[AUTO-SKILL] Skill creation failed (non-fatal):", (err as Error).message);
        return null;
    }
}

// ── LLM Analysis ─────────────────────────────────

async function analyzeForSkill(
    llm: LLMClient,
    taskDescription: string,
    toolCallHistory: ToolCallRecord[],
    outcome: "success" | "partial",
): Promise<SkillAnalysis | null> {
    // Build a compact summary of tool calls
    const toolSummary = toolCallHistory.map((tc, i) => {
        // Truncate args and results to keep prompt small
        const argsStr = typeof tc.args === "string"
            ? tc.args.substring(0, 150)
            : JSON.stringify(tc.args).substring(0, 150);
        const resultStr = tc.result.substring(0, 200);
        return `${i + 1}. ${tc.name}(${argsStr}) -> ${resultStr}`;
    }).join("\n");

    const uniqueTools = [...new Set(toolCallHistory.map(tc => tc.name))];

    const prompt = `Analyze this completed task and determine if it should be saved as a reusable skill.

TASK DESCRIPTION: ${taskDescription.substring(0, 500)}
OUTCOME: ${outcome}
TOOL CALLS (${toolCallHistory.length} total):
${toolSummary}

UNIQUE TOOLS USED: ${uniqueTools.join(", ")}

If this task represents a REPEATABLE PATTERN (not a one-off request), generate a skill definition as JSON:
{
  "worth_creating": true,
  "name": "Descriptive Skill Name",
  "slug": "kebab-case-slug",
  "description": "One-sentence description of what this skill does",
  "triggers": ["trigger phrase 1", "trigger phrase 2", "trigger phrase 3"],
  "procedure": ["Step 1: ...", "Step 2: ...", ...],
  "pitfalls": ["Common mistake 1", "Common mistake 2"],
  "verification": ["How to verify step 1 worked", "How to verify final result"],
  "tools_required": ["tool_name_1", "tool_name_2"]
}

If this task is too specific or one-off (e.g., "set my name to John"), return:
{"worth_creating": false, "reason": "..."}

Rules:
- Only create skills for GENERAL patterns, not user-specific tasks
- Triggers should be generic phrases that would match future similar tasks
- Procedure steps should be detailed enough to repeat the workflow
- Describe the reusable procedure (what to do next time), NOT the actions you took this session — write "to do X, run Y" not "I ran Y and it worked"
- Do NOT record that a tool failed or "doesn't work"; negative capability claims harden into false refusals the agent cites against itself for months
- Include at least 1 pitfall and 1 verification step
- Slug must be unique and descriptive (max 50 chars)

Output ONLY valid JSON.`;

    const messages: ChatCompletionMessageParam[] = [
        { role: "user", content: prompt },
    ];

    const response = await llm.chat({
        messages,
        systemPrompt: "You analyze task executions and extract reusable skill patterns. Output valid JSON only.",
        modelOverride: "openai/gpt-4.1-nano",
    });

    const content = response.choices?.[0]?.message?.content || "";
    const jsonStr = extractJSON(content);
    if (!jsonStr) return null;

    const parsed = JSON.parse(jsonStr);
    if (!parsed.worth_creating) {
        console.log(`[AUTO-SKILL] Not worth creating: ${parsed.reason || "LLM decided against it"}`);
        return null;
    }

    // Validate required fields
    if (!parsed.name || !parsed.slug || !parsed.procedure || !Array.isArray(parsed.procedure)) {
        return null;
    }

    return {
        name: parsed.name,
        slug: parsed.slug.toLowerCase().replace(/[^a-z0-9-]/g, "-").substring(0, 50),
        description: parsed.description || parsed.name,
        triggers: Array.isArray(parsed.triggers) ? parsed.triggers : [parsed.slug],
        procedure: parsed.procedure,
        pitfalls: Array.isArray(parsed.pitfalls) ? parsed.pitfalls : [],
        verification: Array.isArray(parsed.verification) ? parsed.verification : [],
        tools_required: Array.isArray(parsed.tools_required) ? parsed.tools_required : [],
    };
}

// ── Skill File Writer ────────────────────────────

function writeSkillFile(analysis: SkillAnalysis, basedOnTask: string): string | null {
    // Auto-skills now go into the local self-improvement draft buffer
    // (kind: "skill"). The nightly synthesis pass merges drafts per slug
    // and uploads to the server's user_prompt_addenda table. Nothing
    // touches the user's filesystem anymore.
    try {
        const slug = `skill-${analysis.slug}`;

        // De-dup: if a draft for this slug already contains the same first
        // procedure step, skip. (Synthesis itself dedupes too, but cheaper
        // here.) Empty/whitespace procedure[0] would make .includes("") true
        // unconditionally — guard against that so we don't lock out the slug.
        const firstStep = (analysis.procedure[0] || "").trim();
        if (firstStep.length > 0) {
            const existing = listDrafts(slug);
            if (existing.length > 0 && existing[0].content.includes(firstStep)) {
                console.log(`[AUTO-SKILL] Skill "${slug}" already drafted today, skipping`);
                return null;
            }
        }

        const procedureSection = analysis.procedure.map((step, i) => `${i + 1}. ${step}`).join("\n");
        const pitfallsSection = analysis.pitfalls.length > 0
            ? analysis.pitfalls.map((p) => `- ${p}`).join("\n")
            : "- No known pitfalls identified yet.";
        const verificationSection = analysis.verification.length > 0
            ? analysis.verification.map((v) => `- ${v}`).join("\n")
            : "- Verify the final output matches the expected result.";

        const content = `# ${analysis.name}\n\n${analysis.description}\n\n## Procedure\n\n${procedureSection}\n\n## Common Pitfalls\n\n${pitfallsSection}\n\n## Verification Steps\n\n${verificationSection}\n\n*Triggers: ${analysis.triggers.join(", ") || "general"}*\n*Tools used: ${analysis.tools_required.join(", ") || "various"}*\n`;

        const reason = `Auto-skill from successful task: ${basedOnTask.substring(0, 100)}`;
        addDraft({ kind: "skill", slug, content, reason });
        console.log(`[AUTO-SKILL] Drafted "${slug}" (will sync at nightly synthesis)`);
        return slug;
    } catch (err) {
        console.warn("[AUTO-SKILL] Draft failed (non-fatal):", (err as Error).message);
        return null;
    }
}

// ── Helpers ──────────────────────────────────────

/** List slugs of auto-generated skills currently in the local draft buffer. */
function listExistingSkillSlugs(): string[] {
    try {
        return getDraftSlugs()
            .filter((s) => s.startsWith("skill-"))
            .map((s) => s.replace(/^skill-/, ""));
    } catch {
        return [];
    }
}

/** Extract lowercase keywords from a string for similarity comparison. */
function extractKeywords(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(w => w.length > 2)
        .filter(w => !STOP_WORDS.has(w));
}

const STOP_WORDS = new Set([
    "the", "and", "for", "that", "this", "with", "from", "have", "has",
    "been", "will", "would", "could", "should", "can", "are", "was",
    "were", "not", "but", "all", "any", "each", "every", "both",
    "into", "over", "after", "before", "about", "just", "than",
    "then", "when", "where", "which", "while", "also", "very",
    "too", "own", "same", "some", "such", "only", "other",
]);
