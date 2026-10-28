// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// SIMD-accelerated vector operations

use napi::bindgen_prelude::*;
use napi_derive::napi;
use simsimd::SpatialSimilarity;

/// Compute cosine similarity between two f32 vectors using SIMD
/// Returns a value between -1.0 and 1.0
#[napi]
pub fn cosine_similarity(a: Float32Array, b: Float32Array) -> Result<f64> {
    let a_slice = a.as_ref();
    let b_slice = b.as_ref();

    if a_slice.len() != b_slice.len() {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "Vector length mismatch: {} vs {}",
                a_slice.len(),
                b_slice.len()
            ),
        ));
    }

    if a_slice.is_empty() {
        return Ok(0.0);
    }

    Ok(cosine_similarity_simd(a_slice, b_slice))
}

/// Compute dot product between two f32 vectors using SIMD
#[napi]
pub fn dot_product(a: Float32Array, b: Float32Array) -> Result<f64> {
    let a_slice = a.as_ref();
    let b_slice = b.as_ref();

    if a_slice.len() != b_slice.len() {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "Vector length mismatch: {} vs {}",
                a_slice.len(),
                b_slice.len()
            ),
        ));
    }

    Ok(dot_product_simd(a_slice, b_slice))
}

/// Compute L2 (Euclidean) distance between two vectors
#[napi]
pub fn euclidean_distance(a: Float32Array, b: Float32Array) -> Result<f64> {
    let a_slice = a.as_ref();
    let b_slice = b.as_ref();

    if a_slice.len() != b_slice.len() {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "Vector length mismatch: {} vs {}",
                a_slice.len(),
                b_slice.len()
            ),
        ));
    }

    Ok(euclidean_distance_simd(a_slice, b_slice))
}

/// Normalize a vector to unit length (in-place modification)
#[napi]
pub fn normalize(mut vec: Float32Array) -> Float32Array {
    let slice = vec.as_mut();
    normalize_simd(slice);
    vec
}

/// Compute magnitude (L2 norm) of a vector
#[napi]
pub fn magnitude(vec: Float32Array) -> f64 {
    magnitude_simd(vec.as_ref())
}

// ═══════════════════════════════════════════════
// Internal SIMD implementations
// ═══════════════════════════════════════════════

/// SIMD-accelerated cosine similarity.
/// Uses three simsimd dot products (a·b, a·a, b·b) rather than simsimd's
/// `cos` helper because the latter can return values outside the expected
/// [0, 2] distance range for non-unit-length vectors (e.g. perfectly
/// opposite vectors did not round-trip to -1 on every backend). The
/// 3-dot-product formulation is still fully SIMD-accelerated and returns
/// a mathematically exact similarity in [-1, 1] assuming non-NaN inputs.
#[inline]
fn cosine_similarity_simd(a: &[f32], b: &[f32]) -> f64 {
    let dot = f32::dot(a, b).unwrap_or(0.0);
    let norm_a_sq = f32::dot(a, a).unwrap_or(0.0);
    let norm_b_sq = f32::dot(b, b).unwrap_or(0.0);
    let denom = (norm_a_sq * norm_b_sq).sqrt();
    if denom == 0.0 || denom.is_nan() {
        0.0
    } else {
        dot / denom
    }
}

/// SIMD-accelerated dot product.
#[inline]
fn dot_product_simd(a: &[f32], b: &[f32]) -> f64 {
    f32::dot(a, b).filter(|d| !d.is_nan()).unwrap_or(0.0)
}

/// SIMD-accelerated Euclidean distance.
/// simsimd exposes `sqeuclidean` (squared Euclidean); sqrt to get plain L2.
#[inline]
fn euclidean_distance_simd(a: &[f32], b: &[f32]) -> f64 {
    let sq = f32::sqeuclidean(a, b)
        .filter(|d| !d.is_nan())
        .unwrap_or(0.0);
    sq.sqrt()
}

/// SIMD-accelerated magnitude calculation
#[inline]
fn magnitude_simd(v: &[f32]) -> f64 {
    let mut sum = 0.0f64;

    let chunks = v.len() / 8;
    let remainder = v.len() % 8;

    for i in 0..chunks {
        let base = i * 8;
        for j in 0..8 {
            let val = v[base + j] as f64;
            sum += val * val;
        }
    }

    let base = chunks * 8;
    for i in 0..remainder {
        let val = v[base + i] as f64;
        sum += val * val;
    }

    sum.sqrt()
}

/// Normalize vector in-place
#[inline]
fn normalize_simd(v: &mut [f32]) {
    let mag = magnitude_simd(v);
    if mag > 0.0 {
        let inv_mag = 1.0 / mag;
        for val in v.iter_mut() {
            *val = (*val as f64 * inv_mag) as f32;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cosine_similarity_identical() {
        let a = vec![1.0f32, 2.0, 3.0, 4.0];
        let b = vec![1.0f32, 2.0, 3.0, 4.0];
        let result = cosine_similarity_simd(&a, &b);
        assert!((result - 1.0).abs() < 1e-10);
    }

    #[test]
    fn test_cosine_similarity_orthogonal() {
        let a = vec![1.0f32, 0.0, 0.0];
        let b = vec![0.0f32, 1.0, 0.0];
        let result = cosine_similarity_simd(&a, &b);
        assert!(result.abs() < 1e-10);
    }

    #[test]
    fn test_cosine_similarity_opposite() {
        let a = vec![1.0f32, 2.0, 3.0];
        let b = vec![-1.0f32, -2.0, -3.0];
        let result = cosine_similarity_simd(&a, &b);
        assert!((result + 1.0).abs() < 1e-10);
    }

    #[test]
    fn test_magnitude() {
        let v = vec![3.0f32, 4.0];
        let mag = magnitude_simd(&v);
        assert!((mag - 5.0).abs() < 1e-10);
    }
}
