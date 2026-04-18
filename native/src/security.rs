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
    /// The bot must never write/delete its own source files.
    static ref PROTECTED_PATHS: Mutex<Vec<String>> = Mutex::new(vec![
        "/Users/user/Desktop/jarvis".to_string(),
    ]);

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

/// AES-256-GCM encrypt. Returns "iv_hex:tag_hex:ciphertext_hex"
#[napi]
pub fn aes_encrypt(plaintext: String, master_key: String) -> napi::Result<String> {
    use napi::Error;

    // Derive key using scrypt
    let derived = derive_key(&master_key)
        .map_err(|e| Error::from_reason(format!("Key derivation failed: {}", e)))?;

    // Generate random IV
    let mut iv = [0u8; 16];
    getrandom::getrandom(&mut iv)
        .map_err(|e| Error::from_reason(format!("Random generation failed: {}", e)))?;

    // AES-256-GCM encrypt
    use aes_gcm::{Aes256Gcm, KeyInit, aead::Aead};
    use aes_gcm::aead::generic_array::GenericArray;

    let key = GenericArray::from_slice(&derived);
    let cipher = Aes256Gcm::new(key);
    let nonce = GenericArray::from_slice(&iv[..12]); // GCM uses 12-byte nonce

    let ciphertext = cipher.encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| Error::from_reason(format!("Encryption failed: {}", e)))?;

    // ciphertext includes the tag appended (last 16 bytes)
    let tag_start = ciphertext.len() - 16;
    let ct = &ciphertext[..tag_start];
    let tag = &ciphertext[tag_start..];

    Ok(format!("{}:{}:{}", hex::encode(&iv[..12]), hex::encode(tag), hex::encode(ct)))
}

/// AES-256-GCM decrypt. Input format: "iv_hex:tag_hex:ciphertext_hex"
#[napi]
pub fn aes_decrypt(encrypted: String, master_key: String) -> napi::Result<String> {
    use napi::Error;

    let parts: Vec<&str> = encrypted.split(':').collect();
    if parts.len() != 3 {
        return Err(Error::from_reason("Invalid encrypted format: expected iv:tag:ciphertext"));
    }

    let iv_bytes = hex::decode(parts[0])
        .map_err(|e| Error::from_reason(format!("Invalid IV hex: {}", e)))?;
    let tag_bytes = hex::decode(parts[1])
        .map_err(|e| Error::from_reason(format!("Invalid tag hex: {}", e)))?;
    let ct_bytes = hex::decode(parts[2])
        .map_err(|e| Error::from_reason(format!("Invalid ciphertext hex: {}", e)))?;

    let derived = derive_key(&master_key)
        .map_err(|e| Error::from_reason(format!("Key derivation failed: {}", e)))?;

    use aes_gcm::{Aes256Gcm, KeyInit, aead::Aead};
    use aes_gcm::aead::generic_array::GenericArray;

    let key = GenericArray::from_slice(&derived);
    let cipher = Aes256Gcm::new(key);
    let nonce = GenericArray::from_slice(&iv_bytes);

    // Combine ciphertext + tag for decryption
    let mut combined = ct_bytes;
    combined.extend_from_slice(&tag_bytes);

    let plaintext = cipher.decrypt(nonce, combined.as_slice())
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
            let ret = libc::ptrace(31 /* PT_DENY_ATTACH */, 0, std::ptr::null_mut::<libc::c_char>(), 0);
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
                    let pid: i32 = line.split_whitespace().nth(1)
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

fn derive_key(master_key: &str) -> Result<Vec<u8>, String> {
    use scrypt::{scrypt, Params};

    let salt = b"atlas-salt";
    let params = Params::new(14, 8, 1, 32).map_err(|e| format!("scrypt params: {}", e))?;
    let mut output = vec![0u8; 32];
    scrypt(master_key.as_bytes(), salt, &params, &mut output)
        .map_err(|e| format!("scrypt: {}", e))?;
    Ok(output)
}
