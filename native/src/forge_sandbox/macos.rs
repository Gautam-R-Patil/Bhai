// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// macOS sandbox-exec backend.
//
// `sandbox-exec` is the userland binary that takes an SBPL (Sandbox Profile
// Language) file and execs a child under that kernel sandbox. Apple deprecated
// it for app distribution but the binary is present on every macOS ≥ 10.5
// and works fine for our use case (one-shot scoped child processes).

#![cfg(target_os = "macos")]

use crate::forge_sandbox::{Capabilities, Sandbox};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::{Child, Command};

pub struct MacosSandbox;

impl Sandbox for MacosSandbox {
    fn spawn(
        &self,
        slug: &str,
        handler_dir: &Path,
        caps: &Capabilities,
    ) -> io::Result<Child> {
        let node = locate_node()?;
        let sbpl_path = handler_dir.join(".sandbox.sb");
        let shim_path = handler_dir.join(".handler-shim.js");
        let handler_path = handler_dir.join("handler.js");

        let profile = build_sbpl_profile(&node, caps);
        write_atomic(&sbpl_path, profile.as_bytes())?;

        let shim_src = crate::forge_sandbox::common::handler_shim_source();
        write_atomic(&shim_path, shim_src.as_bytes())?;

        Command::new("/usr/bin/sandbox-exec")
            .arg("-f").arg(&sbpl_path)
            .arg(&node)
            .arg(&shim_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("HOME", handler_dir)
            .env("ATLAS_FORGE_HANDLER_PATH", &handler_path)
            .env("ATLAS_FORGE_SLUG", slug)
            .spawn()
    }
}

fn locate_node() -> io::Result<PathBuf> {
    if let Ok(p) = which::which("node") {
        return Ok(p);
    }
    for guess in &[
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
        "/usr/bin/node",
    ] {
        if Path::new(guess).exists() {
            return Ok(PathBuf::from(guess));
        }
    }
    Err(io::Error::new(io::ErrorKind::NotFound, "node binary not found in PATH or known macOS locations"))
}

pub fn build_sbpl_profile(node_path: &Path, caps: &Capabilities) -> String {
    let mut buf = String::with_capacity(1024);
    buf.push_str("(version 1)\n");
    buf.push_str("(deny default)\n");

    buf.push_str("(allow process-fork)\n");
    buf.push_str(&format!("(allow process-exec (literal \"{}\"))\n", escape_sbpl_string(&node_path.to_string_lossy())));
    buf.push_str("(allow process-info* (target self))\n");
    buf.push_str("(allow signal (target self))\n");

    buf.push_str("(allow file-read* (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/random\") (literal \"/dev/urandom\"))\n");
    buf.push_str("(allow file-read* (subpath \"/usr/lib\") (subpath \"/System/Library\") (subpath \"/Library/Frameworks\"))\n");
    if let Some(parent) = node_path.parent() {
        buf.push_str(&format!("(allow file-read* (subpath \"{}\"))\n", escape_sbpl_string(&parent.to_string_lossy())));
        if let Some(prefix) = parent.parent() {
            buf.push_str(&format!("(allow file-read* (subpath \"{}\"))\n", escape_sbpl_string(&prefix.to_string_lossy())));
        }
    }
    buf.push_str("(allow file-read* (subpath \"/private/tmp\") (subpath \"/private/var/folders\"))\n");
    buf.push_str("(allow file-write* (subpath \"/private/tmp\") (subpath \"/private/var/folders\"))\n");

    buf.push_str("(allow mach-lookup (global-name \"com.apple.system.notification_center\"))\n");
    buf.push_str("(allow mach-lookup (global-name \"com.apple.distributed_notifications.2\"))\n");

    for path in &caps.fs_read {
        buf.push_str(&format!("(allow file-read* (subpath \"{}\"))\n", escape_sbpl_string(path)));
    }
    for path in &caps.fs_write {
        buf.push_str(&format!("(allow file-read* (subpath \"{}\"))\n", escape_sbpl_string(path)));
        buf.push_str(&format!("(allow file-write* (subpath \"{}\"))\n", escape_sbpl_string(path)));
    }
    for host in &caps.net {
        let _ = host;
        buf.push_str("(allow network-outbound (remote ip \"*:443\"))\n");
        buf.push_str("(allow network-outbound (remote ip \"*:80\"))\n");
        buf.push_str("(allow network-outbound (remote ip \"*:53\"))\n");
    }
    for exec in &caps.exec {
        buf.push_str(&format!("(allow process-exec (literal \"{}\"))\n", escape_sbpl_string(exec)));
    }

    buf
}

fn escape_sbpl_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            _ => out.push(c),
        }
    }
    out
}

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.flush()?;
    }
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn profile_starts_with_deny_default() {
        let p = build_sbpl_profile(Path::new("/usr/local/bin/node"), &Capabilities::default());
        let first_two_lines: Vec<&str> = p.lines().take(2).collect();
        assert_eq!(first_two_lines[0], "(version 1)");
        assert_eq!(first_two_lines[1], "(deny default)");
    }

    #[test]
    fn profile_allows_node_exec() {
        let node = PathBuf::from("/opt/homebrew/bin/node");
        let p = build_sbpl_profile(&node, &Capabilities::default());
        assert!(p.contains("(allow process-exec (literal \"/opt/homebrew/bin/node\"))"),
                "profile must allow node exec; got:\n{p}");
    }

    #[test]
    fn profile_includes_fs_read_subpaths() {
        let caps = Capabilities {
            fs_read: vec!["/Users/x/Downloads/".into(), "/tmp/cache/".into()],
            ..Default::default()
        };
        let p = build_sbpl_profile(Path::new("/usr/local/bin/node"), &caps);
        assert!(p.contains("(allow file-read* (subpath \"/Users/x/Downloads/\"))"));
        assert!(p.contains("(allow file-read* (subpath \"/tmp/cache/\"))"));
    }

    #[test]
    fn profile_fs_write_implies_fs_read() {
        let caps = Capabilities {
            fs_write: vec!["/tmp/out/".into()],
            ..Default::default()
        };
        let p = build_sbpl_profile(Path::new("/usr/local/bin/node"), &caps);
        assert!(p.contains("(allow file-read* (subpath \"/tmp/out/\"))"));
        assert!(p.contains("(allow file-write* (subpath \"/tmp/out/\"))"));
    }

    #[test]
    fn profile_net_allows_port_443() {
        let caps = Capabilities {
            net: vec!["api.openai.com".into()],
            ..Default::default()
        };
        let p = build_sbpl_profile(Path::new("/usr/local/bin/node"), &caps);
        assert!(p.contains("(allow network-outbound (remote ip \"*:443\"))"));
        assert!(p.contains("(allow network-outbound (remote ip \"*:53\"))"), "DNS allowed for resolver");
    }

    #[test]
    fn profile_with_no_net_blocks_outbound() {
        let p = build_sbpl_profile(Path::new("/usr/local/bin/node"), &Capabilities::default());
        assert!(!p.contains("network-outbound"), "no caps.net → no outbound allows");
    }

    #[test]
    fn profile_allows_exec_capability_paths() {
        let caps = Capabilities {
            exec: vec!["/usr/bin/ffmpeg".into()],
            ..Default::default()
        };
        let p = build_sbpl_profile(Path::new("/usr/local/bin/node"), &caps);
        assert!(p.contains("(allow process-exec (literal \"/usr/bin/ffmpeg\"))"));
    }

    #[test]
    fn escape_sbpl_handles_quotes_and_backslashes() {
        assert_eq!(escape_sbpl_string("/path"), "/path");
        assert_eq!(escape_sbpl_string("/has \"quote\""), "/has \\\"quote\\\"");
        assert_eq!(escape_sbpl_string("/back\\slash"), "/back\\\\slash");
    }
}
