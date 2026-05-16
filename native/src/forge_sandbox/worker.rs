// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Per-slug worker — owns one sandboxed Node child plus its piped stdio.
//
// Single-flight: only one in-flight call at a time. The agent's tool-call
// pattern is one-call-per-tool-invocation; pipelining adds complexity for
// negligible win. `inflight: AtomicBool` is the gate; the Pool checks it
// before evicting.

use serde_json::Value;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout};

/// Path-bag held by the Worker so eviction / restart can re-spawn with the
/// same handler dir without re-resolving from the slug. (Kept inline here
/// because there's no other consumer; we'd otherwise introduce a tiny module.)
#[derive(Debug, Clone)]
pub struct Sandpath {
    pub handler_dir: PathBuf,
}

#[derive(Debug)]
pub enum InvokeError {
    /// Another call is already in flight on this worker — caller must
    /// retry on a different worker or wait. The Pool ensures we never
    /// hit this in practice (one worker per slug, single-flight).
    Busy,
    /// `tokio::time::timeout` fired before the child responded.
    Timeout { budget_ms: u64 },
    /// Child wrote a line that wasn't valid JSON, or the JSON shape was off.
    Ipc(String),
    /// Stdin/stdout pipe died (child crashed or was killed).
    Pipe(io::Error),
    /// Catch-all for serde/IO failures we can't classify.
    Other(String),
}

impl std::fmt::Display for InvokeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InvokeError::Busy => write!(f, "worker busy"),
            InvokeError::Timeout { budget_ms } => write!(f, "timeout after {budget_ms}ms"),
            InvokeError::Ipc(m) => write!(f, "ipc: {m}"),
            InvokeError::Pipe(e) => write!(f, "pipe: {e}"),
            InvokeError::Other(m) => write!(f, "other: {m}"),
        }
    }
}

impl std::error::Error for InvokeError {}

pub struct Worker {
    pub slug: String,
    pub paths: Sandpath,
    pub pid: u32,
    pub spawned_at: Instant,
    pub last_used: Instant,
    pub inflight: AtomicBool,

    child: Child,
    stdin: ChildStdin,
    stdout_lines: Lines<BufReader<ChildStdout>>,
}

impl Worker {
    /// Wrap an already-spawned Tokio `Child` plus its piped stdio. Caller
    /// (Pool::get_or_spawn → Sandbox::spawn) is responsible for choosing the
    /// OS sandbox; this constructor only sets up framing.
    pub async fn from_child(slug: String, paths: Sandpath, mut child: Child) -> Result<Self, InvokeError> {
        let pid = child.id().ok_or_else(|| InvokeError::Other("child has no pid".into()))?;
        let stdin = child.stdin.take().ok_or_else(|| InvokeError::Other("child stdin not piped".into()))?;
        let stdout = child.stdout.take().ok_or_else(|| InvokeError::Other("child stdout not piped".into()))?;
        let mut stdout_lines = BufReader::new(stdout).lines();

        let boot = tokio::time::timeout(Duration::from_secs(5), stdout_lines.next_line()).await;
        match boot {
            Ok(Ok(Some(line))) => {
                let v: Value = serde_json::from_str(&line)
                    .map_err(|e| InvokeError::Ipc(format!("boot line not JSON: {e}")))?;
                let id = v.get("id").and_then(|i| i.as_str()).unwrap_or("");
                let ok = v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false);
                if id != "__boot__" || !ok {
                    let err = v.get("error").map(|e| e.to_string()).unwrap_or_default();
                    return Err(InvokeError::Ipc(format!("boot failed: {err}")));
                }
            }
            Ok(Ok(None)) => return Err(InvokeError::Ipc("child closed stdout before boot".into())),
            Ok(Err(e)) => return Err(InvokeError::Pipe(e)),
            Err(_) => return Err(InvokeError::Timeout { budget_ms: 5_000 }),
        }

        let now = Instant::now();
        Ok(Self {
            slug,
            paths,
            pid,
            spawned_at: now,
            last_used: now,
            inflight: AtomicBool::new(false),
            child,
            stdin,
            stdout_lines,
        })
    }

    /// Acquire single-flight lock. Returns Err::Busy if another call is in
    /// flight. Caller must call `release_inflight()` exactly once for every
    /// successful `try_acquire_inflight()` — the Worker drop handler kills
    /// the child but does NOT clear inflight on its own.
    pub fn try_acquire_inflight(&self) -> Result<(), InvokeError> {
        self.inflight
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map(|_| ())
            .map_err(|_| InvokeError::Busy)
    }

    pub fn release_inflight(&self) {
        self.inflight.store(false, Ordering::Release);
    }

    pub fn is_inflight(&self) -> bool {
        self.inflight.load(Ordering::Acquire)
    }

    /// Drop-in placeholder; Task 7 fills the body. Marked pub so the Pool
    /// can call it.
    pub async fn invoke(&mut self, _input: Value, _deadline: Duration) -> Result<Value, InvokeError> {
        Err(InvokeError::Other("Worker::invoke unimplemented (Task 7)".into()))
    }

    /// Drop-in placeholder; Task 9 fills the body.
    pub async fn shutdown(&mut self) -> io::Result<()> {
        let _ = self.child.kill().await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;
    use tokio::process::Command;

    /// Spawn a fake "child" that prints the boot JSON immediately and then
    /// pipes stdin→stdout (like `cat`). On unix this is `/bin/sh -c 'echo
    /// ... ; cat'`; on macOS `/bin/sh` is always present.
    async fn spawn_fake_child(boot_ok: bool) -> Result<Child, std::io::Error> {
        let boot = if boot_ok {
            r#"{"id":"__boot__","ok":true}"#
        } else {
            r#"{"id":"__boot__","ok":false,"error":{"kind":"boot_failed","message":"x"}}"#
        };
        Command::new("/bin/sh")
            .arg("-c")
            .arg(format!("echo '{boot}'; cat"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    }

    #[tokio::test]
    async fn from_child_reads_boot_line_and_succeeds() {
        let child = spawn_fake_child(true).await.expect("spawn");
        let paths = Sandpath { handler_dir: std::env::temp_dir() };
        let w = Worker::from_child("test".into(), paths, child).await;
        assert!(w.is_ok(), "expected boot success, got {:?}", w.err());
        let w = w.unwrap();
        assert_eq!(w.slug, "test");
        assert!(w.pid > 0);
        assert!(!w.is_inflight());
    }

    #[tokio::test]
    async fn from_child_rejects_boot_false() {
        let child = spawn_fake_child(false).await.expect("spawn");
        let paths = Sandpath { handler_dir: std::env::temp_dir() };
        let w = Worker::from_child("bad".into(), paths, child).await;
        assert!(w.is_err());
        match w.err().unwrap() {
            InvokeError::Ipc(msg) => assert!(msg.contains("boot failed"), "msg: {msg}"),
            other => panic!("expected Ipc, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn try_acquire_inflight_is_single_flight() {
        let child = spawn_fake_child(true).await.expect("spawn");
        let paths = Sandpath { handler_dir: std::env::temp_dir() };
        let w = Worker::from_child("test".into(), paths, child).await.unwrap();
        assert!(w.try_acquire_inflight().is_ok(), "first acquire must succeed");
        assert!(matches!(w.try_acquire_inflight(), Err(InvokeError::Busy)));
        w.release_inflight();
        assert!(w.try_acquire_inflight().is_ok(), "after release, acquire succeeds again");
    }
}
