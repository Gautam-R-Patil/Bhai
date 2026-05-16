// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Forge Phase 4 sandbox supervisor — module root.
//
// Owns the cross-platform `Sandbox` trait and the per-OS factory. Each backend
// (macos.rs, linux.rs in Plan 3, windows.rs in Plan 3) implements `Sandbox::spawn`
// which is the ONE place where Rust crosses the kernel-sandbox boundary.

use std::io;
use std::path::Path;
use tokio::process::Child;

pub mod api;
pub mod common;
pub mod pool;
pub mod strikes;
pub mod worker;

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "linux")]
pub mod linux_seccomp;

/// Validated set of resources a persisted tool may touch. Mirrors the TS
/// `Capabilities` shape in `src/forge/capabilities.ts` exactly — Plan 4 wires
/// the parser, but the Rust side does its own parse to avoid trusting whatever
/// the TS shim claims it sent. JSON wire format:
/// ```json
/// { "fs_read": ["~/Downloads/"], "fs_write": [], "net": ["api.openai.com"], "exec": [] }
/// ```
#[derive(Debug, Clone, Default)]
pub struct Capabilities {
    pub fs_read: Vec<String>,
    pub fs_write: Vec<String>,
    pub net: Vec<String>,
    pub exec: Vec<String>,
}

/// Single OS-boundary crossing. Implementations spawn a Node child with the
/// `handler-shim.js` script and stdin/stdout piped, under whatever kernel
/// sandbox the OS supports. The returned `Child` MUST have its stdin and
/// stdout configured to `Stdio::piped()` so the Worker can take them.
pub trait Sandbox: Send + Sync {
    fn spawn(
        &self,
        slug: &str,
        handler_dir: &Path,
        caps: &Capabilities,
    ) -> io::Result<Child>;
}

/// Compile-time factory. Returns the per-OS impl, or a stub that errors with
/// `platform_unsupported` on Linux/Windows until Plan 3 ships.
#[cfg(target_os = "macos")]
pub fn make_sandbox() -> Box<dyn Sandbox> {
    Box::new(macos::MacosSandbox)
}

#[cfg(not(target_os = "macos"))]
pub fn make_sandbox() -> Box<dyn Sandbox> {
    Box::new(UnsupportedSandbox)
}

#[cfg(not(target_os = "macos"))]
pub struct UnsupportedSandbox;

#[cfg(not(target_os = "macos"))]
impl Sandbox for UnsupportedSandbox {
    fn spawn(
        &self,
        _slug: &str,
        _handler_dir: &Path,
        _caps: &Capabilities,
    ) -> io::Result<Child> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "forge sandbox: platform_unsupported (Plan 3 adds Linux/Windows backends)",
        ))
    }
}

// Re-exports for ergonomic consumers within the crate.
pub use pool::Pool;
pub use strikes::{StrikeBoard, StrikeRecord};
pub use worker::{InvokeError, Worker};
