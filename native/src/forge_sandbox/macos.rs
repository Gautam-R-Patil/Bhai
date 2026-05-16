// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// macOS sandbox-exec backend. Full impl in Task 12.

use std::io;
use std::path::Path;
use tokio::process::Child;
use crate::forge_sandbox::{Capabilities, Sandbox};

pub struct MacosSandbox;

impl Sandbox for MacosSandbox {
    fn spawn(
        &self,
        _slug: &str,
        _handler_dir: &Path,
        _caps: &Capabilities,
    ) -> io::Result<Child> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "MacosSandbox: not yet implemented (Task 12)",
        ))
    }
}
