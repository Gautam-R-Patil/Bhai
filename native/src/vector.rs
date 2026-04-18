// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// SIMD-accelerated vector operations

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Compute cosine similarity between two f32 vectors using SIMD
/// Returns a value between -1.0 and 1.0
#[napi]
pub fn cosine_similarity(a: Float32Array, b: Float32Array) -> Result<f64> {
    let a_slice = a.as_ref();
    let b_slice = b.as_ref();

    if a_slice.len() != b_slice.len() {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Vector length mismatch: {} vs {}", a_slice.len(), b_slice.len()),
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
            format!("Vector length mismatch: {} vs {}", a_slice.len(), b_slice.len()),
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
            format!("Vector length mismatch: {} vs {}", a_slice.len(), b_slice.len()),
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

/// SIMD-accelerated cosine similarity
/// Processes 8 elements at a time on x86_64 with AVX2
#[inline]
fn cosine_similarity_simd(a: &[f32], b: &[f32]) -> f64 {
    let mut dot = 0.0f64;
    let mut norm_a = 0.0f64;
    let mut norm_b = 0.0f64;

    // Process in chunks of 8 for better SIMD utilization
    let chunks = a.len() / 8;
    let remainder = a.len() % 8;

    for i in 0..chunks {
        let base = i * 8;

        // Unroll 8 elements - compiler will vectorize this
        for j in 0..8 {
            let av = a[base + j] as f64;
            let bv = b[base + j] as f64;
            dot += av * bv;
            norm_a += av * av;
            norm_b += bv * bv;
        }
    }

    // Handle remainder
    let base = chunks * 8;
    for i in 0..remainder {
        let av = a[base + i] as f64;
        let bv = b[base + i] as f64;
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

/// SIMD-accelerated dot product
#[inline]
fn dot_product_simd(a: &[f32], b: &[f32]) -> f64 {
    let mut sum = 0.0f64;

    let chunks = a.len() / 8;
    let remainder = a.len() % 8;

    for i in 0..chunks {
        let base = i * 8;
        for j in 0..8 {
            sum += (a[base + j] as f64) * (b[base + j] as f64);
        }
    }

    let base = chunks * 8;
    for i in 0..remainder {
        sum += (a[base + i] as f64) * (b[base + i] as f64);
    }

    sum
}

/// SIMD-accelerated Euclidean distance
#[inline]
fn euclidean_distance_simd(a: &[f32], b: &[f32]) -> f64 {
    let mut sum = 0.0f64;

    let chunks = a.len() / 8;
    let remainder = a.len() % 8;

    for i in 0..chunks {
        let base = i * 8;
        for j in 0..8 {
            let diff = (a[base + j] as f64) - (b[base + j] as f64);
            sum += diff * diff;
        }
    }

    let base = chunks * 8;
    for i in 0..remainder {
        let diff = (a[base + i] as f64) - (b[base + i] as f64);
        sum += diff * diff;
    }

    sum.sqrt()
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
