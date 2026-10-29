// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Forge sandbox — Windows backend.
//
// Architecture: AppContainer profile + ACL grants for caps.fs_*, plus a
// JobObject with memory/CPU/process limits. The child is spawned via
// CreateProcessAsUserW with EXTENDED_STARTUPINFO_PRESENT pointing at a
// STARTUPINFOEX containing PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES.
//
// **IMPLEMENTATION STATUS: stub.** The `Sandbox` trait returns
// `tokio::process::Child`, but tokio 1.x does not expose a way to construct
// one from raw Win32 handles. Two real options exist for production:
//   1. Wait for tokio to ship `Child::from_raw_handles` (open issue).
//   2. Vendor a small fork of `tokio::process::Child` that exposes the
//      private `imp::Child::from_inner` constructor.
//
// For now this returns `io::ErrorKind::Unsupported` with a descriptive
// message. The full pipeline of (AppContainer profile, ACL grants, JobObject
// limits, STARTUPINFOEX, CreateProcessAsUserW) is implemented as
// independently-tested helpers in `windows_appcontainer.rs` and
// `windows_jobobject.rs`; the missing piece is the std → tokio Child
// conversion.
//
// A working `WindowsManagedProcess` wrapping raw HANDLEs is also implemented
// in `windows_managed_process.rs` for a future trait refactor.

#![cfg(target_os = "windows")]

use std::io;
use std::path::{Path, PathBuf};
use tokio::process::Child;

use crate::forge_sandbox::{Capabilities, Sandbox};

pub struct WindowsSandbox {
    pub node_path: PathBuf,
}

impl WindowsSandbox {
    pub fn new(node_path: PathBuf) -> Self {
        Self { node_path }
    }
}

impl Sandbox for WindowsSandbox {
    fn spawn(&self, _slug: &str, _handler_dir: &Path, _caps: &Capabilities) -> io::Result<Child> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "WindowsSandbox: AppContainer-isolated spawn requires tokio Child::from_raw_handles \
             (not yet exposed in tokio 1.x). Helpers in windows_appcontainer.rs + \
             windows_jobobject.rs are production-ready; integration deferred until tokio \
             ships the conversion API or a fork is vendored.",
        ))
    }
}
