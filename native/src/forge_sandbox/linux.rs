// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
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
    fn spawn(&self, slug: &str, handler_dir: &Path, caps: &Capabilities) -> io::Result<Child> {
        // ── Pre-flight: build all filters in PARENT before fork ──

        let bpf = build_filter(caps).map_err(|e| io::Error::other(format!("seccomp: {e:?}")))?;

        let landlock_optional =
            std::env::var("ATLAS_FORGE_LANDLOCK_OPTIONAL").as_deref() == Ok("true");
        let mut landlock_ruleset = if landlock_available() {
            Some(
                build_ruleset(caps, self.strict)
                    .map_err(|e| io::Error::other(format!("landlock: {e}")))?,
            )
        } else if !landlock_optional {
            // SECURE DEFAULT: refuse to spawn without Landlock unless the
            // operator has explicitly opted out via ATLAS_FORGE_LANDLOCK_OPTIONAL=true.
            // seccomp-only mode has no path-level filesystem isolation —
            // a synthesized handler can read /etc/passwd, ~/.ssh/, etc.
            return Err(io::Error::other(
                "Landlock unavailable on this kernel (<5.13). Refusing to spawn without fs isolation. \
                 Upgrade kernel or set ATLAS_FORGE_LANDLOCK_OPTIONAL=true to allow seccomp-only mode (UNSAFE).",
            ));
        } else {
            tracing_warn(
                slug,
                "Landlock unavailable AND ATLAS_FORGE_LANDLOCK_OPTIONAL=true — seccomp-only enforcement, NO filesystem isolation",
            );
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
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // CRITICAL: env_clear() FIRST — synthesized handlers must not
            // inherit Bhai's OPENAI_API_KEY / TELEGRAM_BOT_TOKEN / etc.
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", handler_dir)
            .env("ATLAS_FORGE_SLUG", slug)
            .env("ATLAS_FORGE_HANDLER_PATH", handler_dir.join("handler.js"))
            // Reap on Drop — prevents zombies on boot-fail paths.
            .kill_on_drop(true);

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

            // 3. Landlock restrict_self (if we built a ruleset). It consumes
            // the ruleset; pre_exec runs once per spawned child, so take() it.
            if let Some(rs) = landlock_ruleset.take() {
                rs.restrict_self()
                    .map_err(|e| io::Error::other(format!("landlock: {e:?}")))?;
            }

            // 4. seccomp filter load.
            seccompiler::apply_filter(&bpf)
                .map_err(|e| io::Error::other(format!("seccomp: {e:?}")))?;

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
    use super::*;
    use nix::sched::CloneFlags;
    use std::fs;
    use tokio::io::{AsyncBufReadExt, BufReader};

    #[test]
    fn clone_newnet_flag_value_is_correct() {
        assert_eq!(CloneFlags::CLONE_NEWNET.bits(), 0x40000000);
    }

    /// Integration: spawn Node under the Linux sandbox and confirm a denied
    /// fs read returns EACCES/EPERM rather than succeeding. Requires `node`
    /// and unprivileged userns or CAP_NET_ADMIN. Skipped on hosts without.
    #[tokio::test]
    #[ignore]
    async fn linux_sandbox_blocks_disallowed_fs_read() {
        if which::which("node").is_err() {
            eprintln!("[skip] node not on PATH");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let handler_path = tmp.path().join("handler.js");
        // The handler attempts /etc/passwd read; expected EACCES from Landlock.
        fs::write(
            tmp.path().join(".handler-shim.js"),
            r#"
const fs = require("node:fs");
try {
    const data = fs.readFileSync("/etc/passwd", "utf8");
    process.stdout.write(JSON.stringify({id:"__boot__",ok:false,error:{kind:"bypass",len:data.length}}) + "\n");
} catch (err) {
    process.stdout.write(JSON.stringify({id:"__boot__",ok:false,error:{kind:"cap_denied",code:err.code}}) + "\n");
}
process.exit(0);
"#,
        ).expect("write shim");
        fs::write(&handler_path, "module.exports = async () => ({});").expect("write handler");

        let sandbox = LinuxSandbox::new(which::which("node").unwrap());
        let caps = Capabilities {
            fs_read: vec![tmp.path().to_string_lossy().into_owned()],
            ..Capabilities::default()
        };
        let res = sandbox.spawn("denytest", tmp.path(), &caps);
        if let Err(e) = &res {
            if format!("{e:?}").contains("EPERM") {
                eprintln!("[skip] unprivileged userns disabled on this host");
                return;
            }
        }
        let mut child = res.expect("spawn");
        let stdout = child.stdout.take().expect("stdout");
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let _ = reader.read_line(&mut line).await;
        assert!(
            line.contains("cap_denied") || line.contains("EACCES") || line.contains("EPERM"),
            "expected cap_denied/EACCES/EPERM, got: {line}"
        );
        let _ = child.kill().await;
    }
}
