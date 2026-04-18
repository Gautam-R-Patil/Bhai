// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Citation Graph — PageRank and centrality for research source ranking.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct CitationEdge {
    pub from_id: String,
    pub to_id: String,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct PageRankResult {
    pub node_id: String,
    pub score: f64,
}

/// Compute PageRank over a citation graph.
/// damping: typically 0.85
/// iterations: typically 20-50
#[napi]
pub fn compute_pagerank(
    node_ids: Vec<String>,
    edges: Vec<CitationEdge>,
    damping: f64,
    iterations: u32,
) -> Vec<PageRankResult> {
    let n = node_ids.len();
    if n == 0 { return vec![]; }

    let d = damping.clamp(0.0, 1.0);
    let id_to_idx: HashMap<&str, usize> = node_ids.iter().enumerate().map(|(i, id)| (id.as_str(), i)).collect();

    // Build adjacency: outlinks[i] = list of nodes i links to
    let mut outlinks: Vec<Vec<usize>> = vec![vec![]; n];
    let mut inlinks: Vec<Vec<usize>> = vec![vec![]; n];

    for edge in &edges {
        if let (Some(&from), Some(&to)) = (id_to_idx.get(edge.from_id.as_str()), id_to_idx.get(edge.to_id.as_str())) {
            outlinks[from].push(to);
            inlinks[to].push(from);
        }
    }

    let mut scores = vec![1.0 / n as f64; n];

    for _ in 0..iterations {
        let mut new_scores = vec![(1.0 - d) / n as f64; n];
        for i in 0..n {
            for &j in &inlinks[i] {
                let out_count = outlinks[j].len().max(1);
                new_scores[i] += d * scores[j] / out_count as f64;
            }
        }
        scores = new_scores;
    }

    let mut results: Vec<PageRankResult> = node_ids.iter().enumerate()
        .map(|(i, id)| PageRankResult { node_id: id.clone(), score: scores[i] })
        .collect();
    results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    results
}

/// Compute betweenness centrality (simplified: based on shortest paths via BFS).
#[napi]
pub fn compute_betweenness(node_ids: Vec<String>, edges: Vec<CitationEdge>) -> Vec<PageRankResult> {
    let n = node_ids.len();
    if n == 0 { return vec![]; }

    let id_to_idx: HashMap<&str, usize> = node_ids.iter().enumerate().map(|(i, id)| (id.as_str(), i)).collect();
    let mut adj: Vec<Vec<usize>> = vec![vec![]; n];
    for edge in &edges {
        if let (Some(&from), Some(&to)) = (id_to_idx.get(edge.from_id.as_str()), id_to_idx.get(edge.to_id.as_str())) {
            adj[from].push(to);
            adj[to].push(from); // Undirected for betweenness
        }
    }

    let mut centrality = vec![0.0f64; n];

    // BFS from each node (cap at 50 nodes for performance)
    let max_sources = n.min(50);
    for s in 0..max_sources {
        let mut dist = vec![-1i32; n];
        let mut paths = vec![0u64; n];
        let mut queue = std::collections::VecDeque::new();
        dist[s] = 0;
        paths[s] = 1;
        queue.push_back(s);

        let mut stack = Vec::new();
        while let Some(v) = queue.pop_front() {
            stack.push(v);
            for &w in &adj[v] {
                if dist[w] < 0 {
                    dist[w] = dist[v] + 1;
                    queue.push_back(w);
                }
                if dist[w] == dist[v] + 1 {
                    paths[w] += paths[v];
                }
            }
        }

        let mut delta = vec![0.0f64; n];
        while let Some(w) = stack.pop() {
            for &v in &adj[w] {
                if dist[v] == dist[w] - 1 && paths[w] > 0 {
                    delta[v] += (paths[v] as f64 / paths[w] as f64) * (1.0 + delta[w]);
                }
            }
            if w != s { centrality[w] += delta[w]; }
        }
    }

    // Normalize
    let max_c = centrality.iter().cloned().fold(0.0f64, f64::max);
    if max_c > 0.0 { for c in &mut centrality { *c /= max_c; } }

    let mut results: Vec<PageRankResult> = node_ids.iter().enumerate()
        .map(|(i, id)| PageRankResult { node_id: id.clone(), score: centrality[i] })
        .collect();
    results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    results
}
