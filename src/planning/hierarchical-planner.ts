// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── Hierarchical Planner ─────────────────────────
 * Two-level planning: abstract goals decompose into concrete steps.
 * Inspired by GoalAct (NCIIP 2025 Best Paper) and TheoryCoder-2.
 *
 * Level 1 (Abstract): High-level skills (searching, coding, writing)
 * Level 2 (Concrete): Primitive actions within each skill
 *
 * Learns reusable abstract operators from experience.
 */

import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";

// ── Types ─────────────────────────────────────

export interface AbstractGoal {
    id: string;
    description: string;
    skillType: string;        // "search" | "code" | "write" | "browse" | "analyze" | "communicate"
    subGoals: ConcreteStep[];
    status: "pending" | "in_progress" | "completed" | "failed";
    priority: number;
}

export interface ConcreteStep {
    id: string;
    parentGoalId: string;
    description: string;
    toolHint?: string;        // Suggested tool
    dependsOn: string[];      // IDs of steps this depends on
    status: "pending" | "in_progress" | "completed" | "failed";
    result?: string;
}

export interface HierarchicalPlan {
    taskDescription: string;
    abstractGoals: AbstractGoal[];
    totalSteps: number;
    estimatedComplexity: number;  // 1-10
}

// ── Main Planner ──────────────────────────────

/**
 * Create a hierarchical plan for a complex task.
 * First decomposes into abstract goals, then each goal into concrete steps.
 */
export async function createHierarchicalPlan(
    llm: LLMClient,
    taskDescription: string,
    context?: string,
): Promise<HierarchicalPlan> {
    // Level 1: Abstract decomposition
    const abstractGoals = await decomposeToAbstractGoals(llm, taskDescription, context);

    // Level 2: Concrete steps per goal
    for (const goal of abstractGoals) {
        goal.subGoals = await decomposeToConcreteSteps(llm, taskDescription, goal);
    }

    const totalSteps = abstractGoals.reduce((sum, g) => sum + g.subGoals.length, 0);

    return {
        taskDescription,
        abstractGoals,
        totalSteps,
        estimatedComplexity: Math.min(10, Math.ceil(totalSteps / 3)),
    };
}

async function decomposeToAbstractGoals(
    llm: LLMClient,
    task: string,
    context?: string,
): Promise<AbstractGoal[]> {
    const messages: ChatCompletionMessageParam[] = [
        {
            role: "user",
            content: `Decompose this task into 2-5 HIGH-LEVEL goals (not detailed steps):

TASK: ${task}
${context ? `CONTEXT: ${context}` : ""}

For each goal, specify:
GOAL: [description]
SKILL: [search|code|write|browse|analyze|communicate]
PRIORITY: [1-5, 1=highest]

Example:
GOAL: Research current best practices for React state management
SKILL: search
PRIORITY: 1`,
        },
    ];

    try {
        const response = await llm.chat({
            messages,
            systemPrompt: "You are a hierarchical planner. Decompose tasks into high-level goals, NOT detailed steps.",
            modelOverride: "openai/gpt-5-mini",
        });

        const content = response.choices?.[0]?.message?.content || "";
        return parseAbstractGoals(content);
    } catch {
        return [{ id: "g0", description: task, skillType: "analyze", subGoals: [], status: "pending", priority: 1 }];
    }
}

async function decomposeToConcreteSteps(
    llm: LLMClient,
    task: string,
    goal: AbstractGoal,
): Promise<ConcreteStep[]> {
    const messages: ChatCompletionMessageParam[] = [
        {
            role: "user",
            content: `For this goal within a larger task, list 2-5 CONCRETE steps:

OVERALL TASK: ${task}
GOAL: ${goal.description}
SKILL TYPE: ${goal.skillType}

For each step:
STEP: [specific action]
TOOL: [suggested tool name or "none"]
DEPENDS: [step numbers this depends on, or "none"]`,
        },
    ];

    try {
        const response = await llm.chat({
            messages,
            systemPrompt: "You are a task decomposer. Break goals into specific, actionable steps with tool hints.",
            modelOverride: "openai/gpt-5-mini",
        });

        const content = response.choices?.[0]?.message?.content || "";
        return parseConcreteSteps(content, goal.id);
    } catch {
        return [{ id: `${goal.id}_s0`, parentGoalId: goal.id, description: goal.description, dependsOn: [], status: "pending" }];
    }
}

function parseAbstractGoals(response: string): AbstractGoal[] {
    const goals: AbstractGoal[] = [];
    const blocks = response.split(/GOAL:\s*/i).filter(b => b.trim());

    for (let i = 0; i < blocks.length && i < 5; i++) {
        const block = blocks[i];
        const desc = block.split("\n")[0].trim();
        const skillMatch = block.match(/SKILL:\s*(\w+)/i);
        const prioMatch = block.match(/PRIORITY:\s*(\d)/i);

        if (desc.length < 5) continue;

        goals.push({
            id: `g${i}`,
            description: desc,
            skillType: skillMatch?.[1]?.toLowerCase() || "analyze",
            subGoals: [],
            status: "pending",
            priority: prioMatch ? parseInt(prioMatch[1]) : i + 1,
        });
    }

    return goals.sort((a, b) => a.priority - b.priority);
}

function parseConcreteSteps(response: string, goalId: string): ConcreteStep[] {
    const steps: ConcreteStep[] = [];
    const blocks = response.split(/STEP:\s*/i).filter(b => b.trim());

    for (let i = 0; i < blocks.length && i < 5; i++) {
        const block = blocks[i];
        const desc = block.split("\n")[0].trim();
        const toolMatch = block.match(/TOOL:\s*(\S+)/i);
        const depMatch = block.match(/DEPENDS:\s*(.+)/i);

        if (desc.length < 5) continue;

        const deps = depMatch?.[1]?.trim() === "none" ? [] :
            (depMatch?.[1]?.match(/\d+/g) || []).map(n => `${goalId}_s${parseInt(n) - 1}`);

        steps.push({
            id: `${goalId}_s${i}`,
            parentGoalId: goalId,
            description: desc,
            toolHint: toolMatch?.[1] === "none" ? undefined : toolMatch?.[1],
            dependsOn: deps,
            status: "pending",
        });
    }

    return steps;
}
