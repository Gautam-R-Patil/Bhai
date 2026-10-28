// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Security modules — Rust port of allowlist + crypto operations.
// Cross-platform: macOS, Windows, Linux.

use std::collections::HashSet;

use lazy_static::lazy_static;
use napi_derive::napi;
use parking_lot::Mutex;
use regex::Regex;

// ══════════════════════════════════════════════════
// ALLOWLIST — Path protection + destructive command detection
// ══════════════════════════════════════════════════

lazy_static! {
    /// Protected codebase paths (self-protection).
    /// Populated at runtime by JS callers via add_protected_path; we no
    /// longer ship a developer-machine path in the binary. JS can pin
    /// the install-time codebase root after boot.
    static ref PROTECTED_PATHS: Mutex<Vec<String>> = Mutex::new(Vec::new());

    /// System-destructive command patterns.
    /// ONLY these are blocked — everything else is allowed.
    static ref DESTRUCTIVE_PATTERNS: Vec<Regex> = vec![
        // Wipe entire filesystem
        Regex::new(r"^rm\s+(-[rf]+\s+)*/\s*$").unwrap(),
        Regex::new(r"^rm\s+(-[rf]+\s+)*/\*\s*$").unwrap(),
        Regex::new(r"^rm\s+(-[rf]+\s+)*--no-preserve-root\s+/").unwrap(),

        // Format/wipe system disk (macOS)
        Regex::new(r"(?i)diskutil\s+(eraseDisk|partitionDisk|secureErase).*disk0").unwrap(),
        Regex::new(r"(?i)diskutil\s+apfs\s+deleteContainer.*disk0").unwrap(),

        // Format/wipe system disk (Linux)
        Regex::new(r"(?i)mkfs(\.\w+)?\s+.*/dev/(sda|nvme0n1|vda)\b").unwrap(),
        Regex::new(r"(?i)wipefs\s+.*/dev/(sda|nvme0n1|vda)\b").unwrap(),

        // dd writing to system disk
        Regex::new(r"(?i)dd\s+.*of=/dev/(disk0|sda|nvme0n1|vda)\b").unwrap(),

        // Format system drive (Windows)
        Regex::new(r"(?i)format\s+[cC]:\s*").unwrap(),
        Regex::new(r"(?i)diskpart.*clean").unwrap(),

        // Destroy boot/system files
        Regex::new(r"(?i)rm\s+(-[rf]+\s+)*/(boot|System|Windows|usr|bin|sbin|lib|etc)\b").unwrap(),
        Regex::new(r"^rm\s+(-[rf]+\s+)*/var\s*$").unwrap(),

        // Fork bomb patterns
        Regex::new(r":\(\)\s*\{\s*:\|:\s*&\s*\}\s*;?\s*:").unwrap(),
        Regex::new(r"\$0\s*\|\s*\$0\s*&").unwrap(),

        // Kernel/system destruction
        Regex::new(r"(?i)echo\s+.*>\s*/dev/(sda|nvme0n1|mem|kmem)").unwrap(),
        Regex::new(r"(?i)cat\s+.*>\s*/dev/(sda|nvme0n1|mem|kmem)").unwrap(),
    ];

    /// Allowed network domains
    static ref ALLOWED_DOMAINS: Mutex<HashSet<String>> = Mutex::new({
        let mut s = HashSet::new();
        for d in &[
            "api.openai.com", "api.anthropic.com", "openrouter.ai",
            "api.elevenlabs.io", "api.github.com", "duckduckgo.com",
            "html.duckduckgo.com", "google.com", "www.google.com",
        ] {
            s.insert(d.to_string());
        }
        s
    });

    /// Shell names for bypass detection
    static ref SHELLS: HashSet<&'static str> = {
        let mut s = HashSet::new();
        for sh in &["bash", "sh", "zsh", "dash", "fish", "powershell", "powershell.exe", "cmd", "cmd.exe"] {
            s.insert(*sh);
        }
        s
    };
}

/// Check if a path is inside the protected codebase
#[napi]
pub fn is_protected_path(file_path: String) -> bool {
    let protected = PROTECTED_PATHS.lock();
    let resolved = normalize_path(&file_path);

    for p in protected.iter() {
        let rp = normalize_path(p);
        if resolved == rp || resolved.starts_with(&format!("{}{}", rp, std::path::MAIN_SEPARATOR)) {
            return true;
        }
    }
    false
}

/// Scan shell args for paths that target protected codebase
#[napi]
pub fn shell_args_target_protected_path(args: Vec<String>) -> Option<String> {
    for arg in &args {
        if arg.starts_with('-') {
            continue;
        }
        let resolved = normalize_path(arg);
        if is_protected_path(resolved.clone()) {
            return Some(resolved);
        }
    }
    None
}

/// Check if a command is system-destructive (should be blocked entirely)
#[napi]
pub fn is_system_destructive(full_command: String) -> bool {
    let normalized = full_command.trim();
    DESTRUCTIVE_PATTERNS.iter().any(|p| p.is_match(normalized))
}

/// Get command permission: "allow" or "block"
#[napi]
pub fn get_command_permission(full_command: String) -> String {
    if is_system_destructive(full_command) {
        "block".to_string()
    } else {
        "allow".to_string()
    }
}

/// Check for shell bypass with destructive inline commands
#[napi]
pub fn is_shell_bypass(command: String, args: Vec<String>) -> bool {
    // Get base command name (strip path)
    let base_cmd = std::path::Path::new(&command)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("")
        .split(' ')
        .next()
        .unwrap_or("");

    if !SHELLS.contains(base_cmd) {
        return false;
    }

    // Check for -c flag (inline command)
    let c_index = args.iter().position(|a| a == "-c");
    if c_index.is_none() {
        return false;
    }

    let c_idx = c_index.unwrap();
    let inline_cmd = args[c_idx + 1..].join(" ");
    is_system_destructive(inline_cmd)
}

/// Check if a domain is in the allowed list
#[napi]
pub fn is_domain_allowed(domain: String) -> bool {
    let allowed = ALLOWED_DOMAINS.lock();
    allowed.contains(&domain) || allowed.contains(&format!("www.{}", domain))
}

/// Add a domain to the allowed list
#[napi]
pub fn add_allowed_domain(domain: String) {
    let mut allowed = ALLOWED_DOMAINS.lock();
    allowed.insert(domain);
}

/// Add a protected path
#[napi]
pub fn add_protected_path(dir_path: String) {
    let mut protected = PROTECTED_PATHS.lock();
    protected.push(dir_path);
}

// ══════════════════════════════════════════════════
// CRYPTO — AES-256-GCM encryption/decryption
// ══════════════════════════════════════════════════

// ── Ciphertext version dispatch ─────────────────
// v1: scrypt(log_n=14, r=8, p=1, len=32) → AES-256-GCM, format "iv:tag:ct"
// v2: scrypt(log_n=16, r=8, p=1, len=32) → AES-256-GCM, format "v2:iv:tag:ct"
//
// New encryptions always use the latest version; decrypt auto-detects
// the version from the prefix so existing v1 ciphertexts (stored
// secrets from before the rollout) keep decrypting correctly.
const CRYPT_VERSION_LEGACY: u8 = 1;
const CRYPT_VERSION_LATEST: u8 = 2;

fn scrypt_params_for_version(version: u8) -> Result<(u8, u32, u32), String> {
    match version {
        // OWASP 2016 minimum; kept only to decrypt pre-rollout data.
        CRYPT_VERSION_LEGACY => Ok((14, 8, 1)),
        // OWASP 2023+ recommendation (N=2^16 = 65 536).
        CRYPT_VERSION_LATEST => Ok((16, 8, 1)),
        _ => Err(format!("Unsupported crypto version: {}", version)),
    }
}

/// Parse the version prefix off a ciphertext payload. Legacy ciphertexts
/// have no prefix and are returned as (1, whole_string). New ones start
/// with "v<n>:" — the hex alphabet is [0-9a-f] so a leading 'v' is an
/// unambiguous version marker.
fn parse_version_prefix(encrypted: &str) -> (u8, &str) {
    if let Some(rest) = encrypted.strip_prefix('v') {
        if let Some(colon_pos) = rest.find(':') {
            let ver_str = &rest[..colon_pos];
            if let Ok(ver) = ver_str.parse::<u8>() {
                return (ver, &rest[colon_pos + 1..]);
            }
        }
    }
    (CRYPT_VERSION_LEGACY, encrypted)
}

/// AES-256-GCM encrypt. Returns "v<version>:iv_hex:tag_hex:ciphertext_hex".
#[napi]
pub fn aes_encrypt(plaintext: String, master_key: String) -> napi::Result<String> {
    use napi::Error;

    let version = CRYPT_VERSION_LATEST;
    let derived = derive_key(&master_key, version)
        .map_err(|e| Error::from_reason(format!("Key derivation failed: {}", e)))?;

    // Generate random IV (GCM uses 12 bytes; we generate 16 and slice
    // to keep existing callers that may persist the string unchanged).
    let mut iv = [0u8; 16];
    getrandom::getrandom(&mut iv)
        .map_err(|e| Error::from_reason(format!("Random generation failed: {}", e)))?;

    use aes_gcm::aead::generic_array::GenericArray;
    use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit};

    let key = GenericArray::from_slice(&derived);
    let cipher = Aes256Gcm::new(key);
    let nonce = GenericArray::from_slice(&iv[..12]);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| Error::from_reason(format!("Encryption failed: {}", e)))?;

    // ciphertext includes the tag appended (last 16 bytes)
    let tag_start = ciphertext.len() - 16;
    let ct = &ciphertext[..tag_start];
    let tag = &ciphertext[tag_start..];

    Ok(format!(
        "v{}:{}:{}:{}",
        version,
        hex::encode(&iv[..12]),
        hex::encode(tag),
        hex::encode(ct)
    ))
}

/// AES-256-GCM decrypt. Accepts both
///   "v2:iv_hex:tag_hex:ciphertext_hex"  (new)
///   "iv_hex:tag_hex:ciphertext_hex"     (legacy v1, no prefix)
/// The version determines which scrypt params are used for key derivation.
#[napi]
pub fn aes_decrypt(encrypted: String, master_key: String) -> napi::Result<String> {
    use napi::Error;

    let (version, payload) = parse_version_prefix(&encrypted);

    let parts: Vec<&str> = payload.split(':').collect();
    if parts.len() != 3 {
        return Err(Error::from_reason(
            "Invalid encrypted format: expected [vN:]iv:tag:ciphertext",
        ));
    }

    let iv_bytes =
        hex::decode(parts[0]).map_err(|e| Error::from_reason(format!("Invalid IV hex: {}", e)))?;
    let tag_bytes =
        hex::decode(parts[1]).map_err(|e| Error::from_reason(format!("Invalid tag hex: {}", e)))?;
    let ct_bytes = hex::decode(parts[2])
        .map_err(|e| Error::from_reason(format!("Invalid ciphertext hex: {}", e)))?;

    let derived = derive_key(&master_key, version)
        .map_err(|e| Error::from_reason(format!("Key derivation failed: {}", e)))?;

    use aes_gcm::aead::generic_array::GenericArray;
    use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit};

    let key = GenericArray::from_slice(&derived);
    let cipher = Aes256Gcm::new(key);
    let nonce = GenericArray::from_slice(&iv_bytes);

    // Combine ciphertext + tag for decryption
    let mut combined = ct_bytes;
    combined.extend_from_slice(&tag_bytes);

    let plaintext = cipher
        .decrypt(nonce, combined.as_slice())
        .map_err(|_| Error::from_reason("Decryption failed: invalid key or corrupted data"))?;

    String::from_utf8(plaintext)
        .map_err(|e| Error::from_reason(format!("Decrypted data is not valid UTF-8: {}", e)))
}

// ══════════════════════════════════════════════════
// BINARY INTEGRITY — Self-validation
// ══════════════════════════════════════════════════

/// Anti-tampering: check if a debugger is attached.
/// Returns true if debugging is detected.
#[napi]
pub fn is_debugger_attached() -> bool {
    #[cfg(target_os = "macos")]
    {
        // macOS: try ptrace PT_DENY_ATTACH — if it fails with EBUSY,
        // a debugger is already attached.
        // PT_DENY_ATTACH = 31
        unsafe {
            let ret = libc::ptrace(
                31, /* PT_DENY_ATTACH */
                0,
                std::ptr::null_mut::<libc::c_char>(),
                0,
            );
            if ret == -1 {
                // EBUSY (16) means debugger is already attached
                return *libc::__error() == libc::EBUSY;
            }
        }
        false
    }

    #[cfg(target_os = "linux")]
    {
        // Linux: check /proc/self/status for TracerPid
        if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
            for line in status.lines() {
                if line.starts_with("TracerPid:") {
                    let pid: i32 = line
                        .split_whitespace()
                        .nth(1)
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(0);
                    return pid != 0;
                }
            }
        }
        false
    }

    #[cfg(target_os = "windows")]
    {
        // Windows: IsDebuggerPresent
        extern "system" {
            fn IsDebuggerPresent() -> i32;
        }
        unsafe { IsDebuggerPresent() != 0 }
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        false
    }
}

// ── Internal Helpers ─────────────────────────────

fn normalize_path(p: &str) -> String {
    // Simple normalization: resolve . and .. and ensure consistent separators
    let path = std::path::PathBuf::from(p);
    match path.canonicalize() {
        Ok(canonical) => canonical.to_string_lossy().into_owned(),
        Err(_) => {
            // If path doesn't exist yet, just clean it
            let cleaned = path.to_string_lossy().into_owned();
            // Normalize separators on Windows
            #[cfg(target_os = "windows")]
            let cleaned = cleaned.replace('/', "\\");
            cleaned
        }
    }
}

fn derive_key(master_key: &str, version: u8) -> Result<Vec<u8>, String> {
    use scrypt::{scrypt, Params};

    let (log_n, r, p) = scrypt_params_for_version(version)?;
    let salt = b"atlas-salt";
    let params = Params::new(log_n, r, p, 32).map_err(|e| format!("scrypt params: {}", e))?;
    let mut output = vec![0u8; 32];
    scrypt(master_key.as_bytes(), salt, &params, &mut output)
        .map_err(|e| format!("scrypt: {}", e))?;
    Ok(output)
}

// ══════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_prefix_recognizes_v2() {
        let (v, rest) = parse_version_prefix("v2:aa:bb:cc");
        assert_eq!(v, 2);
        assert_eq!(rest, "aa:bb:cc");
    }

    #[test]
    fn parse_version_prefix_recognizes_future_version_numbers() {
        let (v, rest) = parse_version_prefix("v99:x:y:z");
        assert_eq!(v, 99);
        assert_eq!(rest, "x:y:z");
    }

    #[test]
    fn parse_version_prefix_falls_back_to_legacy_on_hex_prefix() {
        // Hex alphabet has no 'v' so a leading hex digit can't be confused.
        let (v, rest) = parse_version_prefix("abc123:def456:0123");
        assert_eq!(v, CRYPT_VERSION_LEGACY);
        assert_eq!(rest, "abc123:def456:0123");
    }

    #[test]
    fn parse_version_prefix_falls_back_on_malformed_version() {
        // "v" without digits or without colon — treat as legacy payload.
        let (v, rest) = parse_version_prefix("vfoo:bar:baz");
        assert_eq!(v, CRYPT_VERSION_LEGACY);
        assert_eq!(rest, "vfoo:bar:baz");
    }

    #[test]
    fn scrypt_params_are_defined_for_both_versions() {
        let (n1, r1, p1) = scrypt_params_for_version(CRYPT_VERSION_LEGACY).unwrap();
        let (n2, r2, p2) = scrypt_params_for_version(CRYPT_VERSION_LATEST).unwrap();
        // v2 must use strictly more memory than v1 (that's the whole point).
        assert!(
            n2 > n1,
            "v2 scrypt log_n={} must exceed v1 log_n={}",
            n2,
            n1
        );
        // Other params stay constant across versions.
        assert_eq!(r1, r2);
        assert_eq!(p1, p2);
    }

    #[test]
    fn scrypt_params_reject_unsupported_version() {
        assert!(scrypt_params_for_version(0).is_err());
        assert!(scrypt_params_for_version(99).is_err());
    }

    #[test]
    fn derive_key_produces_32_bytes_for_both_versions() {
        let k1 = derive_key("master", CRYPT_VERSION_LEGACY).unwrap();
        let k2 = derive_key("master", CRYPT_VERSION_LATEST).unwrap();
        assert_eq!(k1.len(), 32);
        assert_eq!(k2.len(), 32);
    }

    #[test]
    fn derive_key_v1_and_v2_differ_for_same_master_key() {
        let k1 = derive_key("master", CRYPT_VERSION_LEGACY).unwrap();
        let k2 = derive_key("master", CRYPT_VERSION_LATEST).unwrap();
        assert_ne!(
            k1, k2,
            "v1 and v2 must produce different keys — params differ"
        );
    }

    #[test]
    fn encrypt_output_starts_with_current_version_prefix() {
        let ct = aes_encrypt("hello".to_string(), "password123".to_string()).unwrap();
        assert!(
            ct.starts_with(&format!("v{}:", CRYPT_VERSION_LATEST)),
            "got: {}",
            ct
        );
    }

    #[test]
    fn roundtrip_v2() {
        let plaintext = "hello, world — 🧠 secret data";
        let ct = aes_encrypt(plaintext.to_string(), "password123".to_string()).unwrap();
        let pt = aes_decrypt(ct, "password123".to_string()).unwrap();
        assert_eq!(pt, plaintext);
    }

    #[test]
    fn roundtrip_v2_with_same_key_different_plaintexts() {
        let master = "the-master-key".to_string();
        let a = aes_encrypt("alpha".to_string(), master.clone()).unwrap();
        let b = aes_encrypt("beta".to_string(), master.clone()).unwrap();
        // Same key + different plaintext + fresh IV → different ciphertexts.
        assert_ne!(a, b);
        assert_eq!(aes_decrypt(a, master.clone()).unwrap(), "alpha");
        assert_eq!(aes_decrypt(b, master).unwrap(), "beta");
    }

    #[test]
    fn encrypt_produces_different_ciphertext_each_call_due_to_random_iv() {
        let a = aes_encrypt("same".to_string(), "key".to_string()).unwrap();
        let b = aes_encrypt("same".to_string(), "key".to_string()).unwrap();
        assert_ne!(a, b, "random IV must make ciphertexts differ");
    }

    #[test]
    fn decrypt_with_wrong_key_fails() {
        let ct = aes_encrypt("secret".to_string(), "correct".to_string()).unwrap();
        assert!(aes_decrypt(ct, "wrong".to_string()).is_err());
    }

    #[test]
    fn decrypt_accepts_legacy_v1_format_without_prefix() {
        // Hand-construct a v1 ciphertext by encrypting with the v1
        // derive_key and formatting WITHOUT the version prefix, then
        // verify aes_decrypt still reads it (parse_version_prefix
        // falls back to legacy for hex-first input).
        use aes_gcm::aead::generic_array::GenericArray;
        use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit};

        let master = "legacy-key";
        let derived = derive_key(master, CRYPT_VERSION_LEGACY).unwrap();
        let mut iv = [0u8; 16];
        getrandom::getrandom(&mut iv).unwrap();
        let cipher = Aes256Gcm::new(GenericArray::from_slice(&derived));
        let nonce = GenericArray::from_slice(&iv[..12]);
        let plaintext = "hello-v1";
        let ct_with_tag = cipher.encrypt(nonce, plaintext.as_bytes()).unwrap();
        let tag_start = ct_with_tag.len() - 16;
        let ct = &ct_with_tag[..tag_start];
        let tag = &ct_with_tag[tag_start..];

        // No "v1:" prefix — raw legacy format
        let legacy_ct = format!(
            "{}:{}:{}",
            hex::encode(&iv[..12]),
            hex::encode(tag),
            hex::encode(ct)
        );

        let pt = aes_decrypt(legacy_ct, master.to_string()).unwrap();
        assert_eq!(pt, plaintext);
    }

    #[test]
    fn decrypt_rejects_malformed_input() {
        // Not enough parts
        assert!(aes_decrypt("aa:bb".to_string(), "key".to_string()).is_err());
        // Invalid hex
        assert!(aes_decrypt("v2:zz:yy:xx".to_string(), "key".to_string()).is_err());
    }

    #[test]
    fn decrypt_rejects_unsupported_version() {
        // parse_version_prefix returns (99, payload); derive_key rejects.
        let res = aes_decrypt("v99:aa:bb:cc".to_string(), "key".to_string());
        assert!(res.is_err());
    }

    #[test]
    fn constants_sanity() {
        assert_eq!(CRYPT_VERSION_LEGACY, 1);
        assert_eq!(CRYPT_VERSION_LATEST, 2);
        assert!(CRYPT_VERSION_LATEST > CRYPT_VERSION_LEGACY);
    }
}
