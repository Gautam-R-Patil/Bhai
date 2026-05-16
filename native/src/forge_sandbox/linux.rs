// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Forge sandbox — Linux backend.
//
// Layered defense, applied in pre_exec (after fork, before exec):
//   1. unshare(CLONE_NEWNET)  — no host network reachable
//   2. prctl(PR_SET_NO_NEW_PRIVS) — required for non-root seccomp + execve drop
//   3. Landlock ruleset.restrict_self() — fs-path allowlist enforcement
//   4. seccomp(2) SET_MODE_FILTER — syscall allowlist
//
// pre_exec runs in async-signal-safe context. All heap-allocated state
// (BPF program, Landlock fds, owned env strings, path strings) is built
// in the PARENT before fork and captured by move into the closure.

#![cfg(target_os = "linux")]

use std::io;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::{Child, Command};

use crate::forge_sandbox::linux_landlock::{build_ruleset, landlock_available};
use crate::forge_sandbox::linux_seccomp::build_filter;
use crate::forge_sandbox::{Capabilities, Sandbox};

pub struct LinuxSandbox {
    pub node_path: PathBuf,
    pub strict: bool,
}

impl LinuxSandbox {
    pub fn new(node_path: PathBuf) -> Self {
        let strict = std::env::var("ATLAS_FORGE_STRICT").as_deref() == Ok("true");
        Self { node_path, strict }
    }
}

impl Sandbox for LinuxSandbox {
    fn spawn(
        &self,
        slug: &str,
        handler_dir: &Path,
        caps: &Capabilities,
    ) -> io::Result<Child> {
        // ── Pre-flight: build all filters in PARENT before fork ──

        let bpf = build_filter(caps)
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("seccomp: {e:?}")))?;

        let landlock_optional =
            std::env::var("ATLAS_FORGE_LANDLOCK_OPTIONAL").as_deref() == Ok("true");
        let landlock_ruleset = if landlock_available() {
            Some(
                build_ruleset(caps, self.strict)
                    .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("landlock: {e}")))?,
            )
        } else if self.strict && !landlock_optional {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                "Landlock unavailable on this kernel and ATLAS_FORGE_STRICT=true",
            ));
        } else {
            tracing_warn(slug, "Landlock unavailable — seccomp-only enforcement");
            None
        };

        let net_passthrough = !caps.net.is_empty()
            && std::env::var("ATLAS_FORGE_LINUX_NET_PASSTHROUGH").as_deref() == Ok("true");
        if !caps.net.is_empty() && !net_passthrough {
            tracing_warn(
                slug,
                "caps.net declared but per-host filtering unimplemented on Linux v1; \
                 falling back to no-network (CLONE_NEWNET unconditional). \
                 Set ATLAS_FORGE_LINUX_NET_PASSTHROUGH=true to opt out (unsafe).",
            );
        }

        // ── Build the Command ──

        let shim_path = handler_dir.join(".handler-shim.js");
        let mut cmd = Command::new(&self.node_path);
        cmd.arg(&shim_path)
            .env("ATLAS_FORGE_SLUG", slug)
            .env("ATLAS_FORGE_HANDLER_PATH", handler_dir.join("handler.js"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // ── pre_exec: async-signal-safe closure ──

        let pre_exec_closure = move || -> io::Result<()> {
            // 1. Network namespace
            if !net_passthrough {
                nix::sched::unshare(nix::sched::CloneFlags::CLONE_NEWNET)
                    .map_err(io::Error::from)?;
            }

            // 2. PR_SET_NO_NEW_PRIVS — required before seccomp for non-root.
            let prctl_ret = unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
            if prctl_ret != 0 {
                return Err(io::Error::last_os_error());
            }

            // 3. Landlock restrict_self (if we built a ruleset).
            if let Some(ref rs) = landlock_ruleset {
                rs.as_ref()
                    .restrict_self()
                    .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("landlock: {e:?}")))?;
            }

            // 4. seccomp filter load.
            seccompiler::apply_filter(&bpf)
                .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("seccomp: {e:?}")))?;

            Ok(())
        };

        // SAFETY: closure captures only:
        //   - bpf (Vec<sock_filter>): read-only slice access, signal-safe
        //   - landlock_ruleset (Option<RulesetCreated>): owns fds, single syscall
        //   - net_passthrough (bool): Copy primitive
        // No malloc, no locks, no allocator-using code runs inside.
        unsafe {
            cmd.pre_exec(pre_exec_closure);
        }

        cmd.spawn()
    }
}

fn tracing_warn(slug: &str, msg: &str) {
    eprintln!("[forge-sandbox][linux][{slug}] {msg}");
}

#[cfg(test)]
mod tests {
    use nix::sched::CloneFlags;

    #[test]
    fn clone_newnet_flag_value_is_correct() {
        assert_eq!(CloneFlags::CLONE_NEWNET.bits(), 0x40000000);
    }
}
