// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// MCTS Engine — Monte Carlo Tree Search for agent planning.
// Inspired by ReST-MCTS* (NeurIPS 2024) and ToolTree (ICLR 2026).
// Handles: tree structure, UCB1 selection, backpropagation, branch pruning.
// LLM calls for node expansion and value estimation stay in TypeScript.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Constants ──────────────────────────────────────

const DEFAULT_EXPLORATION_CONSTANT: f64 = 1.414; // sqrt(2), standard UCB1
const MAX_TREE_DEPTH: u32 = 15;
const MAX_TREE_NODES: usize = 5000;
const MIN_VISITS_FOR_EXPANSION: u32 = 2;

// ── Types ──────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct MCTSNode {
    pub id: u32,
    pub parent_id: i32,        // -1 for root
    pub action: String,        // The action/step this node represents
    pub state_summary: String, // Brief state description after this action
    pub depth: u32,
    pub visit_count: u32,
    pub total_reward: f64, // Sum of all backpropagated rewards
    pub prior_score: f64,  // Initial quality estimate (from PRM or LLM)
    pub children_ids: Vec<u32>,
    pub is_terminal: bool, // Leaf node (task complete or failed)
    pub is_expanded: bool, // Whether children have been generated
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct MCTSTree {
    pub nodes: Vec<MCTSNode>,
    pub next_id: u32,
    pub best_path: Vec<u32>, // IDs of nodes in the current best path
    pub total_simulations: u32,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct SelectionResult {
    pub node_id: u32,
    pub path: Vec<u32>, // Path from root to selected node
    pub needs_expansion: bool,
    pub ucb_score: f64,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct ExpandResult {
    pub new_ids: Vec<u32>,
    pub tree: MCTSTree,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct BackpropResult {
    pub updated_count: u32,
    pub best_path_changed: bool,
    pub best_path: Vec<u32>,
    pub best_reward: f64,
    pub tree: MCTSTree,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct PruningResult {
    pub pruned_count: u32,
    pub remaining_count: u32,
    pub pruned_node_ids: Vec<u32>,
    pub tree: MCTSTree,
}

// ── Tree Creation ──────────────────────────────────

/// Create a new MCTS tree with a root node.
#[napi]
pub fn create_mcts_tree(root_action: String, root_state: String) -> MCTSTree {
    let root = MCTSNode {
        id: 0,
        parent_id: -1,
        action: root_action,
        state_summary: root_state,
        depth: 0,
        visit_count: 0,
        total_reward: 0.0,
        prior_score: 0.5,
        children_ids: vec![],
        is_terminal: false,
        is_expanded: false,
    };

    MCTSTree {
        nodes: vec![root],
        next_id: 1,
        best_path: vec![0],
        total_simulations: 0,
    }
}

// ── Selection (UCB1) ───────────────────────────────

/// Select the most promising node to expand using UCB1.
/// Traverses from root, at each level picking the child with highest UCB score.
/// Returns the leaf node that should be expanded next.
#[napi]
pub fn select_node(tree: MCTSTree, exploration_constant: Option<f64>) -> SelectionResult {
    let c = exploration_constant.unwrap_or(DEFAULT_EXPLORATION_CONSTANT);
    let total_visits = tree.total_simulations.max(1) as f64;

    let mut current_id = 0u32; // Start at root
    let mut path = vec![0u32];

    while let Some(node) = tree.nodes.iter().find(|n| n.id == current_id) {
        // If node is terminal or not yet expanded, select it
        if node.is_terminal || !node.is_expanded || node.children_ids.is_empty() {
            return SelectionResult {
                node_id: current_id,
                path,
                needs_expansion: !node.is_expanded && !node.is_terminal,
                ucb_score: compute_ucb(node, total_visits, c),
            };
        }

        // Find child with highest UCB score
        let mut best_child_id = node.children_ids[0];
        let mut best_ucb = f64::NEG_INFINITY;

        for &child_id in &node.children_ids {
            if let Some(child) = tree.nodes.iter().find(|n| n.id == child_id) {
                let ucb = compute_ucb(child, node.visit_count as f64, c);
                if ucb > best_ucb {
                    best_ucb = ucb;
                    best_child_id = child_id;
                }
            }
        }

        current_id = best_child_id;
        path.push(current_id);

        // Safety: prevent infinite loops
        if path.len() > MAX_TREE_DEPTH as usize {
            break;
        }
    }

    SelectionResult {
        node_id: current_id,
        path,
        needs_expansion: false,
        ucb_score: 0.0,
    }
}

fn compute_ucb(node: &MCTSNode, parent_visits: f64, c: f64) -> f64 {
    if node.visit_count == 0 {
        // Unvisited nodes get high priority (exploration bonus)
        return node.prior_score + c * (parent_visits.ln() / 1.0).sqrt() + 10.0;
    }

    let exploitation = node.total_reward / node.visit_count as f64;
    let exploration = c * ((parent_visits.ln()) / node.visit_count as f64).sqrt();

    // Blend with prior score (decreasing weight as visits increase)
    let prior_weight = 1.0 / (1.0 + node.visit_count as f64);
    let prior_bonus = prior_weight * node.prior_score;

    exploitation + exploration + prior_bonus
}

// ── Expansion ──────────────────────────────────────

/// Add child nodes to a selected node. Called after LLM generates possible next actions.
/// Returns the modified tree and IDs of the new children.
#[napi]
pub fn expand_node(
    mut tree: MCTSTree,
    parent_id: u32,
    actions: Vec<String>,
    state_summaries: Vec<String>,
    prior_scores: Vec<f64>,
) -> ExpandResult {
    if tree.nodes.len() >= MAX_TREE_NODES {
        return ExpandResult {
            new_ids: vec![],
            tree,
        };
    }

    let parent_depth = tree
        .nodes
        .iter()
        .find(|n| n.id == parent_id)
        .map(|n| n.depth)
        .unwrap_or(0);

    if parent_depth >= MAX_TREE_DEPTH {
        return ExpandResult {
            new_ids: vec![],
            tree,
        };
    }

    let n = actions
        .len()
        .min(state_summaries.len())
        .min(prior_scores.len());
    let mut new_ids = Vec::with_capacity(n);

    for (i, action) in actions.iter().enumerate().take(n) {
        let child_id = tree.next_id;
        tree.next_id += 1;

        let child = MCTSNode {
            id: child_id,
            parent_id: parent_id as i32,
            action: action.clone(),
            state_summary: state_summaries.get(i).cloned().unwrap_or_default(),
            depth: parent_depth + 1,
            visit_count: 0,
            total_reward: 0.0,
            prior_score: prior_scores.get(i).copied().unwrap_or(0.5),
            children_ids: vec![],
            is_terminal: false,
            is_expanded: false,
        };

        tree.nodes.push(child);
        new_ids.push(child_id);
    }

    // Update parent
    if let Some(parent) = tree.nodes.iter_mut().find(|n| n.id == parent_id) {
        parent.children_ids.extend(&new_ids);
        parent.is_expanded = true;
    }

    ExpandResult { new_ids, tree }
}

// ── Backpropagation ────────────────────────────────

/// Backpropagate a reward from a leaf node up to the root.
/// Updates visit counts and total rewards along the path.
#[napi]
pub fn backpropagate(mut tree: MCTSTree, leaf_id: u32, reward: f64) -> BackpropResult {
    tree.total_simulations += 1;

    let mut current_id = leaf_id as i32;
    let mut updated = 0u32;

    // Traverse up to root
    while current_id >= 0 {
        if let Some(node) = tree.nodes.iter_mut().find(|n| n.id == current_id as u32) {
            node.visit_count += 1;
            node.total_reward += reward;
            current_id = node.parent_id;
            updated += 1;
        } else {
            break;
        }
    }

    // Recompute best path
    let best_path = compute_best_path(&tree.nodes);
    let best_reward = best_path
        .last()
        .and_then(|&id| tree.nodes.iter().find(|n| n.id == id))
        .map(|n| {
            if n.visit_count > 0 {
                n.total_reward / n.visit_count as f64
            } else {
                0.0
            }
        })
        .unwrap_or(0.0);

    let old_best = tree.best_path.clone();
    tree.best_path = best_path.clone();

    BackpropResult {
        updated_count: updated,
        best_path_changed: old_best != best_path,
        best_path,
        best_reward,
        tree,
    }
}

fn compute_best_path(nodes: &[MCTSNode]) -> Vec<u32> {
    let mut path = vec![0u32]; // Start at root
    let mut current_id = 0u32;

    while let Some(node) = nodes.iter().find(|n| n.id == current_id) {
        if node.children_ids.is_empty() {
            break;
        }

        // Pick child with best average reward
        let mut best_child = node.children_ids[0];
        let mut best_avg = f64::NEG_INFINITY;

        for &child_id in &node.children_ids {
            if let Some(child) = nodes.iter().find(|n| n.id == child_id) {
                let avg = if child.visit_count > 0 {
                    child.total_reward / child.visit_count as f64
                } else {
                    child.prior_score
                };
                if avg > best_avg {
                    best_avg = avg;
                    best_child = child_id;
                }
            }
        }

        path.push(best_child);
        current_id = best_child;

        if path.len() > MAX_TREE_DEPTH as usize {
            break;
        }
    }

    path
}

// ── Pruning ────────────────────────────────────────

/// Prune low-performing branches to keep tree manageable.
/// Removes subtrees rooted at children with average reward below threshold.
#[napi]
pub fn prune_tree(mut tree: MCTSTree, min_avg_reward: f64, min_visits: u32) -> PruningResult {
    let mut to_prune: Vec<u32> = Vec::new();

    // Find nodes eligible for pruning (non-root, visited enough, below threshold)
    for node in &tree.nodes {
        if node.parent_id < 0 || node.visit_count < min_visits {
            continue;
        }
        let avg = node.total_reward / node.visit_count.max(1) as f64;
        if avg < min_avg_reward {
            to_prune.push(node.id);
        }
    }

    // Collect all descendants of pruned nodes
    let mut all_pruned: Vec<u32> = Vec::new();
    for &prune_id in &to_prune {
        collect_descendants(&tree.nodes, prune_id, &mut all_pruned);
        all_pruned.push(prune_id);
    }

    // Remove from parent's children list
    for &prune_id in &to_prune {
        if let Some(node) = tree.nodes.iter().find(|n| n.id == prune_id) {
            let parent_id = node.parent_id;
            if parent_id >= 0 {
                if let Some(parent) = tree.nodes.iter_mut().find(|n| n.id == parent_id as u32) {
                    parent.children_ids.retain(|&id| id != prune_id);
                }
            }
        }
    }

    // Remove pruned nodes
    let pruned_set: std::collections::HashSet<u32> = all_pruned.iter().copied().collect();
    tree.nodes.retain(|n| !pruned_set.contains(&n.id));

    PruningResult {
        pruned_count: all_pruned.len() as u32,
        remaining_count: tree.nodes.len() as u32,
        pruned_node_ids: all_pruned,
        tree,
    }
}

fn collect_descendants(nodes: &[MCTSNode], node_id: u32, result: &mut Vec<u32>) {
    if let Some(node) = nodes.iter().find(|n| n.id == node_id) {
        for &child_id in &node.children_ids {
            result.push(child_id);
            collect_descendants(nodes, child_id, result);
        }
    }
}

// ── Tree Statistics ────────────────────────────────

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct MCTSStats {
    pub total_nodes: u32,
    pub total_simulations: u32,
    pub max_depth: u32,
    pub avg_branching_factor: f64,
    pub best_path_length: u32,
    pub best_path_avg_reward: f64,
}

#[napi]
pub fn get_mcts_stats(tree: MCTSTree) -> MCTSStats {
    let max_depth = tree.nodes.iter().map(|n| n.depth).max().unwrap_or(0);
    let non_leaf_count = tree
        .nodes
        .iter()
        .filter(|n| !n.children_ids.is_empty())
        .count();
    let total_children: usize = tree.nodes.iter().map(|n| n.children_ids.len()).sum();
    let avg_branching = if non_leaf_count > 0 {
        total_children as f64 / non_leaf_count as f64
    } else {
        0.0
    };

    let best_path_rewards: Vec<f64> = tree
        .best_path
        .iter()
        .filter_map(|&id| tree.nodes.iter().find(|n| n.id == id))
        .filter(|n| n.visit_count > 0)
        .map(|n| n.total_reward / n.visit_count as f64)
        .collect();
    let best_avg = if best_path_rewards.is_empty() {
        0.0
    } else {
        best_path_rewards.iter().sum::<f64>() / best_path_rewards.len() as f64
    };

    MCTSStats {
        total_nodes: tree.nodes.len() as u32,
        total_simulations: tree.total_simulations,
        max_depth,
        avg_branching_factor: avg_branching,
        best_path_length: tree.best_path.len() as u32,
        best_path_avg_reward: best_avg,
    }
}

/// Extract the best action sequence from the tree.
/// Returns the actions along the best path (excluding root).
#[napi]
pub fn extract_best_plan(tree: MCTSTree) -> Vec<String> {
    tree.best_path
        .iter()
        .skip(1) // Skip root
        .filter_map(|&id| tree.nodes.iter().find(|n| n.id == id))
        .map(|n| n.action.clone())
        .collect()
}

/// Mark a node as terminal (success or failure). Returns the modified tree.
#[napi]
pub fn mark_terminal(mut tree: MCTSTree, node_id: u32, is_success: bool) -> MCTSTree {
    if let Some(node) = tree.nodes.iter_mut().find(|n| n.id == node_id) {
        node.is_terminal = true;
        if is_success {
            node.total_reward += 1.0;
            node.visit_count += 1;
        }
    }
    tree
}
