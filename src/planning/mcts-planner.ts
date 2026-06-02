// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/**
 * ── MCTS Planner ─────────────────────────────────
 * Monte Carlo Tree Search for agent planning.
 * Inspired by ReST-MCTS* (NeurIPS 2024) and ToolTree (ICLR 2026).
 *
 * Instead of committing to a single plan, explores a tree of possible
 * action sequences. Each node is scored by a Process Reward Model.
 * UCB1 balances exploitation of known-good paths with exploration of
 * new branches.
 *
 * Integration: Called by swarm.ts for complex task decomposition,
 * and by mesh.ts for step-level planning decisions.
 */

import type { LLMClient, ChatCompletionMessageParam } from "../llm.js";

// ── Types ─────────────────────────────────────

export interface MCTSConfig {
    maxSimulations: number;      // Total MCTS iterations (default: 20)
    maxDepth: number;            // Max tree depth (default: 10)
    explorationConstant: number; // UCB1 exploration weight (default: 1.414)
    pruneThreshold: number;      // Min avg reward to survive pruning (default: 0.3)
    branchingFactor: number;     // Max children per node (default: 3)
}

export interface MCTSResult {
    bestPlan: string[];          // Sequence of actions in the best path
    confidence: number;          // Average reward of best path
    simulationsRun: number;
    nodesExplored: number;
    alternativePlans: string[][]; // Top-3 alternative paths
}

// ── Default Config ────────────────────────────

const DEFAULT_CONFIG: MCTSConfig = {
    maxSimulations: 20,
    maxDepth: 10,
    explorationConstant: 1.414,
    pruneThreshold: 0.3,
    branchingFactor: 3,
};

// ── Main MCTS Planner ─────────────────────────

/**
 * Run MCTS planning for a complex task.
 * Uses the LLM to expand nodes (generate possible next actions)
 * and the PRM to score each step.
 */
export async function runMCTSPlanning(
    llm: LLMClient,
    taskDescription: string,
    currentContext: string,
    config: Partial<MCTSConfig> = {},
): Promise<MCTSResult> {
    const cfg = { ...DEFAULT_CONFIG, ...config };

    // Try native module first
    const native = loadNative();

    // Create tree with native or JS
    let tree: any;
    if (native) {
        tree = native.createMctsTree(taskDescription, currentContext);
    } else {
        tree = createJSTree(taskDescription, currentContext);
    }

    let simulationsRun = 0;

    for (let i = 0; i < cfg.maxSimulations; i++) {
        // 1. SELECT — find the most promising leaf node
        const selection = native
            ? native.selectNode(tree, cfg.explorationConstant)
            : selectNodeJS(tree, cfg.explorationConstant);

        if (!selection.needs_expansion) {
            // All leaves are terminal or expanded — we're done
            break;
        }

        // 2. EXPAND — use LLM to generate possible next actions
        const actions = await generateActions(
            llm, taskDescription, tree, selection.node_id, cfg.branchingFactor
        );

        if (actions.length === 0) {
            // No valid actions — mark as terminal
            if (native) {
                tree = native.markTerminal(tree, selection.node_id, false);
            }
            continue;
        }

        // 3. SIMULATE — score each action with PRM or LLM evaluation
        const scores = await scoreActions(llm, taskDescription, actions);

        // 4. EXPAND in tree
        if (native) {
            const expandResult = native.expandNode(
                tree, selection.node_id,
                actions, actions.map(() => ""), // State summaries (populated by LLM)
                scores
            );
            tree = expandResult.tree; // Get modified tree back
        } else {
            expandNodeJS(tree, selection.node_id, actions, scores);
        }

        // 5. BACKPROPAGATE — update path rewards
        const bestScore = Math.max(...scores, 0);
        if (native) {
            const bpResult = native.backpropagate(tree, selection.node_id, bestScore);
            tree = bpResult.tree; // Get modified tree back
        } else {
            backpropagateJS(tree, selection.node_id, bestScore);
        }

        simulationsRun++;

        // Periodic pruning
        if (i > 0 && i % 5 === 0 && native) {
            const pruneResult = native.pruneTree(tree, cfg.pruneThreshold, 2);
            tree = pruneResult.tree; // Get modified tree back
        }
    }

    // Extract best plan
    const bestPlan = native
        ? native.extractBestPlan(tree)
        : extractBestPlanJS(tree);

    const stats = native ? native.getMctsStats(tree) : getStatsJS(tree);

    return {
        bestPlan,
        confidence: stats.best_path_avg_reward || 0,
        simulationsRun,
        nodesExplored: stats.total_nodes || 0,
        alternativePlans: [], // TODO: extract top-3 paths
    };
}

// ── LLM Interaction ───────────────────────────

async function generateActions(
    llm: LLMClient,
    taskDescription: string,
    tree: any,
    nodeId: number,
    branchingFactor: number,
): Promise<string[]> {
    // Build context from path to this node
    const pathContext = getNodePath(tree, nodeId);

    const messages: ChatCompletionMessageParam[] = [
        {
            role: "user",
            content: `Task: ${taskDescription}

Steps taken so far:
${pathContext.map((s, i) => `${i + 1}. ${s}`).join("\n") || "None (this is the first step)"}

Generate ${branchingFactor} possible NEXT actions. Each should be a distinct approach.
Format: One action per line, numbered 1-${branchingFactor}. Be specific and actionable.
If the task appears complete, respond with "DONE".`,
        },
    ];

    try {
        const response = await llm.chat({
            messages,
            systemPrompt: "You are a planning module. Generate possible next actions for the task. Be diverse — explore different approaches.",
            modelOverride: "openai/gpt-5-mini",
        });

        const content = response.choices?.[0]?.message?.content || "";
        if (content.trim() === "DONE") return [];

        return content
            .split("\n")
            .filter(line => /^\d+\./.test(line.trim()))
            .map(line => line.replace(/^\d+\.\s*/, "").trim())
            .filter(a => a.length > 5)
            .slice(0, branchingFactor);
    } catch {
        return [];
    }
}

async function scoreActions(
    llm: LLMClient,
    taskDescription: string,
    actions: string[],
): Promise<number[]> {
    // Use Process Reward Model for step-level scoring
    try {
        const { scoreStepsWithLLM } = await import("./process-reward.js");
        const scores = await scoreStepsWithLLM(llm, taskDescription, actions);
        // PRM returns normalized 0-1 scores — validate
        if (scores.length === actions.length && scores.every(s => s >= 0 && s <= 1)) {
            return scores;
        }
        // Pad or trim to match actions length
        while (scores.length < actions.length) scores.push(0.5);
        return scores.slice(0, actions.length);
    } catch {
        // Fallback: uniform scores
        return actions.map(() => 0.5);
    }
}

function getNodePath(tree: any, nodeId: number): string[] {
    // Extract action sequence from root to this node
    const path: string[] = [];
    const nodes = tree.nodes || [];
    let current = nodes.find((n: any) => n.id === nodeId);

    while (current && current.parent_id >= 0) {
        path.unshift(current.action);
        current = nodes.find((n: any) => n.id === current.parent_id);
    }

    return path;
}

// ── JS Fallbacks ──────────────────────────────

function createJSTree(action: string, state: string): any {
    return {
        nodes: [{ id: 0, parent_id: -1, action, state_summary: state, depth: 0, visit_count: 0, total_reward: 0, prior_score: 0.5, children_ids: [], is_terminal: false, is_expanded: false }],
        next_id: 1,
        best_path: [0],
        total_simulations: 0,
    };
}

function selectNodeJS(tree: any, c: number): any {
    // Simple: find first unexpanded non-terminal leaf
    for (const node of tree.nodes) {
        if (!node.is_expanded && !node.is_terminal) {
            return { node_id: node.id, path: [node.id], needs_expansion: true, ucb_score: 0.5 };
        }
    }
    return { node_id: 0, path: [0], needs_expansion: false, ucb_score: 0 };
}

function expandNodeJS(tree: any, parentId: number, actions: string[], scores: number[]): void {
    const parent = tree.nodes.find((n: any) => n.id === parentId);
    if (!parent) return;

    for (let i = 0; i < actions.length; i++) {
        const id = tree.next_id++;
        tree.nodes.push({
            id, parent_id: parentId, action: actions[i], state_summary: "",
            depth: parent.depth + 1, visit_count: 0, total_reward: 0,
            prior_score: scores[i] || 0.5, children_ids: [], is_terminal: false, is_expanded: false,
        });
        parent.children_ids.push(id);
    }
    parent.is_expanded = true;
}

function backpropagateJS(tree: any, leafId: number, reward: number): void {
    tree.total_simulations++;
    let current = tree.nodes.find((n: any) => n.id === leafId);
    while (current) {
        current.visit_count++;
        current.total_reward += reward;
        current = current.parent_id >= 0 ? tree.nodes.find((n: any) => n.id === current.parent_id) : null;
    }
}

function extractBestPlanJS(tree: any): string[] {
    const plan: string[] = [];
    let currentId = 0;
    while (true) {
        const node = tree.nodes.find((n: any) => n.id === currentId);
        if (!node || node.children_ids.length === 0) break;
        let bestChild = node.children_ids[0];
        let bestAvg = -Infinity;
        for (const cid of node.children_ids) {
            const child = tree.nodes.find((n: any) => n.id === cid);
            if (child) {
                const avg = child.visit_count > 0 ? child.total_reward / child.visit_count : child.prior_score;
                if (avg > bestAvg) { bestAvg = avg; bestChild = cid; }
            }
        }
        const bestNode = tree.nodes.find((n: any) => n.id === bestChild);
        if (bestNode) plan.push(bestNode.action);
        currentId = bestChild;
    }
    return plan;
}

function getStatsJS(tree: any): any {
    return { total_nodes: tree.nodes.length, total_simulations: tree.total_simulations, best_path_avg_reward: 0.5 };
}

// ── Native Module ─────────────────────────────

let _native: any = null;
let _nativeLoaded = false;

function loadNative(): any {
    if (_nativeLoaded) return _native;
    _nativeLoaded = true;
    try {
        const { createRequire } = require("node:module");
        const nativeRequire = createRequire(import.meta.url);
        const path = require("node:path");
        _native = nativeRequire(path.join(process.cwd(), "native", "index.js"));
        return _native;
    } catch { return null; }
}
