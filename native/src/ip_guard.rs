// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// IP Protection module for browser agent.
// Handles: JS code validation + exfiltration prevention, proprietary variable
// obfuscation, HMAC-signed action audit log, and module integrity fingerprint.
//
// None of the logic in this file is exposed to the user-supplied JS sandbox.
// All sensitive computations stay in Rust and never cross the WASM boundary.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use getrandom::getrandom;
use lazy_static::lazy_static;
use napi_derive::napi;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

// ── Constants ────────────────────────────────

/// Maximum entries in the action audit ring buffer
const AUDIT_RING_SIZE: usize = 512;

/// Proprietary internal variable names that must be obfuscated before
/// being written into page.evaluate() calls.
const INTERNAL_VARS: &[&str] = &[
    "__hoverAddedNodes",
    "__hoverObserver",
    "__ytPlayerEvents",
    "__ytReady",
    "__ytStateChanges",
    "__atlasCapture",
    "__atlasClickPos",
];

/// JS patterns that indicate attempted exfiltration or introspection of
/// ATLAS internals. These are blocked in validate_js_code().
const BLOCKED_PATTERNS: &[&str] = &[
    // Network exfiltration
    "XMLHttpRequest",
    "fetch(",
    "WebSocket(",
    "navigator.sendBeacon",
    "EventSource(",
    // ATLAS internal variable access
    "__hoverAddedNodes",
    "__hoverObserver",
    "__atlasCapture",
    "__atlasClickPos",
    "__ytPlayerEvents",
    // Dynamic code execution
    "eval(",
    "Function(",
    "setTimeout(",
    "setInterval(",
    // Prototype poisoning
    "__proto__",
    "prototype.constructor",
    // Node.js escape attempts (should never be in page JS but block anyway)
    "process.env",
    "require(",
    "__dirname",
];

// ── Session state ─────────────────────────────────────────────────────────────

struct IpGuardState {
    /// 32-byte HMAC key derived once per session from a random seed
    hmac_key: [u8; 32],
    /// Per-session opaque name mapping: canonical_name → session_opaque_name
    var_map: HashMap<String, String>,
    /// Audit ring buffer
    audit: Vec<AuditEntry>,
    /// Module fingerprint (set once at init from compile-time constants)
    fingerprint: String,
    /// Counters
    validations_ok: u64,
    validations_blocked: u64,
    signs_issued: u64,
}

impl IpGuardState {
    fn new() -> Self {
        let mut key = [0u8; 32];
        getrandom(&mut key).expect("ip_guard: key generation failed");

        // Build the var_map: each internal var gets a short opaque hex name
        // derived deterministically from the session key + var name.
        let mut var_map = HashMap::new();
        for &var in INTERNAL_VARS {
            let opaque = derive_opaque_name(&key, var);
            var_map.insert(var.to_string(), opaque);
        }

        // Module fingerprint — SHA-256 of compile-time sentinel constants.
        // This detects if the .node binary is replaced at runtime.
        let sentinel = format!(
            "atlas-ip-guard:{}:{}:{}",
            AUDIT_RING_SIZE,
            INTERNAL_VARS.len(),
            BLOCKED_PATTERNS.len(),
        );
        let fingerprint = sha256_hex(sentinel.as_bytes());

        Self {
            hmac_key: key,
            var_map,
            audit: Vec::with_capacity(AUDIT_RING_SIZE),
            fingerprint,
            validations_ok: 0,
            validations_blocked: 0,
            signs_issued: 0,
        }
    }
}

#[derive(Clone, Serialize)]
struct AuditEntry {
    tool_name: String,
    params_hash: String, // SHA-256 of params_json to avoid storing sensitive data
    signature: String,
    timestamp_ms: u64,
}

lazy_static! {
    static ref GUARD: Mutex<IpGuardState> = Mutex::new(IpGuardState::new());
}

// ═══════════════════════════════════════════════════
// A. JS CODE VALIDATOR + VARIABLE OBFUSCATOR
// ═══════════════════════════════════════════════════

/// Validate JavaScript code before passing it to page.evaluate().
///
/// Blocks:
/// - Network exfiltration (fetch, XHR, WebSocket, sendBeacon)
/// - Access to ATLAS internal injected variables
/// - Dynamic code execution (eval, Function constructor)
/// - Prototype pollution (__proto__, constructor)
/// - Node.js escape (process.env, require)
///
/// Returns the original code if clean, or an error with the blocked pattern.
#[napi]
pub fn validate_js_code(code: String) -> napi::Result<String> {
    let mut guard = GUARD.lock();

    for &pattern in BLOCKED_PATTERNS {
        if code.contains(pattern) {
            guard.validations_blocked += 1;
            return Err(napi::Error::from_reason(format!(
                "ip_guard: blocked pattern '{}' in js_eval code",
                pattern
            )));
        }
    }

    guard.validations_ok += 1;
    Ok(code)
}

/// Return the session-scoped opaque name for a proprietary internal variable.
///
/// Example: `obfuscate_injected_variable("__hoverAddedNodes")` → `"__a8f3c2b1"`
///
/// The mapping is stable within a session (same input → same output).
/// Different sessions produce different opaque names, preventing hardcoded
/// reverse-engineering of our injection patterns.
#[napi]
pub fn obfuscate_injected_variable(name: String) -> String {
    let guard = GUARD.lock();
    guard
        .var_map
        .get(&name)
        .cloned()
        .unwrap_or_else(|| {
            // For vars not in INTERNAL_VARS, derive on the fly
            derive_opaque_name(&guard.hmac_key, &name)
        })
}

/// Rewrite all ATLAS internal variable references in a JS code string to their
/// obfuscated session-scoped equivalents. Call this before any page.evaluate()
/// that injects our MutationObserver or other internal JS.
#[napi]
pub fn rewrite_internal_vars(code: String) -> String {
    let guard = GUARD.lock();
    let mut result = code;
    for (canonical, opaque) in &guard.var_map {
        result = result.replace(canonical.as_str(), opaque.as_str());
    }
    result
}

// ═══════════════════════════════════════════════════
// B. ACTION SIGNER + AUDIT RING BUFFER
// ═══════════════════════════════════════════════════

/// Compute HMAC-SHA256 of (tool_name + params_json) using the session key.
/// Returns a hex-encoded 32-byte MAC.
///
/// Wire this into every browser tool call to create a tamper-evident audit trail.
#[napi]
pub fn sign_browser_action(tool_name: String, params_json: String) -> String {
    let mut guard = GUARD.lock();

    let mac = hmac_sha256(&guard.hmac_key, &format!("{}{}", tool_name, params_json));
    let sig = hex::encode(&mac);
    let params_hash = sha256_hex(params_json.as_bytes());
    let ts = now_ms();

    // Append to audit ring (evict oldest when full)
    if guard.audit.len() >= AUDIT_RING_SIZE {
        guard.audit.remove(0);
    }
    guard.audit.push(AuditEntry {
        tool_name,
        params_hash,
        signature: sig.clone(),
        timestamp_ms: ts,
    });

    guard.signs_issued += 1;
    sig
}

/// Verify a previously-issued action signature. Returns true if the MAC matches.
#[napi]
pub fn verify_browser_action(tool_name: String, params_json: String, signature: String) -> bool {
    let guard = GUARD.lock();
    let expected = hmac_sha256(&guard.hmac_key, &format!("{}{}", tool_name, params_json));
    let expected_hex = hex::encode(&expected);
    // Constant-time comparison
    constant_time_eq(expected_hex.as_bytes(), signature.as_bytes())
}

/// Return the last N entries of the audit log as a JSON array.
/// Each entry: { tool_name, params_hash, signature, timestamp_ms }
#[napi]
pub fn get_action_audit_tail(n: u32) -> String {
    let guard = GUARD.lock();
    let n = (n as usize).min(guard.audit.len());
    let tail = &guard.audit[guard.audit.len() - n..];
    serde_json::to_string(tail).unwrap_or_default()
}

/// Get IP guard statistics as JSON
#[napi]
pub fn get_ip_guard_stats() -> String {
    let guard = GUARD.lock();
    serde_json::json!({
        "validations_ok": guard.validations_ok,
        "validations_blocked": guard.validations_blocked,
        "signs_issued": guard.signs_issued,
        "audit_entries": guard.audit.len(),
        "var_map_size": guard.var_map.len(),
    })
    .to_string()
}

// ═══════════════════════════════════════════════════
// C. MODULE INTEGRITY FINGERPRINT
// ═══════════════════════════════════════════════════

/// Return the compile-time module fingerprint (SHA-256 of internal sentinels).
/// TypeScript should check this on boot to detect tampered .node binaries.
#[napi]
pub fn get_module_fingerprint() -> String {
    GUARD.lock().fingerprint.clone()
}

/// Encrypt a sensitive string using the session HMAC key + AES-256-GCM.
/// Use to protect any proprietary data that must be stored outside the process.
/// Format: hex(nonce):hex(ciphertext+tag)
#[napi]
pub fn encrypt_sensitive(plaintext: String) -> napi::Result<String> {
    let guard = GUARD.lock();
    let cipher = Aes256Gcm::new_from_slice(&guard.hmac_key)
        .map_err(|e| napi::Error::from_reason(format!("cipher init: {e}")))?;

    let mut nonce_bytes = [0u8; 12];
    getrandom(&mut nonce_bytes)
        .map_err(|e| napi::Error::from_reason(format!("nonce gen: {e}")))?;

    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| napi::Error::from_reason(format!("encrypt: {e}")))?;

    Ok(format!("{}:{}", hex::encode(nonce_bytes), hex::encode(ct)))
}

/// Decrypt a string previously encrypted with encrypt_sensitive()
#[napi]
pub fn decrypt_sensitive(encrypted: String) -> napi::Result<String> {
    let guard = GUARD.lock();
    let parts: Vec<&str> = encrypted.splitn(2, ':').collect();
    if parts.len() != 2 {
        return Err(napi::Error::from_reason("ip_guard: invalid encrypted format"));
    }

    let nonce_bytes = hex::decode(parts[0])
        .map_err(|e| napi::Error::from_reason(format!("nonce decode: {e}")))?;
    let ct = hex::decode(parts[1])
        .map_err(|e| napi::Error::from_reason(format!("ct decode: {e}")))?;

    let cipher = Aes256Gcm::new_from_slice(&guard.hmac_key)
        .map_err(|e| napi::Error::from_reason(format!("cipher init: {e}")))?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    let pt = cipher
        .decrypt(nonce, ct.as_ref())
        .map_err(|e| napi::Error::from_reason(format!("decrypt: {e}")))?;

    String::from_utf8(pt)
        .map_err(|e| napi::Error::from_reason(format!("utf8: {e}")))
}

// ── Internal helpers ─────────────────────────────

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// HMAC-SHA256: H(key, message) — manual implementation using SHA-256 from the
/// security module's scrypt dependency chain. We roll a minimal HMAC here to
/// avoid adding a new crate (ring/hmac are heavy).
fn hmac_sha256(key: &[u8; 32], message: &str) -> [u8; 32] {
    // HMAC-SHA256 = SHA256((key XOR opad) || SHA256((key XOR ipad) || message))
    // ipad = 0x36 repeated, opad = 0x5c repeated
    let mut ikey = [0u8; 64];
    let mut okey = [0u8; 64];
    for i in 0..32 {
        ikey[i] = key[i] ^ 0x36;
        okey[i] = key[i] ^ 0x5c;
    }
    for i in 32..64 {
        ikey[i] = 0x36;
        okey[i] = 0x5c;
    }

    // inner = SHA256(ikey || message)
    let mut inner_input = ikey.to_vec();
    inner_input.extend_from_slice(message.as_bytes());
    let inner = sha256_bytes(&inner_input);

    // outer = SHA256(okey || inner)
    let mut outer_input = okey.to_vec();
    outer_input.extend_from_slice(&inner);
    sha256_bytes(&outer_input)
}

/// Pure-Rust SHA-256 implementation (no external crates required — uses our
/// own bitwise operations, matching FIPS 180-4).
fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    // SHA-256 initial hash values (first 32 bits of fractional parts of square roots of first 8 primes)
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];

    // Round constants (first 32 bits of fractional parts of cube roots of first 64 primes)
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
        0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
        0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
        0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
        0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
        0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];

    // Pre-processing: padding
    let bit_len = (data.len() as u64) * 8;
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    // Process each 512-bit (64-byte) chunk
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[i*4], chunk[i*4+1], chunk[i*4+2], chunk[i*4+3]]);
        }
        for i in 16..64 {
            let s0 = w[i-15].rotate_right(7) ^ w[i-15].rotate_right(18) ^ (w[i-15] >> 3);
            let s1 = w[i-2].rotate_right(17) ^ w[i-2].rotate_right(19) ^ (w[i-2] >> 10);
            w[i] = w[i-16].wrapping_add(s0).wrapping_add(w[i-7]).wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] =
            [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]];

        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            hh = g; g = f; f = e;
            e = d.wrapping_add(temp1);
            d = c; c = b; b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a); h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c); h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e); h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g); h[7] = h[7].wrapping_add(hh);
    }

    let mut out = [0u8; 32];
    for (i, &word) in h.iter().enumerate() {
        out[i*4..i*4+4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(sha256_bytes(data))
}

/// Derive a short opaque variable name from the session key + canonical name.
/// Output: "__" + first 6 hex chars of SHA-256(key || name)
fn derive_opaque_name(key: &[u8; 32], name: &str) -> String {
    let mut input = key.to_vec();
    input.extend_from_slice(name.as_bytes());
    let hash = sha256_bytes(&input);
    format!("__{}", hex::encode(&hash[..3]))
}

/// Constant-time byte comparison
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() { return false; }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}
