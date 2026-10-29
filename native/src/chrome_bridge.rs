// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Native Rust module for Chrome Bridge protocol security and performance.
// Handles: token generation, message authentication, and fast JSON validation.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use getrandom::getrandom;
use napi_derive::napi;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

lazy_static::lazy_static! {
    /// Active session state for the Chrome bridge
    static ref BRIDGE_STATE: Mutex<BridgeState> = Mutex::new(BridgeState::default());

    /// Rate limiter: command type -> (count, window_start_ms)
    static ref RATE_LIMITS: Mutex<HashMap<String, (u32, u64)>> = Mutex::new(HashMap::new());
}

/// Maximum commands per second per command type
const MAX_COMMANDS_PER_SECOND: u32 = 30;

/// Token expiry: 24 hours in milliseconds
const TOKEN_EXPIRY_MS: u64 = 24 * 60 * 60 * 1000;

// ── Bridge State ─────────────────────────────

#[derive(Default)]
struct BridgeState {
    token: Option<String>,
    token_created_at: u64,
    encryption_key: Option<[u8; 32]>,
    authenticated: bool,
    total_commands: u64,
    total_errors: u64,
}

// ── Token Generation ─────────────────────────

/// Generate a cryptographically secure bridge token (32-byte hex string).
/// This token is shared between Bhai and the Chrome extension for auth.
#[napi]
pub fn generate_bridge_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom(&mut bytes).expect("Failed to generate random bytes");
    let token = hex::encode(bytes);

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    let mut state = BRIDGE_STATE.lock();
    state.token = Some(token.clone());
    state.token_created_at = now;
    state.authenticated = false;

    // Derive an encryption key from the token using SHA-256. The previous
    // implementation XOR-folded the 64-byte hex string into a 32-byte buffer
    // via i % 32, which collapses key entropy from ~256 bits down to roughly
    // the per-byte entropy of hex (~24 effective bits) because key[j] ends
    // up = token[j] ^ token[j+32]. SHA-256 of the token bytes preserves the
    // full ~128-bit security margin.
    state.encryption_key = Some(derive_bridge_key(token.as_bytes()));

    token
}

/// Derive the AES-256 message-encryption key from token bytes via SHA-256.
fn derive_bridge_key(token_bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"atlas-chrome-bridge-key/v1|");
    hasher.update(token_bytes);
    let digest = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

/// Set the bridge token (used when loading from disk to sync Rust state).
/// This primes the Rust BRIDGE_STATE so that validate_bridge_token works
/// correctly with tokens loaded from the filesystem.
#[napi]
pub fn set_bridge_token(token: String) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    let mut state = BRIDGE_STATE.lock();
    state.token = Some(token.clone());
    state.token_created_at = now;
    state.authenticated = false;

    state.encryption_key = Some(derive_bridge_key(token.as_bytes()));
}

/// Validate a token against the stored one. Returns true if valid.
#[napi]
pub fn validate_bridge_token(token: String) -> bool {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    let mut state = BRIDGE_STATE.lock();

    // Check token exists
    let stored = match &state.token {
        Some(t) => t.clone(),
        None => return false,
    };

    // Check expiry
    if now - state.token_created_at > TOKEN_EXPIRY_MS {
        state.token = None;
        state.authenticated = false;
        return false;
    }

    // Constant-time comparison to prevent timing attacks
    if constant_time_eq(stored.as_bytes(), token.as_bytes()) {
        state.authenticated = true;
        true
    } else {
        false
    }
}

/// Check if the bridge is currently authenticated
#[napi]
pub fn is_bridge_authenticated() -> bool {
    BRIDGE_STATE.lock().authenticated
}

/// Revoke/rotate the current token (forces re-auth)
#[napi]
pub fn revoke_bridge_token() -> String {
    let mut state = BRIDGE_STATE.lock();
    state.authenticated = false;
    state.token = None;
    state.encryption_key = None;
    drop(state);
    generate_bridge_token()
}

// ── Message Encryption ───────────────────────

/// Encrypt a bridge message payload using the session key.
/// Used for sensitive data like page content, form values.
#[napi]
pub fn encrypt_bridge_message(plaintext: String) -> napi::Result<String> {
    let state = BRIDGE_STATE.lock();
    let key = state.encryption_key.ok_or_else(|| {
        napi::Error::from_reason("No encryption key — generate a bridge token first")
    })?;

    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| napi::Error::from_reason(format!("Cipher init failed: {e}")))?;

    let mut nonce_bytes = [0u8; 12];
    getrandom(&mut nonce_bytes)
        .map_err(|e| napi::Error::from_reason(format!("Nonce generation failed: {e}")))?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| napi::Error::from_reason(format!("Encryption failed: {e}")))?;

    // Format: hex(nonce) + ":" + hex(ciphertext)
    Ok(format!(
        "{}:{}",
        hex::encode(nonce_bytes),
        hex::encode(ciphertext)
    ))
}

/// Decrypt a bridge message payload.
#[napi]
pub fn decrypt_bridge_message(encrypted: String) -> napi::Result<String> {
    let state = BRIDGE_STATE.lock();
    let key = state.encryption_key.ok_or_else(|| {
        napi::Error::from_reason("No encryption key — generate a bridge token first")
    })?;

    let parts: Vec<&str> = encrypted.splitn(2, ':').collect();
    if parts.len() != 2 {
        return Err(napi::Error::from_reason(
            "Invalid encrypted format: expected nonce:ciphertext",
        ));
    }

    let nonce_bytes = hex::decode(parts[0])
        .map_err(|e| napi::Error::from_reason(format!("Invalid nonce hex: {e}")))?;
    let ciphertext = hex::decode(parts[1])
        .map_err(|e| napi::Error::from_reason(format!("Invalid ciphertext hex: {e}")))?;

    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| napi::Error::from_reason(format!("Cipher init failed: {e}")))?;

    let nonce = Nonce::from_slice(&nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|e| napi::Error::from_reason(format!("Decryption failed: {e}")))?;

    String::from_utf8(plaintext)
        .map_err(|e| napi::Error::from_reason(format!("Invalid UTF-8: {e}")))
}

// ── Rate Limiting ────────────────────────────

/// Check if a command type is within rate limits. Returns true if allowed.
#[napi]
pub fn check_bridge_rate_limit(command_type: String) -> bool {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    let mut limits = RATE_LIMITS.lock();
    let entry = limits.entry(command_type).or_insert((0, now));

    // Reset window if >1 second elapsed
    if now - entry.1 > 1000 {
        entry.0 = 0;
        entry.1 = now;
    }

    if entry.0 >= MAX_COMMANDS_PER_SECOND {
        return false;
    }

    entry.0 += 1;
    true
}

// ── Command Validation ───────────────────────

/// Validate a bridge command JSON payload. Fast native validation
/// prevents malformed commands from reaching the handler layer.
#[napi]
pub fn validate_bridge_command(json_str: String) -> napi::Result<String> {
    let cmd: BridgeCommandValidation = serde_json::from_str(&json_str)
        .map_err(|e| napi::Error::from_reason(format!("Invalid command JSON: {e}")))?;

    // Validate required fields
    if cmd.id.is_empty() {
        return Err(napi::Error::from_reason("Command 'id' must not be empty"));
    }

    if cmd.r#type.is_empty() {
        return Err(napi::Error::from_reason("Command 'type' must not be empty"));
    }

    // Validate command type is in the allowed set
    if !is_allowed_command(&cmd.r#type) {
        return Err(napi::Error::from_reason(format!(
            "Unknown command type: '{}' — not in allowed set",
            cmd.r#type
        )));
    }

    // Rate limit check
    if !check_bridge_rate_limit(cmd.r#type.clone()) {
        return Err(napi::Error::from_reason(format!(
            "Rate limit exceeded for command type: '{}'",
            cmd.r#type
        )));
    }

    // Track stats
    {
        let mut state = BRIDGE_STATE.lock();
        state.total_commands += 1;
    }

    Ok(json_str)
}

/// Get bridge statistics
#[napi]
pub fn get_bridge_stats() -> String {
    let state = BRIDGE_STATE.lock();
    serde_json::to_string(&BridgeStats {
        authenticated: state.authenticated,
        total_commands: state.total_commands,
        total_errors: state.total_errors,
        has_token: state.token.is_some(),
    })
    .unwrap_or_default()
}

/// Record a bridge error
#[napi]
pub fn record_bridge_error() {
    let mut state = BRIDGE_STATE.lock();
    state.total_errors += 1;
}

// ── Internal Helpers ─────────────────────────

#[derive(Deserialize)]
struct BridgeCommandValidation {
    id: String,
    r#type: String,
}

#[derive(Serialize)]
struct BridgeStats {
    authenticated: bool,
    total_commands: u64,
    total_errors: u64,
    has_token: bool,
}

/// Allowed command types for the Chrome bridge protocol
fn is_allowed_command(cmd: &str) -> bool {
    matches!(
        cmd,
        "get_active_tab"
            | "get_all_tabs"
            | "scan_elements"
            | "click_at"
            | "type_text"
            | "scroll"
            | "execute_js"
            | "navigate"
            | "go_back"
            | "screenshot"
            | "switch_tab"
            | "close_tab"
            | "keyboard"
            | "hover"
            | "select_option"
            | "wait_for"
            | "ping"
            // Raw CDP (allowlisted in the extension): native typing, file inputs, real
            // mouse input for the CAPTCHA solver; the site-scoped cookie read used to
            // carry a login into Playwright.
            | "cdp"
            | "get_cookies"
            // The picture-CAPTCHA solver: read widget frames, play a mouse gesture
            | "captcha_frames"
            | "mouse_path"
    )
}

/// Constant-time byte comparison to prevent timing attacks on token validation
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}
