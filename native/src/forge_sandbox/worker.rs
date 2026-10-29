// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
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
    stdin: Option<ChildStdin>,
    stdout_lines: Lines<BufReader<ChildStdout>>,
}

impl Worker {
    /// Wrap an already-spawned Tokio `Child` plus its piped stdio. Caller
    /// (Pool::get_or_spawn → Sandbox::spawn) is responsible for choosing the
    /// OS sandbox; this constructor only sets up framing.
    pub async fn from_child(
        slug: String,
        paths: Sandpath,
        mut child: Child,
    ) -> Result<Self, InvokeError> {
        let pid = child
            .id()
            .ok_or_else(|| InvokeError::Other("child has no pid".into()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| InvokeError::Other("child stdin not piped".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| InvokeError::Other("child stdout not piped".into()))?;
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
            stdin: Some(stdin),
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

    /// Send a request and read the matching response. Caller is expected to
    /// have already called `try_acquire_inflight()` — `invoke` does NOT
    /// re-enter that gate so the Pool can checkout the worker before holding
    /// it across an await point.
    pub async fn invoke(&mut self, input: Value, deadline: Duration) -> Result<Value, InvokeError> {
        let req_id = uuid::Uuid::new_v4().to_string();
        let request = serde_json::json!({
            "id": req_id,
            "input": input,
            "deadline_ms": deadline.as_millis() as u64,
        });
        let mut line =
            serde_json::to_string(&request).map_err(|e| InvokeError::Other(e.to_string()))?;
        line.push('\n');

        let stdin = self.stdin.as_mut().ok_or_else(|| {
            InvokeError::Pipe(io::Error::new(io::ErrorKind::BrokenPipe, "stdin closed"))
        })?;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(InvokeError::Pipe)?;
        stdin.flush().await.map_err(InvokeError::Pipe)?;

        let read = tokio::time::timeout(deadline, self.stdout_lines.next_line()).await;
        let raw = match read {
            Ok(Ok(Some(s))) => s,
            Ok(Ok(None)) => return Err(InvokeError::Ipc("child closed stdout".into())),
            Ok(Err(e)) => return Err(InvokeError::Pipe(e)),
            Err(_) => {
                let _ = self.child.start_kill();
                return Err(InvokeError::Timeout {
                    budget_ms: deadline.as_millis() as u64,
                });
            }
        };

        let value: Value = serde_json::from_str(&raw).map_err(|e| {
            InvokeError::Ipc(format!(
                "response not JSON: {e}; raw={}",
                truncate(&raw, 200)
            ))
        })?;

        let resp_id = value.get("id").and_then(|i| i.as_str()).unwrap_or("");
        if resp_id != req_id {
            return Err(InvokeError::Ipc(format!(
                "response id mismatch: expected {req_id}, got {resp_id}"
            )));
        }

        self.last_used = Instant::now();
        Ok(value)
    }

    /// Graceful shutdown: close stdin (the shim sees EOF on its readline and
    /// exits cleanly), wait up to 1s for the child to exit, SIGKILL if alive.
    /// Idempotent — safe to call multiple times.
    pub async fn shutdown(&mut self) -> io::Result<()> {
        if let Some(mut stdin) = self.stdin.take() {
            let _ = stdin.write_all(b"{\"kind\":\"shutdown\"}\n").await;
            let _ = stdin.flush().await;
            drop(stdin);
        }

        let waited = tokio::time::timeout(Duration::from_secs(1), self.child.wait()).await;
        match waited {
            Ok(Ok(_status)) => Ok(()),
            Ok(Err(e)) => Err(e),
            Err(_) => {
                let _ = self.child.start_kill();
                let _ = self.child.wait().await;
                Ok(())
            }
        }
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
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
        let paths = Sandpath {
            handler_dir: std::env::temp_dir(),
        };
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
        let paths = Sandpath {
            handler_dir: std::env::temp_dir(),
        };
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
        let paths = Sandpath {
            handler_dir: std::env::temp_dir(),
        };
        let w = Worker::from_child("test".into(), paths, child)
            .await
            .unwrap();
        assert!(
            w.try_acquire_inflight().is_ok(),
            "first acquire must succeed"
        );
        assert!(matches!(w.try_acquire_inflight(), Err(InvokeError::Busy)));
        w.release_inflight();
        assert!(
            w.try_acquire_inflight().is_ok(),
            "after release, acquire succeeds again"
        );
    }

    async fn spawn_echo_child() -> Child {
        Command::new("/bin/sh")
            .arg("-c")
            .arg(r#"echo '{"id":"__boot__","ok":true}'; while IFS= read -r LINE; do printf '%s\n' "$LINE"; done"#)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn")
    }

    #[tokio::test]
    async fn invoke_round_trips_via_echo_child() {
        let child = spawn_echo_child().await;
        let paths = Sandpath {
            handler_dir: std::env::temp_dir(),
        };
        let mut w = Worker::from_child("echo".into(), paths, child)
            .await
            .expect("boot");

        let req = serde_json::json!({"echo": "hello"});
        w.try_acquire_inflight().expect("acquire");
        let resp = w
            .invoke(req.clone(), Duration::from_secs(5))
            .await
            .expect("invoke");
        w.release_inflight();

        assert!(resp.get("id").is_some(), "response has id");
        assert!(resp.get("input").is_some(), "echo preserved input field");
        assert_eq!(resp.get("input").unwrap(), &req, "input round-tripped");
    }

    #[tokio::test]
    async fn invoke_returns_pipe_error_when_child_dies() {
        let child = Command::new("/bin/sh")
            .arg("-c")
            .arg(r#"echo '{"id":"__boot__","ok":true}'; read X; exit 0"#)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn");
        let paths = Sandpath {
            handler_dir: std::env::temp_dir(),
        };
        let mut w = Worker::from_child("dies".into(), paths, child)
            .await
            .expect("boot");

        w.try_acquire_inflight().expect("acquire");
        let first = w
            .invoke(serde_json::json!({"x":1}), Duration::from_secs(2))
            .await;
        w.release_inflight();
        match first {
            Err(InvokeError::Ipc(m)) if m.contains("closed") => {}
            Err(InvokeError::Pipe(_)) => {}
            other => panic!("expected EOF-style error, got {other:?}"),
        }
    }

    #[test]
    fn truncate_handles_multibyte_utf8() {
        // 2-byte: é (U+00E9). Slicing at a non-boundary byte would panic.
        let s = "é".repeat(150);
        let t = truncate(&s, 200);
        assert!(t.ends_with('…'));
        assert!(t.len() < s.len());
    }

    #[test]
    fn truncate_handles_4byte_emoji() {
        // 4-byte: 🎉 (U+1F389). 60 emoji = 240 bytes; max=201 splits mid-codepoint.
        let s = "🎉".repeat(60);
        let t = truncate(&s, 201);
        assert!(t.ends_with('…'));
        // The walk-back must have stepped to a char boundary (multiple of 4).
        let body = &t[..t.len() - "…".len()];
        assert_eq!(body.len() % 4, 0, "body must be on a codepoint boundary");
    }

    #[test]
    fn truncate_under_max_returns_as_is() {
        let s = "hello";
        assert_eq!(truncate(s, 100), "hello");
    }

    #[tokio::test]
    async fn invoke_times_out_when_child_does_not_respond() {
        let child = Command::new("/bin/sh")
            .arg("-c")
            .arg(r#"echo '{"id":"__boot__","ok":true}'; sleep 60"#)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn");
        let paths = Sandpath {
            handler_dir: std::env::temp_dir(),
        };
        let mut w = Worker::from_child("slow".into(), paths, child)
            .await
            .expect("boot");

        w.try_acquire_inflight().expect("acquire");
        let start = Instant::now();
        let r = w
            .invoke(serde_json::json!({}), Duration::from_millis(200))
            .await;
        let elapsed = start.elapsed();
        w.release_inflight();

        match r {
            Err(InvokeError::Timeout { budget_ms }) => assert_eq!(budget_ms, 200),
            other => panic!("expected Timeout, got {other:?}"),
        }
        assert!(
            elapsed < Duration::from_secs(5),
            "invoke should have killed quickly, took {elapsed:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_does_not_leak_child_process() {
        let child = Command::new("/bin/sh")
            .arg("-c")
            .arg(r#"echo '{"id":"__boot__","ok":true}'; sleep 60"#)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn");
        let paths = Sandpath {
            handler_dir: std::env::temp_dir(),
        };
        let mut w = Worker::from_child("leak".into(), paths, child)
            .await
            .expect("boot");
        let pid = w.pid;

        w.try_acquire_inflight().expect("acquire");
        let _ = w
            .invoke(serde_json::json!({}), Duration::from_millis(100))
            .await;
        w.release_inflight();

        drop(w);
        tokio::time::sleep(Duration::from_millis(200)).await;
        let kill_check = unsafe { libc::kill(pid as i32, 0) };
        assert!(
            kill_check != 0,
            "child pid {pid} should be reaped after Worker drop"
        );
    }

    #[tokio::test]
    async fn shutdown_grace_period_lets_child_exit_cleanly() {
        let child = Command::new("/bin/sh")
            .arg("-c")
            .arg(r#"echo '{"id":"__boot__","ok":true}'; cat >/dev/null"#)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn");
        let paths = Sandpath {
            handler_dir: std::env::temp_dir(),
        };
        let mut w = Worker::from_child("graceful".into(), paths, child)
            .await
            .expect("boot");

        let start = Instant::now();
        let r = w.shutdown().await;
        let elapsed = start.elapsed();
        assert!(
            r.is_ok(),
            "shutdown should succeed cleanly, got {:?}",
            r.err()
        );
        assert!(
            elapsed < Duration::from_secs(1),
            "expected clean exit < 1s, took {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn shutdown_sigkills_child_that_ignores_grace() {
        let child = Command::new("/bin/sh")
            .arg("-c")
            .arg(r#"echo '{"id":"__boot__","ok":true}'; sleep 60"#)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn");
        let paths = Sandpath {
            handler_dir: std::env::temp_dir(),
        };
        let mut w = Worker::from_child("stubborn".into(), paths, child)
            .await
            .expect("boot");

        let start = Instant::now();
        let r = w.shutdown().await;
        let elapsed = start.elapsed();
        assert!(r.is_ok());
        assert!(
            elapsed < Duration::from_secs(3),
            "shutdown should be fast, took {elapsed:?}"
        );
        assert!(
            elapsed >= Duration::from_millis(900),
            "should wait grace period, took {elapsed:?}"
        );
    }
}
