// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Batch vector operations with parallel processing

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rayon::prelude::*;

/// Result of a similarity search
#[napi(object)]
pub struct SimilarityResult {
    pub index: u32,
    pub score: f64,
}

/// Find top-k most similar vectors to a query using parallel processing
/// Returns indices and scores sorted by similarity (highest first)
#[napi]
pub fn find_top_k_similar(
    query: Float32Array,
    vectors: Vec<Float32Array>,
    k: u32,
) -> Result<Vec<SimilarityResult>> {
    let query_slice = query.as_ref();
    let k = k as usize;

    if vectors.is_empty() {
        return Ok(vec![]);
    }

    // Convert NAPI arrays to slices for rayon compatibility
    let slices: Vec<&[f32]> = vectors.iter().map(|v| v.as_ref()).collect();

    // Compute similarities in parallel
    let mut scored: Vec<(usize, f64)> = slices
        .par_iter()
        .enumerate()
        .map(|(i, v_slice)| {
            if v_slice.len() != query_slice.len() {
                (i, f64::NEG_INFINITY)
            } else {
                let score = cosine_similarity_internal(query_slice, v_slice);
                (i, score)
            }
        })
        .collect();

    // Sort by score descending
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    // Take top k
    let results: Vec<SimilarityResult> = scored
        .into_iter()
        .take(k)
        .filter(|(_, score)| score.is_finite())
        .map(|(index, score)| SimilarityResult {
            index: index as u32,
            score,
        })
        .collect();

    Ok(results)
}

/// Compute pairwise cosine similarities between all vectors in a batch
/// Returns a flat array of similarity scores (upper triangle of similarity matrix)
#[napi]
pub fn batch_pairwise_similarity(vectors: Vec<Float32Array>) -> Result<Vec<f64>> {
    let n = vectors.len();
    if n < 2 {
        return Ok(vec![]);
    }

    // Pre-allocate result array for upper triangle
    let num_pairs = n * (n - 1) / 2;
    let mut results = vec![0.0f64; num_pairs];

    // Convert to slices for faster access
    let slices: Vec<&[f32]> = vectors.iter().map(|v| v.as_ref()).collect();

    // Compute pairwise similarities in parallel
    results
        .par_iter_mut()
        .enumerate()
        .for_each(|(pair_idx, result)| {
            // Convert linear index to (i, j) pair
            let (i, j) = linear_to_pair(pair_idx, n);
            *result = cosine_similarity_internal(slices[i], slices[j]);
        });

    Ok(results)
}

/// Compute cosine similarities between a query and multiple vectors
/// Returns an array of similarity scores
#[napi]
pub fn batch_cosine_similarity(
    query: Float32Array,
    vectors: Vec<Float32Array>,
) -> Result<Vec<f64>> {
    let query_slice = query.as_ref();

    // Convert NAPI arrays to slices for rayon compatibility
    let slices: Vec<&[f32]> = vectors.iter().map(|v| v.as_ref()).collect();

    let results: Vec<f64> = slices
        .par_iter()
        .map(|v_slice| {
            if v_slice.len() != query_slice.len() {
                f64::NEG_INFINITY
            } else {
                cosine_similarity_internal(query_slice, v_slice)
            }
        })
        .collect();

    Ok(results)
}

/// Quantize f32 vectors to i8 for memory efficiency (4x reduction)
/// Values are scaled to [-127, 127] range
#[napi]
pub fn quantize_to_int8(vec: Float32Array) -> Int8Array {
    let slice = vec.as_ref();

    // Find min/max for scaling
    let mut min_val = f32::INFINITY;
    let mut max_val = f32::NEG_INFINITY;
    for &v in slice {
        if v < min_val {
            min_val = v;
        }
        if v > max_val {
            max_val = v;
        }
    }

    let range = max_val - min_val;
    let scale = if range > 0.0 { 254.0 / range } else { 1.0 };

    let quantized: Vec<i8> = slice
        .iter()
        .map(|&v| {
            let normalized = ((v - min_val) * scale - 127.0).clamp(-127.0, 127.0);
            normalized as i8
        })
        .collect();

    Int8Array::new(quantized)
}

/// Dequantize i8 vectors back to f32
/// Note: This is lossy - original values won't be exactly recovered
#[napi]
pub fn dequantize_from_int8(vec: Int8Array, min_val: f64, max_val: f64) -> Float32Array {
    let slice = vec.as_ref();
    let min_val = min_val as f32;
    let max_val = max_val as f32;
    let range = max_val - min_val;
    let scale = if range > 0.0 { range / 254.0 } else { 1.0 };

    let dequantized: Vec<f32> = slice
        .iter()
        .map(|&v| (v as f32 + 127.0) * scale + min_val)
        .collect();

    Float32Array::new(dequantized)
}

// ═══════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════

/// Internal cosine similarity (no error handling, for batch operations)
#[inline]
fn cosine_similarity_internal(a: &[f32], b: &[f32]) -> f64 {
    let mut dot = 0.0f64;
    let mut norm_a = 0.0f64;
    let mut norm_b = 0.0f64;

    for i in 0..a.len() {
        let av = a[i] as f64;
        let bv = b[i] as f64;
        dot += av * bv;
        norm_a += av * av;
        norm_b += bv * bv;
    }

    let denom = (norm_a * norm_b).sqrt();
    if denom == 0.0 {
        0.0
    } else {
        dot / denom
    }
}

/// Convert linear index to pair indices (i, j) where i < j
#[inline]
fn linear_to_pair(idx: usize, n: usize) -> (usize, usize) {
    // Solve: idx = i*n - i*(i+1)/2 + j - i - 1
    let i = n
        - 2
        - ((((8 * (n * (n - 1) / 2 - 1 - idx) + 1) as f64).sqrt() - 1.0) / 2.0).floor() as usize;
    let j = idx - i * (n - 1) + (i + 1) * i / 2 + i + 1;
    (i, j)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_linear_to_pair() {
        // For n=4, pairs are: (0,1), (0,2), (0,3), (1,2), (1,3), (2,3)
        assert_eq!(linear_to_pair(0, 4), (0, 1));
        assert_eq!(linear_to_pair(1, 4), (0, 2));
        assert_eq!(linear_to_pair(2, 4), (0, 3));
        assert_eq!(linear_to_pair(3, 4), (1, 2));
        assert_eq!(linear_to_pair(4, 4), (1, 3));
        assert_eq!(linear_to_pair(5, 4), (2, 3));
    }
}
