// Copyright (c) 2024-2026 XAGI Labs Private Limited. All rights reserved.
// HNSW Vector Index — Full port of src/memory/vector-index.ts

use napi::bindgen_prelude::*;
use napi_derive::napi;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::cmp::Ordering;
use std::sync::Arc;

// ── Constants ──────────────────────────────────────

const M: usize = 16;
const EF_CONSTRUCTION: usize = 200;
const EF_SEARCH: usize = 50;
const MAX_LEVEL: usize = 8;

fn ml() -> f64 {
    1.0 / (M as f64).ln()
}

// ── Float16 Helpers ────────────────────────────────

fn f32_to_f16(val: f32) -> u16 {
    let bits = val.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exponent = ((bits >> 23) & 0xff) as i32 - 127 + 15;
    let mantissa = ((bits >> 13) & 0x3ff) as u16;

    if exponent <= 0 {
        return sign; // underflow -> zero
    }
    if exponent >= 31 {
        return sign | 0x7c00; // overflow -> infinity
    }
    sign | ((exponent as u16) << 10) | mantissa
}

fn f16_to_f32(h: u16) -> f32 {
    let sign = ((h as u32 & 0x8000) as u32) << 16;
    let exponent = ((h >> 10) & 0x1f) as u32;
    let mantissa = (h & 0x3ff) as u32;

    if exponent == 0 {
        if mantissa == 0 {
            return f32::from_bits(sign);
        }
        // Denormalized
        let mut e: i32 = -1;
        let mut m = mantissa;
        loop {
            e += 1;
            m <<= 1;
            if m & 0x400 != 0 {
                break;
            }
        }
        let bits = sign | (((e as u32 + 127 - 15 + 1) & 0xff) << 23) | ((m & 0x3ff) << 13);
        return f32::from_bits(bits);
    }
    if exponent == 31 {
        let bits = sign | 0x7f800000 | (mantissa << 13);
        return f32::from_bits(bits);
    }
    let bits = sign | ((exponent - 15 + 127) << 23) | (mantissa << 13);
    f32::from_bits(bits)
}

fn compress_vec(vec: &[f32]) -> Vec<u16> {
    vec.iter().map(|&v| f32_to_f16(v)).collect()
}

fn decompress_vec(compressed: &[u16]) -> Vec<f32> {
    compressed.iter().map(|&v| f16_to_f32(v)).collect()
}

// ── Internal Types ─────────────────────────────────

#[derive(Clone)]
struct HNSWNode {
    id: i64,
    vector: Vec<u16>, // Float16 compressed
    level: usize,
    neighbors: Vec<Vec<i64>>, // neighbors[layer] = list of neighbor IDs
}

#[derive(Clone)]
struct DistIdPair {
    id: i64,
    dist: f64,
}

impl PartialEq for DistIdPair {
    fn eq(&self, other: &Self) -> bool {
        self.dist == other.dist && self.id == other.id
    }
}
impl Eq for DistIdPair {}

impl PartialOrd for DistIdPair {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

// Max-heap ordering (largest dist first) for use in BinaryHeap
impl Ord for DistIdPair {
    fn cmp(&self, other: &Self) -> Ordering {
        self.dist
            .partial_cmp(&other.dist)
            .unwrap_or(Ordering::Equal)
    }
}

// ── Serialized Format ──────────────────────────────

#[derive(Serialize, Deserialize)]
struct SerializedIndex {
    version: u32,
    dim: usize,
    #[serde(rename = "entryPoint")]
    entry_point: i64,
    #[serde(rename = "maxLevel")]
    max_level: usize,
    nodes: Vec<SerializedNode>,
}

#[derive(Serialize, Deserialize)]
struct SerializedNode {
    id: i64,
    vector: Vec<u16>,
    level: usize,
    neighbors: Vec<Vec<i64>>,
}

// ── Core Index ─────────────────────────────────────

struct HNSWIndexInner {
    nodes: HashMap<i64, HNSWNode>,
    entry_point: i64,
    max_level: usize,
    dim: usize,
}

impl HNSWIndexInner {
    fn new(dim: usize) -> Self {
        Self {
            nodes: HashMap::new(),
            entry_point: -1,
            max_level: 0,
            dim,
        }
    }

    fn random_level(&self) -> usize {
        let ml_val = ml();
        let mut level = 0usize;
        while rand_f64() < ml_val && level < MAX_LEVEL {
            level += 1;
        }
        level
    }

    fn distance_f16(&self, a: &[u16], b: &[u16]) -> f64 {
        cosine_distance_f16_f16(a, b)
    }

    fn distance_from_f32(&self, query: &[f32], b: &[u16]) -> f64 {
        cosine_distance_f32_f16(query, b)
    }

    fn search_layer(
        &self,
        query: &[f32],
        entry_ids: &[i64],
        ef: usize,
        layer: usize,
    ) -> Vec<DistIdPair> {
        let mut visited = HashSet::new();
        let mut candidates: Vec<DistIdPair> = Vec::new();
        let mut results: Vec<DistIdPair> = Vec::new();

        for &id in entry_ids {
            visited.insert(id);
            if let Some(node) = self.nodes.get(&id) {
                let dist = self.distance_from_f32(query, &node.vector);
                candidates.push(DistIdPair { id, dist });
                results.push(DistIdPair { id, dist });
            }
        }

        candidates.sort_by(|a, b| a.dist.partial_cmp(&b.dist).unwrap_or(Ordering::Equal));

        while !candidates.is_empty() {
            let nearest = candidates.remove(0);
            let farthest_dist = results
                .iter()
                .map(|r| r.dist)
                .fold(f64::NEG_INFINITY, f64::max);

            if nearest.dist > farthest_dist && results.len() >= ef {
                break;
            }

            let node = match self.nodes.get(&nearest.id) {
                Some(n) => n,
                None => continue,
            };

            let neighbors = match node.neighbors.get(layer) {
                Some(n) => n,
                None => continue,
            };

            for &neighbor_id in neighbors {
                if visited.contains(&neighbor_id) {
                    continue;
                }
                visited.insert(neighbor_id);

                let neighbor_node = match self.nodes.get(&neighbor_id) {
                    Some(n) => n,
                    None => continue,
                };

                let dist = self.distance_from_f32(query, &neighbor_node.vector);

                if results.len() < ef || dist < farthest_dist {
                    candidates.push(DistIdPair {
                        id: neighbor_id,
                        dist,
                    });
                    candidates
                        .sort_by(|a, b| a.dist.partial_cmp(&b.dist).unwrap_or(Ordering::Equal));
                    results.push(DistIdPair {
                        id: neighbor_id,
                        dist,
                    });
                    results.sort_by(|a, b| a.dist.partial_cmp(&b.dist).unwrap_or(Ordering::Equal));
                    if results.len() > ef {
                        results.pop();
                    }
                }
            }
        }

        results
    }

    fn select_neighbors(&self, candidates: &mut Vec<DistIdPair>, max_neighbors: usize) -> Vec<i64> {
        candidates.sort_by(|a, b| a.dist.partial_cmp(&b.dist).unwrap_or(Ordering::Equal));
        candidates
            .iter()
            .take(max_neighbors)
            .map(|c| c.id)
            .collect()
    }

    fn add_vector(&mut self, id: i64, embedding: &[f32]) {
        let compressed = compress_vec(embedding);
        let level = self.random_level();

        let new_node = HNSWNode {
            id,
            vector: compressed,
            level,
            neighbors: (0..=level).map(|_| Vec::new()).collect(),
        };

        // First node
        if self.entry_point == -1 {
            self.nodes.insert(id, new_node);
            self.entry_point = id;
            self.max_level = level;
            return;
        }

        // Remove old version if exists
        if self.nodes.contains_key(&id) {
            self.remove_vector(id);
        }

        self.nodes.insert(id, new_node);

        let mut current_entry_ids = vec![self.entry_point];

        // Traverse from top to the node's level + 1
        for l in (level + 1..=self.max_level).rev() {
            let nearest = self.search_layer(embedding, &current_entry_ids, 1, l);
            if !nearest.is_empty() {
                current_entry_ids = vec![nearest[0].id];
            }
        }

        // From node's level down to 0
        let start_level = std::cmp::min(level, self.max_level);
        for l in (0..=start_level).rev() {
            let candidates = self.search_layer(embedding, &current_entry_ids, EF_CONSTRUCTION, l);
            let mut candidates_clone = candidates.clone();
            let neighbors = self.select_neighbors(&mut candidates_clone, M);

            // Set neighbors for new node
            if let Some(node) = self.nodes.get_mut(&id) {
                if l < node.neighbors.len() {
                    node.neighbors[l] = neighbors.clone();
                }
            }

            // Bidirectional connections
            for &neighbor_id in &neighbors {
                // Add connection from neighbor to new node
                if let Some(neighbor) = self.nodes.get_mut(&neighbor_id) {
                    while neighbor.neighbors.len() <= l {
                        neighbor.neighbors.push(Vec::new());
                    }
                    neighbor.neighbors[l].push(id);

                    // Trim if over capacity
                    if neighbor.neighbors[l].len() > M * 2 {
                        let neighbor_vec = neighbor.vector.clone();
                        let nids: Vec<i64> = neighbor.neighbors[l].clone();
                        let mut neighbor_candidates: Vec<DistIdPair> = nids
                            .iter()
                            .map(|&nid| {
                                let dist = if let Some(n) = self.nodes.get(&nid) {
                                    self.distance_f16(&neighbor_vec, &n.vector)
                                } else {
                                    f64::INFINITY
                                };
                                DistIdPair { id: nid, dist }
                            })
                            .collect();
                        let trimmed = self.select_neighbors(&mut neighbor_candidates, M);
                        if let Some(neighbor) = self.nodes.get_mut(&neighbor_id) {
                            neighbor.neighbors[l] = trimmed;
                        }
                    }
                }
            }

            current_entry_ids = candidates.iter().map(|c| c.id).collect();
        }

        // Update entry point if new node has higher level
        if level > self.max_level {
            self.max_level = level;
            self.entry_point = id;
        }
    }

    fn remove_vector(&mut self, id: i64) {
        let node = match self.nodes.get(&id) {
            Some(n) => n.clone(),
            None => return,
        };

        // Remove from all neighbor lists
        for l in 0..=node.level {
            if let Some(layer_neighbors) = node.neighbors.get(l) {
                for &neighbor_id in layer_neighbors {
                    if let Some(neighbor) = self.nodes.get_mut(&neighbor_id) {
                        if let Some(layer) = neighbor.neighbors.get_mut(l) {
                            layer.retain(|&nid| nid != id);
                        }
                    }
                }
            }
        }

        self.nodes.remove(&id);

        // If removed node was entry point, pick a new one
        if self.entry_point == id {
            if self.nodes.is_empty() {
                self.entry_point = -1;
                self.max_level = 0;
            } else {
                let mut best_id: i64 = -1;
                let mut best_level: usize = 0;
                for (&nid, n) in &self.nodes {
                    if n.level > best_level || best_id == -1 {
                        best_id = nid;
                        best_level = n.level;
                    }
                }
                self.entry_point = best_id;
                self.max_level = best_level;
            }
        }
    }

    fn search(&self, query: &[f32], k: usize) -> Vec<SearchResultJS> {
        if self.entry_point == -1 || self.nodes.is_empty() {
            return Vec::new();
        }

        let mut current_entry_ids = vec![self.entry_point];

        // Traverse from top to layer 1
        for l in (1..=self.max_level).rev() {
            let nearest = self.search_layer(query, &current_entry_ids, 1, l);
            if !nearest.is_empty() {
                current_entry_ids = vec![nearest[0].id];
            }
        }

        // Search layer 0 with higher ef
        let ef = std::cmp::max(k, EF_SEARCH);
        let mut results = self.search_layer(query, &current_entry_ids, ef, 0);

        results.sort_by(|a, b| a.dist.partial_cmp(&b.dist).unwrap_or(Ordering::Equal));
        results
            .into_iter()
            .take(k)
            .map(|r| SearchResultJS {
                id: r.id,
                distance: r.dist,
            })
            .collect()
    }

    fn brute_force_search(&self, query: &[f32], k: usize) -> Vec<SearchResultJS> {
        if self.nodes.is_empty() {
            return Vec::new();
        }

        let mut scored: Vec<(i64, f64)> = self
            .nodes
            .iter()
            .map(|(&id, node)| {
                let dist = self.distance_from_f32(query, &node.vector);
                (id, dist)
            })
            .collect();

        scored.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(Ordering::Equal));
        scored
            .into_iter()
            .take(k)
            .map(|(id, distance)| SearchResultJS { id, distance })
            .collect()
    }

    fn to_json(&self) -> String {
        let serialized = SerializedIndex {
            version: 1,
            dim: self.dim,
            entry_point: self.entry_point,
            max_level: self.max_level,
            nodes: self
                .nodes
                .values()
                .map(|node| SerializedNode {
                    id: node.id,
                    vector: node.vector.clone(),
                    level: node.level,
                    neighbors: node.neighbors.clone(),
                })
                .collect(),
        };
        serde_json::to_string(&serialized).unwrap_or_default()
    }

    fn from_json(&mut self, json: &str) -> bool {
        let data: SerializedIndex = match serde_json::from_str(json) {
            Ok(d) => d,
            Err(_) => return false,
        };

        if data.version != 1 || data.dim != self.dim {
            return false;
        }

        self.nodes.clear();
        self.entry_point = data.entry_point;
        self.max_level = data.max_level;

        for sn in data.nodes {
            self.nodes.insert(
                sn.id,
                HNSWNode {
                    id: sn.id,
                    vector: sn.vector,
                    level: sn.level,
                    neighbors: sn.neighbors,
                },
            );
        }

        true
    }
}

// ── Simple RNG (xorshift64) ────────────────────────

use std::cell::Cell;

thread_local! {
    static RNG_STATE: Cell<u64> = Cell::new(0);
}

fn rand_f64() -> f64 {
    RNG_STATE.with(|state| {
        let mut s = state.get();
        if s == 0 {
            // Seed from time
            s = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(42);
        }
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        state.set(s);
        (s as f64) / (u64::MAX as f64)
    })
}

fn cosine_distance_f32(a: &[f32], b: &[f32]) -> f64 {
    let mut dot: f64 = 0.0;
    let mut norm_a: f64 = 0.0;
    let mut norm_b: f64 = 0.0;
    let len = a.len().min(b.len());
    for i in 0..len {
        let ai = a[i] as f64;
        let bi = b[i] as f64;
        dot += ai * bi;
        norm_a += ai * ai;
        norm_b += bi * bi;
    }
    let denom = norm_a.sqrt() * norm_b.sqrt();
    if denom == 0.0 {
        return 1.0;
    }
    1.0 - (dot / denom)
}

/// Compute cosine distance between f32 query and f16-compressed vector
/// WITHOUT allocating a temporary Vec<f32> — converts on-the-fly.
fn cosine_distance_f32_f16(a: &[f32], b_f16: &[u16]) -> f64 {
    let mut dot: f64 = 0.0;
    let mut norm_a: f64 = 0.0;
    let mut norm_b: f64 = 0.0;
    let len = a.len().min(b_f16.len());
    for i in 0..len {
        let ai = a[i] as f64;
        let bi = f16_to_f32(b_f16[i]) as f64;
        dot += ai * bi;
        norm_a += ai * ai;
        norm_b += bi * bi;
    }
    let denom = norm_a.sqrt() * norm_b.sqrt();
    if denom == 0.0 {
        return 1.0;
    }
    1.0 - (dot / denom)
}

/// Compute cosine distance between two f16-compressed vectors without heap allocation.
fn cosine_distance_f16_f16(a_f16: &[u16], b_f16: &[u16]) -> f64 {
    let mut dot: f64 = 0.0;
    let mut norm_a: f64 = 0.0;
    let mut norm_b: f64 = 0.0;
    let len = a_f16.len().min(b_f16.len());
    for i in 0..len {
        let ai = f16_to_f32(a_f16[i]) as f64;
        let bi = f16_to_f32(b_f16[i]) as f64;
        dot += ai * bi;
        norm_a += ai * ai;
        norm_b += bi * bi;
    }
    let denom = norm_a.sqrt() * norm_b.sqrt();
    if denom == 0.0 {
        return 1.0;
    }
    1.0 - (dot / denom)
}

// ── Singleton ──────────────────────────────────────

lazy_static::lazy_static! {
    static ref HNSW_INDEX: Mutex<HNSWIndexInner> = Mutex::new(HNSWIndexInner::new(384));
}

// ── NAPI Exports ───────────────────────────────────

#[napi(object)]
pub struct SearchResultJS {
    pub id: i64,
    pub distance: f64,
}

/// Create or reset the HNSW index with a given dimension
#[napi]
pub fn hnsw_create(dim: u32) -> bool {
    let mut idx = HNSW_INDEX.lock();
    *idx = HNSWIndexInner::new(dim as usize);
    true
}

/// Add a vector to the HNSW index
#[napi]
pub fn hnsw_add_vector(id: i64, embedding: Vec<f64>) -> bool {
    let f32_vec: Vec<f32> = embedding.iter().map(|&v| v as f32).collect();
    let mut idx = HNSW_INDEX.lock();
    idx.add_vector(id, &f32_vec);
    true
}

/// Remove a vector from the HNSW index
#[napi]
pub fn hnsw_remove_vector(id: i64) -> bool {
    let mut idx = HNSW_INDEX.lock();
    idx.remove_vector(id);
    true
}

/// Search for k nearest neighbors
#[napi]
pub fn hnsw_search(query: Vec<f64>, k: u32) -> Vec<SearchResultJS> {
    let f32_vec: Vec<f32> = query.iter().map(|&v| v as f32).collect();
    let idx = HNSW_INDEX.lock();
    idx.search(&f32_vec, k as usize)
}

/// Brute-force search (for small datasets or verification)
#[napi]
pub fn hnsw_brute_force_search(query: Vec<f64>, k: u32) -> Vec<SearchResultJS> {
    let f32_vec: Vec<f32> = query.iter().map(|&v| v as f32).collect();
    let idx = HNSW_INDEX.lock();
    idx.brute_force_search(&f32_vec, k as usize)
}

/// Get number of vectors in the index
#[napi]
pub fn hnsw_size() -> u32 {
    let idx = HNSW_INDEX.lock();
    idx.nodes.len() as u32
}

/// Check if a vector exists
#[napi]
pub fn hnsw_has(id: i64) -> bool {
    let idx = HNSW_INDEX.lock();
    idx.nodes.contains_key(&id)
}

/// Serialize index to JSON string (for persistence)
#[napi]
pub fn hnsw_save() -> String {
    let idx = HNSW_INDEX.lock();
    idx.to_json()
}

/// Load index from JSON string
#[napi]
pub fn hnsw_load(json: String) -> bool {
    let mut idx = HNSW_INDEX.lock();
    idx.from_json(&json)
}

/// Float16 compress a Float32 vector (returns u16 array as f64 for JS interop)
#[napi]
pub fn f16_compress(vec: Vec<f64>) -> Vec<f64> {
    let f32_vec: Vec<f32> = vec.iter().map(|&v| v as f32).collect();
    compress_vec(&f32_vec).iter().map(|&v| v as f64).collect()
}

/// Float16 decompress to Float32 vector
#[napi]
pub fn f16_decompress(compressed: Vec<f64>) -> Vec<f64> {
    let u16_vec: Vec<u16> = compressed.iter().map(|&v| v as u16).collect();
    decompress_vec(&u16_vec).iter().map(|&v| v as f64).collect()
}
