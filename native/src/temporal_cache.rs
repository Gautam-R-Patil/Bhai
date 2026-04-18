// Copyright (c) 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Temporal Locality Cache — Full port of src/memory/temporal-cache.ts

use napi_derive::napi;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Constants ──────────────────────────────────────

const BLOOM_SIZE: usize = 1 << 17; // 131072 bits = 16KB
const BLOOM_HASH_COUNT: usize = 7;
const LRU_MAX_SIZE: usize = 500;
const LRU_TTL_MS: u64 = 5 * 60 * 1000; // 5 minutes

// ── Bloom Filter ───────────────────────────────────

struct BloomFilter {
    bits: Vec<u32>,
}

impl BloomFilter {
    fn new() -> Self {
        Self {
            bits: vec![0u32; BLOOM_SIZE >> 5],
        }
    }

    fn hashes(&self, key: &str) -> Vec<usize> {
        let mut h: Vec<usize> = Vec::with_capacity(BLOOM_HASH_COUNT);

        // FNV-1a for h1
        let mut h1: u32 = 0;
        for byte in key.bytes() {
            h1 ^= byte as u32;
            h1 = h1.wrapping_mul(0x01000193);
        }

        // DJB2 for h2
        let mut h2: u32 = 0;
        for byte in key.bytes() {
            h2 = h2.wrapping_mul(33).wrapping_add(byte as u32);
        }

        for i in 0..BLOOM_HASH_COUNT {
            let combined = (h1 as i64 + (i as i64) * (h2 as i64)).unsigned_abs() as usize;
            h.push(combined % BLOOM_SIZE);
        }
        h
    }

    fn add(&mut self, key: &str) {
        for hash in self.hashes(key) {
            self.bits[hash >> 5] |= 1 << (hash & 31);
        }
    }

    fn might_contain(&self, key: &str) -> bool {
        for hash in self.hashes(key) {
            if self.bits[hash >> 5] & (1 << (hash & 31)) == 0 {
                return false;
            }
        }
        true
    }

    fn clear(&mut self) {
        self.bits.fill(0);
    }
}

// ── LRU Cache Entry ────────────────────────────────

#[derive(Clone)]
struct CacheEntry {
    results_json: String, // Serialized MemoryRecord[]
    timestamp: u64,
    query_hash: String,
}

// ── Temporal Cache Inner ───────────────────────────

struct TemporalCacheInner {
    bloom: BloomFilter,
    cache: HashMap<String, CacheEntry>,
    access_order: Vec<String>,
}

impl TemporalCacheInner {
    fn new() -> Self {
        Self {
            bloom: BloomFilter::new(),
            cache: HashMap::new(),
            access_order: Vec::new(),
        }
    }

    fn hash_query(&self, query: &str) -> String {
        let normalized = query.to_lowercase().trim().to_string();
        let mut hash: i32 = 0;
        for byte in normalized.bytes() {
            hash = hash.wrapping_mul(31).wrapping_add(byte as i32);
        }
        format!("{}", hash)
    }

    fn register_content(&mut self, content: &str) {
        let words: Vec<&str> = content
            .to_lowercase()
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .filter(|w| w.len() > 3)
            .collect();
        // Need to own the strings due to lifetime
        let lower = content.to_lowercase();
        for word in lower
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .filter(|w| w.len() > 3)
        {
            self.bloom.add(word);
        }
    }

    fn might_have_content(&self, query: &str) -> bool {
        let lower = query.to_lowercase();
        let words: Vec<&str> = lower
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .filter(|w| w.len() > 3)
            .collect();

        if words.is_empty() {
            return true;
        }
        words.iter().any(|w| self.bloom.might_contain(w))
    }

    fn get(&mut self, query: &str) -> Option<String> {
        let hash = self.hash_query(query);
        let entry = self.cache.get(&hash)?.clone();

        let now = now_ms();
        if now - entry.timestamp > LRU_TTL_MS {
            self.cache.remove(&hash);
            self.access_order.retain(|h| h != &hash);
            return None;
        }

        // Move to end (most recent)
        self.access_order.retain(|h| h != &hash);
        self.access_order.push(hash);

        Some(entry.results_json)
    }

    fn set(&mut self, query: &str, results_json: &str) {
        let hash = self.hash_query(query);

        // Evict LRU if at capacity
        while self.cache.len() >= LRU_MAX_SIZE && !self.access_order.is_empty() {
            let evict_hash = self.access_order.remove(0);
            self.cache.remove(&evict_hash);
        }

        self.cache.insert(
            hash.clone(),
            CacheEntry {
                results_json: results_json.to_string(),
                timestamp: now_ms(),
                query_hash: hash.clone(),
            },
        );

        self.access_order.retain(|h| h != &hash);
        self.access_order.push(hash);
    }

    fn invalidate(&mut self, memory_id: i64) {
        let memory_id_str = memory_id.to_string();
        let to_remove: Vec<String> = self
            .cache
            .iter()
            .filter(|(_, entry)| entry.results_json.contains(&memory_id_str))
            .map(|(hash, _)| hash.clone())
            .collect();

        for hash in &to_remove {
            self.cache.remove(hash);
            self.access_order.retain(|h| h != hash);
        }
    }

    fn clear_cache(&mut self) {
        self.cache.clear();
        self.access_order.clear();
    }

    fn clear_all(&mut self) {
        self.clear_cache();
        self.bloom.clear();
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ── Singleton ──────────────────────────────────────

lazy_static::lazy_static! {
    static ref TEMPORAL_CACHE: Mutex<TemporalCacheInner> = Mutex::new(TemporalCacheInner::new());
}

// ── NAPI Exports ───────────────────────────────────

/// Register content keywords in the bloom filter
#[napi]
pub fn temporal_cache_register_content(content: String) {
    let mut cache = TEMPORAL_CACHE.lock();
    cache.register_content(&content);
}

/// Quick check: might ANY content match these keywords?
#[napi]
pub fn temporal_cache_might_have_content(query: String) -> bool {
    let cache = TEMPORAL_CACHE.lock();
    cache.might_have_content(&query)
}

/// Try to get cached results for a query (returns JSON string or null)
#[napi]
pub fn temporal_cache_get(query: String) -> Option<String> {
    let mut cache = TEMPORAL_CACHE.lock();
    cache.get(&query)
}

/// Store results for a query (results as JSON string)
#[napi]
pub fn temporal_cache_set(query: String, results_json: String) {
    let mut cache = TEMPORAL_CACHE.lock();
    cache.set(&query, &results_json);
}

/// Invalidate all cache entries containing a specific memory ID
#[napi]
pub fn temporal_cache_invalidate(memory_id: i64) {
    let mut cache = TEMPORAL_CACHE.lock();
    cache.invalidate(memory_id);
}

/// Clear the LRU cache
#[napi]
pub fn temporal_cache_clear() {
    let mut cache = TEMPORAL_CACHE.lock();
    cache.clear_cache();
}

/// Clear everything including bloom filter
#[napi]
pub fn temporal_cache_clear_all() {
    let mut cache = TEMPORAL_CACHE.lock();
    cache.clear_all();
}

/// Get cache stats
#[napi(object)]
pub struct CacheStats {
    pub cache_size: u32,
    pub max_cache: u32,
}

#[napi]
pub fn temporal_cache_stats() -> CacheStats {
    let cache = TEMPORAL_CACHE.lock();
    CacheStats {
        cache_size: cache.cache.len() as u32,
        max_cache: LRU_MAX_SIZE as u32,
    }
}
